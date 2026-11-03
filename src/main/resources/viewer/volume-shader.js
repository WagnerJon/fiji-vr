export const vertexShader = `
varying vec3 localPosition;
void main(){localPosition=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
export const fragmentShader = `
precision highp float;
precision highp sampler3D;
__VOLUME_SAMPLERS__
uniform vec3 eye;
uniform vec3 extent;
uniform float threshold;
uniform float density;
uniform float clipDepth;
uniform int mode;
uniform bool isRGB;
uniform vec3 channelTint;
uniform vec3 voxelShape;
uniform sampler3D accelerationGrid;
uniform vec3 accelerationShape;
uniform vec3 cellSize;
uniform bool useAcceleration;
varying vec3 localPosition;
void main(){
  vec3 direction=normalize(localPosition-eye);
  vec3 safeDir=vec3(direction.x<0.0?-1.0:1.0,direction.y<0.0?-1.0:1.0,direction.z<0.0?-1.0:1.0)*max(abs(direction),vec3(0.000001));
  vec3 lo=-extent*0.5;
  vec3 hi=extent*0.5;
  hi.z=lo.z+extent.z*clipDepth;
  vec3 a=(lo-eye)/safeDir, b=(hi-eye)/safeDir;
  vec3 nearT=min(a,b), farT=max(a,b);
  float start=max(max(nearT.x,nearT.y),max(nearT.z,0.0));
  float stop=min(min(farT.x,farT.y),farT.z);
  if(stop<=start) discard;
  float voxelRate=max(max(abs(direction.x)*voxelShape.x/extent.x,abs(direction.y)*voxelShape.y/extent.y),abs(direction.z)*voxelShape.z/extent.z);
  int steps=max(1,int(ceil((stop-start)*voxelRate)));
  float stepSize=(stop-start)/float(steps);
  vec3 previousCell=vec3(-1.0);float maximum=1.0;
  float peak=0.0; vec3 peakColor=vec3(0.0); vec4 acc=vec4(0.0);
  for(int i=0;i<steps;i++){
    vec3 p=eye+direction*(start+(float(i)+0.5)*stepSize);
    vec3 uv=p/extent+0.5;
    uv.y=1.0-uv.y;
    if(useAcceleration){
      vec3 cell=clamp(floor(uv*voxelShape/cellSize),vec3(0.0),accelerationShape-1.0);
      if(any(notEqual(cell,previousCell))){
        float bound=texture(accelerationGrid,(cell+0.5)/accelerationShape).r;
        maximum=bound==0.0?0.0:min(1.0,bound+0.000001);previousCell=cell;
      }
      float signalBound=max(0.0,(maximum-threshold)/(1.0-threshold));
      if(maximum<=threshold || (mode==0 && signalBound<=peak)){
        vec3 rate=direction/extent;rate.y=-rate.y;
        vec3 low=cell*cellSize/voxelShape,high=min((cell+1.0)*cellSize,voxelShape)/voxelShape;
        vec3 boundary=mix(low,high,step(vec3(0.0),rate));
        vec3 crossing=vec3(1e20);
        if(abs(rate.x)>0.000000001)crossing.x=max(0.0,(boundary.x-uv.x)/rate.x);
        if(abs(rate.y)>0.000000001)crossing.y=max(0.0,(boundary.y-uv.y)/rate.y);
        if(abs(rate.z)>0.000000001)crossing.z=max(0.0,(boundary.z-uv.z)/rate.z);
        float exitTime=start+(float(i)+0.5)*stepSize+min(min(crossing.x,crossing.y),crossing.z);
        // Stop one lattice point before the boundary: never skip an unbounded sample.
        int jump=int(floor(min(float(steps), (exitTime-start)/stepSize-0.5)))-1;
        i=max(i,min(steps-1,jump));continue;
      }
    }
    vec3 sampleColor=sampleVolume(uv);
    // Max RGB intensity keeps saturated red, green and blue equally visible.
    float value=isRGB ? max(max(sampleColor.r,sampleColor.g),sampleColor.b) : sampleColor.r;
    float signal=max(0.0,(value-threshold)/(1.0-threshold));
    if(mode==0){
      if(signal>peak){peak=signal;peakColor=sampleColor;}
      if(peak>=1.0)break;
    }else{
      float alpha=1.0-exp(-signal*density*stepSize*8.0);
      vec3 color=isRGB ? sampleColor : channelTint*signal;
      acc.rgb+=(1.0-acc.a)*alpha*color;
      acc.a+=(1.0-acc.a)*alpha;
      if(acc.a>=1.0)break;
    }
  }
  if(mode==0){if(peak<0.005)discard;gl_FragColor=vec4(isRGB ? peakColor : channelTint*peak,peak);}
  else {if(acc.a<0.005)discard;gl_FragColor=vec4(acc.rgb/max(acc.a,0.0001),acc.a);}
}`;
