/** Small resumable network requests; GPU blocks and source resolution are unchanged. */
export const TRANSFER_CHUNK_BYTES=2*1024*1024;
function aborted(){const error=new Error('Transfer cancelled');error.name='AbortError';return error;}
async function backoff(ms,signal){
  if(signal?.aborted)throw aborted();
  await new Promise((resolve,reject)=>{
    const stop=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(aborted());};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);
    signal?.addEventListener('abort',stop,{once:true});
  });
}
async function segment(file,start,length,signal,fetcher,retries,timeout){
  let last;
  for(let attempt=0;attempt<=retries;attempt++){
    if(signal.aborted)throw aborted();
    const controller=new AbortController(),cancel=()=>controller.abort();
    signal.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const compressed=typeof DecompressionStream==='function' && typeof Response==='function';
      const url=compressed?`${file}${file.includes('?')?'&':'?'}chunk=${start}-${start+length-1}&compression=gzip`:file;
      const response=await fetcher(url,{signal:controller.signal,cache:'no-store',headers:compressed?{}:{Range:`bytes=${start}-${start+length-1}`}});
      if(response.status!==(compressed?200:206)){
        const error=new Error(response.status===404 || response.status===410?'The Fiji viewing session or image is no longer available.':'The connection did not return the requested image bytes.');
        error.permanent=[400,404,410,416].includes(response.status);throw error;
      }
      const range=response.headers?.get(compressed?'X-Fiji-Raw-Range':'Content-Range');
      if(compressed && !range)throw new Error('The connection did not identify the image segment. Restart Fiji with the updated plugin.');
      if(range && !range.startsWith(`bytes ${start}-${start+length-1}/`))throw new Error('The connection returned the wrong image range.');
      const encoding=compressed?response.headers?.get('X-Fiji-Encoding'):'identity';
      if(compressed && !['gzip','identity'].includes(encoding))throw new Error('Invalid image transfer encoding.');
      const buffer=encoding==='gzip'
        ? await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
        : await response.arrayBuffer();
      const bytes=new Uint8Array(buffer);
      if(bytes.length!==length)throw new Error(`Incomplete image transfer (${bytes.length} of ${length} bytes).`);
      const declared=Number(response.headers?.get('Content-Length'));
      return {bytes,wireBytes:declared>0?declared:bytes.length};
    }catch(error){
      if(signal.aborted)throw aborted();
      last=error;if(error.permanent)break;
    }finally{controller.abort();clearTimeout(timer);signal.removeEventListener('abort',cancel);}
    if(attempt<retries)await backoff(250*2**attempt,signal);
  }
  const error=new Error(`Image download failed after retrying. Keep the Fiji window open and check the headset connection. ${last?.message || ''}`);
  error.cause=last;throw error;
}
export async function fetchByteRange(file,start,length,signal,fetcher=fetch,options={}){
  if(!Number.isSafeInteger(start) || start<0 || !Number.isSafeInteger(length) || length<=0)throw new Error('Invalid image byte range.');
  if(signal?.aborted)throw aborted();
  const chunkSize=options.chunkBytes || TRANSFER_CHUNK_BYTES;
  const concurrency=Math.max(1,Math.min(3,options.concurrency || 3));
  const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  const output=new Uint8Array(length);let next=0,received=0,wireReceived=0;
  async function worker(){
    while(next<length){
      if(controller.signal.aborted)throw aborted();
      const offset=next,size=Math.min(chunkSize,length-offset);next+=size;
      const result=await segment(file,start+offset,size,controller.signal,fetcher,options.retries ?? 3,options.timeoutMs || 45000);
      output.set(result.bytes,offset);received+=size;wireReceived+=result.wireBytes;options.onProgress?.(received,length,wireReceived);
    }
  }
  try{await Promise.all(Array.from({length:Math.min(concurrency,Math.ceil(length/chunkSize))},worker));return output;}
  catch(error){controller.abort();throw error;}
  finally{signal?.removeEventListener('abort',cancel);}
}
