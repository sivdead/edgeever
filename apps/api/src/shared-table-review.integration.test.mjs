import {test,expect} from 'bun:test';
import {environment,fixture} from '../../../scripts/experiments/shared-records/support.mjs';
import {SharedTableTypeChange} from './shared-table-type-change.ts';
import {coerceTableCell,applyTableView,parseTableDocument} from '../../../packages/shared/src/table.ts';
import {serializeSharedSnapshot} from './shared-table-store.ts';

test('text cursors preserve truncated and isolated surrogates and finish without repeating rows',async()=>{
 const document=fixture(123),truncated=coerceTableCell(document.fields[0],'x'+'😀'.repeat(1000));
 expect(truncated.charCodeAt(truncated.length-1)).toBe(0xd83d);
 const values=['a','\ud800','\ue000','\ufffd',truncated,'x\ud800y'];
 document.records.forEach((r,i)=>r.cells.name=values[i%values.length]);
 const e=await environment(document);try{
  for(const direction of ['asc','desc']){
   const view={id:'text',name:'Text',match:'all',filters:[],sorts:[{fieldId:'name',direction}]};
   let cursor;const records=[];
   for(let page=0;page<5;page++){
    const result=await e.store.query('ws_default',e.memo.id,{view,cursor});records.push(...result.records);
    expect(new Set(records.map(r=>r.id)).size).toBe(records.length);
    cursor=result.next;if(!cursor)break;
   }
   expect(cursor).toBeNull();expect(records).toEqual(applyTableView(e.document,e.document.records,view));
  }
  const view={id:'equal',name:'Equal',match:'all',filters:[{fieldId:'name',operator:'eq',value:'x\ud800y'}],sorts:[]};
  expect((await e.store.query('ws_default',e.memo.id,{view})).records).toEqual(applyTableView(e.document,e.document.records,view));
 }finally{e.close();}
});

test('null attachments retain null and behave as empty values in legacy filters',async()=>{
 const e=await environment(fixture(8));try{
  await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:'r0',cells:{...e.document.records[0].cells,files:null}}]});
  const document=await e.store.snapshot('ws_default',e.memo.id);expect(document.records[0].cells.files).toBeNull();
  for(const operator of ['contains','eq','empty','notEmpty']){
   const view={id:'legacy',name:'Legacy',match:'all',filters:[{fieldId:'files',operator,value:'pdf',legacy:true}],sorts:[]};
   expect((await e.store.query('ws_default',e.memo.id,{view})).records).toEqual(applyTableView(document,document.records,view));
  }
  // Reproduce the exact projection written by the preceding candidate.
  e.sql.query("UPDATE ee_table_records SET normalized_json=json_set(normalized_json,'$.files','') WHERE record_id='r0'").run();
  for(const operator of ['contains','eq']){
   const view={id:'old',name:'Old',match:'all',filters:[{fieldId:'files',operator,value:'pdf',legacy:true}],sorts:[]};
   expect((await e.store.query('ws_default',e.memo.id,{view})).records).toEqual([]);
  }
 }finally{e.close();}
});

test('opaque record/field identities preserve accepted UTF-16 through edits, type jobs and history',async()=>{
 const document=fixture(3),field='f\ud800x',record='x\ud800y';document.fields[0].id=field;
 document.records.forEach((r,i)=>{r.cells[field]=String(i);delete r.cells.name;});document.records[0].id=record;
 const e=await environment(document);try{
  expect((await e.store.query('ws_default',e.memo.id,{view:e.document.views[0]})).records[0].id).toBe(record);
  await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:record,cells:{...document.records[0].cells,[field]:'42'}}]});
  expect((await e.store.head('ws_default',e.memo.id)).row_count).toBe(3);
  expect(e.sql.query('SELECT count(*) AS n FROM ee_table_records').get().n).toBe(3);
  const types=new SharedTableTypeChange(e.db),p=await types.preflight('ws_default',e.memo.id,field,{id:field,name:'Number',type:'number'});
  let job=await types.start('ws_default',e.memo.id,p.id,true);while(job.state!=='ready')job=await types.advance('ws_default',e.memo.id,job.id);
  await types.publish('ws_default',e.memo.id,job.id);
  expect((await e.store.snapshot('ws_default',e.memo.id)).records[0]).toEqual({id:record,cells:{...document.records[0].cells,[field]:42}});
  await e.store.restore('ws_default',e.memo.id,1,3);expect(await e.store.snapshot('ws_default',e.memo.id)).toEqual({...e.document,cellEncoding:'nullable-v1'});
 }finally{e.close();}
});

