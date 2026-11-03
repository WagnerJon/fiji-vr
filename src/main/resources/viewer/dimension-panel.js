import * as THREE from './vendor/three.module.js';

export function sliderIndex(fraction, count) {
  return Math.max(0, Math.min(count - 1, Math.round(Math.max(0, Math.min(1, fraction)) * (count - 1))));
}
export function panelAction(uv) {
  const x=uv.x*900,y=(1-uv.y)*400;
  if(y<82) return x>=710?{button:'slice'}:x>=540?{button:'play'}:x>=342?{button:'pin'}:null;
  const row=Math.floor((y-82)/100);
  if(row<0 || row>2) return null;
  return {axis:['c','z','t'][row], fraction:(x-230)/610, delta:x<200?-1:x>870?1:0};
}

/** ImageJ-like C/Z/T controls drawn as a ray-interactive plane inside immersion. */
export class DimensionPanel {
  constructor(scene,onChange,onButton,canvas = document.createElement('canvas')) {
    this.onChange=onChange;this.onButton=onButton;this.pressed=new Set();this.capture=new Map();this.signature='';this.pinned=false;
    this.canvas=canvas;this.canvas.width=900;this.canvas.height=400;this.context=this.canvas.getContext('2d');
    this.texture=new THREE.CanvasTexture(this.canvas);
    this.mesh=new THREE.Mesh(new THREE.PlaneGeometry(.58,.258),new THREE.MeshBasicMaterial({map:this.texture,transparent:true,depthTest:false,side:THREE.DoubleSide}));
    this.mesh.renderOrder=30;this.mesh.visible=false;scene.add(this.mesh);
    this.raycaster=new THREE.Raycaster();
    this.lines=[0,1].map(()=>{
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),new THREE.LineBasicMaterial({color:0x79dbc6,depthTest:false,transparent:true,opacity:.8}));
      line.visible=false;line.renderOrder=31;scene.add(line);return line;
    });
  }
  clear() {this.pressed.clear();this.capture.clear();this.lines.forEach(line=>{line.visible=false;});this.mesh.visible=false;}
  setPinned(pinned) {
    this.pinned=Boolean(pinned);
    if(this.state)this.draw(this.state);
  }
  resetPlacement() {this.setPinned(false);this.clear();}
  draw(state) {
    this.state=state;
    const signature=JSON.stringify({...state,pinned:this.pinned});if(signature===this.signature)return;this.signature=signature;
    const c=this.context;c.clearRect(0,0,900,400);c.fillStyle='#111c2bf5';c.fillRect(0,0,900,400);
    c.strokeStyle='#617088';c.lineWidth=2;c.strokeRect(1,1,898,398);c.font='bold 28px system-ui';c.fillStyle='#e8f1ff';
    c.fillText(state.label,24,48,300);
    c.font='24px system-ui';c.fillStyle=this.pinned?'#f1bd7a':'#79dbc6';
    c.strokeStyle=c.fillStyle;c.lineWidth=2;c.strokeRect(346,14,180,54);c.fillText(this.pinned?'Follow me':'Pin here',363,48,150);
    c.fillStyle='#79dbc6';c.fillText(state.playing?'Pause':'Play',565,48);c.fillText(state.sliceLocked?'Full-res slices':state.sliceOnly?'Volume':'Slice only',725,48);
    ['c','z','t'].forEach((axis,row)=>{
      const {index,count}=state[axis],y=132+row*100;
      c.fillStyle=count>1?'#e8f1ff':'#8190a3';c.font='bold 30px system-ui';c.fillText(`${axis.toUpperCase()}  ${index+1} / ${count}`,24,y+10,170);
      c.fillStyle='#8190a3';c.fillText('‹',198,y+10);c.fillText('›',874,y+10);
      c.strokeStyle='#526175';c.lineWidth=10;c.beginPath();c.moveTo(230,y);c.lineTo(840,y);c.stroke();
      const x=230+(count>1?index/(count-1):0)*610;
      c.strokeStyle=count>1?'#79dbc6':'#526175';c.beginPath();c.moveTo(230,y);c.lineTo(x,y);c.stroke();
      c.fillStyle=count>1?'#79dbc6':'#8190a3';c.beginPath();c.arc(x,y,15,0,Math.PI*2);c.fill();
    });
    this.texture.needsUpdate=true;
  }
  update(camera,frame,space,sources,inputs) {
    this.mesh.visible=true;
    // A pinned panel keeps both its position and orientation in the XR scene.
    // Its pose is independent of the image transform and subsequent head movement.
    if(!this.pinned){
      camera.getWorldQuaternion(this.mesh.quaternion);camera.getWorldPosition(this.mesh.position);
      this.mesh.position.add(new THREE.Vector3(0,-.30,-.85).applyQuaternion(this.mesh.quaternion));
    }
    this.mesh.updateMatrixWorld(true);
    const consumed=new Set(),present=new Set(sources);
    for(const source of this.pressed)if(!present.has(source)){this.pressed.delete(source);this.capture.delete(source);}
    this.lines.forEach(line=>{line.visible=false;});
    sources.slice(0,2).forEach((source,i)=>{
      const input=inputs.find(item=>item.id===source);
      const trigger=source.gamepad?.buttons?.[0];
      const held=source.hand?Boolean(input?.held):Boolean(trigger?.pressed || trigger?.value>.65);
      const wasHeld=this.pressed.has(source);
      if(!held){this.pressed.delete(source);this.capture.delete(source);}else this.pressed.add(source);
      const pose=source.targetRaySpace && frame.getPose(source.targetRaySpace,space);
      if(!pose){this.capture.delete(source);return;}
      const p=pose.transform.position,q=pose.transform.orientation;
      const origin=new THREE.Vector3(p.x,p.y,p.z),direction=new THREE.Vector3(0,0,-1).applyQuaternion(new THREE.Quaternion(q.x,q.y,q.z,q.w));
      this.raycaster.set(origin,direction);
      const hit=this.raycaster.intersectObject(this.mesh,false)[0];
      if(held && !wasHeld && hit) {
        const action=panelAction(hit.uv);
        if(action){this.capture.set(source,action);if(action.button==='pin')this.setPinned(!this.pinned);else if(action.button)this.onButton(action.button);}
      }
      const action=this.capture.get(source);
      if(held && action) {
        consumed.add(source);
        if(action.axis && hit && this.state) {
          const axis=this.state[action.axis];
          const index=action.delta?Math.max(0,Math.min(axis.count-1,axis.index+(!wasHeld?action.delta:0))):sliderIndex((hit.uv.x*900-230)/610,axis.count);
          if(index!==axis.index)this.onChange(action.axis,index);
        }
      }
      const end=hit?hit.point:origin.clone().addScaledVector(direction,.7);
      const line=this.lines[i],attribute=line.geometry.attributes.position;
      attribute.setXYZ(0,origin.x,origin.y,origin.z);attribute.setXYZ(1,end.x,end.y,end.z);attribute.needsUpdate=true;
      line.geometry.computeBoundingSphere();line.visible=true;line.material.color.set(held && action?0xf1bd7a:0x79dbc6);
    });
    return consumed;
  }
}
