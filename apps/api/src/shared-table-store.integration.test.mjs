import {test, expect} from 'bun:test';
import {createMemoRecord} from './memo-service.ts';
import {SharedTableStore,serializeSharedSnapshot} from './shared-table-store.ts';
import {SharedTableTypeChange} from './shared-table-type-change.ts';
import {serializeTableDocument, parseTableDocument, applyTableView} from '../../../packages/shared/src/table.ts';

import {fixture,environment} from '../../../scripts/experiments/shared-records/support.mjs';
import {Hono} from 'hono';
import {registerSharedCandidateRoutes} from '../../../scripts/experiments/shared-records/routes.ts';
import {createEdgeEverZip,parseEdgeEverZip,restoreEdgeEverZip} from '../../../packages/shared/src/backup-archive.ts';
import {getMemoDetail} from './memo-service.ts';
import {listNotebooks} from './notebook-service.ts';
import {docToText,markdownToDoc} from '@edgeever/shared';
import {sha256} from './hash-utils.ts';
const actor={actorType:'user',actorId:'test'};
async function pages(e,view=e.document.views[0]) {
  let cursor; const records=[];
  do {const page=await e.store.query('ws_default',e.memo.id,{view,cursor,includeTotal:true});records.push(...page.records);cursor=page.next;}while(cursor);
  return records;
}

test('legacy/named views, attachments, nulls and unusual field IDs survive shared JSON storage',async()=>{
  const document=fixture(10); document.fields.push({id:'a.b"quoted',name:'Quoted',type:'text'});
  for(const row of document.records)row.cells['a.b"quoted']='value\r\n😀';
  document.records[0].cells.files=[{resourceId:'resource-a',filename:'附件.pdf',mimeType:'application/pdf',byteSize:7}];
  const e=await environment(document);try{
    expect(e.document.records[0].cells.files).toEqual(document.records[0].cells.files);
    expect(await e.store.snapshot('ws_default',e.memo.id)).toEqual({...e.document,cellEncoding:'nullable-v1'});
    expect(await pages(e)).toEqual(e.document.records);
    const legacy={...e.document,schemaVersion:1,view:{filters:[],sort:null}};delete legacy.views;
    const second=await createMemoRecord(e.db,'ws_default',{notebookId:'nb_inbox',contentMarkdown:serializeTableDocument(legacy)},actor,'test');
    await e.store.initialize('ws_default',second.id,parseTableDocument(second.contentMarkdown));
    expect((await e.store.snapshot('ws_default',second.id)).view).toEqual(legacy.view);
    expect(e.sql.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ee_table_%'").all().every(row=>!row.name.includes(e.memo.id))).toBe(true);
  }finally{e.close();}
});

test('pagination matches existing filtering/sorting, counts only once and never crosses tables',async()=>{
  const e=await environment();try{
    for(const view of [e.document.views[0],e.document.views[1],{id:'temp',name:'Temp',match:'any',filters:[{fieldId:'amount',operator:'lt',value:3},{fieldId:'name',operator:'contains',value:'中文😀 11'}],sorts:[{fieldId:'status',direction:'asc'},{fieldId:'amount',direction:'desc'}]}]){
      expect(await pages(e,view)).toEqual(applyTableView(e.document,e.document.records,view));
    }
    const indexes=e.sql.query("SELECT sql FROM sqlite_master WHERE type='index' AND name LIKE 'ee_table_view_%'").all();
    await pages(e,{id:'temporary',name:'Temporary',match:'all',filters:[],sorts:[{fieldId:'name',direction:'desc'}]});
    expect(e.sql.query("SELECT sql FROM sqlite_master WHERE type='index' AND name LIKE 'ee_table_view_%'").all()).toEqual(indexes);
    await expect(e.store.query('other',e.memo.id,{view:e.document.views[0]})).rejects.toMatchObject({status:404});
  }finally{e.close();}
});

test('editing one record writes one history entry; stale offline drafts and cursors return 409',async()=>{
  const e=await environment();try{
    const first=await e.store.query('ws_default',e.memo.id,{view:e.document.views[0]});
    const before=e.sql.query('SELECT record_id,cells_json FROM ee_table_records WHERE table_id=? AND record_id<>? ORDER BY position').all(e.memo.id,'r2');
    await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:'r2',cells:{...e.document.records[2].cells,name:'offline edit'}}]});
    expect(e.sql.query('SELECT count(*) AS n FROM ee_table_versions WHERE table_id=? AND revision=2').get(e.memo.id).n).toBe(1);
    expect(e.sql.query('SELECT record_id,cells_json FROM ee_table_records WHERE table_id=? AND record_id<>? ORDER BY position').all(e.memo.id,'r2')).toEqual(before);
    await expect(e.store.apply('ws_default',e.memo.id,{expectedRevision:1,deletes:['r3']})).rejects.toMatchObject({status:409});
    await expect(e.store.query('ws_default',e.memo.id,{view:e.document.views[0],cursor:first.next})).rejects.toMatchObject({status:409});
    expect((await e.store.snapshot('ws_default',e.memo.id,1)).records).toEqual(e.document.records);
    expect((await e.store.search('ws_default',e.memo.id,'offline')).map(r=>r.id)).toEqual(['r2']);
    await expect(e.store.search('other',e.memo.id,'offline')).rejects.toMatchObject({status:404});
  }finally{e.close();}
});

