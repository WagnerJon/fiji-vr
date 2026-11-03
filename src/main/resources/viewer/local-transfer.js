/** Keep WebXR on HTTPS; send only image byte requests to the session's private LAN listener. */
export function privateIPv4(host) {
  const parts=host.split('.');if(parts.length!==4 || parts.some(p=>!/^\d{1,3}$/.test(p)||Number(p)>255))return false;
  const [a,b]=parts.map(Number);return a===10 || a===192&&b===168 || a===172&&b>=16&&b<=31;
}
export function localBases(manifest,base) {
  const session=base.pathname.split('/').filter(Boolean)[0];
  if(manifest?.version!==1 || !/^[a-f0-9]{32}$/.test(session||'') || manifest.session!==session || !Array.isArray(manifest.localBases))throw new Error('Invalid local connection information.');
  return [...new Set(manifest.localBases.slice(0,4).map(value=>{
    const url=new URL(value);
    if(url.protocol!=='http:' || !privateIPv4(url.hostname) || !url.port || url.username || url.password || url.pathname!==base.pathname || url.search || url.hash)throw new Error('Invalid local image address.');
    return url.href;
  }))];
}
function cancelError(){return Object.assign(new Error('Transfer cancelled'),{name:'AbortError'});}
export class ImageTransport {
  constructor({baseURL,fetcher=fetch,permissions=globalThis.navigator?.permissions,onState=()=>{},probeTimeout=12000,requestTimeout=8000}) {
    this.base=new URL('.',baseURL);this.fetcher=(...args)=>fetcher(...args);this.permissions=permissions;this.onState=onState;this.probeTimeout=probeTimeout;this.requestTimeout=requestTimeout;
    this.onComputer=['127.0.0.1','localhost','[::1]'].includes(this.base.hostname);
    this.onLAN=privateIPv4(this.base.hostname);this.candidates=[];this.localBase=null;this.busy=false;this.attempt=0;this.probes=[];
    this.route=this.onComputer?'computer':this.onLAN?'wifi':'relay';
    this.message=this.onComputer?'This computer · image data stays local.':this.onLAN?'Local network · image data stays on this network.':'Internet relay · checking for a direct local connection…';
  }
  changed(message=this.message){this.message=message;this.onState(this);}
  async permission() {
    for(const name of ['local-network','local-network-access'])try{return (await this.permissions.query({name})).state;}catch{}
    return 'unknown';
  }
  async initialize() {
    if(this.onComputer||this.onLAN){this.changed();return;}
    try {
      const response=await this.fetcher(new URL('connection.json',this.base).href,{cache:'no-store',credentials:'omit'});
      if(!response.ok)throw new Error('No local setup');
      this.candidates=localBases(await response.json(),this.base);
      if(!this.candidates.length){this.changed('Internet relay · Fiji found no available local network address. Reconnect after joining the same Wi-Fi.');return;}
      const permission=await this.permission();
      if(permission==='granted')await this.connect();
      else this.changed(permission==='denied'?'Internet relay · local-network access is blocked. Allow it in this site’s permissions, then choose Use local Wi-Fi.':'Internet relay · choose Use local Wi-Fi to transfer images directly. Allow local-network access if asked.');
    } catch {this.changed('Internet relay · direct local transfer is unavailable for this session.');}
  }
  cancelProbes(){this.attempt++;for(const controller of this.probes)controller.abort();this.probes=[];this.busy=false;}
  useRelay(){this.cancelProbes();this.localBase=null;this.route=this.onComputer?'computer':this.onLAN?'wifi':'relay';this.changed('Internet relay · image data goes through the HTTPS link.');}
  async connect() {
    if(this.onComputer||this.onLAN||!this.candidates.length)return false;
    this.cancelProbes();const attempt=this.attempt;this.busy=true;this.changed('Checking local Wi-Fi… Allow local-network access if your browser asks.');
    try {
      const attempts=this.candidates.map(async base=>{
        const controller=new AbortController();this.probes.push(controller);const timer=setTimeout(()=>controller.abort(),this.probeTimeout);
        try {
          const response=await this.fetcher(new URL('connection.json',base).href,{mode:'cors',targetAddressSpace:'local',credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
          if(!response.ok)throw new Error('Not reachable');
          const manifest=await response.json();
          if(manifest.version!==1||manifest.session!==this.base.pathname.split('/').filter(Boolean)[0])throw new Error('Wrong Fiji session');
          return base;
        }finally{clearTimeout(timer);}
      });
      const base=await Promise.any(attempts);if(attempt!==this.attempt)return false;
      this.localBase=base;this.route='wifi';this.changed('Local Wi-Fi · image data goes directly to Fiji over your local network (HTTP).');return true;
    } catch {
      if(attempt===this.attempt){this.localBase=null;this.route='relay';this.changed('Internet relay · local Wi-Fi could not connect. Use the same network, allow local-network access, and check that guest Wi-Fi is not isolating devices. Older headset browsers may block this connection.');}return false;
    } finally {
      if(attempt===this.attempt){for(const controller of this.probes)controller.abort();this.probes=[];this.busy=false;this.changed();}
    }
  }
  fetch=async(file,options={})=>{
    const source=new URL(file,this.base),name=source.pathname.slice(this.base.pathname.length),base=this.localBase;
    if(!base || source.origin!==this.base.origin || !source.pathname.startsWith(this.base.pathname) || !/^(volume|frame-[1-9][0-9]*|channel-[1-9][0-9]*-frame-[1-9][0-9]*)\.raw$/.test(name))return this.fetcher(file,options);
    if(options.signal?.aborted)throw cancelError();
    const url=new URL(name+source.search,base);
    // LAN bandwidth avoids the relay; skip gzip work for these short native-byte pieces.
    if(url.searchParams.get('compression')==='gzip')url.searchParams.set('compression','identity');
    const controller=new AbortController(),cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>controller.abort(),this.requestTimeout);
    try {
      const response=await this.fetcher(url.href,{...options,mode:'cors',credentials:'omit',redirect:'error',targetAddressSpace:'local',signal:controller.signal});
      if(!response.ok)throw new Error('Local response unavailable');
      // Finish and check a piece here so a lost/truncated local body can fall back too.
      const buffer=await response.arrayBuffer(),chunk=url.searchParams.get('chunk'),range=options.headers?.Range;
      const match=chunk?/^(\d+)-(\d+)$/.exec(chunk):/^bytes=(\d+)-(\d+)$/.exec(range||'');
      if(match){
        const [,start,end]=match,identity=response.headers.get(chunk?'X-Fiji-Raw-Range':'Content-Range');
        if(response.status!==(chunk?200:206) || !identity?.startsWith(`bytes ${start}-${end}/`) || buffer.byteLength!==Number(end)-Number(start)+1 || chunk&&response.headers.get('X-Fiji-Encoding')!=='identity')throw new Error('Incomplete local image transfer');
      }
      return new Response(buffer,{status:response.status,headers:response.headers});
    } catch(error) {
      if(options.signal?.aborted)throw cancelError();
      if(this.localBase===base){this.localBase=null;this.route='relay';this.changed('Internet relay · local Wi-Fi was lost or blocked. Retrying this image piece through the HTTPS link.');}
      return this.fetcher(file,options);
    }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);}
  };
}
