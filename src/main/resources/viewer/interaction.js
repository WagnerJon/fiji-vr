import * as THREE from './vendor/three.module.js';

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);
const MIN_HAND_DISTANCE = 0.08;

export function stickAxis(value) {
  if (!Number.isFinite(value) || Math.abs(value) <= 0.18) return 0;
  return Math.sign(value) * (Math.min(Math.abs(value), 1) - 0.18) / 0.82;
}

export function thumbstick(source) {
  const pad = source.gamepad;
  if (!pad) return [0, 0];
  // xr-standard reserves 0/1 for a touchpad, even when there is no touchpad.
  const index = pad.mapping === 'xr-standard' ? 2 : Math.max(0, pad.axes.length - 2);
  return [stickAxis(pad.axes[index]), stickAxis(pad.axes[index + 1])];
}

/** Read fresh reference-space poses; never rely on stale Object3D world matrices. */
export function readXRInputs(frame, space, sources, squeezeSources, pinchStates) {
  const results = [];
  const present = new Set(sources);
  for (const source of pinchStates.keys()) if (!present.has(source)) pinchStates.delete(source);
  for (const source of sources) {
    let pose, held;
    if (source.hand && frame.getJointPose) {
      const wrist = source.hand.get('wrist');
      const thumb = source.hand.get('thumb-tip');
      const index = source.hand.get('index-finger-tip');
      pose = wrist && frame.getJointPose(wrist, space);
      const a = thumb && frame.getJointPose(thumb, space);
      const b = index && frame.getJointPose(index, space);
      if (!pose || !a || !b) { pinchStates.delete(source); continue; }
      const distance = Math.hypot(a.transform.position.x - b.transform.position.x, a.transform.position.y - b.transform.position.y, a.transform.position.z - b.transform.position.z);
      // Hysteresis avoids repeatedly dropping/regrabbing near the pinch threshold.
      held = distance < (pinchStates.get(source) ? 0.04 : 0.025);
      pinchStates.set(source, held);
    } else {
      const gripSpace = source.gripSpace || source.targetRaySpace;
      pose = gripSpace && frame.getPose(gripSpace, space);
      if (!pose) continue;
      const pad = source.gamepad;
      held = pad?.mapping === 'xr-standard' && pad.buttons.length > 1
        ? Boolean(pad.buttons[1].pressed || pad.buttons[1].value > 0.65)
        : squeezeSources.has(source);
    }
    const p = pose.transform.position, q = pose.transform.orientation;
    results.push({ id: source, handedness: source.handedness, held,
      position: new THREE.Vector3(p.x, p.y, p.z),
      quaternion: new THREE.Quaternion(q.x, q.y, q.z, q.w).normalize() });
  }
  return results;
}

function snapshot(input) {
  return { id: input.id, position: input.position.clone(), quaternion: input.quaternion.clone() };
}
function midpoint(a, b) { return a.position.clone().add(b.position).multiplyScalar(0.5); }
function pairAxis(a, b) { return b.position.clone().sub(a.position); }
function wristTwist(before, after, inverseSwing, axis) {
  const residual = after.quaternion.clone().multiply(before.quaternion.clone().invert()).multiply(inverseSwing);
  const along = residual.x * axis.x + residual.y * axis.y + residual.z * axis.z;
  const angle = 2 * Math.atan2(along, residual.w);
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Object is kept directly under the identity scene, in XR reference coordinates. */
export class VolumeManipulation {
  constructor(object) { this.object = object; this.previous = []; }
  clear() { this.previous = []; }
  update(inputs) {
    const active = inputs.filter(input => input.held).slice(0, 2);
    if (!active.length) { this.clear(); return; }
    // Keep the two identities stable even if WebXR reorders inputSources.
    if (active.length === 2 && this.previous.length === 2 && active[0].id === this.previous[1].id) active.reverse();
    if (active.length === 2 && pairAxis(...active).length() < MIN_HAND_DISTANCE) {
      this.clear(); return; // Freeze while hands overlap, then rebase without a jump.
    }
    if (active.length !== this.previous.length || active.some((hand, i) => hand.id !== this.previous[i].id)) {
      this.previous = active.map(snapshot); return;
    }
    let delta, from, to;
    if (active.length === 1) {
      delta = active[0].quaternion.clone().multiply(this.previous[0].quaternion.clone().invert());
      from = this.previous[0].position;
      to = active[0].position;
    } else {
      const oldAxis = pairAxis(...this.previous).normalize();
      const newAxis = pairAxis(...active).normalize();
      const swing = new THREE.Quaternion().setFromUnitVectors(oldAxis, newAxis);
      // Separation controls ball-like turning. Wrist roll adds twist around that axis.
      const inverseSwing = swing.clone().invert();
      const angle = (wristTwist(this.previous[0], active[0], inverseSwing, newAxis)
        + wristTwist(this.previous[1], active[1], inverseSwing, newAxis)) * 0.5;
      delta = new THREE.Quaternion().setFromAxisAngle(newAxis, angle).multiply(swing);
      from = midpoint(...this.previous); to = midpoint(...active);
    }
    this.object.position.sub(from).applyQuaternion(delta).add(to);
    this.object.quaternion.premultiply(delta).normalize();
    this.previous = active.map(snapshot);
  }
  applyThumbsticks(sources, dt, viewQuaternion) {
    dt = THREE.MathUtils.clamp(dt, 0, 0.05);
    const right = RIGHT.clone().applyQuaternion(viewQuaternion);
    const forward = FORWARD.clone().applyQuaternion(viewQuaternion);
    for (const source of sources) {
      const [x, y] = thumbstick(source);
      if (source.handedness === 'left') {
        this.object.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(UP, -x * dt * 1.3));
        this.object.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(right, -y * dt * 1.3));
      } else if (source.handedness === 'right') {
        this.object.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(forward, -x * dt * 1.3));
        const scale = THREE.MathUtils.clamp(this.object.scale.x * Math.exp(-y * dt), 0.05, 5);
        this.object.scale.setScalar(scale);
      }
    }
    this.object.quaternion.normalize();
  }
}
