import assert from 'node:assert/strict';
import { resolutionPlan, sampledSlice, fetchSlice } from '../src/main/resources/viewer/resolution.js';
import { FrameTimeline } from '../src/main/resources/viewer/timeline.js';
export async function runResolutionChecks(){
 const passed=[];const check=async(name,body)=>{await body();passed.push(name);};
 await check('2048 × 2048 images retain every pixel without a fixed 256/192 dimension cap',()=>{
  const shape=[2048,2048,1],plan=resolutionPlan(shape,1,2048,8192);assert.equal(plan.slices,false);assert.equal(plan.bytesPerFrame,2048*2048);assert.deepEqual(shape,[2048,2048,1]);
 });
 await check('large volumes remain full volumes unless slices are explicitly selected',()=>{
  const plan=resolutionPlan([2048,2048,100],1,2048,8192);assert.equal(plan.slices,false);assert.equal(plan.bytesPerFrame,2048*2048*100);
  const low3D=resolutionPlan([2048,2048,1],4,256,8192);assert.equal(low3D.slices,false);assert.equal(low3D.planeBytes,2048*2048*4);
 });
 await check('unsupported full-resolution planes give an explicit error',()=>{
  assert.throws(()=>resolutionPlan([16384,16384,1],4,2048,8192),/has not been reduced/);
 });
 await check('plane selection has exact voxel-center indices at original resolution',()=>{
  for(let i=0;i<100;i++)assert.equal(sampledSlice(i,100,100),i);
  assert.equal(sampledSlice(2047,2048,192),191);
 });
 await check('slice fetches request only the required bytes and reject whole-volume fallback',async()=>{
  let header;const data=await fetchSlice('volume.raw',20,4,undefined,async(file,options)=>{header=options.headers.Range;return {status:206,arrayBuffer:async()=>new Uint8Array([1,2,3,4]).buffer};});
  assert.equal(header,'bytes=80-83');assert.equal(data.length,4);
  await assert.rejects(fetchSlice('volume.raw',0,4,undefined,async()=>({status:200})),/download failed/);
 });
 await check('changing Z invalidates cached slices and rejects late replies',async()=>{
  let old;const applied=[];
  const time=new FrameTimeline({files:['volume.raw'],bytesPerFrame:1,onFrame:data=>applied.push(data[0]),fetchFrame:()=>new Promise(resolve=>old=resolve)});
  const stale=time.request(0);await time.reload(async()=>new Uint8Array([99]));old(new Uint8Array([1]));await stale;assert.deepEqual(applied,[99]);assert.equal(time.cache.size,0);assert.equal(time.displayed[0],99);
 });
 return passed;
}
if(typeof process!=='undefined' && process.argv[1]?.endsWith('test-resolution.mjs'))for(const name of await runResolutionChecks())console.log(`PASS: ${name}`);
