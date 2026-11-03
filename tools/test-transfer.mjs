import assert from 'node:assert/strict';
import { fetchByteRange } from '../src/main/resources/viewer/transfer.js';
export async function runTransferChecks(){
 const passed=[];const check=async(name,body)=>{await body();passed.push(name);};
 const bounds=options=>options.headers.Range.slice(6).split('-').map(Number);
 const response=(a,b)=>({status:206,headers:{get:name=>name==='Content-Range'?`bytes ${a}-${b}/10000`:null},arrayBuffer:async()=>Uint8Array.from({length:b-a+1},(_,i)=>(a+i)%256).buffer});
 await check('small parallel ranges reassemble byte-exact data at the correct offsets',async()=>{
  const requests=[],progress=[];
  const data=await fetchByteRange('volume.raw',123,31,undefined,async(file,options)=>{const [a,b]=bounds(options);requests.push([a,b]);return response(a,b);},{chunkBytes:8,onProgress:n=>progress.push(n)});
  assert.deepEqual([...data],Array.from({length:31},(_,i)=>(123+i)%256));assert.equal(requests.length,4);assert.ok(requests.every(([a,b])=>b-a+1<=8));assert.equal(progress.at(-1),31);
 });
 await check('a truncated body retries only the failed range',async()=>{
  const calls=new Map();
  const data=await fetchByteRange('volume.raw',0,16,undefined,async(file,options)=>{
   const [a,b]=bounds(options),n=(calls.get(a)||0)+1;calls.set(a,n);
   if(a===8 && n===1)return {status:206,arrayBuffer:async()=>new Uint8Array(2).buffer};
   return response(a,b);
  },{chunkBytes:8});assert.equal(data.length,16);assert.equal(calls.get(0),1);assert.equal(calls.get(8),2);
 });
 await check('network Content-Length/body errors and transient 502 responses are retried',async()=>{
  let count=0;
  const data=await fetchByteRange('volume.raw',0,4,undefined,async(file,options)=>{
   count++;if(count===1)return {status:206,arrayBuffer:async()=>{throw new TypeError('Content-Length exceeds response Body');}};
   if(count===2)return {status:502};return response(...bounds(options));
  });assert.equal(count,3);assert.equal(data.length,4);
 });
 await check('range identity is checked instead of accepting the wrong cached segment',async()=>{
  let calls=0;
  const data=await fetchByteRange('volume.raw',8,4,undefined,async(file,options)=>{calls++;return calls===1?response(0,3):response(...bounds(options));});
  assert.equal(calls,2);assert.deepEqual([...data],[8,9,10,11]);
 });
 await check('closed sessions fail immediately with a useful message',async()=>{
  let calls=0;
  await assert.rejects(fetchByteRange('volume.raw',0,8,undefined,async()=>{calls++;return {status:404};}),/no longer available/);assert.equal(calls,1);
 });
 await check('user cancellation stops retries and leaves no delayed transfer',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(fetchByteRange('volume.raw',0,8,controller.signal,async()=>{calls++;controller.abort();throw new TypeError('Failed to fetch');}),/cancelled/);assert.equal(calls,1);
 });
 return passed;
}
if(typeof process!=='undefined' && process.argv[1]?.endsWith('test-transfer.mjs'))for(const name of await runTransferChecks())console.log(`PASS: ${name}`);