test('append/delete and historical restore preserve ordering and metadata',async()=>{
  const e=await environment(fixture(8));try{
    await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:'new',cells:{name:'new',amount:77,status:'A',files:[]}}],deletes:['r2']});
    expect((await e.store.snapshot('ws_default',e.memo.id)).records.map(r=>r.id)).toEqual(['r0','r1','r3','r4','r5','r6','r7','new']);
    await e.store.restore('ws_default',e.memo.id,1,2);
    expect(await e.store.snapshot('ws_default',e.memo.id)).toEqual({...e.document,cellEncoding:'nullable-v1'});
    expect((await e.store.snapshot('ws_default',e.memo.id,2)).records.at(-1).id).toBe('new');
  }finally{e.close();}
});

test('transaction failure rolls back records, head, history and full-text projection',async()=>{
  const e=await environment(fixture(8));try{
    e.sql.exec("CREATE TRIGGER reject_history BEFORE INSERT ON ee_table_versions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    await expect(e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:'r0',cells:{...e.document.records[0].cells,name:'partial'}}]})).rejects.toThrow('injected failure');
    expect((await e.store.head('ws_default',e.memo.id)).revision).toBe(1);
    expect(await e.store.snapshot('ws_default',e.memo.id)).toEqual({...e.document,cellEncoding:'nullable-v1'});
    expect(await e.store.search('ws_default',e.memo.id,'partial')).toEqual([]);
  }finally{e.close();}
});

test('type preflight rejects bad values; confirmation cannot bypass conversion failures',async()=>{
  const d=fixture(3);d.records[0].cells.name='00123';d.records[1].cells.name='bad';d.records[2].cells.name='2';
  const e=await environment(d);try{
    const types=new SharedTableTypeChange(e.db);
    const preflight=await types.preflight('ws_default',e.memo.id,'name',{id:'name',name:'Name',type:'number'});
    expect(preflight.failures.map(r=>r.recordId)).toEqual(['r1']);
    expect(preflight.confirmations.map(r=>r.recordId)).toEqual(['r0']);
    await expect(types.start('ws_default',e.memo.id,preflight.id,true)).rejects.toMatchObject({status:409});
    expect(await e.store.snapshot('ws_default',e.memo.id)).toEqual({...e.document,cellEncoding:'nullable-v1'});
  }finally{e.close();}
});

test('batched type changes pause only this table; reads, cancel and stale preflights stay safe',async()=>{
  const d=fixture(123);for(const row of d.records)row.cells.name=String(row.cells.amount);
  const e=await environment(d);try{
    const types=new SharedTableTypeChange(e.db),target={id:'name',name:'Name',type:'number'};
    let p=await types.preflight('ws_default',e.memo.id,'name',target);
    await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:'r0',cells:{...d.records[0].cells,name:'3'}}]});
    await expect(types.start('ws_default',e.memo.id,p.id,true)).rejects.toMatchObject({status:409});
    p=await types.preflight('ws_default',e.memo.id,'name',target);const job=await types.start('ws_default',e.memo.id,p.id,true);
    await types.advance('ws_default',e.memo.id,job.id);
    await expect(e.store.apply('ws_default',e.memo.id,{expectedRevision:2,deletes:['r1']})).rejects.toMatchObject({code:'table_migration_in_progress'});
    expect((await e.store.snapshot('ws_default',e.memo.id)).fields[0].type).toBe('text');
    await types.cancel('ws_default',e.memo.id,job.id);
    expect((await e.store.head('ws_default',e.memo.id)).lockJobId).toBeNull();
    await e.store.apply('ws_default',e.memo.id,{expectedRevision:2,deletes:['r1']});
  }finally{e.close();}
});

