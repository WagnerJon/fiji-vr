/** Conservative native-voxel maximum cells, including a one-voxel interpolation halo. */
export function accelerationShape(shape,cellSize=[32,32,8]){return shape.map((n,i)=>Math.ceil(n/cellSize[i]));}
export function blockMaximumGrid(data,shape,block,components,cellSize=[32,32,8]){
 const [width,height,depth]=shape,[sx,sy,sz]=cellSize,[gx,gy,gz]=accelerationShape(shape,cellSize);
 const maxima=new Uint8Array(gx*gy*gz);
 const first=Math.max(0,Math.floor((block.readStart-1)/sz)),last=Math.min(gz-1,Math.floor(block.readEnd/sz));
 for(let cz=first;cz<=last;cz++)for(let cy=0;cy<gy;cy++)for(let cx=0;cx<gx;cx++){
  const z0=Math.max(block.readStart,cz*sz-1),z1=Math.min(block.readEnd,(cz+1)*sz+1);
  const y0=Math.max(0,cy*sy-1),y1=Math.min(height,(cy+1)*sy+1),x0=Math.max(0,cx*sx-1),x1=Math.min(width,(cx+1)*sx+1);
  let peak=0;
  outer:for(let z=z0;z<z1;z++)for(let y=y0;y<y1;y++){
   let offset=(((z-block.readStart)*height+y)*width+x0)*components;
   for(let x=x0;x<x1;x++,offset+=components){
    let value=data[offset];if(components===4)value=Math.max(value,data[offset+1],data[offset+2]);
    if(value>peak)peak=value;if(peak===255)break outer;
   }
  }
  maxima[(cz*gy+cy)*gx+cx]=peak;
 }
 return maxima;
}
export function mergeMaxima(target,source){for(let i=0;i<target.length;i++)if(source[i]>target[i])target[i]=source[i];}

/** A transferred buffer returns after preprocessing, avoiding a large UI-thread scan. */
export class VolumePreprocessor{
 constructor(){this.worker=null;}
 async prepare(data,shape,block,components,signal,cellSize=[32,32,8]){
  if(signal.aborted){const error=new Error('Cancelled');error.name='AbortError';throw error;}
  if(typeof Worker==='undefined')return {data,maxima:blockMaximumGrid(data,shape,block,components,cellSize)};
  return new Promise((resolve,reject)=>{
   const worker=this.worker || new Worker(new URL('./acceleration-worker.js',import.meta.url),{type:'module'});this.worker=worker;
   const cleanup=()=>{signal.removeEventListener('abort',cancel);worker.onmessage=null;worker.onerror=null;};
   const cancel=()=>{cleanup();this.dispose();const error=new Error('Cancelled');error.name='AbortError';reject(error);};
   signal.addEventListener('abort',cancel,{once:true});
   worker.onmessage=event=>{cleanup();if(event.data.error)reject(new Error(event.data.error));else resolve(event.data);};
   worker.onerror=event=>{cleanup();this.dispose();reject(new Error(event.message || 'Volume acceleration preparation failed.'));};
   worker.postMessage({data,shape,block,components,cellSize},[data.buffer]);
  });
 }
 dispose(){this.worker?.terminate();this.worker=null;}
}
