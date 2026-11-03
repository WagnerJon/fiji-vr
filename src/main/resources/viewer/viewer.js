import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VolumeManipulation, readXRInputs } from './interaction.js';
import { FrameTimeline, TimeAxisInput } from './timeline.js';
import { DimensionPanel } from './dimension-panel.js';
import { resolutionPlan, sampledSlice, fetchSlice } from './resolution.js';
import { blockLayout, volumeSamplingShader, loadVolumeBlocks } from './volume-blocks.js';
import { RenderInvalidation, compareFrames } from './render-performance.js';
import { vertexShader, fragmentShader } from './volume-shader.js';
import { ImageTransport } from './local-transfer.js';

const $ = id => document.getElementById(id);
const status = message => { $('status').textContent = message; };
const transport=new ImageTransport({baseURL:location.href,onState:connection=>{
  $('connection-status').textContent=connection.message;
  $('local-wifi').hidden=connection.onComputer||connection.onLAN;
  $('local-wifi').disabled=connection.busy||connection.onComputer||connection.onLAN||!connection.candidates.length;
  $('relay-transfer').hidden=connection.route!=='wifi'||connection.onLAN;
}});
function restartPendingTransfer(){
  if(!timeline)return;
  if(timeline.loading)void timeline.reload();
  else {timeline.setPrefetchEnabled(false);timeline.setPrefetchEnabled(!document.hidden&&!benchmarking);}
}
$('local-wifi').onclick=async()=>{if(await transport.connect())restartPendingTransfer();};
$('relay-transfer').onclick=()=>{transport.useRelay();restartPendingTransfer();};
const invalidation=new RenderInvalidation();let benchmarking=false;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(devicePixelRatio);
function viewport() {
  const wide = innerWidth >= 900;
  const left = wide ? 350 : 0, top = wide ? 0 : Math.min(300, innerHeight * 0.42);
  const width = innerWidth - left, height = Math.max(100, innerHeight - top - 150);
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.left = `${left}px`; renderer.domElement.style.top = `${top}px`;
  renderer.setSize(width, height);
  invalidation.invalidate();
  camera.aspect = width / height; camera.updateProjectionMatrix();
}
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0, 1.4, 0.6);
viewport();
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1.4, -0.8);
orbit.update();
orbit.addEventListener('change',()=>invalidation.invalidate());
const object = new THREE.Group();
scene.add(object);
let floorSpace = true;
function reset() { invalidation.invalidate();object.position.set(0, floorSpace ? 1.4 : 0, -0.8); object.rotation.set(0, 0, 0); object.scale.setScalar(renderer.xr.isPresenting ? 0.65 : 0.95); }
reset();
$('reset').onclick = () => { manipulation.clear(); reset(); };
const manipulation = new VolumeManipulation(object);
const squeezeSources = new Set();
const pinchStates = new Map();
const markers = [0x79dbc6, 0xf1bd7a].map(color => {
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 }));
  marker.visible = false; marker.renderOrder = 10; scene.add(marker); return marker;
});
const viewQuaternion = new THREE.Quaternion();
let timeline = null;
const timeInput = new TimeAxisInput();
let dimensionPanel = null;
function clearInteraction() {
  manipulation.clear(); squeezeSources.clear(); pinchStates.clear(); timeInput.clear();
  dimensionPanel?.clear();
  markers.forEach(marker => { marker.visible = false; });
}
renderer.xr.addEventListener('sessionend', () => {
  clearInteraction(); dimensionPanel?.resetPlacement();timeline?.setPlaying(false); floorSpace = true; reset(); orbit.enabled = true; viewport();
});

