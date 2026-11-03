import * as THREE from './vendor/three.module.js';
import { fetchByteRange } from './transfer.js';
import { accelerationShape, blockMaximumGrid, mergeMaxima, VolumePreprocessor } from './acceleration.js';

/** Native XY pixels and contiguous Z blocks; halos preserve interpolation at seams. */
export function blockLayout(shape, components, max3D, maxTextures, budget) {
  const [width,height,depth]=shape,planeBytes=width*height*components;
  if(width>max3D || height>max3D)throw new Error(`This browser’s 3D texture limit is ${max3D} pixels per axis, below the original ${width} × ${height} XY plane. No image reduction has been applied.`);
  const slots=Math.max(1,maxTextures-1);
  const target=Math.max(1,Math.floor(64*1024*1024/planeBytes)-2);
  const core=planeBytes*depth<=64*1024*1024 && depth<=max3D ? depth : Math.min(Math.max(1,max3D-2),Math.max(Math.ceil(depth/slots),target));
  const blocks=[];
  for(let start=0;start<depth;start+=core) {
    const end=Math.min(depth,start+core),readStart=Math.max(0,start-1),readEnd=Math.min(depth,end+1);
    blocks.push({start,end,readStart,readEnd,depth:readEnd-readStart,offset:readStart*planeBytes,bytes:(readEnd-readStart)*planeBytes});
  }
  if(blocks.length>slots)throw new Error('The original volume needs more 3D texture blocks than this browser can sample. No slices or reduced image have been substituted.');
  const gpuBytes=blocks.reduce((sum,block)=>sum+block.bytes,0);
  if(gpuBytes>budget)throw new Error(`The full-resolution volume needs ${Math.ceil(gpuBytes/1048576)} MiB including block borders. Increase “Volume memory” above, or use a PC VR browser with more available graphics memory. No slice-only fallback has been applied.`);
  return {blocks,gpuBytes,planeBytes};
}

export function volumeSamplingShader(blocks, depth) {
  const declarations=blocks.map((_,i)=>`uniform sampler3D volumeBlock${i};`).join('\n');
  const branches=blocks.map((block,i)=>`${i<blocks.length-1?`if(uv.z < ${(block.end/depth).toFixed(12)})`:''} {return texture(volumeBlock${i},vec3(uv.xy,(uv.z*${depth.toFixed(1)}-${block.readStart.toFixed(1)})/${block.depth.toFixed(1)})).rgb;}`).join('\n');
  return `${declarations}\nvec3 sampleVolume(vec3 uv){\n${branches}\n}`;
}

/** All blocks stay GPU resident; CPU staging holds only one block at a time. */
export async function loadVolumeBlocks(file, plan, shape, isRGB, renderer, signal, progress=()=>{}, fetcher=fetch) {
  const textures=[];let gridTexture=null;const context=renderer.getContext(),maxGridDepth=context.getParameter?context.getParameter(context.MAX_3D_TEXTURE_SIZE):2048;const cellSize=[32,32,Math.max(8,Math.ceil(shape[2]/maxGridDepth))],gridShape=accelerationShape(shape,cellSize),maxima=new Uint8Array(gridShape.reduce((a,b)=>a*b,1));const preprocessor=new VolumePreprocessor();let completed=0,wireCompleted=0;const transferBytes=plan.blocks.reduce((sum,block)=>sum+block.bytes,0);
  try {
    for(let index=0;index<plan.blocks.length;index++) {
      if(signal.aborted){const error=new Error('Cancelled');error.name='AbortError';throw error;}
      const block=plan.blocks[index];
      progress(index,plan.blocks.length,completed,transferBytes,wireCompleted);
      let blockWire=0;
      let data=await fetchByteRange(file,block.offset,block.bytes,signal,fetcher,{onProgress:(received,total,wire)=>{blockWire=wire;progress(index,plan.blocks.length,completed+received,transferBytes,wireCompleted+wire);}});
      wireCompleted+=blockWire;
      completed+=block.bytes;
      if(signal.aborted){const error=new Error('Cancelled');error.name='AbortError';throw error;}
      const prepared=await preprocessor.prepare(data,shape,block,isRGB?4:1,signal,cellSize);data=prepared.data;mergeMaxima(maxima,prepared.maxima);
      const texture=new THREE.Data3DTexture(data,shape[0],shape[1],block.depth);
      textures.push(texture);
      texture.format=isRGB?THREE.RGBAFormat:THREE.RedFormat;texture.type=THREE.UnsignedByteType;
      texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.unpackAlignment=1;texture.needsUpdate=true;
      const gl=renderer.getContext();
      renderer.initTexture(texture);
      if(gl.getError()!==gl.NO_ERROR || gl.isContextLost())throw new Error('The graphics device could not allocate the full-resolution volume. Lower the volume memory allowance or use PC VR. No downsampling was applied.');
      // Already uploaded; no full-volume CPU copy is retained. Context loss requires reopening.
      texture.image.data=null;
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(signal.aborted){const error=new Error('Cancelled');error.name='AbortError';throw error;}
    gridTexture=new THREE.Data3DTexture(maxima,...gridShape);gridTexture.format=THREE.RedFormat;gridTexture.type=THREE.UnsignedByteType;gridTexture.minFilter=gridTexture.magFilter=THREE.NearestFilter;gridTexture.unpackAlignment=1;gridTexture.needsUpdate=true;renderer.initTexture(gridTexture);
    const gl=renderer.getContext();if(gl.getError()!==gl.NO_ERROR||gl.isContextLost())throw new Error('The graphics device could not allocate the playback cache. Reduce Playback cache and reopen the viewer.');
    gridTexture.image.data=null;
    let disposed=false;return {textures,acceleration:{texture:gridTexture,shape:gridShape,cellSize},wireBytes:wireCompleted,dispose(){if(disposed)return;disposed=true;for(const texture of textures)texture.dispose();gridTexture.dispose();}};
  } catch(error) {for(const texture of textures)texture.dispose();gridTexture?.dispose();throw error;}finally{preprocessor.dispose();}
}
