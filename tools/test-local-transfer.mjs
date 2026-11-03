import assert from 'node:assert/strict';
import {ImageTransport,localBases,privateIPv4} from '../src/main/resources/viewer/local-transfer.js';
import {fetchByteRange} from '../src/main/resources/viewer/transfer.js';
const token='0123456789abcdef0123456789abcdef',base=`https://viewer.example.test/${token}/`,lan=`http://192.168.4.10:51234/${token}/`;
const manifest={version:1,session:token,localBases:[lan]};
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const packet=(start,end)=>new Response(Uint8Array.from({length:end-start+1},(_,i)=>(start+i)%256),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/99999`}});
export async function runLocalTransferChecks(){
 const passed=[];const check=async(name,fn)=>{await fn();passed.push(name);};
 await check('native fetch is invoked without an incorrect object receiver',async()=>{
  let calls=0;const transport=new ImageTransport({baseURL:base,permissions:{query:async()=>({state:'prompt'})},fetcher:async function(){assert.equal(this,undefined);calls++;return json(manifest);}});
  await transport.initialize();assert.equal(await transport.connect(),true);assert.equal(calls,2);
 });
 const permissions=state=>({query:async()=>({state})});
 await check('connection candidates are limited to private IPv4 addresses and the exact session path',()=>{
  for(const host of ['10.0.1.2','172.16.0.1','172.31.255.2','192.168.1.4'])assert.ok(privateIPv4(host));
  for(const host of ['127.0.0.1','8.8.8.8','172.15.0.1','172.32.0.1','192.169.0.1','192.168.999.1','example.test'])assert.ok(!privateIPv4(host));
  assert.deepEqual(localBases(manifest,new URL(base)),[lan]);
  for(const url of [`http://8.8.8.8:1234/${token}/`,`http://127.0.0.1:1234/${token}/`,lan.replace(token,'other'),lan.replace('http:','https:'),lan.replace('192.168.4.10','user:password@192.168.4.10')])assert.throws(()=>localBases({...manifest,localBases:[url]},new URL(base)));
  assert.throws(()=>localBases({...manifest,session:'wrong'},new URL(base)));
 });
 await check('first local-network permission is gated on the viewer button, not page load',async()=>{
  const calls=[],transport=new ImageTransport({baseURL:base,permissions:permissions('prompt'),fetcher:async url=>{calls.push(url);return json(manifest);}});
  await transport.initialize();assert.equal(calls.length,1);assert.equal(transport.route,'relay');assert.equal(transport.localBase,null);
  assert.equal(await transport.connect(),true);assert.equal(transport.route,'wifi');assert.equal(transport.localBase,lan);assert.equal(calls.length,2);
 });
 await check('previously granted local access connects automatically and checks session identity',async()=>{
  const transport=new ImageTransport({baseURL:base,permissions:permissions('granted'),fetcher:async()=>json(manifest)});
  await transport.initialize();assert.equal(transport.route,'wifi');
  const wrong=new ImageTransport({baseURL:base,permissions:permissions('prompt'),fetcher:async url=>json(url===base+'connection.json'?manifest:{...manifest,session:'wrong'})});
  await wrong.initialize();assert.equal(await wrong.connect(),false);assert.equal(wrong.route,'relay');
 });
 await check('full volumes, channels and slices use unchanged local byte ranges, omitting credentials',async()=>{
  const calls=[],transport=new ImageTransport({baseURL:base,permissions:permissions('granted'),fetcher:async(url,options)=>{calls.push([url,options]);if(url.endsWith('connection.json'))return json(manifest);const [start,end]=options.headers.Range.slice(6).split('-').map(Number);return packet(start,end);}});
  await transport.initialize();
  for(const file of ['volume.raw','frame-2.raw','channel-2-frame-3.raw']){
   const bytes=await fetchByteRange(file,123,21,undefined,transport.fetch,{chunkBytes:8});assert.deepEqual([...bytes],Array.from({length:21},(_,i)=>(123+i)%256));
  }
  const dataCalls=calls.filter(([url])=>url.includes('.raw'));assert.equal(dataCalls.length,9);assert.ok(dataCalls.every(([url,options])=>url.startsWith(lan)&&options.credentials==='omit'&&options.targetAddressSpace==='local'));
 });
 await check('LAN chunk requests avoid gzip work and validate their native bytes before delivery',async()=>{
  let requested;const transport=new ImageTransport({baseURL:base,permissions:permissions('granted'),fetcher:async(url,options)=>{
   if(url.endsWith('connection.json'))return json(manifest);requested=url;assert.equal(options.targetAddressSpace,'local');
   return new Response(new Uint8Array([4,5,6]),{headers:{'X-Fiji-Encoding':'identity','X-Fiji-Raw-Range':'bytes 4-6/20'}});
  }});await transport.initialize();const response=await transport.fetch('volume.raw?chunk=4-6&compression=gzip',{});
  assert.equal(new URL(requested).searchParams.get('compression'),'identity');assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[4,5,6]);
 });
 await check('lost or truncated local transfers visibly fall back for the affected piece',async()=>{
  for(const kind of ['network','body','truncated']){
   const states=[],calls=[],transport=new ImageTransport({baseURL:base,permissions:permissions('granted'),onState:t=>states.push(t.message),fetcher:async(url,options)=>{
    calls.push(url);if(url.endsWith('connection.json'))return json(manifest);
    if(url.startsWith(lan)){
     if(kind==='network')throw new TypeError('Failed to fetch');
     if(kind==='body')return {ok:true,arrayBuffer:async()=>{throw new TypeError('Content-Length exceeds body');}};
     return packet(4,4);
    }
    return packet(4,6);
   }});await transport.initialize();const bytes=await fetchByteRange('volume.raw',4,3,undefined,transport.fetch);
   assert.deepEqual([...bytes],[4,5,6]);assert.equal(transport.route,'relay');assert.ok(states.some(s=>s.includes('local Wi-Fi was lost')));assert.ok(calls.includes('volume.raw'));
  }
 });
 await check('user cancellation never switches routes or retries through the relay',async()=>{
  let dataCalls=0;const controller=new AbortController(),transport=new ImageTransport({baseURL:base,permissions:permissions('granted'),fetcher:async(url,options)=>{
   if(url.endsWith('connection.json'))return json(manifest);dataCalls++;controller.abort();throw new TypeError('aborted');
  }});await transport.initialize();await assert.rejects(transport.fetch('volume.raw',{signal:controller.signal,headers:{Range:'bytes=0-3'}}),{name:'AbortError'});assert.equal(dataCalls,1);assert.equal(transport.route,'wifi');
 });
 await check('desktop viewing does not probe the network; arbitrary URLs are never forwarded to LAN',async()=>{
  let calls=0;const desktop=new ImageTransport({baseURL:`http://127.0.0.1:1234/${token}/`,fetcher:async()=>{calls++;return json({});}});await desktop.initialize();assert.equal(calls,0);assert.equal(desktop.route,'computer');
  const requested=[],transport=new ImageTransport({baseURL:base,permissions:permissions('granted'),fetcher:async url=>{requested.push(url);return json(manifest);}});await transport.initialize();
  await transport.fetch('volume.json');await transport.fetch('https://other.example.test/volume.raw');await transport.fetch('../volume.raw');assert.deepEqual(requested.slice(2),['volume.json','https://other.example.test/volume.raw','../volume.raw']);
  transport.useRelay();assert.equal(transport.route,'relay');assert.equal(transport.localBase,null);
 });
 return passed;
}
if(typeof process!=='undefined'&&process.argv[1]?.endsWith('test-local-transfer.mjs'))for(const name of await runLocalTransferChecks())console.log(`PASS: ${name}`);
