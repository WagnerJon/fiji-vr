import assert from 'node:assert/strict';
import * as THREE from '../src/main/resources/viewer/vendor/three.module.js';
import { FrameTimeline } from '../src/main/resources/viewer/timeline.js';
import { DimensionPanel, panelAction, sliderIndex } from '../src/main/resources/viewer/dimension-panel.js';
export async function runDimensionChecks(){
 const passed=[];const check=async(name,body)=>{await body();passed.push(name);};
 await check('channel changes keep T and never reuse a frame cached from another channel',async()=>{
   const applied=[];
   const timeline=new FrameTimeline({files:['frame-1.raw','volume.raw'],initial:1,bytesPerFrame:1,onFrame:(data,t,c)=>applied.push([data[0],t,c]),fetchFrame:async file=>new Uint8Array([file.startsWith('channel-')?22:11])});
   await timeline.request(1);await timeline.setSeries(['channel-2-frame-1.raw','channel-2-frame-2.raw'],1);
   assert.equal(timeline.shown,1);assert.equal(timeline.shownSeries,1);assert.deepEqual(applied,[[11,1,0],[22,1,1]]);
 });
 await check('late replies from a previous channel cannot overwrite the selected channel',async()=>{
   let previous;const applied=[];
   const timeline=new FrameTimeline({files:['volume.raw'],bytesPerFrame:1,onFrame:(data,t,c)=>applied.push(c),fetchFrame:file=>file==='volume.raw'?new Promise(resolve=>previous=resolve):Promise.resolve(new Uint8Array([7]))});
   const older=timeline.request(0);await timeline.setSeries(['channel-2-frame-1.raw'],1);previous(new Uint8Array([1]));await older;assert.deepEqual(applied,[1]);
 });
 await check('slider endpoints, single-value axes and C/Z/T hit regions',()=>{
   assert.equal(sliderIndex(-2,8),0);assert.equal(sliderIndex(2,8),7);assert.equal(sliderIndex(.6,1),0);
   for(const [axis,y]of[['c',132],['z',232],['t',332]])assert.equal(panelAction({x:.5,y:1-y/400}).axis,axis);
   assert.equal(panelAction({x:.5,y:.9}).button,'pin');assert.equal(panelAction({x:.9,y:.9}).button,'slice');assert.equal(panelAction({x:.65,y:.9}).button,'play');
 });
 await check('ray + trigger grabs the panel slider and consumes only that source',()=>{
   const canvas={width:0,height:0,getContext:()=>new Proxy({},{get:()=>()=>{}})};
   const changes=[],scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();camera.updateMatrixWorld(true);
   const panel=new DimensionPanel(scene,(axis,index)=>changes.push([axis,index]),()=>{},canvas);
   panel.draw({label:'Test',playing:false,sliceOnly:false,c:{index:0,count:3},z:{index:0,count:10},t:{index:0,count:4}});
   const source={targetRaySpace:{},gamepad:{buttons:[{pressed:false}]}};
   let target=new THREE.Vector3(.58*(.85-.5),-.30+.258*(1-132/400-.5),-.85);
   const frame={getPose:()=>({transform:{position:{x:0,y:0,z:0},orientation:new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1),target.clone().normalize())}})};
   panel.update(camera,frame,{},[source],[]);source.gamepad.buttons[0].pressed=true;
   const consumed=panel.update(camera,frame,{},[source],[]);assert.ok(consumed.has(source));assert.deepEqual(changes,[['c',2]]);
   source.gamepad.buttons[0].pressed=false;assert.equal(panel.update(camera,frame,{},[source],[]).size,0);
   panel.clear();assert.equal(panel.mesh.visible,false);
 });
 const fixture=()=>{
   const labels=[],canvas={width:0,height:0,getContext:()=>new Proxy({fillText:text=>labels.push(text)},{get:(object,key)=>object[key]||(()=>{})})};
   const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(),buttons=[];
   const panel=new DimensionPanel(scene,()=>{},button=>buttons.push(button),canvas);
   panel.draw({label:'C 1 · Z 4 · T 2',playing:false,sliceOnly:false,c:{index:0,count:2},z:{index:3,count:8},t:{index:1,count:3}});
   camera.updateMatrixWorld(true);panel.update(camera,{}, {},[],[]);
   const frameAt=(uv,origin=new THREE.Vector3())=>{
     const point=new THREE.Vector3((uv.x-.5)*.58,(uv.y-.5)*.258,0).applyMatrix4(panel.mesh.matrixWorld);
     const q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1),point.sub(origin).normalize());
     return {getPose:()=>({transform:{position:origin,orientation:q}})};
   };
   return {panel,camera,buttons,labels,frameAt};
 };
 await check('pin freezes panel position and orientation under head translation and rotation; follow restores tracking',()=>{
   const {panel,camera,labels}=fixture();const position=panel.mesh.position.clone(),rotation=panel.mesh.quaternion.clone();
   panel.setPinned(true);assert.ok(labels.includes('Follow me'));
   camera.position.set(1.2,.6,-.4);camera.rotation.set(.4,-.8,.2);camera.updateMatrixWorld(true);
   panel.update(camera,{}, {},[],[]);assert.ok(panel.mesh.position.distanceTo(position)<1e-12);assert.ok(panel.mesh.quaternion.angleTo(rotation)<1e-12);
   panel.draw({...panel.state,label:'C 2 · Z 7 · T 3'});assert.equal(panel.pinned,true);
   panel.setPinned(false);panel.update(camera,{}, {},[],[]);
   const expected=new THREE.Vector3(0,-.30,-.85).applyQuaternion(camera.quaternion).add(camera.position);
   assert.ok(panel.mesh.position.distanceTo(expected)<1e-12);assert.ok(panel.mesh.quaternion.angleTo(camera.quaternion)<1e-7);assert.ok(labels.includes('Follow me'));assert.equal(labels.filter(text=>text==='Pin here').length,2);
 });
 await check('controller Pin/Follow acts once per press and captures only the interacting source',()=>{
   const {panel,camera,frameAt,buttons}=fixture(),source={targetRaySpace:{},gamepad:{buttons:[{pressed:true}]}},other={targetRaySpace:{},gamepad:{buttons:[{pressed:false}]}};
   const frame=frameAt({x:.48,y:.9});
   assert.ok(panel.update(camera,frame,{},[source,other],[]).has(source));assert.equal(panel.pinned,true);assert.equal(panel.capture.get(source).button,'pin');
   const held=panel.update(camera,frame,{},[source,other],[]);assert.ok(held.has(source));assert.ok(!held.has(other));assert.equal(panel.pinned,true);
   source.gamepad.buttons[0].pressed=false;assert.equal(panel.update(camera,frame,{},[source,other],[]).size,0);
   source.gamepad.buttons[0].pressed=true;panel.update(camera,frame,{},[source],[]);assert.equal(panel.pinned,false);assert.deepEqual(buttons,[]);
 });
 await check('hand pinch can pin the panel; temporary hiding preserves placement and new session reset restores follow',()=>{
   const {panel,camera,frameAt}=fixture(),hand={hand:{},targetRaySpace:{}},frame=frameAt({x:.48,y:.9});
   assert.ok(panel.update(camera,frame,{},[hand],[{id:hand,held:true}]).has(hand));assert.equal(panel.pinned,true);
   const position=panel.mesh.position.clone(),rotation=panel.mesh.quaternion.clone();panel.clear();assert.equal(panel.mesh.visible,false);assert.equal(panel.pinned,true);
   camera.position.set(2,1,0);camera.rotation.y=1;camera.updateMatrixWorld(true);panel.update(camera,{}, {},[],[]);
   assert.equal(panel.mesh.visible,true);assert.ok(panel.mesh.position.distanceTo(position)<1e-12);assert.ok(panel.mesh.quaternion.angleTo(rotation)<1e-12);
   panel.resetPlacement();assert.equal(panel.pinned,false);panel.update(camera,{}, {},[],[]);assert.ok(panel.mesh.position.distanceTo(position)>1);
 });
 return passed;
}
if(typeof process!=='undefined' && process.argv[1]?.endsWith('test-dimensions.mjs'))for(const name of await runDimensionChecks())console.log(`PASS: ${name}`);
