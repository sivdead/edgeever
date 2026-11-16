import {Database} from 'bun:sqlite';
import {globSync,readFileSync} from 'node:fs';
import {createSelfHostedStorageAdapter} from '../../../apps/api/src/self-hosted-storage-adapter.ts';
import {createMemoRecord} from '../../../apps/api/src/memo-service.ts';
import {SharedTableStore} from '../../../apps/api/src/shared-table-store.ts';
import {serializeTableDocument,parseTableDocument} from '../../../packages/shared/src/table.ts';
const actor={actorType:'user',actorId:'test'};
export function fixture(rows=123, columns=4) {
  const fields=[{id:'name',name:'Name',type:'text'},{id:'amount',name:'Amount',type:'number'},
    {id:'status',name:'Status',type:'select',options:['Z','A']},{id:'files',name:'Files',type:'attachment'}];
  for(let i=4;i<columns;i++)fields.push({id:'f'+i,name:'Field '+i,type:'text'});
  return {schemaVersion:2,fields,views:[{id:'default',name:'All',match:'all',filters:[],sorts:[]},
    {id:'amount',name:'Amount',match:'all',filters:[{fieldId:'amount',operator:'gte',value:5}],sorts:[{fieldId:'amount',direction:'desc'}]}],
    records:Array.from({length:rows},(_,i)=>({id:'r'+i,cells:Object.fromEntries(fields.map(f=>[f.id,
      f.type==='number'?i%31:f.type==='select'?['Z','A'][i%2]:f.type==='attachment'?[]:'中文😀 '+i+' '+f.id]))}))};
}
export async function environment(document=fixture(),{initialize=true}={}) {
  const sql=new Database(':memory:');
  for(const file of globSync('migrations/*.sql').sort())sql.exec(readFileSync(file,'utf8'));
  sql.exec(readFileSync('scripts/experiments/shared-records/schema.sql','utf8'));
  const storage=createSelfHostedStorageAdapter(sql,'/unused');
  const memo=await createMemoRecord(storage.db,'ws_default',{notebookId:'nb_inbox',contentMarkdown:serializeTableDocument(document)},actor,'test');
  const store=new SharedTableStore(storage.db);
  // Exercise the actual #805 legacy wire format, not a different test-only format.
  const legacy=parseTableDocument(memo.contentMarkdown);
  if(initialize)await store.initialize('ws_default',memo.id,legacy);
  return {sql,db:storage.db,store,memo,document:legacy,close:()=>sql.close()};
}
