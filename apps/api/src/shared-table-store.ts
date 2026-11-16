import {tableStatement,readStoredRecord} from './table-query-sql';
import {compareTableText,coerceTableCell,parseTableDocumentJson,serializeTableDocument,tableFallbackMarkdown,TABLE_RECORD_LIMIT,type TableDocument,type TableRecord} from '../../../packages/shared/src/table';
import {docToText,markdownToDoc} from '@edgeever/shared';
import {AppError} from './app-error';
import {indexStatements,type SharedFieldIndex} from './shared-table-index';
import {SharedTableQuery} from './shared-table-query';
import type {DatabaseAdapter,PreparedStatementAdapter} from './storage-contract';

export type SharedHead={workspace_id:string;table_id:string;revision:number;schema_revision:number;row_count:number;max_position:number;header_json:string;indexes_json:string;lock_job_id:string|null};
export type StoredSharedRecord={record_id:string;position:number;cells_json:string};
export const tableConflict=()=>new AppError('revision_conflict','The table changed; retain the draft and refresh',409);
const bad=()=>new AppError('bad_request','Invalid table records or metadata',400);
export const tableLocked=()=>new AppError('table_migration_in_progress','This table is being converted',409);
export function serializeSharedSnapshot(document:TableDocument){
 const encoded={...document,cellEncoding:'nullable-v1'};
 return serializeTableDocument(encoded);
}
export function tableHeader(document:TableDocument):TableDocument {
 const h=parseTableDocumentJson(JSON.stringify({...document,records:[]}),true);
 if(!h)throw bad();return h;
}
export function normalizeSharedRecord(header:TableDocument,record:TableRecord):TableRecord {
 if(!record||typeof record.id!=='string'||!record.id||record.id.length>80||!record.cells||typeof record.cells!=='object')throw bad();
 return {id:record.id,cells:Object.fromEntries(header.fields.map(f=>{
  const value=Object.hasOwn(record.cells,f.id)?record.cells[f.id]:undefined;
  return [f.id,value===null?null:coerceTableCell(f,value)];
 }))};
}
export function recordProjection(header:TableDocument,record:TableRecord) {
 return {cells:JSON.stringify(record.cells),normalized:JSON.stringify(Object.fromEntries(header.fields.map(f=>{
  const v=record.cells[f.id];return [f.id,f.type==='attachment'?(Array.isArray(v)?v.map(a=>a.filename.toLocaleLowerCase()):[]):String(v??'').toLocaleLowerCase()];
 }))),search:recordSearchText(header,record)};
}
const recordSearchText=(header:TableDocument,record:TableRecord)=>docToText(markdownToDoc(tableFallbackMarkdown({...header,records:[record]})));

type PreparedSnapshot={header:TableDocument;records:TableRecord[]};
const prepareSnapshot=(document:TableDocument):PreparedSnapshot=>{
 const header=tableHeader(document);
 if(!Array.isArray(document.records))throw bad();
 const records=document.records.map(r=>normalizeSharedRecord(header,r));
 if(records.length>TABLE_RECORD_LIMIT||new Set(records.map(r=>r.id)).size!==records.length)throw bad();
 return {header,records};
};
const headResult=(h:SharedHead)=>({...h,lockJobId:h.lock_job_id});

