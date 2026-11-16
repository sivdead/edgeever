import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {environment,fixture} from '../../../scripts/experiments/shared-records/support.mjs';
import {applyTableView,serializeTableDocument,parseTableDocument} from '../../../packages/shared/src/table.ts';
import {createMemoRecord} from './memo-service.ts';
import {captureReads,isRecordPage} from '../../../scripts/experiments/shared-records/query-metrics.mjs';

const mixedView=(primary='asc',secondary='desc')=>({id:'temporary',name:'Temporary',match:'all',
 filters:[{fieldId:'name',operator:'contains',value:'中文'}],
 sorts:[{fieldId:'status',direction:primary},{fieldId:'amount',direction:secondary}]});
function captureQueries(e){
 const queries=[];captureReads(e.db,query=>queries.push(query));
 return queries;
}

test('legal wide views remain within D1 SQL, binding, function and pattern limits',async()=>{
 const document=fixture(51);
 document.fields=Array.from({length:40},(_,i)=>({id:String(i).padStart(2,'0')+'\0'.repeat(78),name:'Field '+i,type:'select',
  options:Array.from({length:40},(_,n)=>String(n).padStart(2,'0')+'a'.repeat(76)+'😀')}));
 document.views=[document.views[0]];
 document.records.forEach(r=>r.cells=Object.fromEntries(document.fields.map(f=>[f.id,f.options[0]])));
 const directory=mkdtempSync(join(tmpdir(),'shared-d1-limits-')),e=await environment(document);
 try{
  const queries=captureQueries(e),view={id:'wide',name:'Wide',match:'all',
   filters:document.fields.slice(0,8).map(f=>({fieldId:f.id,operator:'contains',value:'\ud83d',legacy:true})),
   sorts:document.fields.map(f=>({fieldId:f.id,direction:'asc'}))};
  expect(await readAll(e,view)).toEqual(applyTableView(e.document,e.document.records,view));
  const database=join(directory,'limits.sqlite');writeFileSync(database,e.sql.serialize());
  const process=spawnSync('python3',['-c',`import sys,json,sqlite3
db=sqlite3.connect(sys.argv[1])
for kind,value in [(sqlite3.SQLITE_LIMIT_SQL_LENGTH,100000),(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER,100),(sqlite3.SQLITE_LIMIT_FUNCTION_ARG,32),(sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH,50)]:
 db.setlimit(kind,value)
for query in json.load(sys.stdin):
 assert len(db.execute(query['sql'],query['bindings']).fetchall()) == query['returned']
`,database],{input:JSON.stringify(queries),encoding:'utf8'});
  expect(process.status,process.stderr).toBe(0);
  expect(Math.max(...queries.map(q=>Buffer.byteLength(q.sql)))).toBeLessThanOrEqual(100000);
  expect(Math.max(...queries.map(q=>q.bindings.length))).toBeLessThanOrEqual(100);
 }finally{e.close();rmSync(directory,{recursive:true,force:true});}
});
async function readAll(e,view,includeTotal=true){
 const records=[];let cursor;
 do{const page=await e.store.query('ws_default',e.memo.id,{view,cursor,includeTotal});records.push(...page.records);cursor=page.next;}while(cursor);
 return records;
}

test('temporary select/number pagination has near-linear cumulative work when rows and pages double',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'shared-query-budget-')),samples=[];
 try{
  for(const rows of [500,1000]){
   const e=await environment(fixture(rows));try{
    const queries=captureQueries(e),view=mixedView();
    expect(await readAll(e,view)).toEqual(applyTableView(e.document,e.document.records,view));
    const database=join(directory,rows+'.sqlite'),input=join(directory,rows+'.json');
    writeFileSync(database,e.sql.serialize());writeFileSync(input,JSON.stringify({flows:[{table:0,view:'temporary',queries}],writes:[]}));
    const process=spawnSync('python3',['scripts/experiments/shared-records/sqlite-metrics.py',database,input],{encoding:'utf8'});
    expect(process.status).toBe(0);samples.push(JSON.parse(process.stdout).queryMetrics[0].sqliteVmSteps);
    expect(queries.filter(q=>q.sql.startsWith('SELECT COUNT(*)'))).toHaveLength(1);
    const pageQueries=queries.filter(q=>isRecordPage(q.sql));
    expect(pageQueries.length).toBeGreaterThan(0);expect(pageQueries.every(q=>q.returned<=51)).toBe(true);
   }finally{e.close();}
  }
  expect(samples[1]).toBeLessThan(samples[0]*2.6);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

for(const primary of ['asc','desc'])for(const secondary of ['asc','desc']){
 test(`grouped pagination preserves ${primary}/${secondary} order, ties, nulls and tenant-scoped payloads`,async()=>{
  const document=fixture(231);document.views[1].sorts[0].direction=secondary;
  for(let i=0;i<document.records.length;i++)document.records[i].cells.amount=i%13===0?null:i%7===0?7:3;
  const e=await environment(document);try{
   const decoy=fixture(231);for(const record of decoy.records)record.cells.name='decoy';
   const other=await createMemoRecord(e.db,'ws_default',{notebookId:'nb_inbox',contentMarkdown:serializeTableDocument(decoy)},{actorType:'user',actorId:'test'},'test');
   await e.store.initialize('ws_default',other.id,parseTableDocument(other.contentMarkdown));
   const indexes=e.sql.query("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all(),view=mixedView(primary,secondary);
   const queries=captureQueries(e);
   for(const includeTotal of [true,false])expect(await readAll(e,view,includeTotal)).toEqual(applyTableView(e.document,e.document.records,view));
   const or={...view,match:'any',filters:[{fieldId:'name',operator:'contains',value:'中文😀 1'},{fieldId:'amount',operator:'lt',value:5}]};
   expect(await readAll(e,or)).toEqual(applyTableView(e.document,e.document.records,or));
   expect(e.sql.query("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all()).toEqual(indexes);
   expect(queries.filter(q=>isRecordPage(q.sql)).every(q=>q.returned<=51)).toBe(true);
   const first=await e.store.query('ws_default',e.memo.id,{view});
   await expect(e.store.query('ws_default',other.id,{view,cursor:first.next})).rejects.toMatchObject({status:409});
   await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:'r0',cells:{...e.document.records[0].cells,amount:99}}]});
   await expect(e.store.query('ws_default',e.memo.id,{view,cursor:first.next})).rejects.toMatchObject({status:409});
  }finally{e.close();}
 });
}

test('single-select pagination preserves quoted options and the null rank without requesting totals',async()=>{
 const document=fixture(231);document.fields[2].options=["O'Reilly",'A"quote'];
 for(let i=0;i<document.records.length;i++)document.records[i].cells.status=["O'Reilly",'A"quote',''][i%3];
 const e=await environment(document);try{
  for(const direction of ['asc','desc']){
   const view={...mixedView(),sorts:[{fieldId:'status',direction}]};
   expect(await readAll(e,view,false)).toEqual(applyTableView(e.document,e.document.records,view));
  }
 }finally{e.close();}
});
