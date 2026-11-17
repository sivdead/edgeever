import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {environment,fixture} from '../../../scripts/experiments/shared-records/support.mjs';
import {captureReads} from '../../../scripts/experiments/shared-records/query-metrics.mjs';
import {parseTableDocument,serializeTableDocument,updateTableCell,updateTableField,saveTableViews} from '../../../packages/shared/src/table.ts';
import {Hono} from 'hono';
import {registerSharedCandidateRoutes} from '../../../scripts/experiments/shared-records/routes.ts';

test('snapshot and query HTTP responses retain nulls through generic edit/export/reimport without manual markers',async()=>{
 const document=fixture(2);document.fields.push({id:'done',name:'Done',type:'checkbox'});
 document.records[0].cells=Object.fromEntries(document.fields.map(f=>[f.id,null]));
 const source=await environment(document,{initialize:false}),target=await environment(document,{initialize:false});
 try{
  await source.store.initialize('ws_default',source.memo.id,document);
  const app=new Hono();app.use('*',async(c,next)=>{c.set('auth',{kind:'agent',actorType:'agent',actorId:'test',workspaceId:'ws_default',scopes:['read:memos']});await next();});
  const post=(path,body)=>app.request('/candidate/tables/'+source.memo.id+'/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},{storage:{db:source.db}});
  registerSharedCandidateRoutes(app);
  const response=await post('snapshot',{});expect(response.status).toBe(200);let edited=await response.json();
  const pageResponse=await post('query',{view:document.views[0]});expect(pageResponse.status).toBe(200);const page=await pageResponse.json();
  expect(parseTableDocument(serializeTableDocument({...page.header,records:page.records})).records[0].cells).toEqual(document.records[0].cells);
  expect(edited.cellEncoding).toBe('nullable-v1');expect(page.header.cellEncoding).toBe('nullable-v1');
  edited=updateTableCell(edited,'r1','name','generic edit');
  edited=updateTableField(edited,'status',{name:'Renamed status'});
  edited=saveTableViews(edited,edited.views.map(v=>({...v,name:v.id==='default'?'Renamed view':v.name})));
  const imported=parseTableDocument(serializeTableDocument(edited));
  expect(imported.records[0].cells).toEqual(document.records[0].cells);
  expect(imported.cellEncoding).toBe('nullable-v1');
  await target.store.importSnapshots('ws_default',target.memo.id,[imported]);
  const restored=await target.store.snapshot('ws_default',target.memo.id);
  expect(restored).toEqual(imported);
  expect(parseTableDocument(serializeTableDocument(restored))).toEqual(imported);
 }finally{source.close();target.close();}
});

test('current snapshots reject writes or hiding after a page read while explicit history stays pinned',async()=>{
 for(const change of ['write','hide']){
  const e=await environment(fixture(8));try{
   const prepare=e.db.prepare.bind(e.db);let pending=true;
   e.db.prepare=sql=>{
    const statement=prepare(sql),bind=statement.bind.bind(statement);
    statement.bind=(...values)=>{
     const bound=bind(...values);
     if(sql.includes('cells_json')&&sql.includes('LIMIT 51')){
      const all=bound.all.bind(bound);bound.all=async(...args)=>{
       const rows=await all(...args);
       if(pending){pending=false;
        if(change==='write')await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,puts:[{id:'r0',cells:{...e.document.records[0].cells,name:'concurrent'}}]});
        else e.sql.query('UPDATE memos SET is_deleted=1 WHERE id=?').run(e.memo.id);
       }
       return rows;
      };
     }
     return bound;
    };
    return statement;
   };
   await expect(e.store.snapshot('ws_default',e.memo.id)).rejects.toMatchObject({status:change==='write'?409:404});
   if(change==='write')expect(await e.store.snapshot('ws_default',e.memo.id,1)).toEqual({...e.document,cellEncoding:'nullable-v1'});
  }finally{e.close();}
 }
});

