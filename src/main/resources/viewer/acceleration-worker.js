import { blockMaximumGrid } from './acceleration.js';
self.onmessage=event=>{
 const {data,shape,block,components,cellSize}=event.data;
 try{const maxima=blockMaximumGrid(data,shape,block,components,cellSize);self.postMessage({data,maxima},[data.buffer,maxima.buffer]);}
 catch(error){self.postMessage({error:error.message});}
};
