import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {spawnSync} from 'node:child_process';
import {bindQueryValue} from './table-query-sql.ts';
import {tableContainsSql} from './table-query-contains.ts';

test('SQLite contains equals existing String.includes at UTF-16 boundaries and byte-alignment counterexamples',()=>{
 const db=new Database(':memory:');
 const check=(haystack,needle)=>{
  const values=[],bind=v=>bindQueryValue(values,v),source=bind(haystack),expected=bind(needle);
  const sql='SELECT '+tableContainsSql(source,needle,expected,bind)+' AS found';
  expect(Boolean(db.query(sql).get(...values).found)).toBe(haystack.includes(needle));
 };
 try{
  const samples=['😀','a😀b','\0😀\0','x\ud800y','\udc00\ud800','😀😀','\ud800\ud800\udc00','\udfff','\u000f\t\b\b\0','\u000f\b\b\b\0'];
  const needles=['\ud83d','\ude00','a\ud83d','\ude00b','\ude00\ud83d','\ud800','\udc00','\udfff','\udbff','x\ud800y','\0\ud83d','\ude00\0','😀','a',''];
  for(const haystack of samples)for(const needle of needles)check(haystack,needle);
  let state=71337;const random=n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n;};
  const alphabet=['a','b','\0','😀','\ud800','\udc00','\ud83d','\ude00','\udbff','\udfff','\u000f','\b','\t'];
  for(let i=0;i<1500;i++){
   let haystack='';for(let j=0,n=1+random(20);j<n;j++)haystack+=alphabet[random(alphabet.length)];
   const start=random(haystack.length),needle=i%2?haystack.slice(start,start+1+random(haystack.length-start)):alphabet[random(alphabet.length)]+alphabet[random(alphabet.length)];
   check(haystack,needle);
  }
 }finally{db.close();}
});

test('UTF-16 boundary contains respects D1 50-byte GLOB patterns for long legal needles',()=>{
 const examples=[
  ['a'.repeat(30)+'😀','a'.repeat(30)+'\ud83d'],
  ['😀'+'a'.repeat(1900),'\ude00'+'a'.repeat(1900)],
  ['😀'+'a'.repeat(1900)+'😀','\ude00'+'a'.repeat(1900)+'\ud83d'],
  ['😀'+'a'.repeat(1900)+'😃','\ude00'+'a'.repeat(1900)+'\ud83d'],
  ['😀'+'a'.repeat(1900)+'😀','\ude00'+'a'.repeat(1899)+'b\ud83d'],
 ];
 const cases=examples.map(([haystack,needle])=>{
  const values=[],bind=v=>bindQueryValue(values,v),source=bind(haystack),expected=bind(needle);
  return {sql:'SELECT '+tableContainsSql(source,needle,expected,bind)+' AS found',values,expected:haystack.includes(needle)};
 });
 const process=spawnSync('python3',['-c',`import sys,json,sqlite3
db=sqlite3.connect(':memory:')
db.setlimit(sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH,50)
for case in json.load(sys.stdin):
 assert bool(db.execute(case['sql'],case['values']).fetchone()[0]) == case['expected']
`],{input:JSON.stringify(cases),encoding:'utf8'});
 expect(process.status,process.stderr).toBe(0);
});
