export function median(values){const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];}
async function completedFrame(renderer,render,timer,image){
 const gl=renderer.getContext(),query=timer?gl.createQuery():null;
 try{
  gl.finish();if(query)gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
  const start=performance.now();
  try{render();}finally{if(query)gl.endQuery(timer.TIME_ELAPSED_EXT);}
  gl.finish();
  // Readback also forces cross-process browsers to complete GPU work.
  gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,image);
  let elapsed=performance.now()-start;
  if(query){
   let waits=0;while(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)){if(++waits>300)throw new Error('GPU timing did not complete. Try measuring again.');await new Promise(resolve=>requestAnimationFrame(resolve));}
   if(gl.getParameter(timer.GPU_DISJOINT_EXT))throw new Error('GPU timing was interrupted. Try measuring again.');
   elapsed=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;
  }
  return elapsed;
 }finally{if(query)gl.deleteQuery(query);}
}
/** Controlled A/B timing with the same frame and a native-resolution pixel comparison. */
export async function compareFrames(renderer,render,setAcceleration){
 const gl=renderer.getContext(),timer=gl.getExtension?.('EXT_disjoint_timer_query_webgl2'),measurements=[[],[]],reference=[];
 const images=[new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4),new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4)];
 for(let round=0;round<6;round++)for(const state of [0,1]){
  await new Promise(resolve=>requestAnimationFrame(resolve));setAcceleration(Boolean(state));
  const elapsed=await completedFrame(renderer,render,timer,images[state]);
  if(round>0)measurements[state].push(elapsed);else reference[state]=images[state].slice();
 }
 const baseline=median(measurements[0]),accelerated=median(measurements[1]);
 let differingBytes=0;for(let i=0;i<reference[0].length;i++)if(reference[0][i]!==reference[1][i])differingBytes++;
 return {baseline,accelerated,speedup:baseline/accelerated,differingBytes,metric:timer?'GPU frame':'Frame + readback'};
}
export class RenderInvalidation{
 constructor(){this.dirty=true;this.draws=0;}
 invalidate(){this.dirty=true;}
 shouldRender(immersive,playing){return this.dirty || immersive || playing;}
 rendered(){this.dirty=false;this.draws++;}
}
