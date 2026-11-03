import { fetchByteRange } from './transfer.js';
/** A rendering choice, never an image-resizing operation. */
export function resolutionPlan(shape, components, max3D, max2D, budget = Infinity, forceSlices = false) {
  if (!Array.isArray(shape) || shape.length !== 3 || !shape.every(n=>Number.isSafeInteger(n) && n>0)) throw new Error('Invalid image dimensions.');
  const planeBytes=shape[0]*shape[1]*components,volumeBytes=planeBytes*shape[2];
  if (!Number.isSafeInteger(volumeBytes)) throw new Error('Image dimensions are too large.');
  if (shape[0]>max2D || shape[1]>max2D || (forceSlices && planeBytes>budget)) throw new Error(`This device cannot display a ${shape[0]} × ${shape[1]} plane at original resolution. The image has not been reduced. Try a device with a larger texture limit or crop an area in Fiji.`);
  const slices=forceSlices;
  return { slices, planeBytes, volumeBytes, bytesPerFrame:slices?planeBytes:volumeBytes,
    reason:slices?'Original-resolution slices · explicitly selected':'Full-resolution volume' };
}
export function sampledSlice(sourceIndex, sourceDepth, textureDepth) {
  return Math.max(0,Math.min(textureDepth-1,Math.floor((sourceIndex+.5)*textureDepth/sourceDepth)));
}
export async function fetchSlice(file, z, planeBytes, signal, fetcher=fetch) {
  return fetchByteRange(file,z*planeBytes,planeBytes,signal,fetcher);
}