/** Shared JSON candidate. Production routes remain on #805 until separate integration. */
export class SharedTableStore {
 private readonly sql:ReturnType<typeof tableStatement>;
 constructor(readonly db:DatabaseAdapter){this.sql=tableStatement(db);}
 async head(workspace:string,id:string){
  const h=await this.sql`SELECT h.* FROM ee_table_heads h JOIN memos m ON m.id=h.table_id AND m.workspace_id=h.workspace_id
   JOIN notebooks n ON n.id=m.notebook_id AND n.workspace_id=m.workspace_id
   WHERE h.workspace_id=${workspace} AND h.table_id=${id} AND m.is_deleted=0 AND n.is_deleted=0`.first<SharedHead>();
  if(!h)throw new AppError('not_found','Table not found',404);
  return headResult({...h,workspace_id:workspace,table_id:id});
 }
 guard(h:SharedHead,job:string|null=null) {
  return this.sql`INSERT OR REPLACE INTO ee_table_assertion SELECT CASE WHEN EXISTS(
   SELECT 1 FROM ee_table_heads h JOIN memos m ON m.id=h.table_id AND m.workspace_id=h.workspace_id
   JOIN notebooks n ON n.id=m.notebook_id AND n.workspace_id=m.workspace_id
   WHERE h.workspace_id=${h.workspace_id} AND h.table_id=${h.table_id} AND h.revision=${h.revision} AND h.lock_job_id IS ${job} AND m.is_deleted=0 AND n.is_deleted=0
   ) THEN 1 ELSE 0 END`;
 }
 async batch(h:SharedHead,statements:PreparedStatementAdapter[],job:string|null=null) {
  try {await this.db.batch([this.guard(h,job),...statements]);}
  catch(error){const current=await this.head(h.workspace_id,h.table_id);
   if(current.revision!==h.revision)throw tableConflict();
   if(current.lock_job_id!==job)throw current.lock_job_id?tableLocked():tableConflict();
   throw error;
  }
 }
 commitStatements(h:SharedHead,header:TableDocument,rowCount:number,maxPosition:number,indexes:SharedFieldIndex[],schema=h.schema_revision) {
  const revision=h.revision+1,json=JSON.stringify(header);
  return [this.sql`UPDATE ee_table_heads SET revision=${revision},schema_revision=${schema},row_count=${rowCount},max_position=${maxPosition},header_json=${json},indexes_json=${JSON.stringify(indexes)}
   WHERE workspace_id=${h.workspace_id} AND table_id=${h.table_id}`,
   this.sql`INSERT INTO ee_table_commits(workspace_id,table_id,revision,schema_revision,row_count,max_position,header_json)
    VALUES(${h.workspace_id},${h.table_id},${revision},${schema},${rowCount},${maxPosition},${json})`];
 }
 private rowStatement(workspace:string,id:string,record:TableRecord,position:number,revision:number,header:TableDocument){
  const p=recordProjection(header,record);
  return this.sql`INSERT INTO ee_table_records(workspace_id,table_id,record_id,position,created_revision,cells_json,normalized_json,search_text)
   VALUES(${workspace},${id},${record.id},${position},${revision},${p.cells},${p.normalized},${p.search}) ON CONFLICT(workspace_id,table_id,record_id) DO UPDATE SET
   position=excluded.position,created_revision=excluded.created_revision,cells_json=excluded.cells_json,normalized_json=excluded.normalized_json,search_text=excluded.search_text`;
 }
 private versionStatement(workspace:string,id:string,record:TableRecord,position:number,revision:number,deleted=0){
  return this.sql`INSERT INTO ee_table_versions(workspace_id,table_id,record_id,revision,position,deleted,cells_json)
   VALUES(${workspace},${id},${record.id},${revision},${position},${deleted},${JSON.stringify(record.cells)})`;
 }
 private async visible(workspace:string,id:string){
  return this.sql`SELECT m.id FROM memos m JOIN notebooks n ON n.id=m.notebook_id AND n.workspace_id=m.workspace_id
   WHERE m.id=${id} AND m.workspace_id=${workspace} AND m.is_deleted=0 AND n.is_deleted=0`.first();
 }
 private async initializeBatch(workspace:string,id:string,statements:PreparedStatementAdapter[]){
  const visibility=this.sql`INSERT OR REPLACE INTO ee_table_assertion SELECT CASE WHEN EXISTS(
   SELECT 1 FROM memos m JOIN notebooks n ON n.id=m.notebook_id AND n.workspace_id=m.workspace_id
   WHERE m.id=${id} AND m.workspace_id=${workspace} AND m.is_deleted=0 AND n.is_deleted=0) THEN 1 ELSE 0 END`;
  try{await this.db.batch([visibility,...statements]);}
  catch(error){if(!await this.visible(workspace,id))throw new AppError('not_found','Table not found',404);throw error;}
 }
 private initialPlan(workspace:string,id:string,prepared:PreparedSnapshot){
  const {header,records}=prepared,plan=indexStatements(this.db,workspace,id,header,[]),json=JSON.stringify(header);
  const head:SharedHead={workspace_id:workspace,table_id:id,revision:1,schema_revision:1,row_count:records.length,max_position:records.length,
   header_json:json,indexes_json:JSON.stringify(plan.next),lock_job_id:null};
  const statements=[this.sql`INSERT INTO ee_table_heads(workspace_id,table_id,revision,schema_revision,row_count,max_position,header_json,indexes_json)
   VALUES(${workspace},${id},1,1,${records.length},${records.length},${json},${head.indexes_json})`,
   this.sql`INSERT INTO ee_table_commits(workspace_id,table_id,revision,schema_revision,row_count,max_position,header_json)
    VALUES(${workspace},${id},1,1,${records.length},${records.length},${json})`,...plan.statements];
  records.forEach((r,i)=>statements.push(this.rowStatement(workspace,id,r,i+1,1,header),this.versionStatement(workspace,id,r,i+1,1)));
  return {head,statements};
 }
 committedHead(h:SharedHead,header:TableDocument,count:number,max:number,indexes:SharedFieldIndex[],schema=h.schema_revision){
  return headResult({...h,revision:h.revision+1,schema_revision:schema,row_count:count,max_position:max,
   header_json:JSON.stringify(header),indexes_json:JSON.stringify(indexes)});
 }
 async initialize(workspace:string,id:string,document:TableDocument){
  if(!await this.visible(workspace,id))throw new AppError('not_found','Table not found',404);
  const plan=this.initialPlan(workspace,id,prepareSnapshot(document));
  await this.initializeBatch(workspace,id,plan.statements);return headResult(plan.head);
 }
 async query(workspace:string,id:string,input:unknown){return JSON.parse(await new SharedTableQuery(this.db,workspace).query(workspace,id,input));}
 async apply(workspace:string,id:string,input:{expectedRevision:number;puts?:TableRecord[];deletes?:string[];header?:TableDocument}){
  const h=await this.head(workspace,id);if(h.revision!==input.expectedRevision)throw tableConflict();if(h.lock_job_id)throw tableLocked();
  const old=JSON.parse(h.header_json) as TableDocument,header=input.header?tableHeader(input.header):old;
  const shape=(d:TableDocument)=>JSON.stringify(d.fields.map(({id,type,options})=>({id,type,options})).sort((a,b)=>compareTableText(a.id,b.id)));
  if(shape(old)!==shape(header))throw bad();
  const puts=(input.puts??[]).map(r=>normalizeSharedRecord(header,r)),deletes=input.deletes??[],ids=[...puts.map(r=>r.id),...deletes];
  if(new Set(ids).size!==ids.length)throw bad();
  const rows=ids.length?(await this.sql`SELECT hex(record_id) AS record_id,position,cells_json FROM ee_table_records WHERE workspace_id=${workspace} AND table_id=${id}
   AND record_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`.all<StoredSharedRecord>()).results.map(readStoredRecord):[];
  const byId=new Map(rows.map(row=>[row.record_id,row]));
  let count=h.row_count,max=h.max_position;const revision=h.revision+1,statements:PreparedStatementAdapter[]=[];
  for(const record of puts){const previous=byId.get(record.id),position=previous?.position??++max;if(!previous)count++;
   statements.push(this.rowStatement(workspace,id,record,position,revision,header),this.versionStatement(workspace,id,record,position,revision));}
  for(const recordId of deletes){const row=byId.get(recordId);if(!row)continue;count--;
   statements.push(this.sql`DELETE FROM ee_table_records WHERE workspace_id=${workspace} AND table_id=${id} AND record_id=${recordId}`,
    this.versionStatement(workspace,id,{id:recordId,cells:JSON.parse(row.cells_json)},row.position,revision,1));}
  if(count>TABLE_RECORD_LIMIT)throw new AppError('table_record_limit','Table record limit reached',409);
  if(JSON.stringify(old.fields.map(f=>[f.id,f.name]))!==JSON.stringify(header.fields.map(f=>[f.id,f.name]))){
   const changed=new Set(ids);let after=0;
   for(;;){
    const page=(await this.sql`SELECT hex(record_id) AS record_id,position,cells_json,search_text FROM ee_table_records
     WHERE workspace_id=${workspace} AND table_id=${id} AND position>${after} ORDER BY position LIMIT 50`
     .all<StoredSharedRecord & {search_text:string}>()).results.map(readStoredRecord);
    if(!page.length)break;
    for(const row of page)if(!changed.has(row.record_id)){
     const search=recordSearchText(header,{id:row.record_id,cells:JSON.parse(row.cells_json)});
     if(search!==row.search_text)statements.push(this.sql`UPDATE ee_table_records SET search_text=${search} WHERE workspace_id=${workspace} AND table_id=${id} AND record_id=${row.record_id}`);
    }
    after=page.at(-1)!.position;
   }
  }
  const plan=indexStatements(this.db,workspace,id,header,JSON.parse(h.indexes_json));
  await this.batch(h,[...statements,...plan.statements,...this.commitStatements(h,header,count,max,plan.next)]);
  return this.committedHead(h,header,count,max,plan.next);
 }
 async snapshotPage(workspace:string,id:string,revision:number,after=0){
  await this.head(workspace,id);
  const commit=await this.sql`SELECT * FROM ee_table_commits WHERE workspace_id=${workspace} AND table_id=${id} AND revision=${revision}`
   .first<SharedHead>();if(!commit)throw tableConflict();
  const rows=(await this.sql`SELECT hex(v.record_id) AS record_id,v.position,v.cells_json FROM ee_table_versions v
   WHERE v.workspace_id=${workspace} AND v.table_id=${id} AND v.position>${after} AND v.revision<=${revision} AND v.deleted=0
   AND v.revision=(SELECT max(latest.revision) FROM ee_table_versions latest
    WHERE latest.workspace_id=v.workspace_id AND latest.table_id=v.table_id AND latest.record_id=v.record_id AND latest.revision<=${revision})
   ORDER BY v.position LIMIT 51`.all<StoredSharedRecord>()).results.map(readStoredRecord);
  const visible=rows.slice(0,50);
  return {revision,header:JSON.parse(commit.header_json) as TableDocument,rowCount:commit.row_count,
   records:visible.map(r=>({id:r.record_id,cells:JSON.parse(r.cells_json)})),next:rows.length>50?visible.at(-1)!.position:null};
 }
 async snapshot(workspace:string,id:string,revision?:number):Promise<TableDocument>{
  const h=await this.head(workspace,id),at=revision??h.revision;
  const first=await this.snapshotPage(workspace,id,at);let next=first.next;const records=first.records;
  while(next!==null){const page=await this.snapshotPage(workspace,id,at,next);records.push(...page.records);next=page.next;}
  if(records.length!==first.rowCount)throw new AppError('table_history_incomplete','Snapshot record count does not match its revision',409);
  return {...first.header,records};
 }
 async restore(workspace:string,id:string,revision:number,expectedRevision:number){
  const h=await this.head(workspace,id);if(h.revision!==expectedRevision)throw tableConflict();if(h.lock_job_id)throw tableLocked();
  return this.replaceSnapshot(h,await this.snapshot(workspace,id,revision));
 }
 /** Local import publishes every supplied revision together or none. */
 async importSnapshots(workspace:string,id:string,snapshots:TableDocument[]){
  if(!snapshots.length)throw bad();
  if(!await this.visible(workspace,id))throw new AppError('not_found','Table not found',404);
  const prepared=snapshots.map(prepareSnapshot),initial=this.initialPlan(workspace,id,prepared[0]);
  const statements=initial.statements;let head=initial.head,current=prepared[0];
  for(const next of prepared.slice(1)){
   const plan=this.replacementPlan(head,next,current.records.map((r,i)=>({record_id:r.id,position:i+1,cells_json:JSON.stringify(r.cells)})));
   statements.push(...plan.statements);head=plan.head;current=next;
  }
  await this.initializeBatch(workspace,id,statements);
 }
 private replacementPlan(h:SharedHead,prepared:PreparedSnapshot,current:StoredSharedRecord[]){
  const {header,records}=prepared,revision=h.revision+1;
  // Full replacement is reserved for explicit history/backup restore, never ordinary edits.
  const statements:PreparedStatementAdapter[]=[this.sql`DELETE FROM ee_table_records WHERE workspace_id=${h.workspace_id} AND table_id=${h.table_id}`];
  const ids=new Set(records.map(r=>r.id));
  for(const row of current)if(!ids.has(row.record_id))statements.push(this.versionStatement(h.workspace_id,h.table_id,{id:row.record_id,cells:JSON.parse(row.cells_json)},row.position,revision,1));
  records.forEach((r,i)=>statements.push(this.rowStatement(h.workspace_id,h.table_id,r,i+1,revision,header),this.versionStatement(h.workspace_id,h.table_id,r,i+1,revision)));
  const plan=indexStatements(this.db,h.workspace_id,h.table_id,header,JSON.parse(h.indexes_json));
  statements.push(...plan.statements,...this.commitStatements(h,header,records.length,records.length,plan.next,h.schema_revision+1));
  return {statements,head:this.committedHead(h,header,records.length,records.length,plan.next,h.schema_revision+1)};
 }
 private async replaceSnapshot(h:SharedHead,document:TableDocument){
  const prepared=prepareSnapshot(document),current=(await this.sql`SELECT hex(record_id) AS record_id,position,cells_json FROM ee_table_records
   WHERE workspace_id=${h.workspace_id} AND table_id=${h.table_id}`.all<StoredSharedRecord>()).results.map(readStoredRecord);
  const plan=this.replacementPlan(h,prepared,current);
  await this.batch(h,plan.statements);return headResult(plan.head);
 }
 async search(workspace:string,id:string,query:string){
  await this.head(workspace,id);
  const rows=(await this.sql`SELECT hex(r.record_id) AS record_id,r.cells_json FROM ee_table_search s JOIN ee_table_records r ON r.id=s.rowid
   WHERE ee_table_search MATCH ${query} AND r.workspace_id=${workspace} AND r.table_id=${id} ORDER BY r.position`.all<StoredSharedRecord>()).results.map(readStoredRecord);
  return rows.map(r=>({id:r.record_id,cells:JSON.parse(r.cells_json)}));
 }
}