test('prototype-named field IDs preserve own cells and missing values through snapshot export',async()=>{
 for(const type of ['text','attachment']){
  const document=fixture(2),value=type==='text'?'kept value':[{resourceId:'resource-a',filename:'kept.txt',mimeType:'text/plain',byteSize:5}];
  document.fields=[{id:'__proto__',name:'Prototype',type},{id:'constructor',name:'Constructor',type:'text'},{id:'toString',name:'To string',type:'text'}];
  document.views=[document.views[0]];
  document.records[0].cells=Object.fromEntries([['__proto__',value],['constructor','kept constructor'],['toString','kept text']]);
  document.records[1].cells={};
  const expected={...document,records:[document.records[0],{id:'r1',cells:Object.fromEntries([['__proto__',type==='text'?'':[]],['constructor',''],['toString','']])}]};
  const e=await environment(document,{initialize:false});try{
   expect(e.document).toEqual(expected);
   expect(Object.entries(e.document.records[1].cells)).toEqual(Object.entries(expected.records[1].cells));
   await e.store.initialize('ws_default',e.memo.id,document);
   const snapshot=await e.store.snapshot('ws_default',e.memo.id);
   expect(Object.hasOwn(snapshot.records[0].cells,'__proto__')).toBe(true);
   expect(snapshot).toEqual({...expected,cellEncoding:'nullable-v1'});
   expect(parseTableDocument(serializeSharedSnapshot(snapshot))).toEqual({...expected,cellEncoding:'nullable-v1'});
   await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:'r0',cells:{}}]});
   expect((await e.store.snapshot('ws_default',e.memo.id)).records[0].cells).toEqual(expected.records[1].cells);
  }finally{e.close();}
 }
});

test('question marks inside imported table IDs are data rather than SQL parameter placeholders',async()=>{
 const e=await environment(fixture(3));try{
  const fields=e.sql.query('PRAGMA table_info(memos)').all().map(f=>f.name);
  const row=e.sql.query('SELECT * FROM memos WHERE id=?').get(e.memo.id);row.id='imported?table';
  e.sql.query('INSERT INTO memos('+fields.map(f=>'"'+f+'"').join(',')+') VALUES('+fields.map(()=>'?').join(',')+')').run(...fields.map(f=>row[f]));
  await e.store.initialize('ws_default',row.id,e.document);
  for(const view of e.document.views){
   const page=await e.store.query('ws_default',row.id,{view,includeTotal:true});
   expect(page.records).toEqual(applyTableView(e.document,e.document.records,view));
   expect(page.matchedRowCount).toBe(applyTableView(e.document,e.document.records,view).length);
  }
 }finally{e.close();}
});

test('saved select indexes accept NUL and isolated-surrogate option text without narrowing inputs',async()=>{
 const document=fixture(123);document.fields[2].options=['A\0B','x\ud800y'];
 document.views[1]={id:'status',name:'Status',match:'all',filters:[],sorts:[{fieldId:'status',direction:'asc'}]};
 document.records.forEach((r,i)=>r.cells.status=document.fields[2].options[i%2]);
 const e=await environment(document);try{
  const view=e.document.views[1],records=[];let cursor;
  do{const page=await e.store.query('ws_default',e.memo.id,{view,cursor});records.push(...page.records);cursor=page.next;}while(cursor);
  expect(records).toEqual(applyTableView(e.document,e.document.records,view));
 }finally{e.close();}
});

