import assert from 'node:assert/strict';
import * as THREE from '../src/main/resources/viewer/vendor/three.module.js';
import { VolumeManipulation, readXRInputs, thumbstick, stickAxis } from '../src/main/resources/viewer/interaction.js';

export function runInteractionChecks() {
  const passed = [];
  const identity = new THREE.Quaternion();
  const left = {}, right = {};
  const position = (x=0,y=0,z=0) => new THREE.Vector3(x,y,z);
  const rotation = (axis, angle) => new THREE.Quaternion().setFromAxisAngle(axis, angle);
  const hand = (id, p, q=identity, held=true) => ({ id, position:p, quaternion:q, held });
  const nearVector = (a,b) => assert.ok(a.distanceTo(b)<1e-6, `${a.toArray()} != ${b.toArray()}`);
  const nearRotation = (a,b) => assert.ok(1-Math.abs(a.dot(b))<1e-6, `${a.toArray()} != ${b.toArray()}`);
  const fixture = () => { const object=new THREE.Group();object.position.set(0,0,-1);return {object,control:new VolumeManipulation(object)}; };
  const check = (name, body) => { body(); passed.push(name); };
  check('either grip translates and rotates from the tracked wrist pose, without a grab jump',()=>{
    for (const id of [left,right]) {
      const {object,control}=fixture();const initial=object.position.clone();
      control.update([hand(id,position())]);nearVector(object.position,initial);
      const q=rotation(position(0,1,0),Math.PI/2);
      control.update([hand(id,position(1,0,0),q)]);
      nearRotation(object.quaternion,q);nearVector(object.position,position(0,0,0));
      control.update([]);control.update([hand(id,position(20,0,0),q)]);nearVector(object.position,position());
    }
  });
  check('two grips turn like a ball and translate together, with no hand-distance scaling',()=>{
    const {object,control}=fixture();object.position.set(0,0,0);object.scale.setScalar(.65);
    control.update([hand(left,position(-.3)),hand(right,position(.3))]);
    const q=rotation(position(0,0,1),Math.PI/2);
    control.update([hand(left,position(1,-.3,0),q),hand(right,position(1,.3,0),q)]);
    nearRotation(object.quaternion,q);nearVector(object.position,position(1));
    control.update([hand(left,position(1,-.6,0),q),hand(right,position(1,.6,0),q)]);
    assert.equal(object.scale.x,.65);nearVector(object.position,position(1));nearRotation(object.quaternion,q);
  });
  check('wrist twisting rotates around the two-hand axis',()=>{
    const {object,control}=fixture();object.position.set(0,0,0);
    control.update([hand(left,position(-.3)),hand(right,position(.3))]);
    const q=rotation(position(1,0,0),Math.PI/3);
    control.update([hand(left,position(-.3),q),hand(right,position(.3),q)]);
    nearRotation(object.quaternion,q);
  });
  check('turning hands through vertical does not produce an unintended roll',()=>{
    const {object,control}=fixture();object.position.set(0,0,0);
    for(let degrees=0;degrees<=180;degrees+=2) {
      const q=rotation(position(0,0,1),degrees*Math.PI/180);
      control.update([hand(left,position(-.3).applyQuaternion(q)),hand(right,position(.3).applyQuaternion(q))]);
      nearRotation(object.quaternion,q);
    }
  });
  check('1→2→1 hand transitions, reordered inputs and lost tracking preserve the object pose',()=>{
    const {object,control}=fixture();
    control.update([hand(left,position(-.3))]);
    control.update([hand(left,position(-.2))]);const expected=object.position.clone();
    control.update([hand(left,position(-.2)),hand(right,position(.4))]);nearVector(object.position,expected);
    control.update([hand(right,position(.4)),hand(left,position(-.2))]);nearVector(object.position,expected);nearRotation(object.quaternion,identity);
    control.update([hand(right,position(.4))]);nearVector(object.position,expected);
    control.update([]);control.update([hand(right,position(99))]);nearVector(object.position,expected);
  });
  check('overlapping hands freeze and rebase safely',()=>{
    const {object,control}=fixture();const expected=object.position.clone();
    control.update([hand(left,position(-.3)),hand(right,position(.3))]);
    control.update([hand(left,position()),hand(right,position())]);nearVector(object.position,expected);
    control.update([hand(left,position(2)),hand(right,position(3))]);nearVector(object.position,expected);
  });
  const source=(side,x,y)=>({handedness:side,gamepad:{mapping:'xr-standard',axes:[0,0,x,y,0.7,-0.7],buttons:[]}});
  check('Quest standard axes, deadzone, left-stick yaw/pitch, right-stick roll/zoom',()=>{
    const axes=thumbstick(source('left',1,-1)); assert.ok(Math.abs(axes[0]-1)<1e-12 && Math.abs(axes[1]+1)<1e-12);
    assert.equal(stickAxis(.17),0);assert.equal(stickAxis(NaN),0);
    for(const [side,x,y,axis,angle] of [['left',1,0,position(0,1,0),-.065],['left',0,-1,position(1,0,0),.065],['right',1,0,position(0,0,-1),-.065]]){
      const {object,control}=fixture();control.applyThumbsticks([source(side,x,y)],.05,identity);nearRotation(object.quaternion,rotation(axis,angle));
    }
    const {object,control}=fixture();control.applyThumbsticks([source('right',0,-1)],.05,identity);assert.ok(object.scale.x>1);
    object.scale.setScalar(5);control.applyThumbsticks([source('right',0,-1)],.05,identity);assert.equal(object.scale.x,5);
    object.scale.setScalar(.05);control.applyThumbsticks([source('right',0,1)],.05,identity);assert.equal(object.scale.x,.05);
  });
  check('stick rotation and zoom persist while gripping, without snapping back',()=>{
    const {object,control}=fixture();const input=hand(left,position());control.update([input]);
    control.applyThumbsticks([source('left',1,0),source('right',0,-1)],.05,identity);
    const expectedQ=object.quaternion.clone(),expectedScale=object.scale.clone();
    control.update([input]);nearRotation(object.quaternion,expectedQ);nearVector(object.scale,expectedScale);
  });
  check('fresh grip poses and polled squeeze work even if squeeze events are absent',()=>{
    const grip={};const input={gripSpace:grip,handedness:'left',gamepad:{mapping:'xr-standard',buttons:[{}, {pressed:true,value:1}]}};
    const transform={position:{x:1,y:2,z:3},orientation:{x:0,y:0,z:0,w:1}};
    const frame={getPose:space=>space===grip?{transform}:null};
    const result=readXRInputs(frame,{},[input],new Set(),new Map());assert.equal(result[0].held,true);nearVector(result[0].position,position(1,2,3));
    assert.equal(readXRInputs({getPose:()=>null},{},[input],new Set(),new Map()).length,0);
  });
  check('bare-hand pinch uses hysteresis and releases when tracking is lost',()=>{
    const joints=new Map(['wrist','thumb-tip','index-finger-tip'].map(name=>[name,{name}]));
    const input={hand:joints,handedness:'left'};let distance=.02;
    const frame={getJointPose:joint=>({transform:{position:{x:joint.name==='index-finger-tip'?distance:0,y:0,z:0},orientation:{x:0,y:0,z:0,w:1}}})};
    const states=new Map();const read=()=>readXRInputs(frame,{},[input],new Set(),states);
    assert.equal(read()[0].held,true);distance=.03;assert.equal(read()[0].held,true);distance=.05;assert.equal(read()[0].held,false);
    readXRInputs({getJointPose:()=>null},{},[input],new Set(),states);assert.equal(states.size,0);
  });
  return passed;
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('test-interaction.mjs')) {
  for (const name of runInteractionChecks()) console.log(`PASS: ${name}`);
}