test('cross-type history reads and restoration preserve each revision schema and original cells',async()=>{
  const d=fixture(75);for(const row of d.records)row.cells.name=String(row.cells.amount);
  d.records[0].cells.name='00123';
  const e=await environment(d);try{
    const types=new SharedTableTypeChange(e.db),p=await types.preflight('ws_default',e.memo.id,'name',{id:'name',name:'Number',type:'number'});
    await expect(types.start('ws_default',e.memo.id,p.id,false)).rejects.toMatchObject({code:'table_conversion_confirmation_required'});
    let job=await types.start('ws_default',e.memo.id,p.id,true);
    while(job.state!=='ready')job=await types.advance('ws_default',e.memo.id,job.id);
    await types.publish('ws_default',e.memo.id,job.id);
    const current=await e.store.snapshot('ws_default',e.memo.id);
    expect(current.fields[0].type).toBe('number');expect(current.records[0].cells.name).toBe(123);
    expect(await e.store.snapshot('ws_default',e.memo.id,1)).toEqual({...e.document,cellEncoding:'nullable-v1'});
    await e.store.restore('ws_default',e.memo.id,1,2);
    expect(await e.store.snapshot('ws_default',e.memo.id)).toEqual({...e.document,cellEncoding:'nullable-v1'});
    expect(await e.store.snapshot('ws_default',e.memo.id,2)).toEqual(current);
    expect(e.sql.query('SELECT count(*) AS n FROM ee_table_type_values').get().n).toBe(0);
  }finally{e.close();}
});

test('saved field indexes are maintained for view edits and actual plans use scoped numeric seeks',async()=>{
  const e=await environment(fixture(500));try{
    const plans=[];const prepare=e.db.prepare.bind(e.db);
    e.db.prepare=sql=>{const s=prepare(sql),bind=s.bind.bind(s);s.bind=(...args)=>{const b=bind(...args);if(sql.startsWith('SELECT r.position')){const explain=e.sql.query('EXPLAIN QUERY PLAN '+sql);try{plans.push(explain.all(...args));}finally{explain.finalize();}}return b;};return s;};
    expect(await pages(e,e.document.views[1])).toEqual(applyTableView(e.document,e.document.records,e.document.views[1]));
    expect(plans.map(p=>p.map(row=>row.detail))).toEqual(expect.arrayContaining([expect.arrayContaining([expect.stringContaining('ee_table_view_')])]));
    const before=e.sql.query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ee_table_view_%'").all();
    const header={...e.document,records:[],views:[e.document.views[0]]};
    await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,header});
    expect(before.length).toBeGreaterThan(0);
    expect(e.sql.query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ee_table_view_%'").all()).toEqual([]);
  }finally{e.close();}
});

