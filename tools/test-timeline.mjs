import assert from 'node:assert/strict';
import { FrameTimeline, TimeAxisInput } from '../src/main/resources/viewer/timeline.js';

export async function runTimelineChecks() {
  const passed=[];
  const check=async(name,body)=>{await body();passed.push(name);};
  const files=['frame-1.raw','volume.raw','frame-3.raw'];
  const data=index=>new Uint8Array([index]);
  await check('initial frame, ordered stepping, clamped endpoints and bounded two-frame cache',async()=>{
    const shown=[];const time=new FrameTimeline({files,initial:1,bytesPerFrame:1,onFrame:(bytes,index)=>shown.push(index),fetchFrame:async file=>data(files.indexOf(file))});
    await time.request(time.initial);assert.equal(time.shown,1);
    await time.step(-1);assert.equal(time.shown,0);await time.step(-1);assert.equal(time.shown,0);
    await time.step(1);await time.step(1);await time.step(1);assert.equal(time.shown,2);assert.equal(time.cache.size,2);
    assert.deepEqual(shown.slice(0,2),[1,0]);
  });
  await check('scrubbing ignores out-of-order responses even if the transport ignores abort',async()=>{
    const pending=new Map(),shown=[];
    const time=new FrameTimeline({files,bytesPerFrame:1,onFrame:(bytes,index)=>shown.push(index),fetchFrame:file=>new Promise(resolve=>pending.set(file,resolve))});
    const old=time.request(0),latest=time.request(2);
    pending.get(files[2])(data(2));await latest;pending.get(files[0])(data(0));await old;
    assert.deepEqual(shown,[2]);assert.equal(time.shown,2);assert.equal(time.cache.size,0);
  });
  await check('bad frame sizes retain the last visible frame and stop playback',async()=>{
    const errors=[];const shown=[];
    const time=new FrameTimeline({files,bytesPerFrame:1,onFrame:(bytes,index)=>shown.push(index),onError:error=>errors.push(error),fetchFrame:async file=>file===files[0]?data(0):new Uint8Array(2)});
    await time.request(0);time.setPlaying(true);await time.request(1);
    assert.equal(time.shown,0);assert.equal(time.requested,0);assert.equal(time.playing,false);assert.equal(errors.length,1);assert.deepEqual(shown,[0]);
  });
  await check('playback waits for loading and loops, manual stepping pauses it',async()=>{
    let resolve;
    const time=new FrameTimeline({files,bytesPerFrame:1,onFrame:()=>{},fetchFrame:file=>file===files[2]?Promise.resolve(data(2)):new Promise(done=>resolve=done)});
    await time.request(2);time.fps=10;time.setPlaying(true);time.tick(.1);
    assert.equal(time.requested,0);assert.equal(time.loading,true);
    time.tick(.1);time.tick(.1);assert.equal(time.requested,0);
    resolve(data(0));await Promise.resolve();await Promise.resolve();assert.equal(time.shown,0);
    void time.step(1);assert.equal(time.playing,false);
  });
  const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
  await check('background volumes warm once, cached playback performs no fetch, active frame is never evicted',async()=>{
    const fetched=[],released=[],shown=[];
    const time=new FrameTimeline({files,bytesPerFrame:1,cacheLimit:2,prefetch:true,fetchFrame:async file=>{fetched.push(file);return data(files.indexOf(file));},disposeFrame:frame=>released.push(frame[0]),onFrame:(frame,index)=>shown.push(index)});
    await time.request(0);await settle();await settle();
    assert.equal(time.cache.size,2);assert.equal(fetched.length,3);assert.deepEqual(released,[]);
    await time.request(1);await time.request(2);await time.request(0);await settle();
    assert.equal(fetched.length,3);assert.deepEqual(shown,[0,1,2,0]);assert.deepEqual(released,[]);
    time.setCacheLimit(0);assert.equal(time.cache.size,0);assert.equal(released.length,2);assert.ok(!released.includes(0));
    time.dispose();assert.equal(released.length,3);assert.equal(new Set(released).size,3);
  });
  await check('request adopts an in-flight prefetched volume instead of downloading twice',async()=>{
    let finish;const fetched=[],released=[];
    const time=new FrameTimeline({files,bytesPerFrame:1,cacheLimit:1,prefetch:true,onFrame:()=>{},disposeFrame:frame=>released.push(frame[0]),fetchFrame:async file=>{fetched.push(file);if(file===files[1])return new Promise(resolve=>finish=resolve);return data(files.indexOf(file));}});
    await time.request(0);assert.equal(time.prefetching,1);const request=time.request(1);finish(data(1));await request;await settle();
    assert.equal(time.shown,1);assert.equal(fetched.filter(file=>file===files[1]).length,1);assert.ok(!released.includes(1));time.dispose();
  });
  await check('channel change releases cached frames and late background results, preserving visible frame until replacement',async()=>{
    const released=[];let finish;const other=['channel-2-frame-1.raw','channel-2-frame-2.raw','channel-2-frame-3.raw'];
    const time=new FrameTimeline({files,bytesPerFrame:1,cacheLimit:1,prefetch:true,onFrame:()=>{},disposeFrame:frame=>released.push(frame[0]),fetchFrame:async file=>file===files[1]?new Promise(resolve=>finish=resolve):new Uint8Array([other.includes(file)?10+other.indexOf(file):0])});
    await time.request(0);await time.setSeries(other,1);finish(data(1));await settle();
    assert.equal(time.shownSeries,1);assert.equal(time.displayed[0],10);assert.ok(released.includes(0));assert.ok(released.includes(1));assert.ok(!released.includes(10));time.dispose();
  });
  await check('background failure keeps playback usable; foreground failure retains visible volume',async()=>{
    const errors=[];const time=new FrameTimeline({files,bytesPerFrame:1,cacheLimit:1,prefetch:true,onFrame:()=>{},onError:error=>errors.push(error),fetchFrame:async file=>{if(file!==files[0])throw new Error('offline');return data(0);}});
    await time.request(0);time.setPlaying(true);await settle();assert.equal(time.prefetchFailed,true);assert.equal(time.playing,true);assert.equal(errors.length,0);
    await time.request(1);assert.equal(time.shown,0);assert.equal(time.displayed[0],0);assert.equal(time.playing,false);assert.equal(errors.length,1);time.dispose();
  });
  await check('shrinking cache cancels pending prefetch and releases late results exactly once',async()=>{
    let finish;const released=[];const time=new FrameTimeline({files,bytesPerFrame:1,cacheLimit:1,prefetch:true,onFrame:()=>{},disposeFrame:frame=>released.push(frame[0]),fetchFrame:async file=>file===files[0]?data(0):new Promise(resolve=>finish=resolve)});
    await time.request(0);time.setCacheLimit(0);finish(data(1));await settle();assert.equal(time.cache.size,0);assert.deepEqual(released,[1]);assert.equal(time.shown,0);time.dispose();assert.deepEqual(released,[1,0]);
  });
  await check('a failed foreground load can be retried successfully',async()=>{
    let attempts=0;const time=new FrameTimeline({files,bytesPerFrame:1,cacheLimit:0,onFrame:()=>{},fetchFrame:async()=>{if(++attempts===1)throw new Error('temporary failure');return data(0);}});
    await time.request(0);assert.equal(time.shown,-1);assert.equal(time.jobs.size,0);await time.request(0);assert.equal(time.shown,0);assert.equal(attempts,2);time.dispose();
  });
  await check('pausing background work cancels prefetch and resumes warming without releasing the visible volume',async()=>{
    let finish;const released=[];let hold=true;
    const time=new FrameTimeline({files,bytesPerFrame:1,cacheLimit:1,prefetch:true,onFrame:()=>{},disposeFrame:frame=>released.push(frame[0]),fetchFrame:async file=>file===files[0]?data(0):hold?new Promise(resolve=>finish=resolve):data(files.indexOf(file))});
    await time.request(0);time.setPrefetchEnabled(false);finish(data(1));await settle();assert.deepEqual(released,[1]);assert.equal(time.cache.size,0);assert.equal(time.displayed[0],0);
    hold=false;time.setPrefetchEnabled(true);await settle();assert.equal(time.cache.size,1);assert.equal(time.cache.get(1)[0],1);time.dispose();
  });
  await check('trigger-modified left stick steps immediately and repeats without consuming right zoom',()=>{
    const input=new TimeAxisInput(),steps=[];
    const left={handedness:'left',gamepad:{mapping:'xr-standard',axes:[0,0,1,0],buttons:[{pressed:true}]}};
    const right={handedness:'right',gamepad:{mapping:'xr-standard',axes:[0,0,0,-1],buttons:[]}};
    const first=input.update([left,right],.05,direction=>steps.push(direction));assert.equal(first.has(left),true);assert.equal(first.has(right),false);assert.deepEqual(steps,[1]);
    for(let i=0;i<5;i++)input.update([left,right],.05,direction=>steps.push(direction));assert.deepEqual(steps,[1,1]);
    left.gamepad.axes[2]=-1;input.update([left],.05,direction=>steps.push(direction));assert.deepEqual(steps,[1,1,-1]);
    left.gamepad.buttons[0].pressed=false;assert.equal(input.update([left],.05,()=>{}).size,0);
  });
  await check('manifest file paths reject traversal',()=>{
    assert.throws(()=>new FrameTimeline({files:['../private.raw'],bytesPerFrame:1,onFrame:()=>{}}));
  });
  return passed;
}
if(typeof process!=='undefined' && process.argv[1]?.endsWith('test-timeline.mjs'))for(const name of await runTimelineChecks())console.log(`PASS: ${name}`);