async function enter(mode) {
  try {
    const session = await navigator.xr.requestSession(mode, { optionalFeatures: ['local-floor', 'hand-tracking'] });
    clearInteraction();dimensionPanel?.resetPlacement();
    session.addEventListener('squeezestart', event => squeezeSources.add(event.inputSource));
    session.addEventListener('squeezeend', event => squeezeSources.delete(event.inputSource));
    session.addEventListener('inputsourceschange', event => {
      for (const source of event.removed) { squeezeSources.delete(source); pinchStates.delete(source); }
    });
    session.addEventListener('visibilitychange', () => {
      if (session.visibilityState !== 'visible') { clearInteraction(); timeline?.setPlaying(false); }
    });
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    try { renderer.xr.setReferenceSpace(await session.requestReferenceSpace('local-floor')); floorSpace = true; }
    catch { floorSpace = false; }
    reset();
    renderer.domElement.style.left = '0'; renderer.domElement.style.top = '0';
    orbit.enabled = false;
  } catch (error) { status(`${mode}: ${error.message}`); }
}
async function support() {
  if (!isSecureContext) return status('Headset mode needs trusted HTTPS or localhost. Desktop preview remains available.');
  if (!navigator.xr) return status('WebXR is unavailable in this browser. Desktop preview is available.');
  for (const [id, mode] of [['vr', 'immersive-vr'], ['ar', 'immersive-ar']]) {
    const supported = await navigator.xr.isSessionSupported(mode);
    $(id).disabled = !supported;
    $(id).onclick = () => enter(mode);
  }
  status('Enabled buttons indicate the immersive modes this browser supports.');
}