test('initialization rechecks visibility inside the transaction and leaves no candidate on failure',async()=>{
 const e=await environment(fixture(8),{initialize:false});try{
  const batch=e.db.batch.bind(e.db);e.db.batch=statements=>{e.sql.query('UPDATE memos SET is_deleted=1 WHERE id=?').run(e.memo.id);return batch(statements);};
  await expect(e.store.initialize('ws_default',e.memo.id,e.document)).rejects.toMatchObject({status:404});
  expect(e.sql.query('SELECT count(*) AS n FROM ee_table_heads').get().n).toBe(0);
  expect(e.sql.query('SELECT count(*) AS n FROM ee_table_records').get().n).toBe(0);
 }finally{e.close();}
});

test('a cancelled type conversion cannot be revived by an earlier pending start',async()=>{
 const document=fixture(8);document.records.forEach(r=>r.cells.name='123');
 const e=await environment(document);try{
  const types=new SharedTableTypeChange(e.db),p=await types.preflight('ws_default',e.memo.id,'name',{id:'name',name:'Name',type:'number'});
  const batch=e.db.batch.bind(e.db);let intercept=true;
  e.db.batch=async statements=>{
   if(intercept){intercept=false;await types.start('ws_default',e.memo.id,p.id,true);await types.cancel('ws_default',e.memo.id,p.id);}
   return batch(statements);
  };
  await expect(types.start('ws_default',e.memo.id,p.id,true)).rejects.toMatchObject({status:409});
  expect(e.sql.query('SELECT state FROM ee_table_type_jobs WHERE id=?').get(p.id).state).toBe('cancelled');
  expect((await e.store.head('ws_default',e.memo.id)).lockJobId).toBeNull();
 }finally{e.close();}
});

test('field names and field order refresh search projections without rewriting cells or history',async()=>{
 const document=fixture(123);document.fields[0].name='BeforeCaption';
 const e=await environment(document);try{
  const cells=e.sql.query('SELECT record_id,cells_json FROM ee_table_records ORDER BY position').all();
  const header={...e.document,records:[],fields:e.document.fields.map(f=>({...f,name:f.id==='name'?'NewCaption':f.name})).reverse()};
  await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,header});
  expect(await e.store.search('ws_default',e.memo.id,'BeforeCaption')).toEqual([]);
  expect(await e.store.search('ws_default',e.memo.id,'NewCaption')).toHaveLength(123);
  expect(e.sql.query('SELECT record_id,cells_json FROM ee_table_records ORDER BY position').all()).toEqual(cells);
  expect(e.sql.query('SELECT count(*) AS n FROM ee_table_versions WHERE revision=2').get().n).toBe(0);
 }finally{e.close();}
});

test('record IDs retain the existing parser bound and metadata reorder uses exact identity',async()=>{
 const e=await environment(fixture(8));try{
  await expect(e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:'x'.repeat(81),cells:e.document.records[0].cells}]})).rejects.toMatchObject({status:400});
  expect((await e.store.head('ws_default',e.memo.id)).revision).toBe(1);
  expect(parseTableDocument(serializeSharedSnapshot(await e.store.snapshot('ws_default',e.memo.id)))).not.toBeNull();
 }finally{e.close();}
 const d=fixture(3);d.fields=[{id:'é',name:'Composed',type:'text'},{id:'e\u0301',name:'Decomposed',type:'text'}];
 d.views=[d.views[0]];d.records.forEach(r=>r.cells={'é':'one','e\u0301':'two'});
 const f=await environment(d);try{
  await f.store.apply('ws_default',f.memo.id,{expectedRevision:1,header:{...f.document,records:[],fields:[...f.document.fields].reverse()}});
  expect((await f.store.snapshot('ws_default',f.memo.id)).fields.map(v=>v.id)).toEqual(['e\u0301','é']);
 }finally{f.close();}
});

test('snapshot import is atomic for invalid later input and injected later database failure',async()=>{
 const initial=fixture(8),tooLarge=fixture(2001);
 for(const failure of ['input','database']){
  const e=await environment(initial,{initialize:false});try{
   if(failure==='database')e.sql.exec("CREATE TRIGGER reject_import BEFORE INSERT ON ee_table_versions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'injected import failure'); END");
   const next=failure==='input'?tooLarge:{...initial,records:initial.records.slice(0,3)};
   await expect(e.store.importSnapshots('ws_default',e.memo.id,[initial,next])).rejects.toThrow();
   expect(e.sql.query('SELECT count(*) AS n FROM ee_table_heads').get().n).toBe(0);
   if(failure==='database')e.sql.exec('DROP TRIGGER reject_import');
   await e.store.importSnapshots('ws_default',e.memo.id,[initial]);
   expect(await e.store.snapshot('ws_default',e.memo.id)).toEqual({...initial,cellEncoding:'nullable-v1'});
  }finally{e.close();}
 }
});

