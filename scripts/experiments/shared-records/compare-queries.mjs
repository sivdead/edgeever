import {Database} from 'bun:sqlite';
import {globSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,basename,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createSelfHostedStorageAdapter} from '../../../apps/api/src/self-hosted-storage-adapter.ts';
import {SharedTableStore} from '../../../apps/api/src/shared-table-store.ts';
import {applyTableView} from '../../../packages/shared/src/table.ts';
import {captureReads,isRecordPage} from './query-metrics.mjs';

const baseline=resolve(process.argv[2]),output=resolve(process.argv[3]);mkdirSync(output,{recursive:true});
const groups=[];
for(const file of globSync(join(baseline,'*-before.sqlite')).sort()){
 const name=basename(file,'-before.sqlite'),previous=JSON.parse(readFileSync(join(baseline,name+'-queries.json'),'utf8'));
 const sqlite=new Database(file,{readonly:true,strict:true}),storage=createSelfHostedStorageAdapter(sqlite,'/unused'),store=new SharedTableStore(storage.db);
 let capture=null;captureReads(storage.db,q=>{if(capture)capture.push(q);});
 const flows=[],pairs=[];
 for(const before of previous.flows){
  const identity=before.queries.find(q=>q.sql.startsWith('SELECT h.revision')).bindings;
  const [workspace,table]=identity;
  const head=sqlite.query('SELECT header_json FROM ee_table_heads WHERE workspace_id=? AND table_id=?').get(workspace,table);
  const document={...JSON.parse(head.header_json),records:sqlite.query('SELECT record_id,cells_json FROM ee_table_records WHERE workspace_id=? AND table_id=? ORDER BY position').all(workspace,table).map(r=>({id:r.record_id,cells:JSON.parse(r.cells_json)}))};
  let view=document.views.find(v=>v.id===before.view);
  if(before.view==='temporary-empty')view={...document.views[1],id:before.view,filters:[{...document.views[1].filters[0],value:9999}]};
  if(before.view==='temporary-mixed')view={id:before.view,name:'Temporary',match:'all',filters:[{fieldId:document.fields[0].id,operator:'contains',value:'中文'}],sorts:[{fieldId:document.fields[2].id,direction:'asc'},{fieldId:document.fields[1].id,direction:'desc'}]};
  assert.ok(view);
  capture=[];let cursor,pages=0;const records=[];
  do{const page=await store.query(workspace,table,{view,cursor,includeTotal:true});records.push(...page.records);cursor=page.next;pages++;}while(cursor);
  const queries=capture;capture=null;
  assert.deepEqual(records,applyTableView(document,document.records,view));assert.equal(pages,before.pages);
  assert.equal(queries.filter(q=>q.sql.startsWith('SELECT COUNT(*)')).length,before.exactCounts);
  const pageQueries=queries.filter(q=>isRecordPage(q.sql));assert.equal(pageQueries.length,pages);assert.ok(pageQueries.every(q=>q.returned<=51));
  const after={...before,queries,returnedRows:queries.reduce((n,q)=>n+q.returned,0)};
  flows.push({...before,view:'before:'+before.view},{...after,view:'after:'+after.view});
  pairs.push({table:before.table,view:before.view,rows:records.length,pages,exactCounts:before.exactCounts,returnedRowsBefore:before.returnedRows,returnedRowsAfter:after.returnedRows});
 }
 sqlite.close();
 const queryFile=join(output,name+'-queries.json');writeFileSync(queryFile,JSON.stringify({flows,writes:[]}));
 const replay=spawnSync('python3',['scripts/experiments/shared-records/sqlite-metrics.py',file,queryFile],{encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(replay.status,0,replay.stderr);
 const metrics=JSON.parse(replay.stdout);
 for(let i=0;i<pairs.length;i++){
  const old=metrics.queryMetrics[i*2],current=metrics.queryMetrics[i*2+1];
  Object.assign(pairs[i],{beforeVmSteps:old.sqliteVmSteps,afterVmSteps:current.sqliteVmSteps,reduction:1-current.sqliteVmSteps/old.sqliteVmSteps,plansBefore:old.plans,plansAfter:current.plans});
  if(pairs[i].view==='temporary-mixed')assert.ok(current.sqliteVmSteps<old.sqliteVmSteps*0.25,'Mixed pagination must remove repeated full-table work');
 }
 groups.push({name,sqliteVersion:metrics.sqliteVersion,pairs});console.log(JSON.stringify({name,comparisons:pairs.length,valid:true}));
}
assert.equal(groups.length,4);
writeFileSync(join(output,'summary.json'),JSON.stringify({boundary:'Both SQL versions replay against the exact same pre-write local database. SQLite VM steps are not D1 billed reads or Workers CPU.',groups},null,2)+'\n');