let uniforms;
async function load() {
  await transport.initialize();
  const metaResponse = await fetch('volume.json');
  if (!metaResponse.ok) throw new Error('This viewing session has ended. Open the image in Fiji and choose View in VR / AR again.');
  const meta = await metaResponse.json();
  const isRGB = meta.encoding === 'rgba8';
  if (meta.encoding !== 'uint8' && !isRGB) throw new Error('Unsupported image format.');
  const gl=renderer.getContext();
  const query=new URLSearchParams(location.search),memory=query.get('memory') || 'unlimited';
  const budget=['512','1024','2048'].includes(memory)?Number(memory)*1024*1024:Infinity;
  $('volume-memory').value=Number.isFinite(budget)?memory:'unlimited';
  $('volume-memory').onchange=()=>{const url=new URL(location.href);url.searchParams.set('memory',$('volume-memory').value);location.assign(url);};
  const plan=resolutionPlan(meta.shape,isRGB?4:1,gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),gl.getParameter(gl.MAX_TEXTURE_SIZE),budget,query.get('mode')==='slices');
  $('original-slices').textContent=plan.slices?'Show full-resolution volume':'Use full-resolution slices';
  $('original-slices').onclick=()=>{const url=new URL(location.href);if(plan.slices)url.searchParams.delete('mode');else url.searchParams.set('mode','slices');location.assign(url);};
  const layout=plan.slices?null:blockLayout(meta.shape,isRGB?4:1,gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),budget);
  const byteCount=plan.slices?plan.planeBytes:1;
  const data = new Uint8Array(plan.slices?byteCount:1);
  let hasVolume=false;
  const channels = meta.channels || [{name: 'Channel 1', color: '#ffffff', frames: meta.frames || ['volume.raw']}];
  let selectedChannel = Math.max(0, Math.min(channels.length-1, (meta.channel || 1)-1));
  const sourceSlices = meta.sourceSlices || meta.shape[2];
  let selectedZ = Math.max(0, Math.min(sourceSlices-1, (meta.slice || 1)-1));
  let displayedZ=selectedZ;
  let sliceOnly = plan.slices || meta.shape[2]===1;
  if (!Array.isArray(meta.spacing) || meta.spacing.length !== 3 || !meta.spacing.every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid voxel spacing.');
  const texture = plan.slices ? new THREE.DataTexture(data,meta.shape[0],meta.shape[1]) : new THREE.Data3DTexture(data,1,1,1);
  const blockUniforms=layout?Object.fromEntries(layout.blocks.map((block,index)=>[`volumeBlock${index}`,{value:texture}])):{};
  const sampleCode=layout?volumeSamplingShader(layout.blocks,meta.shape[2]):'vec3 sampleVolume(vec3 uv){return vec3(0.0);}';
  texture.format = isRGB ? THREE.RGBAFormat : THREE.RedFormat; texture.type = THREE.UnsignedByteType;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1; texture.needsUpdate = true;
  const lengths = meta.shape.map((n, i) => n * meta.spacing[i]);
  const extent = new THREE.Vector3(...lengths).divideScalar(Math.max(...lengths));
  const emptyGrid=new THREE.Data3DTexture(new Uint8Array([255]),1,1,1);emptyGrid.format=THREE.RedFormat;emptyGrid.type=THREE.UnsignedByteType;emptyGrid.minFilter=emptyGrid.magFilter=THREE.NearestFilter;emptyGrid.unpackAlignment=1;emptyGrid.needsUpdate=true;
  uniforms = {accelerationGrid:{value:emptyGrid},accelerationShape:{value:new THREE.Vector3(1,1,1)},cellSize:{value:new THREE.Vector3(32,32,8)},useAcceleration:{value:true},...blockUniforms,voxelShape:{value:new THREE.Vector3(...meta.shape)}, channelTint:{value:new THREE.Color(channels[selectedChannel].color || '#ffffff')}, isRGB:{value:isRGB}, volume:{value:texture}, eye:{value:new THREE.Vector3()}, extent:{value:extent}, threshold:{value:0.08}, density:{value:2}, clipDepth:{value:1}, mode:{value:1}};
  const material = new THREE.ShaderMaterial({uniforms, vertexShader, fragmentShader:fragmentShader.replace('__VOLUME_SAMPLERS__',sampleCode), side:THREE.BackSide, transparent:true, depthWrite:false});
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(extent.x, extent.y, extent.z), material);
  mesh.onBeforeRender = (r,s,c) => { c.getWorldPosition(uniforms.eye.value); mesh.worldToLocal(uniforms.eye.value); material.uniformsNeedUpdate = true; };
  object.add(mesh);
  object.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({color:0x79dbc6,transparent:true,opacity:0.22})));
  $('meta').textContent = `${meta.title} · ${isRGB ? 'RGB · ' : ''}${meta.shape.join(' × ')} voxels · ${lengths.map(n=>n.toPrecision(4)).join(' × ')} ${meta.unit}. ${meta.spatialReduction ? 'Reduced preview · explicitly selected in Fiji' : plan.reason}${layout?` · ${layout.blocks.length} block(s), ${Math.ceil(layout.gpuBytes/1048576)} MiB, ${Number.isFinite(budget)?'limited':'unlimited'} memory`:''}; ${channels.length} channel(s), ${meta.frameCount || 1} time point(s).`;
  const renderHelp=()=>{
    $('render-help').textContent=Number($('mode').value)===0
      ? 'Brightest projection: the brightest sample on each viewing ray wins, even if it is at the back. Use Transparent volume to see overlapping layers.'
      : 'Front-to-back transparency: nearer structures contribute first. Lower Signal threshold to include faint structures; lower Opacity to see through dense ones.';
    $('clip-label').textContent=Number($('clip').value)===1?'Source Z depth · full volume':`Source Z depth · ${Math.round(Number($('clip').value)*100)}% (clipped)`;
    $('density').disabled=sliceOnly||Number($('mode').value)===0;
  };
  for (const [id, name] of [['threshold','threshold'], ['density','density'], ['clip','clipDepth'], ['mode','mode']]) $(id).oninput = () => { uniforms[name].value = Number($(id).value);renderHelp();invalidation.invalidate(); };
  $('show-all').onclick=()=>{$('clip').value='1';uniforms.clipDepth.value=1;renderHelp();invalidation.invalidate();};
  renderHelp();
  const sliceUniforms = { ...blockUniforms,volume:{value:texture}, isRGB:{value:isRGB}, tint:uniforms.channelTint, z:{value:(selectedZ+.5)/sourceSlices}, alpha:{value:.12} };
  const sliceMaterial = new THREE.ShaderMaterial({uniforms:sliceUniforms, transparent:true, depthWrite:false, side:THREE.DoubleSide,
    vertexShader:'varying vec2 coords;void main(){coords=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader:`precision highp float;precision highp sampler3D;${plan.slices?'uniform sampler2D volume;':sampleCode}uniform bool isRGB;uniform vec3 tint;uniform float z;uniform float alpha;varying vec2 coords;void main(){vec3 v=${plan.slices?'texture(volume,vec2(coords.x,1.0-coords.y)).rgb':'sampleVolume(vec3(coords.x,1.0-coords.y,z))'};gl_FragColor=vec4(isRGB?v:tint*v.r,alpha);}` });
  const slice = new THREE.Mesh(new THREE.PlaneGeometry(extent.x,extent.y),sliceMaterial);
  slice.renderOrder=4;object.add(slice);
  const border = new THREE.LineSegments(new THREE.EdgesGeometry(slice.geometry),new THREE.LineBasicMaterial({color:0x79dbc6,depthTest:false}));
  border.renderOrder=5;object.add(border);
  const files = channels[selectedChannel].frames;
  const sliceFetcher=() => {
    const z=sampledSlice(selectedZ,sourceSlices,meta.shape[2]);
    return (file,signal)=>fetchSlice(file,z,plan.planeBytes,signal,transport.fetch);
  };
  const refresh = () => {
    invalidation.invalidate();
    const shownC = timeline.shown >= 0 ? timeline.shownSeries : selectedChannel;
    const shownT = timeline.shown >= 0 ? timeline.shown : timeline.requested;
    const label = `C ${shownC+1}/${channels.length}  ·  Z ${displayedZ+1}/${sourceSlices}  ·  T ${shownT+1}/${files.length}`;
    const pending = timeline.loading ? ` · loading C ${selectedChannel+1}, Z ${selectedZ+1}, T ${timeline.requested+1}…` : '';
    $('dimension-label').textContent = label + pending;
    $('channel').value=selectedChannel+1;$('z').value=selectedZ+1;$('time').value=timeline.requested+1;
    const elapsed = meta.frameInterval>0 ? ` · ${(shownT*meta.frameInterval).toLocaleString(undefined,{maximumFractionDigits:4})} ${meta.timeUnit || 's'}` : '';
    $('time-label').textContent=`T ${shownT+1} / ${files.length}${elapsed}`;
    $('channel-label').textContent=`${selectedChannel+1}/${channels.length}`;$('z-label').textContent=`${selectedZ+1}/${sourceSlices}`;
    $('play').textContent=timeline.playing?'Pause':'Play';
    $('slice-only').checked=sliceOnly;$('slice-only').disabled=plan.slices;
    for(const id of ['mode','threshold','density','clip','show-all'])$(id).disabled=sliceOnly;renderHelp();
    $('benchmark').disabled=plan.slices||sliceOnly||timeline.loading||benchmarking;$('acceleration').disabled=plan.slices||sliceOnly||benchmarking;
    sliceUniforms.z.value=(displayedZ+.5)/sourceSlices;
    slice.position.z=(sliceUniforms.z.value-.5)*extent.z;
    mesh.visible=hasVolume && !sliceOnly;slice.visible=hasVolume && sliceOnly;sliceUniforms.alpha.value=1;
    border.visible=hasVolume;border.position.copy(slice.position);
    const cached=timeline.cache.size;
    $('cache-status').textContent=`${cached} additional time point${cached===1?'':'s'} ready${timeline.prefetching!==null?` · preparing T ${timeline.prefetching+1}…`:''}${timeline.prefetchFailed?' · background preparation stopped; uncached points load on demand':''}. ${plan.slices?'Cached slices':`Up to ${timeline.cacheLimit} extra full-resolution volume${timeline.cacheLimit===1?'':'s'}`}.`;
    dimensionPanel?.draw({label:timeline.loading?'Loading…':`C ${shownC+1} · Z ${selectedZ+1} · T ${shownT+1}${elapsed}`,playing:timeline.playing,sliceOnly,sliceLocked:plan.slices,
      c:{index:selectedChannel,count:channels.length},z:{index:selectedZ,count:sourceSlices},t:{index:timeline.requested,count:files.length}});
  };
  const changeDimension = (axis,index) => {
    if(axis==='c' && index!==selectedChannel){ selectedChannel=index;void timeline.setSeries(channels[index].frames,index); }
    if(axis==='z' && index!==selectedZ){ selectedZ=index;if(plan.slices){void timeline.reload(sliceFetcher());}else{displayedZ=selectedZ;refresh();} }
    if(axis==='t' && index!==timeline.requested){timeline.setPlaying(false);void timeline.request(index);}
  };
  dimensionPanel = new DimensionPanel(scene,changeDimension,button=>{
    if(button==='play')timeline.setPlaying(!timeline.playing);
    if(button==='slice' && !plan.slices){sliceOnly=!sliceOnly;$('slice-only').checked=sliceOnly;refresh();}
  });

  $('panel-home').onclick=()=>dimensionPanel.resetPlacement();

  const gridShape=meta.shape.map((n,i)=>Math.ceil(n/(i===2?Math.max(8,Math.ceil(meta.shape[2]/gl.getParameter(gl.MAX_3D_TEXTURE_SIZE))):32)));
  const frameBytes=plan.slices?plan.planeBytes:layout.gpuBytes+gridShape.reduce((a,b)=>a*b,1);
  const cacheCapacity=()=>plan.slices?2:Math.min(files.length-1,Math.floor(Number($('playback-cache').value)*1048576/frameBytes));
  $('playback-cache').disabled=files.length<=1;
  $('playback-cache').onchange=()=>timeline.setCacheLimit(cacheCapacity());
  timeline = new FrameTimeline({ files, cacheLimit:cacheCapacity(),prefetch:true, initial: Math.max(0, (meta.frame || 1) - 1), bytesPerFrame: byteCount,
    ...(plan.slices ? {fetchFrame:sliceFetcher()} : {
      validateFrame:volume=>volume?.textures?.length===layout.blocks.length,
      disposeFrame:volume=>volume?.dispose(),
      fetchFrame:(file,signal,{background=false}={})=>{
        const transferStarted=performance.now();
        return loadVolumeBlocks(file,layout,meta.shape,isRGB,renderer,signal,(index,count,received=0,total=0,wire=0)=>{
          if(!signal.aborted && !background){const seconds=Math.max(.1,(performance.now()-transferStarted)/1000);const message=`Loading full volume: block ${index+1}/${count} · ${(received/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MiB · ${(wire/1048576/seconds).toFixed(1)} MiB/s network`;status(message);$('transfer-summary').textContent=message;}
        },transport.fetch);
      }
    }),
    onFrame: (frameData,index,channel,{cached}) => {
      if(plan.slices){texture.image.data=frameData;texture.needsUpdate=true;}
      else {
        const acceleration=frameData.acceleration;
        uniforms.accelerationGrid.value=acceleration.texture;uniforms.accelerationShape.value.set(...acceleration.shape);uniforms.cellSize.value.set(...acceleration.cellSize);
        frameData.textures.forEach((block,i)=>{blockUniforms[`volumeBlock${i}`].value=block;});
        material.uniformsNeedUpdate=true;sliceMaterial.uniformsNeedUpdate=true;
        const loaded=`Full volume ready${cached?' · from playback cache':''} · ${Math.ceil(layout.gpuBytes/1048576)} MiB graphics data · ${(frameData.wireBytes/1048576).toFixed(1)} MiB downloaded (lossless)`;status(loaded);$('transfer-summary').textContent=loaded;
      }
      hasVolume=true;displayedZ=selectedZ;uniforms.channelTint.value.set(channels[channel].color || '#ffffff');
    },
    onError: error => {
      status(error.message);$('transfer-summary').textContent=error.message;
      if(timeline.shown>=0 && timeline.shownSeries!==selectedChannel) {
        selectedChannel=timeline.shownSeries;timeline.seriesKey=selectedChannel;timeline.files=channels[selectedChannel].frames;timeline.invalidate();timeline.displayedEpoch=timeline.epoch;refresh();
      }
    },
    onState: () => refresh()
  });
  timeline.seriesKey=selectedChannel;timeline.shownSeries=selectedChannel;
  $('channel').max=channels.length;$('channel').disabled=channels.length===1;
  $('z').max=sourceSlices;$('z').disabled=sourceSlices===1;
  $('time').disabled=files.length===1;
  $('channel').oninput=()=>changeDimension('c',Number($('channel').value)-1);
  $('z').oninput=()=>changeDimension('z',Number($('z').value)-1);
  $('slice-only').onchange=()=>{sliceOnly=$('slice-only').checked;refresh();};
  $('timeline').hidden = files.length <= 1;
  $('time').max = files.length; $('time').value = timeline.initial + 1;
  $('time').oninput = () => changeDimension('t',Number($('time').value)-1);
  $('previous').onclick = () => void timeline.step(-1);
  $('next').onclick = () => void timeline.step(1);
  $('play').onclick = () => timeline.setPlaying(!timeline.playing);
  $('speed').onchange = () => { timeline.fps = Number($('speed').value); };
  $('acceleration').disabled=plan.slices;
  $('acceleration').onchange=()=>{uniforms.useAcceleration.value=$('acceleration').checked;invalidation.invalidate();};
  $('benchmark').disabled=plan.slices;
  $('benchmark').onclick=async()=>{
    if(renderer.xr.isPresenting || timeline.loading || !hasVolume){$('render-stats').textContent='Finish loading, then measure outside immersive mode.';return;}
    const enabled=uniforms.useAcceleration.value,oldOrbit=orbit.enabled;benchmarking=true;orbit.enabled=false;
    timeline.setPlaying(false);timeline.setPrefetchEnabled(false);$('benchmark').disabled=true;$('render-stats').textContent='Measuring completed frames with the same camera and source voxels…';
    try{
      const result=await compareFrames(renderer,()=>{if(timeline.loading)throw new Error('Volume changed; measure again after loading.');renderer.render(scene,camera);},value=>{uniforms.useAcceleration.value=value;material.uniformsNeedUpdate=true;});
      uniforms.useAcceleration.value=result.differingBytes===0 && result.accelerated<result.baseline;$('acceleration').checked=uniforms.useAcceleration.value;
      $('render-stats').textContent=`${result.metric} median: native ${result.baseline.toFixed(1)} ms · accelerated ${result.accelerated.toFixed(1)} ms · ${result.speedup.toFixed(2)}×. Pixel check: ${result.differingBytes===0?'identical':`${result.differingBytes} differing bytes`}. Using ${uniforms.useAcceleration.value?'accelerated':'native'} traversal. Original voxels and ray spacing unchanged.`;
    }catch(error){uniforms.useAcceleration.value=enabled;$('render-stats').textContent=error.message;}
    finally{benchmarking=false;timeline.setPrefetchEnabled(!document.hidden);orbit.enabled=oldOrbit;$('benchmark').disabled=plan.slices||sliceOnly;refresh();invalidation.invalidate();}
  };
  window.addEventListener('pagehide',event=>{if(!event.persisted)timeline.dispose();});
  document.addEventListener('visibilitychange',()=>timeline.setPrefetchEnabled(!document.hidden && !benchmarking));
  await timeline.request(timeline.initial);

}
let previous = 0;
renderer.setAnimationLoop((time, frame) => {
  if(benchmarking)return;
  const dt = Math.min((time-previous)/1000, 0.05); previous = time;
  const session = renderer.xr.getSession();
  if (session && frame && session.visibilityState === 'visible') {
    const reference = renderer.xr.getReferenceSpace();
    const sources = Array.from(session.inputSources);
    const inputs = readXRInputs(frame, reference, sources, squeezeSources, pinchStates);
    const panelSources = dimensionPanel ? dimensionPanel.update(renderer.xr.getCamera(),frame,reference,sources,inputs) : new Set();
    manipulation.update(inputs.filter(input=>!panelSources.has(input.id)));
    renderer.xr.getCamera().getWorldQuaternion(viewQuaternion);
    // Ignore sticks from sources whose tracking is currently unavailable.
    const trackedSources = inputs.map(input => input.id).filter(source=>!panelSources.has(source));
    const timeSources = timeline?.files.length > 1 ? timeInput.update(trackedSources, dt, direction => void timeline.step(direction)) : new Set();
    manipulation.applyThumbsticks(trackedSources.filter(source => !timeSources.has(source)), dt, viewQuaternion);
    markers.forEach((marker, index) => {
      const input = inputs[index];
      marker.visible = Boolean(input);
      if (input) { marker.position.copy(input.position); marker.scale.setScalar(input.held ? 1.5 : 1); }
    });
  } else if (session) clearInteraction();
  else if (dimensionPanel) dimensionPanel.clear();
  if (timeline && (!session || session.visibilityState === 'visible') && !document.hidden) timeline.tick(dt);
  if((!session && document.hidden) || (session && session.visibilityState!=='visible'))return;
  if(!invalidation.shouldRender(Boolean(session),Boolean(timeline?.playing)))return;
  renderer.setClearColor(0x0a111b, session?.environmentBlendMode === 'alpha-blend' ? 0 : 1);
  renderer.render(scene, camera);invalidation.rendered();
});
window.addEventListener('resize', () => { if (!renderer.xr.isPresenting) viewport(); });
renderer.domElement.addEventListener('webglcontextlost',()=>status('The graphics device lost its context, possibly because the full volume exceeded available graphics memory. Reopen the session or try a PC VR browser. No downsampling or slice fallback was applied.'));
load().then(()=>{if(!timeline || timeline.shown<0)return;return support();}).catch(error => {status(error.message);$('transfer-summary').textContent=error.message;});