test('large legal type diagnostics retain full values without exceeding the existing D1 state-cell boundary',async()=>{
 const e=await environment(fixture(0));try{
  const rows=fixture(1000).records.map(r=>({...r,cells:{...r.cells,name:'0'.repeat(2000)}}));
  await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:rows});
  const types=new SharedTableTypeChange(e.db),p=await types.preflight('ws_default',e.memo.id,'name',{id:'name',name:'Name',type:'number'});
  expect(p.failures).toEqual([]);expect(p.confirmations).toHaveLength(1000);expect(p.confirmations[0].before).toBe('0'.repeat(2000));
  const state=e.sql.query('SELECT length(CAST(confirmations_json AS BLOB)) AS bytes FROM ee_table_type_jobs WHERE id=?').get(p.id);
  expect(state.bytes).toBeLessThan(2000000);
  await expect(types.start('ws_default',e.memo.id,p.id,false)).rejects.toMatchObject({code:'table_conversion_confirmation_required'});
  const job=await types.start('ws_default',e.memo.id,p.id,true);await types.cancel('ws_default',e.memo.id,job.id);
 }finally{e.close();}
});

test('a write acknowledgement reports its committed revision while a later writer advances the table',async()=>{
 const e=await environment(fixture(8));try{
  const batch=e.db.batch.bind(e.db);let later=true;
  e.db.batch=async statements=>{
   const result=await batch(statements);
   if(later){later=false;await e.store.apply('ws_default',e.memo.id,{expectedRevision:2,puts:[{id:'r0',cells:{...e.document.records[0].cells,name:'later device'}}]});}
   return result;
  };
  const acknowledgement=await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:'r0',cells:{...e.document.records[0].cells,name:'this device'}}]});
  expect(acknowledgement.revision).toBe(2);expect((await e.store.head('ws_default',e.memo.id)).revision).toBe(3);
  expect((await e.store.snapshot('ws_default',e.memo.id,2)).records[0].cells.name).toBe('this device');
 }finally{e.close();}
});

test('contains retains existing UTF-16 boundary matching for text and attachment filenames',async()=>{
 const values=['😀','😃','a😀z','\ud83d','\ude00','\ud83dX\ude00','a\0😀z','x\ud800y','*?[😀','?\t\b\v\0'];
 const document=fixture(123);document.records.forEach((r,i)=>{
  r.cells.name=values[i%values.length];r.cells.files=[{resourceId:'res'+i,filename:values[i%values.length],mimeType:'text/plain',byteSize:5}];
 });
 const e=await environment(document);try{
  expect(e.document.records[0].cells.files).toEqual(document.records[0].cells.files);
  for(const value of ['\ud83d','\ude00','\ude00z','a\ud83d','\ude00\ud83d','\ud83dX\ude00','\0\ud83d','a\0\ud83d','*?[\ud83d','\ud800']){
   for(const [fieldId,operator,legacy] of [['name','contains',false],['name','notContains',false],['files','contains',true]]){
    const view={id:'utf16',name:'UTF16',match:'all',filters:[{fieldId,operator,value,...(legacy?{legacy:true}:{})}],sorts:[]};
    const expected=applyTableView(e.document,e.document.records,view),records=[];let cursor;
    if(fieldId==='files'&&value==='\ud83d')expect(expected.length).toBeGreaterThan(0);
    do{const page=await e.store.query('ws_default',e.memo.id,{view,cursor,includeTotal:true});records.push(...page.records);cursor=page.next;}while(cursor);
    expect(records.map(r=>r.id)).toEqual(expected.map(r=>r.id));
   }
  }
 }finally{e.close();}
});
