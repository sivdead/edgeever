import {Database} from 'bun:sqlite';
import {globSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createSelfHostedStorageAdapter} from '../../../apps/api/src/self-hosted-storage-adapter.ts';
import {createMemoRecord} from '../../../apps/api/src/memo-service.ts';
import {SharedTableStore} from '../../../apps/api/src/shared-table-store.ts';
import {serializeTableDocument,parseTableDocument,applyTableView} from '../../../packages/shared/src/table.ts';
import {fixture} from './support.mjs';
import {captureReads,isRecordPage} from './query-metrics.mjs';

const output=resolve(process.argv[2]??'test-results/shared-records');mkdirSync(output,{recursive:true});
const groups=[{tables:2,rows:1000,columns:10},{tables:10,rows:1000,columns:10},{tables:30,rows:1000,columns:10},{tables:2,rows:1950,columns:38,rich:true}];
const results=[];
for(const group of groups){
 const name=`${group.tables}tables-${group.rows}x${group.columns}${group.rich?'-rich':''}`,file=join(output,name+'.sqlite');
 // Refuse overwriting an existing evidence database.
 const sql=new Database(file,{create:true,strict:true});
 assert.equal(sql.query("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n,0,'Use a fresh output directory');
 for(const migration of globSync('migrations/*.sql').sort())sql.exec(readFileSync(migration,'utf8'));
 sql.exec(readFileSync('scripts/experiments/shared-records/schema.sql','utf8'));
 const storage=createSelfHostedStorageAdapter(sql,'/unused'),store=new SharedTableStore(storage.db),ids=[],documents=[];
 for(let n=0;n<group.tables;n++){
  const document=fixture(group.rows,group.columns);
  // Different logical IDs exercise scoped indexes rather than one universal JSON path.
  const rename=id=>n===0?id:id+'_table'+n;
  document.fields=document.fields.map(f=>({...f,id:rename(f.id)}));
  document.records=document.records.map((r,i)=>({...r,cells:Object.fromEntries(Object.entries(r.cells).map(([id,value])=>[rename(id),group.rich&&id.startsWith('f')?`**文字 ${i}** [link](https://example.test/${i})\n\`code\``:value]))}));
  document.views=document.views.map(v=>({...v,filters:v.filters.map(f=>({...f,fieldId:rename(f.fieldId)})),sorts:v.sorts.map(s=>({...s,fieldId:rename(s.fieldId)}))}));
  const memo=await createMemoRecord(storage.db,'ws_default',{notebookId:'nb_inbox',contentMarkdown:serializeTableDocument(document)},{actorType:'user',actorId:'local'},'local');
  const legacy=parseTableDocument(memo.contentMarkdown);assert.ok(legacy);await store.initialize('ws_default',memo.id,legacy);ids.push(memo.id);documents.push(legacy);
 }
 let capture=null;captureReads(storage.db,query=>{if(capture)capture.push(query);});
 const flows=[];
 for(const n of [...new Set([0,group.tables-1])]){
  const document=documents[n],view=document.views[1];
  for(const selected of [document.views[0],view,{...view,id:'temporary-empty',filters:[{...view.filters[0],value:9999}]},{id:'temporary-mixed',name:'Temporary',match:'all',filters:[{fieldId:document.fields[0].id,operator:'contains',value:'中文'}],sorts:[{fieldId:document.fields[2].id,direction:'asc'},{fieldId:document.fields[1].id,direction:'desc'}]}]){
   capture=[];let cursor,records=[],pages=0;const start=performance.now();
   do{const page=await store.query('ws_default',ids[n],{view:selected,cursor,includeTotal:true});records.push(...page.records);cursor=page.next;pages++;}while(cursor);
   const elapsedMs=performance.now()-start,queries=capture;capture=null;
   assert.deepEqual(records,applyTableView(document,document.records,selected));
   const counts=queries.filter(q=>q.sql.startsWith('SELECT COUNT(*)'));
   assert.equal(counts.length,selected.filters.length?1:0);
   const pageQueries=queries.filter(q=>isRecordPage(q.sql));
   assert.equal(pageQueries.length,pages);assert.ok(pageQueries.every(q=>q.returned<=51));
   flows.push({table:n,view:selected.id,rows:records.length,pages,elapsedMs,queries,returnedRows:queries.reduce((sum,q)=>sum+q.returned,0),exactCounts:counts.length});
  }
 }
 // Capture real write statements as well as their storage/VM cost on a rollback-only clone.
 const beforeFile=join(output,name+'-before.sqlite');writeFileSync(beforeFile,sql.serialize());
 const writes=[],originalBatch=storage.db.batch.bind(storage.db);
 storage.db.batch=async statements=>{writes.push(...statements.map(s=>({sql:s.sql,bindings:s.bindings})));return originalBatch(statements);};
 const beforeChanges=Number(sql.query('SELECT total_changes() AS n').get().n);
 await store.apply('ws_default',ids[0],{expectedRevision:1,puts:[{id:'r0',cells:{...documents[0].records[0].cells,name:'single-cell update'}}]});
 const writeChanges=Number(sql.query('SELECT total_changes() AS n').get().n)-beforeChanges;
 assert.equal(sql.query('SELECT count(*) AS n FROM ee_table_versions WHERE table_id=? AND revision=2').get(ids[0]).n,1);
 const queryFile=join(output,name+'-queries.json');writeFileSync(queryFile,JSON.stringify({flows,writes}));
 sql.close();
 const metrics=spawnSync('python3',['scripts/experiments/shared-records/sqlite-metrics.py',beforeFile,queryFile],{encoding:'utf8',maxBuffer:8*1024*1024});
 assert.equal(metrics.status,0,metrics.stderr);
 const measured=JSON.parse(metrics.stdout);
 results.push({name,...group,flows:flows.map(({queries,...flow})=>flow),writeChanges,...measured});
 console.log(JSON.stringify({group:name,flowCount:flows.length,valid:true}));
}
writeFileSync(join(output,'summary.json'),JSON.stringify({runtime:{bun:Bun.version},metricBoundary:'Local SQLite VM steps and returned rows are not D1 billed rows or Workers CPU.',groups:results},null,2));
console.log(join(output,'summary.json'));