test('explicit revision reads remain complete when a write commits between historical pages',async()=>{
 const e=await environment(fixture(123));try{
  const prepare=e.db.prepare.bind(e.db);let pending=true;
  e.db.prepare=sql=>{
   const statement=prepare(sql),bind=statement.bind.bind(statement);
   statement.bind=(...values)=>{
    const bound=bind(...values);
    if(sql.includes('cells_json')&&sql.includes('LIMIT 51')){
     const all=bound.all.bind(bound);bound.all=async(...args)=>{
      const rows=await all(...args);
      if(pending){pending=false;await e.store.apply('ws_default',e.memo.id,{expectedRevision:1,
       puts:[{id:'new',cells:{...e.document.records[0].cells,name:'new'}},{id:'r61',cells:{...e.document.records[61].cells,name:'changed'}}],deletes:['r60']});}
      return rows;
     };
    }
    return bound;
   };return statement;
  };
  expect(await e.store.snapshot('ws_default',e.memo.id,1)).toEqual({...e.document,cellEncoding:'nullable-v1'});
  const current=await e.store.snapshot('ws_default',e.memo.id);
  expect(current.records).toHaveLength(123);expect(current.records.find(r=>r.id==='r61').cells.name).toBe('changed');
  expect(current.records.some(r=>r.id==='r60')).toBe(false);expect(current.records.at(-1).id).toBe('new');
 }finally{e.close();}
});

test('complete current snapshots and current-document exports have bounded work across pages and accumulated history',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'shared-snapshot-budget-')),samples=[];
 try{
  for(const rows of [0,100,200,400]){
   const e=await environment(fixture(rows));let capture=null;
   captureReads(e.db,q=>{if(capture)capture.push(q);});
   let current=e.document,revision=1;
   try{
    for(const history of rows===200?[1,10,50]:[10]){
     while(revision<history){revision++;current={...current,records:current.records.map(r=>({...r,cells:{...r.cells,name:'revision '+revision+' '+r.id}}))};
      await e.store.apply('ws_default',e.memo.id,{expectedRevision:revision-1,puts:current.records});
     }
     const flows=[];
     for(const mode of ['current','current-export','historical','explicit-current']){
      capture=[];const snapshot=await e.store.snapshot('ws_default',e.memo.id,mode==='historical'?1:mode==='explicit-current'?history:undefined);const queries=capture;capture=null;
      expect(snapshot).toEqual({...(mode==='historical'?e.document:current),cellEncoding:'nullable-v1'});
      if(mode==='current-export')expect(parseTableDocument(serializeTableDocument(snapshot)).records).toEqual(current.records);
      flows.push({table:0,view:mode,queries});
     }
     const database=join(directory,rows+'-'+history+'.sqlite'),input=join(directory,rows+'-'+history+'.json');
     writeFileSync(database,e.sql.serialize());writeFileSync(input,JSON.stringify({flows,writes:[]}));
     const process=spawnSync('python3',['scripts/experiments/shared-records/sqlite-metrics.py',database,input],{encoding:'utf8'});
     expect(process.status,process.stderr).toBe(0);const metrics=JSON.parse(process.stdout).queryMetrics;
     samples.push({rows,history,currentVm:metrics[0].sqliteVmSteps,currentExportVm:metrics[1].sqliteVmSteps,historicalVm:metrics[2].sqliteVmSteps,explicitCurrentVm:metrics[3].sqliteVmSteps,
      queries:flows[0].queries.length,pages:flows[0].queries.filter(q=>q.sql.includes('LIMIT 51')).length,
      returnedRows:flows[0].queries.reduce((n,q)=>n+q.returned,0),readsHistory:flows[0].queries.some(q=>q.sql.includes('ee_table_versions')),
      counts:flows[0].queries.filter(q=>q.sql.includes('COUNT(*)')).length});
    }
   }finally{e.close();}
  }
  console.info('snapshot-budget '+JSON.stringify(samples));
  const byHistory=samples.filter(s=>s.rows===200);
  expect(byHistory.at(-1).currentVm).toBeLessThan(byHistory[0].currentVm*1.1);
  expect(byHistory.at(-1).currentExportVm).toBeLessThan(byHistory[0].currentExportVm*1.1);
  for(const sample of samples){
   expect(sample.readsHistory).toBe(false);expect(sample.counts).toBe(0);
   const pages=Math.max(1,Math.ceil(sample.rows/50));
   expect(sample.pages).toBeLessThanOrEqual(pages);expect(sample.queries).toBeLessThanOrEqual(pages*2+1);
   expect(sample.returnedRows).toBeLessThanOrEqual(sample.rows+pages*2+1);
  }
  const bySize=samples.filter(s=>s.history===10&&s.rows>0);
  for(let i=1;i<bySize.length;i++){
   expect(bySize[i].currentVm).toBeLessThan(bySize[i-1].currentVm*2.5);
   expect(bySize[i].currentExportVm).toBeLessThan(bySize[i-1].currentExportVm*2.5);
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});
