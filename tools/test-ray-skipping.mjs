import assert from 'node:assert/strict';
import { blockMaximumGrid,accelerationShape } from '../src/main/resources/viewer/acceleration.js';
export function runRayChecks(){
 const shape=[41,35,19],cell=[8,8,4],extent=shape.map(n=>n/41),gridShape=accelerationShape(shape,cell),data=new Uint8Array(shape.reduce((a,b)=>a*b,1));
 let seed=91;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
 for(let i=0;i<data.length;i++)if(random()<.015)data[i]=Math.floor(random()*255)+1;
 const grid=blockMaximumGrid(data,shape,{readStart:0,readEnd:shape[2]},1,cell);
 const sample=uv=>{
  const point=uv.map((v,a)=>Math.max(0,Math.min(shape[a]-1,v*shape[a]-.5))),lo=point.map(Math.floor),f=point.map((v,a)=>v-lo[a]);let sum=0;
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++){const index=[x,y,z].map((d,a)=>Math.min(shape[a]-1,lo[a]+d));sum+=data[(index[2]*shape[1]+index[1])*shape[0]+index[0]]/255*(x?f[0]:1-f[0])*(y?f[1]:1-f[1])*(z?f[2]:1-f[2]);}
  return sum;
 };
 function march(eye,direction,threshold,clip,accelerate,transparent){
  const near=[],far=[];
  for(let a=0;a<3;a++){const low=-extent[a]/2,high=a===2?low+extent[a]*clip:extent[a]/2;const d=direction[a]<0?-Math.max(1e-6,-direction[a]):Math.max(1e-6,direction[a]);const u=(low-eye[a])/d,v=(high-eye[a])/d;near.push(Math.min(u,v));far.push(Math.max(u,v));}
  const start=Math.max(0,...near),stop=Math.min(...far);if(stop<=start)return 0;
  const rate=Math.max(...direction.map((d,a)=>Math.abs(d)*shape[a]/extent[a])),steps=Math.max(1,Math.ceil((stop-start)*rate)),step=(stop-start)/steps;
  let peak=0,alpha=0;
  for(let i=0;i<steps;i++){
   const uv=direction.map((d,a)=>(eye[a]+d*(start+(i+.5)*step))/extent[a]+.5);uv[1]=1-uv[1];
   if(accelerate){
    const c=uv.map((v,a)=>Math.max(0,Math.min(gridShape[a]-1,Math.floor(v*shape[a]/cell[a]))));
    const byte=grid[(c[2]*gridShape[1]+c[1])*gridShape[0]+c[0]],bound=byte===0?0:Math.min(1,byte/255+1e-6),signal=Math.max(0,(bound-threshold)/(1-threshold));
    if(bound<=threshold || (!transparent && signal<=peak)){
     let exit=1e20;
     for(let a=0;a<3;a++){const r=direction[a]/extent[a]*(a===1?-1:1);if(Math.abs(r)>1e-9){const boundary=r>=0?Math.min((c[a]+1)*cell[a],shape[a])/shape[a]:c[a]*cell[a]/shape[a];exit=Math.min(exit,Math.max(0,(boundary-uv[a])/r));}}
     const time=start+(i+.5)*step+exit,jump=Math.floor(Math.min(steps,(time-start)/step-.5))-1;i=Math.max(i,Math.min(steps-1,jump));continue;
    }
   }
   const signal=Math.max(0,(sample(uv)-threshold)/(1-threshold));
   if(transparent){const contribution=1-Math.exp(-signal*2*step*8);alpha+=(1-alpha)*contribution;}
   else peak=Math.max(peak,signal);
  }
  return transparent?alpha:peak;
 }
 for(let ray=0;ray<1200;ray++){
  const eye=[random()*4-2,random()*4-2,random()*4-2],target=extent.map(e=>(random()-.5)*e),direction=target.map((v,a)=>v-eye[a]),length=Math.hypot(...direction);direction.forEach((d,a)=>direction[a]=d/length);
  const threshold=[0,.08,.4][ray%3],clip=[1,.51][ray%2];
  for(const transparent of [false,true])assert.ok(Math.abs(march(eye,direction,threshold,clip,false,transparent)-march(eye,direction,threshold,clip,true,transparent))<1e-12,`Ray ${ray}, threshold ${threshold}, clip ${clip}, transparent ${transparent}`);
 }
 return ['1,200 seeded oblique rays: native and skipped MIP/transparency results agree, including clipping and interpolation'];
}
if(typeof process!=='undefined' && process.argv[1]?.endsWith('test-ray-skipping.mjs'))for(const name of runRayChecks())console.log(`PASS: ${name}`);
