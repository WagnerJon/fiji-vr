import assert from 'node:assert/strict';
import { blockLayout, volumeSamplingShader, loadVolumeBlocks } from '../src/main/resources/viewer/volume-blocks.js';
import { FrameTimeline } from '../src/main/resources/viewer/timeline.js';
export async function runVolumeChecks(){
 const passed=[];const check=async(name,body)=>{await body();passed.push(name);};
 await check('2048-square large stacks retain the full volume with unlimited allocation',()=>{
  const plan=blockLayout([2048,2048,100],1,2048,16,Infinity);
  assert.ok(plan.blocks.length>1);assert.equal(plan.blocks[0].start,0);assert.equal(plan.blocks.at(-1).end,100);
  assert.ok(plan.gpuBytes>128*1024*1024);assert.ok(plan.blocks.length<=16);
  assert.throws(()=>blockLayout([2048,2048,100],1,2048,16,128*1024*1024),/needs/);
 });
 await check('block cores cover every voxel once and each seam has both interpolation neighbors',()=>{
  const plan=blockLayout([4,4,20],1,8,8,Infinity);let z=0;
  for(const block of plan.blocks){assert.equal(block.start,z);assert.ok(block.depth<=8);if(block.start>0)assert.equal(block.readStart,block.start-1);if(block.end<20)assert.equal(block.readEnd,block.end+1);z=block.end;}
  assert.equal(z,20);
  const shader=volumeSamplingShader(plan.blocks,20);assert.ok(shader.includes('volumeBlock0'));assert.equal((shader.match(/uniform sampler3D/g)||[]).length,plan.blocks.length);
  const sample=z=>{
   const uv=(z+.5)/20;const block=plan.blocks.find(b=>uv<b.end/20)||plan.blocks.at(-1);
   const local=(uv*20-block.readStart)/block.depth;
   return local*block.depth-.5+block.readStart;
  };
  for(let z=-.49;z<19.49;z+=.125)assert.ok(Math.abs(sample(z)-z)<1e-10);
 });
 await check('limits are actual texture limits, not a slice-only fallback or 4096-voxel software cap',()=>{
  assert.throws(()=>blockLayout([2048,2048,100],1,256,16,Infinity),/3D texture limit/);
  const long=blockLayout([2,2,6000],1,2048,16,Infinity);assert.equal(long.blocks.at(-1).end,6000);
 });
 await check('range loading covers every block, releases CPU staging and disposes GPU resources',async()=>{
  const plan=blockLayout([4,4,20],1,8,8,Infinity),ranges=[],uploads=[];let disposed=0;
  const renderer={getContext:()=>({getError:()=>0,NO_ERROR:0,isContextLost:()=>false}),initTexture:texture=>{uploads.push(texture.image.data.length);texture.addEventListener('dispose',()=>disposed++);}};
  const pack=await loadVolumeBlocks('volume.raw',plan,[4,4,20],false,renderer,new AbortController().signal,()=>{},async(file,options)=>{
   ranges.push(options.headers.Range);const match=options.headers.Range.match(/bytes=(\d+)-(\d+)/);return {status:206,arrayBuffer:async()=>new Uint8Array(Number(match[2])-Number(match[1])+1).buffer};
  });
  assert.equal(pack.textures.length,plan.blocks.length);assert.deepEqual(uploads,[...plan.blocks.map(b=>b.bytes),pack.acceleration.shape.reduce((a,b)=>a*b,1)]);assert.ok(pack.textures.every(t=>t.image.data===null));
  assert.deepEqual(ranges,plan.blocks.map(b=>`bytes=${b.offset}-${b.offset+b.bytes-1}`));pack.dispose();assert.equal(disposed,plan.blocks.length+1);pack.dispose();assert.equal(disposed,plan.blocks.length+1);
 });
 await check('cancelled volume requests dispose already uploaded blocks',async()=>{
  const plan=blockLayout([4,4,20],1,8,8,Infinity),controller=new AbortController();let disposed=0;
  const renderer={getContext:()=>({getError:()=>0,NO_ERROR:0,isContextLost:()=>false}),initTexture:texture=>{texture.addEventListener('dispose',()=>disposed++);controller.abort();}};
  await assert.rejects(loadVolumeBlocks('volume.raw',plan,[4,4,20],false,renderer,controller.signal,()=>{},async(file,options)=>{
   const match=options.headers.Range.match(/bytes=(\d+)-(\d+)/);return {status:206,arrayBuffer:async()=>new Uint8Array(Number(match[2])-Number(match[1])+1).buffer};
  }),/Cancelled/);assert.equal(disposed,1);
 });
 await check('late GPU volume loads are disposed and never replace a newer C/T selection',async()=>{
  let old,disposed=0;const shown=[];const pack=index=>({index,textures:[{}],dispose(){disposed++;}});
  const time=new FrameTimeline({files:['frame-1.raw','volume.raw'],bytesPerFrame:1,cacheLimit:0,validateFrame:p=>Array.isArray(p.textures),disposeFrame:p=>p.dispose(),onFrame:p=>shown.push(p.index),fetchFrame:file=>file==='frame-1.raw'?new Promise(resolve=>old=resolve):Promise.resolve(pack(2))});
  const stale=time.request(0);await time.request(1);old(pack(1));await stale;assert.deepEqual(shown,[2]);assert.equal(disposed,1);assert.equal(time.cache.size,0);
 });
 return passed;
}
if(typeof process!=='undefined' && process.argv[1]?.endsWith('test-volume-blocks.mjs'))for(const name of await runVolumeChecks())console.log(`PASS: ${name}`);
