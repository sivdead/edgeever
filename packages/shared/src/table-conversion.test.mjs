import {test,expect} from 'bun:test';
import {convertFieldValue} from './table-conversion.ts';
const field=(type,options)=>({id:'fld_0',name:'Field 0',type,...(options?{options}:{})});
test('conversion rules preserve failures, precision, dates, options and empty checkbox values',()=>{
 const cases=[
  ['text','number','120','ok',120],['text','number','00123','confirmation',123],
  ['text','number','1.00','confirmation',1],['text','number','12元','failure'],
  ['text','number','1,200','failure'],['text','number','0x10','failure'],
  ['text','number','9007199254740993','failure'],['text','number','1.23456789012345678','failure'],
  ['text','number','1e-999','failure'],['text','number','Infinity','failure'],
  ['text','number','0.1','ok',0.1],['text','number','5e-324','ok',Number.MIN_VALUE],
  ['text','number','9007199254740992','ok',9007199254740992],
  ['text','date','2024-02-29','ok','2024-02-29'],['text','date','2025-02-29','failure'],
  ['text','date','11/12/2026','failure'],['text','date','2026-11-12T00:00:00Z','failure'],
  ['text','checkbox','true','ok',true],['text','checkbox','false','ok',false],
  ['text','checkbox','1','confirmation',true],['text','checkbox','yes','failure'],
  ['number','checkbox',0,'confirmation',false],['text','checkbox','','ok',null],
  ['text','checkbox',null,'ok',null],['checkbox','number',false,'confirmation',0],
  ['text','select','A','ok','A'],['text','select','a','failure'],
  ['attachment','text',[],'failure'],['text','attachment',null,'failure'],
 ];
 for(const [from,to,value,status,expected] of cases){const result=convertFieldValue(field(from),field(to,['A','B']),value);expect(result.status).toBe(status);if(status!=='failure')expect(result.value).toEqual(expected);}
 const attachments=[{resourceId:'r1',filename:'x.txt',mimeType:'text/plain',byteSize:2}];
 expect(convertFieldValue(field('attachment'),field('attachment'),attachments).value).toEqual(attachments);
});
