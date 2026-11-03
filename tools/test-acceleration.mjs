import assert from 'node:assert/strict';
import { accelerationShape,blockMaximumGrid,mergeMaxima } from '../src/main/resources/viewer/acceleration.js';
import { RenderInvalidation,median } from '../src/main/resources/viewer/render-performance.js';
import { blockLayout } from '../src/main/resources/viewer/volume-blocks.js';
export async function runAccelerationChecks(){
 const passed=[];const check=(name,body)=>{body();passed.push(name);};
 check('maxima include all interpolation neighbors, including cells spanning texture blocks',()=>{
  const shape=[65,35,19],size=[32,32,8],grid=accelerationShape(shape,size),data=new Uint8Array(shape.reduce((a,b)=>a*b,1));
  let seed=7;for(let i=0;i<data.length;i++){seed=(1664525*seed+1013904223)>>>0;if((seed>>>24)<3)data[i]=(seed>>>16)&255;}
  const plan={blocks:[[0,5],[5,13],[13,19]].map(([start,end])=>{const readStart=Math.max(0,start-1),readEnd=Math.min(shape[2],end+1);return {readStart,readEnd,offset:readStart*shape[0]*shape[1],bytes:(readEnd-readStart)*shape[0]*shape[1]};})},maxima=new Uint8Array(grid.reduce((a,b)=>a*b,1));
  for(const block of plan.blocks)mergeMaxima(maxima,blockMaximumGrid(data.subarray(block.offset,block.offset+block.bytes),shape,block,1,size));
  for(let z=0;z<grid[2];z++)for(let y=0;y<grid[1];y++)for(let x=0;x<grid[0];x++){
   let expected=0;for(let k=Math.max(0,z*8-1);k<Math.min(shape[2],(z+1)*8+1);k++)for(let j=Math.max(0,y*32-1);j<Math.min(shape[1],(y+1)*32+1);j++)for(let i=Math.max(0,x*32-1);i<Math.min(shape[0],(x+1)*32+1);i++)expected=Math.max(expected,data[(k*shape[1]+j)*shape[0]+i]);
   assert.equal(maxima[(z*grid[1]+y)*grid[0]+x],expected);
  }
 });
 check('an isolated one-voxel feature at a cell boundary contributes to both neighbors',()=>{
  const shape=[64,64,16],data=new Uint8Array(64*64*16);data[(8*64+32)*64+32]=255;
  const maximum=blockMaximumGrid(data,shape,{readStart:0,readEnd:16},1);
  assert.equal(maximum.length,8);assert.ok([...maximum].every(value=>value===255));
 });
 check('RGB alpha does not make an empty cell appear occupied',()=>{
  const data=new Uint8Array(4*4*4*4);for(let i=3;i<data.length;i+=4)data[i]=255;
  assert.equal(blockMaximumGrid(data,[4,4,4],{readStart:0,readEnd:4},4)[0],0);
  data[0]=93;data[1]=47;assert.equal(blockMaximumGrid(data,[4,4,4],{readStart:0,readEnd:4},4)[0],93);
 });
 check('desktop redraws only changed views; XR and playback continue rendering',()=>{
  const state=new RenderInvalidation();assert.equal(state.shouldRender(false,false),true);state.rendered();assert.equal(state.shouldRender(false,false),false);
  assert.equal(state.shouldRender(true,false),true);assert.equal(state.shouldRender(false,true),true);state.invalidate();assert.equal(state.shouldRender(false,false),true);
  assert.equal(median([1,100,2,4,3]),3);
 });
 check('skipping leaves the original sample lattice and every nonzero sample intact',()=>{
  const shape=[64,64,64],data=new Uint8Array(64**3);for(let z=25;z<38;z++)for(let y=25;y<38;y++)for(let x=25;x<38;x++)data[(z*64+y)*64+x]=(x+y+z)%251+1;
  const maxima=blockMaximumGrid(data,shape,{readStart:0,readEnd:64},1,[8,8,8]);
  // Reference a selection of rays in both directions, with fractional starting offsets.
  for(let axis=0;axis<3;axis++)for(const sign of [-1,1])for(let row=0;row<64;row+=3)for(let column=0;column<64;column+=5){
   const samples=[];for(let i=0;i<64;i++){const p=[0,0,0];p[(axis+1)%3]=row;p[(axis+2)%3]=column;p[axis]=sign>0?i:63-i;samples.push(p);}
   let baseline=0,accelerated=0;
   for(const p of samples)baseline=Math.max(baseline,data[(p[2]*64+p[1])*64+p[0]]);
   for(let i=0;i<samples.length;i++){
    const p=samples[i],cell=p.map(v=>Math.floor(v/8)),upper=maxima[(cell[2]*8+cell[1])*8+cell[0]];
    if(upper===0){const limit=sign>0?(cell[axis]+1)*8:cell[axis]*8;const advance=sign>0?limit-p[axis]:p[axis]-limit;i+=Math.max(0,advance-2);continue;}
    accelerated=Math.max(accelerated,data[(p[2]*64+p[1])*64+p[0]]);
   }
   assert.equal(accelerated,baseline);
  }
 });
 return passed;
}
if(typeof process!=='undefined' && process.argv[1]?.endsWith('test-acceleration.mjs'))for(const name of await runAccelerationChecks())console.log(`PASS: ${name}`);
