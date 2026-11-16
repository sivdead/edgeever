/** Strict field conversion shared by preflight and execution; never coerces failures to null. */
import type {TableField,TableCellValue} from "./table";

export const TYPE_CONVERSION_RULE_VERSION=1;
export type Conversion={status:'ok'|'confirmation';value:TableCellValue;reason:string}|{status:'failure';reason:string};
const failure=(reason:string):Conversion=>({status:'failure',reason});
// Canonical decimal coefficient/exponent without first rounding through Number.
function decimal(value:string){
 const m=/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
 if(!m||(!m[2]&&!m[3]))return null;
 let digits=(m[2]+(m[3]??'')).replace(/^0+/,'');
 if(!digits)return '0';
 let exponent=Number(m[4]??0)-(m[3]?.length??0);
 while(digits.endsWith('0')){digits=digits.slice(0,-1);exponent++;}
 return (m[1]==='-'?'-':'')+digits+'e'+exponent;
}
export function convertFieldValue(source:TableField,target:TableField,value:TableCellValue):Conversion{
 if(source.type!==target.type&&(source.type==='attachment'||target.type==='attachment'))return failure('Attachment conversion is not supported');
 if(value===null||value==='')return {status:'ok',value:value===''&&['number','checkbox'].includes(target.type)?null:value,reason:''};
 if(target.type==='attachment')return {status:'ok',value,reason:''};
 if(Array.isArray(value))return failure('Attachment conversion is not supported');
 let next:TableCellValue;
 if(target.type==='number'){
  if(typeof value==='boolean')next=Number(value);
  else if(typeof value==='number'){if(!Number.isFinite(value))return failure('Number is not finite');next=value;}
  else{
   const raw=value.trim(),n=Number(raw),d=decimal(raw);
   if(!d||!Number.isFinite(n))return failure('Use a finite decimal number without units or separators');
   if(d!==decimal(String(n)))return failure('Number cannot retain the supplied decimal value');
   next=n;
  }
 }else if(target.type==='checkbox'){
  if(value===true||value==='true'||value===1||value==='1')next=true;
  else if(value===false||value==='false'||value===0||value==='0')next=false;
  else return failure('Use true/false or 1/0');
 }else{
  next=String(value);
  if(target.type==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(next)||!Number.isFinite(Date.parse(next))||new Date(next).toISOString().slice(0,10)!==next))return failure('Use a valid YYYY-MM-DD date');
  if(target.type==='select'&&!(target.options??[]).includes(next))return failure('Value is not a target option');
 }
 const changed=String(next)!==String(value);
 return {status:changed?'confirmation':'ok',value:next,reason:changed?'Representation changes':''};
}