test('local HTTP flow uses existing scope checks, isolates workspaces and preserves a stale offline draft',async()=>{
 const e=await environment();try{
  const app=new Hono();let workspace='ws_default',scopes=['read:memos','write:memos'];
  app.use('*',async(c,next)=>{c.set('auth',{kind:'agent',actorType:'agent',actorId:'test',workspaceId:workspace,scopes});await next();});
  app.onError((error,c)=>c.json({error:{code:error.code??'error',message:error.message}},error.status??500));
  registerSharedCandidateRoutes(app);
  const post=(path,body)=>app.request('/candidate/tables/'+e.memo.id+'/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},{storage:{db:e.db}});
  const page=await (await post('query',{view:e.document.views[0]})).json();expect(page.records).toHaveLength(50);
  const draft={expectedRevision:page.revision,puts:[{id:'r0',cells:{...page.records[0].cells,name:'offline local draft'}}]};
  await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:'r0',cells:{...page.records[0].cells,name:'other device'}}]});
  expect((await post('records',draft)).status).toBe(409);expect(draft.puts[0].cells.name).toBe('offline local draft');
  expect((await (await post('snapshot',{})).json()).records[0].cells.name).toBe('other device');
  scopes=['read:memos'];expect((await post('records',{...draft,expectedRevision:2})).status).toBe(403);
  workspace='other';expect((await post('query',{view:e.document.views[0]})).status).toBe(404);
 }finally{e.close();}
});

test('two concurrent record writers commit once and leave one consistent revision',async()=>{
 const e=await environment(fixture(8));try{
  const results=await Promise.allSettled(['one','two'].map(name=>e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:name,cells:{...e.document.records[0].cells,name}}]})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.find(r=>r.status==='rejected').reason.status).toBe(409);
  expect((await e.store.head('ws_default',e.memo.id)).row_count).toBe(9);
  expect(e.sql.query('SELECT count(*) AS n FROM ee_table_versions WHERE revision=2').get().n).toBe(1);
 }finally{e.close();}
});

test('a table hidden between preparation and commit cannot accept a pending write',async()=>{
 const e=await environment(fixture(8));try{
  const original=e.db.batch.bind(e.db);
  e.db.batch=statements=>{e.sql.query('UPDATE memos SET is_deleted=1 WHERE id=?').run(e.memo.id);return original(statements);};
  await expect(e.store.apply('ws_default',e.memo.id,{expectedRevision:1,deletes:['r0']})).rejects.toMatchObject({status:404});
  expect(e.sql.query('SELECT revision FROM ee_table_heads WHERE table_id=?').get(e.memo.id).revision).toBe(1);
  expect(e.sql.query('SELECT count(*) AS n FROM ee_table_records WHERE table_id=?').get(e.memo.id).n).toBe(8);
 }finally{e.close();}
});

