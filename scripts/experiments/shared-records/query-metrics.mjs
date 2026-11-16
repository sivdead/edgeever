/** Preserve the real adapter statement objects while observing returned reads. */
export function captureReads(db,consume){
 const prepare=db.prepare.bind(db);
 db.prepare=sql=>{
  const statement=prepare(sql),bind=statement.bind.bind(statement);
  statement.bind=(...bindings)=>{
   const bound=bind(...bindings);
   for(const method of ['first','all']){
    const read=bound[method].bind(bound);
    bound[method]=async(...args)=>{
     const result=await read(...args);
     consume({sql,bindings,returned:method==='all'?result.results.length:result===null?0:1});
     return result;
    };
   }
   return bound;
  };
  return statement;
 };
}
export const isRecordPage=sql=>sql.includes('SELECT r.position,');
