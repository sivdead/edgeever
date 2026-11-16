import {tableStatement,readStoredRecord,sqliteTextFromHex} from './table-query-sql';
import type {TableDocument,TableField,TableRecord} from '../../../packages/shared/src/table';
import {convertFieldValue} from '../../../packages/shared/src/table-conversion';
import {AppError} from './app-error';
import {SharedTableStore,recordProjection,tableHeader,tableConflict,tableLocked,type StoredSharedRecord} from './shared-table-store';
import {indexStatements} from './shared-table-index';
import type {DatabaseAdapter} from './storage-contract';

type Issue={recordId:string;reason:string;before:unknown;after?:unknown};
type Job={id:string;workspace_id:string;table_id:string;source_revision:number;field_id:string;target_json:string;header_json:string;state:'preflight'|'running'|'ready'|'published'|'cancelled';failures_json:string;confirmations_json:string;after_position:number};
const invalid=()=>new AppError('table_conversion_conflict','The conversion or its source changed',409);
/** Candidate driver advances each bounded batch explicitly; there is no background worker. */
export class SharedTableTypeChange {
 readonly store:SharedTableStore;
 private readonly sql:ReturnType<typeof tableStatement>;
 constructor(readonly db:DatabaseAdapter){this.store=new SharedTableStore(db);this.sql=tableStatement(db);}
 private async job(workspace:string,id:string,jobId:string){
  await this.store.head(workspace,id);
  const job=await this.sql`SELECT *,hex(field_id) AS field_id_hex FROM ee_table_type_jobs WHERE workspace_id=${workspace} AND table_id=${id} AND id=${jobId}`.first<Job & {field_id_hex:string}>();
  if(!job)throw new AppError('not_found','Conversion not found',404);return {...job,workspace_id:workspace,table_id:id,field_id:sqliteTextFromHex(job.field_id_hex)};
 }
 async preflight(workspace:string,id:string,fieldId:string,target:TableField){
  const h=await this.store.head(workspace,id);if(h.lock_job_id)throw tableLocked();
  const header=JSON.parse(h.header_json) as TableDocument,source=header.fields.find(f=>f.id===fieldId);
  if(!source||target.id!==fieldId)throw new AppError('bad_request','Unknown conversion field',400);
  let next:TableDocument;
  try {next=tableHeader({...header,fields:header.fields.map(f=>f.id===fieldId?target:f)});}
  catch {throw new AppError('table_rules_incompatible','Update incompatible view or field rules before conversion',409);}
  target=next.fields.find(f=>f.id===fieldId)!;
  const failures:Issue[]=[],confirmations:Issue[]=[];let after=0;
  for(;;){
   const rows=(await this.sql`SELECT hex(record_id) AS record_id,position,cells_json FROM ee_table_records
    WHERE workspace_id=${workspace} AND table_id=${id} AND position>${after} ORDER BY position LIMIT 50`.all<StoredSharedRecord>()).results.map(readStoredRecord);
   if(!rows.length)break;
   for(const row of rows){const before=JSON.parse(row.cells_json)[fieldId]??null,result=convertFieldValue(source,target,before);
    if(result.status==='failure')failures.push({recordId:row.record_id,before,reason:result.reason});
    if(result.status==='confirmation')confirmations.push({recordId:row.record_id,before,after:result.value,reason:result.reason});
   }
   after=rows.at(-1)!.position;
  }
  const jobId=crypto.randomUUID();
  await this.store.batch(h,[this.sql`INSERT INTO ee_table_type_jobs(id,workspace_id,table_id,source_revision,field_id,target_json,header_json,state,failures_json,confirmations_json)
   VALUES(${jobId},${workspace},${id},${h.revision},${fieldId},${JSON.stringify(target)},${JSON.stringify(next)},'preflight',${JSON.stringify(failures.map(issue=>issue.recordId))},${JSON.stringify(confirmations.map(issue=>issue.recordId))})`]);
  return {id:jobId,sourceRevision:h.revision,failures,confirmations};
 }
 async start(workspace:string,id:string,jobId:string,confirmed:boolean){
  const h=await this.store.head(workspace,id),job=await this.job(workspace,id,jobId);
  if(job.state!=='preflight'||job.source_revision!==h.revision)throw tableConflict();if(h.lock_job_id)throw tableLocked();
  if(JSON.parse(job.failures_json).length)throw new AppError('table_conversion_failed','Fix values that cannot be converted',409);
  if(JSON.parse(job.confirmations_json).length&&!confirmed)throw new AppError('table_conversion_confirmation_required','Confirm representation changes',409);
  try{await this.store.batch(h,[
   this.sql`INSERT OR REPLACE INTO ee_table_assertion SELECT CASE WHEN EXISTS(
    SELECT 1 FROM ee_table_type_jobs WHERE id=${job.id} AND workspace_id=${workspace} AND table_id=${id} AND source_revision=${h.revision} AND state='preflight') THEN 1 ELSE 0 END`,
   this.sql`UPDATE ee_table_type_jobs SET state='running',after_position=0 WHERE id=${job.id}`,
   this.sql`UPDATE ee_table_heads SET lock_job_id=${job.id} WHERE workspace_id=${workspace} AND table_id=${id}`]);}
  catch(error){if((await this.job(workspace,id,job.id)).state!=='preflight')throw invalid();throw error;}
  return this.job(workspace,id,jobId);
 }
 async advance(workspace:string,id:string,jobId:string){
  const h=await this.store.head(workspace,id),job=await this.job(workspace,id,jobId);
  if(job.state!=='running'||h.lock_job_id!==job.id||h.revision!==job.source_revision)throw invalid();
  const old=JSON.parse(h.header_json) as TableDocument,header=JSON.parse(job.header_json) as TableDocument,target=JSON.parse(job.target_json) as TableField;
  const source=old.fields.find(f=>f.id===job.field_id)!;
  const rows=(await this.sql`SELECT hex(record_id) AS record_id,position,cells_json FROM ee_table_records
   WHERE workspace_id=${workspace} AND table_id=${id} AND position>${job.after_position} ORDER BY position LIMIT 50`.all<StoredSharedRecord>()).results.map(readStoredRecord);
  const after=rows.at(-1)?.position??job.after_position;
  const statements=[this.sql`INSERT OR REPLACE INTO ee_table_assertion SELECT CASE WHEN EXISTS(
   SELECT 1 FROM ee_table_type_jobs WHERE id=${job.id} AND state='running' AND after_position=${job.after_position}) THEN 1 ELSE 0 END`];
  for(const row of rows){
   const cells=JSON.parse(row.cells_json),result=convertFieldValue(source,target,cells[job.field_id]??null);
   if(result.status==='failure')throw new AppError('table_conversion_failed','Source cannot be converted',409);
   const record:TableRecord={id:row.record_id,cells:{...cells,[job.field_id]:result.value}},p=recordProjection(header,record);
   statements.push(this.sql`INSERT INTO ee_table_type_values(job_id,record_id,position,cells_json,normalized_json,search_text)
    VALUES(${job.id},${row.record_id},${row.position},${p.cells},${p.normalized},${p.search})`);
  }
  // A final empty page is valid and does not reprocess previous records.
  statements.push(this.sql`UPDATE ee_table_type_jobs SET after_position=${after},state=${rows.length<50||after>=h.max_position?'ready':'running'} WHERE id=${job.id}`);
  try {await this.store.batch(h,statements,job.id);}
  catch(error){const current=await this.job(workspace,id,jobId);if(current.after_position!==job.after_position||current.state!==job.state)throw invalid();throw error;}
  return this.job(workspace,id,jobId);
 }
 async publish(workspace:string,id:string,jobId:string){
  const h=await this.store.head(workspace,id),job=await this.job(workspace,id,jobId);
  if(job.state!=='ready'||h.lock_job_id!==job.id||h.revision!==job.source_revision)throw invalid();
  const header=JSON.parse(job.header_json) as TableDocument,revision=h.revision+1;
  const plan=indexStatements(this.db,workspace,id,header,JSON.parse(h.indexes_json));
  await this.store.batch(h,[
   this.sql`INSERT OR REPLACE INTO ee_table_assertion SELECT CASE WHEN
    (SELECT count(*) FROM ee_table_type_values WHERE job_id=${job.id})=${h.row_count} AND
    EXISTS(SELECT 1 FROM ee_table_type_jobs WHERE id=${job.id} AND state='ready') THEN 1 ELSE 0 END`,
   this.sql`UPDATE ee_table_records SET cells_json=(SELECT v.cells_json FROM ee_table_type_values v WHERE v.job_id=${job.id} AND v.record_id=ee_table_records.record_id),
    normalized_json=(SELECT v.normalized_json FROM ee_table_type_values v WHERE v.job_id=${job.id} AND v.record_id=ee_table_records.record_id),
    search_text=(SELECT v.search_text FROM ee_table_type_values v WHERE v.job_id=${job.id} AND v.record_id=ee_table_records.record_id),created_revision=${revision}
    WHERE workspace_id=${workspace} AND table_id=${id}`,
   this.sql`INSERT INTO ee_table_versions(workspace_id,table_id,record_id,revision,position,deleted,cells_json)
    SELECT workspace_id,table_id,record_id,${revision},position,0,cells_json FROM ee_table_records WHERE workspace_id=${workspace} AND table_id=${id}`,
   ...plan.statements,...this.store.commitStatements(h,header,h.row_count,h.max_position,plan.next,h.schema_revision+1),
   this.sql`UPDATE ee_table_heads SET lock_job_id=NULL WHERE workspace_id=${workspace} AND table_id=${id}`,
   this.sql`DELETE FROM ee_table_type_values WHERE job_id=${job.id}`,
   this.sql`UPDATE ee_table_type_jobs SET state='published' WHERE id=${job.id}`,
  ],job.id);
  return this.store.committedHead({...h,lock_job_id:null},header,h.row_count,h.max_position,plan.next,h.schema_revision+1);
 }
 async cancel(workspace:string,id:string,jobId:string){
  const h=await this.store.head(workspace,id),job=await this.job(workspace,id,jobId);
  if(!['running','ready'].includes(job.state)||h.lock_job_id!==job.id||h.revision!==job.source_revision)throw invalid();
  await this.store.batch(h,[this.sql`DELETE FROM ee_table_type_values WHERE job_id=${job.id}`,
   this.sql`UPDATE ee_table_type_jobs SET state='cancelled' WHERE id=${job.id}`,
   this.sql`UPDATE ee_table_heads SET lock_job_id=NULL WHERE workspace_id=${workspace} AND table_id=${id}`],job.id);
 }
}