test('existing ZIP v2 restores current data, cross-type histories and attachment bytes without the source',async()=>{
 const d=fixture(8);for(const row of d.records)row.cells.name=String(row.cells.amount);
 d.records[0].cells.name='00123';d.records[0].cells.files=[{resourceId:'resource-a',filename:'附件.pdf',mimeType:'application/pdf',byteSize:7}];
 const e=await environment(d),target=await environment(d,{initialize:false});let sourceClosed=false;
 try{
  const snapshots=[await e.store.snapshot('ws_default',e.memo.id)],types=new SharedTableTypeChange(e.db);
  expect(snapshots[0].records[0].cells.files).toEqual(d.records[0].cells.files);
  const p=await types.preflight('ws_default',e.memo.id,'name',{id:'name',name:'Number',type:'number'});
  let job=await types.start('ws_default',e.memo.id,p.id,true);while(job.state!=='ready')job=await types.advance('ws_default',e.memo.id,job.id);
  await types.publish('ws_default',e.memo.id,job.id);snapshots.push(await e.store.snapshot('ws_default',e.memo.id));
  await e.store.apply('ws_default',e.memo.id,{expectedRevision:2,puts:[{id:'r2',cells:{...snapshots[1].records[2].cells,name:99}},{id:'r3',cells:{...snapshots[1].records[3].cells,status:null}}]});
  snapshots.push(await e.store.snapshot('ws_default',e.memo.id));
  const original=await getMemoDetail(e.db,'ws_default',e.memo.id),bytes=Uint8Array.from([1,2,3,4,5,6,7]);
  const materialize=async(document,revision)=>{const contentMarkdown=serializeTableDocument(parseTableDocument(serializeSharedSnapshot(document))),contentJson=markdownToDoc(contentMarkdown);return {...original,revision,contentMarkdown,contentJson,contentText:docToText(contentJson),contentHash:await sha256(contentMarkdown)};};
  const current=await materialize(snapshots[2],3),revisions=[];
  for(let i=0;i<2;i++){const memo=await materialize(snapshots[i],i+1);revisions.push({id:'history-'+i,memoId:e.memo.id,revision:i+1,title:memo.title,tags:memo.tags,contentJson:memo.contentJson,contentMarkdown:memo.contentMarkdown,contentText:memo.contentText,contentHash:memo.contentHash,createdBy:'test',createdAt:memo.createdAt});}
  const resource={id:'resource-a',memoId:e.memo.id,originalMemoId:null,kind:'attachment',mimeType:'application/pdf',filename:'附件.pdf',byteSize:bytes.length,sha256:await sha256(bytes),width:null,height:null,createdAt:current.createdAt,updatedAt:current.updatedAt,url:'/api/v1/resources/resource-a/blob'};
  const notebooks=await listNotebooks(e.db,'ws_default');
  const archive=await createEdgeEverZip({listNotebooks:async()=>({notebooks}),listPrompts:async()=>({prompts:[]}),getPage:async()=>({memos:[current],resources:[resource],revisions,totalCount:1,nextOffset:null}),getResourceBlob:async()=>new Blob([bytes])},{edgeeverVersion:'candidate',buildId:'local-shared-records'});
  const parsed=await parseEdgeEverZip(archive);expect(parsed.manifest.formatVersion).toBe(2);expect(parsed.memos[0].revisions).toHaveLength(2);
  e.close();sourceClosed=true;
  const chunks=[];
  await restoreEdgeEverZip(parsed,{restoreNotebooks:async()=>{},restorePrompts:async()=>{},restoreMemos:async memos=>{
   const item=memos[0];await target.store.importSnapshots('ws_default',target.memo.id,[...item.revisions.sort((a,b)=>a.revision-b.revision).map(r=>parseTableDocument(r.contentMarkdown)),parseTableDocument(item.memo.contentMarkdown)]);
  },createResourceRestoreSink:async()=>({write:async chunk=>chunks.push(chunk),close:async()=>{},abort:async()=>{}})});
  for(let revision=1;revision<=3;revision++){
   const restored=await target.store.snapshot('ws_default',target.memo.id,revision);
   expect(restored).toEqual({...snapshots[revision-1],cellEncoding:'nullable-v1'});expect(restored.records[0].cells.files).toEqual(d.records[0].cells.files);
   expect(parseTableDocument(serializeTableDocument(restored))).toEqual(restored);
  }
  expect(new Uint8Array(await new Blob(chunks).arrayBuffer())).toEqual(bytes);
 }finally{if(!sourceClosed)e.close();target.close();}
});

test('online/offline Unicode, null, attachment and quoted-field queries preserve the agreed order',async()=>{
 const d=fixture(123),values=['A','a','中','文','😀','\uE000','Z','',null];
 d.fields.push({id:'a.b"quoted',name:'Quoted',type:'text'});
 for(let i=0;i<d.records.length;i++){
  d.records[i].cells.name=values[i%values.length];d.records[i].cells.amount=i%7===0?null:i%5;
  d.records[i].cells['a.b"quoted']='quoted value';
  if(i%10===0)d.records[i].cells.files=[{resourceId:'res'+i,filename:'附件😀.pdf',mimeType:'application/pdf',byteSize:7}];
 }
 const e=await environment(d);try{
  expect(e.document.records[0].cells.files).toEqual(d.records[0].cells.files);
  const base={id:'temp',name:'Temp',match:'all',filters:[],sorts:[]};
  for(const view of [{...base,sorts:[{fieldId:'name',direction:'asc'}]},
   {...base,sorts:[{fieldId:'amount',direction:'asc'},{fieldId:'status',direction:'desc'}]},
   {...base,sorts:[{fieldId:'files',direction:'desc'}]},
   {...base,filters:[{fieldId:'files',operator:'contains',value:'附件😀',legacy:true}]},
   {...base,filters:[{fieldId:'a.b"quoted',operator:'eq',value:'quoted value'}]}]){
   expect(await pages(e,view)).toEqual(applyTableView(e.document,e.document.records,view));
  }
 }finally{e.close();}
});
