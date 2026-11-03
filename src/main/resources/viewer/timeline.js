import { thumbstick } from './interaction.js';

/** Owns the displayed frame plus a bounded LRU of inactive frames. */
export class FrameTimeline {
  constructor({ files, initial = 0, bytesPerFrame, onFrame, onState = () => {}, onError = () => {}, validateFrame = null, disposeFrame = () => {}, cacheLimit = 2, prefetch = false, fetchFrame = async (file, signal) => {
    const response = await fetch(file, { signal });
    if (!response.ok) throw new Error('This time point could not be loaded. Check that the Fiji viewing session is still open.');
    return new Uint8Array(await response.arrayBuffer());
  } }) {
    this.checkFiles(files);this.files=files;this.initial=Math.max(0,Math.min(files.length-1,initial));
    Object.assign(this,{bytesPerFrame,onFrame,onState,onError,fetchFrame,disposeFrame});
    this.validateFrame=validateFrame || (data=>data instanceof Uint8Array && data.byteLength===bytesPerFrame);
    this.cacheLimit=cacheLimit;this.prefetchEnabled=prefetch;this.cache=new Map();this.jobs=new Map();
    this.shown=-1;this.requested=this.initial;this.loading=false;this.playing=false;this.fps=2;this.elapsed=0;
    this.seriesKey=0;this.shownSeries=0;this.epoch=0;this.displayedEpoch=-1;this.version=0;this.displayed=null;this.prefetching=null;this.prefetchFailed=false;this.disposed=false;
  }
  checkFiles(files) {
    if(!Array.isArray(files)||!files.length||!files.every(file=>/^(volume|frame-[1-9][0-9]*|channel-[1-9][0-9]*-frame-[1-9][0-9]*)\.raw$/.test(file)))throw new Error('Invalid time-series files.');
  }
  clearCache() {for(const frame of this.cache.values())this.disposeFrame(frame);this.cache.clear();}
  invalidate() {
    this.epoch++;this.version++;for(const job of this.jobs.values())job.controller.abort();this.jobs.clear();this.clearCache();this.prefetching=null;this.prefetchFailed=false;this.loading=false;
  }
  setSeries(files,key) {
    this.checkFiles(files);if(files.length!==this.files.length)throw new Error('Invalid channel series.');
    this.invalidate();this.files=files;this.seriesKey=key;this.setPlaying(false);return this.request(this.requested);
  }
  reload(fetchFrame=this.fetchFrame) {this.invalidate();this.fetchFrame=fetchFrame;return this.request(this.requested);}
  setCacheLimit(limit) {
    this.cacheLimit=Math.max(0,Math.floor(limit));
    for(const [index,job] of this.jobs)if(!job.claimed){job.controller.abort();this.jobs.delete(index);}
    this.prefetching=null;this.trimCache();this.prefetchFailed=false;this.changed();this.prefetchNext();
  }
  setPrefetchEnabled(enabled) {
    this.prefetchEnabled=Boolean(enabled);
    if(!enabled){for(const [index,job] of this.jobs)if(!job.claimed){job.controller.abort();this.jobs.delete(index);}this.prefetching=null;}
    this.changed();if(enabled)this.prefetchNext();
  }
  trimCache(reserve=0) {
    while(this.cache.size>Math.max(0,this.cacheLimit-reserve)){const index=this.cache.keys().next().value;this.disposeFrame(this.cache.get(index));this.cache.delete(index);}
  }
  changed() {this.onState(this);}
  setPlaying(playing) {this.playing=Boolean(playing)&&this.files.length>1;this.elapsed=0;this.changed();}
  step(delta) {this.setPlaying(false);return this.request(Math.max(0,Math.min(this.files.length-1,this.requested+delta)));}
  tick(dt) {
    if(!this.playing||this.loading||this.shown<0)return;
    this.elapsed+=Math.max(0,Math.min(dt,.1));
    if(this.elapsed>=1/this.fps){this.elapsed=0;void this.request((this.shown+1)%this.files.length);}
  }
  startJob(index,claimed) {
    const controller=new AbortController(),epoch=this.epoch;
    const job={controller,claimed,epoch};this.jobs.set(index,job);
    job.promise=(async()=>{
      let frame=await this.fetchFrame(this.files[index],controller.signal,{background:!claimed,index});
      if(controller.signal.aborted||epoch!==this.epoch||this.disposed){this.disposeFrame(frame);throw Object.assign(new Error('Cancelled'),{name:'AbortError'});}
      if(!this.validateFrame(frame)){this.disposeFrame(frame);throw new Error('This time point has an invalid volume size.');}
      return frame;
    })();return job;
  }
  prefetchNext() {
    if(!this.prefetchEnabled||this.prefetchFailed||this.disposed||this.loading||this.shown<0||this.cacheLimit<1||this.prefetching!==null)return;
    const targets=Array.from({length:Math.min(this.cacheLimit,this.files.length-1)},(_,i)=>(this.shown+i+1)%this.files.length);
    const index=targets.find(i=>!this.cache.has(i));if(index===undefined)return;
    // Prefer nearby future points, protecting the displayed volume from eviction.
    if(this.cache.size>=this.cacheLimit){const victim=[...this.cache.keys()].find(i=>!targets.includes(i))??this.cache.keys().next().value;this.disposeFrame(this.cache.get(victim));this.cache.delete(victim);}
    const job=this.startJob(index,false);this.prefetching=index;this.changed();
    void job.promise.then(frame=>{
      if(!job.claimed){if(job.controller.signal.aborted||job.epoch!==this.epoch||this.disposed)this.disposeFrame(frame);else {this.cache.set(index,frame);this.trimCache();}}
    }).catch(error=>{if(error.name!=='AbortError'&&job.epoch===this.epoch)this.prefetchFailed=true;}).finally(()=>{
      if(this.jobs.get(index)!==job)return;
      this.jobs.delete(index);
      if(job.epoch!==this.epoch)return;
      if(this.prefetching===index)this.prefetching=null;
      this.changed();if(!job.claimed)this.prefetchNext();
    });
  }
  async request(index) {
    if(this.disposed||!Number.isInteger(index)||index<0||index>=this.files.length)return;
    if(this.loading&&this.requested===index)return;
    if(!this.loading&&this.shown===index&&this.displayedEpoch===this.epoch)return;
    const version=++this.version,epoch=this.epoch;
    for(const [i,job] of this.jobs)if(i!==index){job.controller.abort();this.jobs.delete(i);}
    this.prefetching=null;this.requested=index;this.loading=true;this.changed();
    let frame;
    try {
      frame=this.cache.get(index);const cached=Boolean(frame);this.cache.delete(index);
      if(!frame){this.trimCache(1);const job=this.jobs.get(index)||this.startJob(index,true);job.claimed=true;try{frame=await job.promise;}finally{if(this.jobs.get(index)===job)this.jobs.delete(index);}}
      if(version!==this.version||epoch!==this.epoch){this.disposeFrame(frame);return;}
      const old=this.displayed,oldIndex=this.shown,oldEpoch=this.displayedEpoch;
      this.onFrame(frame,index,this.seriesKey,{cached});this.displayed=frame;frame=null;
      if(old){if(oldEpoch===epoch&&this.cacheLimit>0)this.cache.set(oldIndex,old);else this.disposeFrame(old);}
      this.trimCache();this.displayedEpoch=epoch;this.shownSeries=this.seriesKey;this.shown=index;this.loading=false;this.prefetchFailed=false;this.changed();this.prefetchNext();
    }catch(error){
      if(frame)this.disposeFrame(frame);
      if(version!==this.version||epoch!==this.epoch)return;
      this.loading=false;this.playing=false;this.requested=this.shown>=0?this.shown:this.initial;this.changed();
      if(error.name!=='AbortError')this.onError(error);
    }
  }
  dispose() {this.disposed=true;this.invalidate();if(this.displayed)this.disposeFrame(this.displayed);this.displayed=null;}
}

/** Left trigger is a modifier: left-stick X scrubs time without rotating. */
export class TimeAxisInput {
  constructor() { this.clear(); }
  clear() { this.direction = 0; this.elapsed = 0; }
  update(sources, dt, step) {
    const consumed = new Set(); let direction = 0;
    for (const source of sources) {
      if (source.handedness !== 'left' || source.hand) continue;
      const trigger = source.gamepad?.buttons?.[0];
      if (!trigger || !(trigger.pressed || trigger.value > 0.65)) continue;
      consumed.add(source);
      const [x] = thumbstick(source);
      direction = Math.abs(x) >= 0.3 ? Math.sign(x) : 0;
    }
    if (!direction) this.clear();
    else if (direction !== this.direction) { this.direction = direction; this.elapsed = 0; step(direction); }
    else {
      this.elapsed += Math.max(0, Math.min(dt, 0.1));
      if (this.elapsed >= 0.25) { this.elapsed = 0; step(direction); }
    }
    return consumed;
  }
}
