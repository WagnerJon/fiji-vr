import ij.ImagePlus;
import ij.ImageStack;
import ij.process.ByteProcessor;
import java.nio.file.*;
import java.util.concurrent.CountDownLatch;

/** Native 2048-square volume larger than the removed 128 MiB cutoff. */
public class FullVolumePreview {
    public static void main(String[] args) throws Exception {
        int width=2048,height=2048,depth=40;ImageStack stack=new ImageStack(width,height);
        for(int z=0;z<depth;z++) {
            byte[] pixels=new byte[width*height];
            double c=(z-(depth-1)*.5)/depth;
            for(int y=0;y<height;y++)for(int x=0;x<width;x++) {
                double a=(x-1023.5)/width,b=(y-1023.5)/height;
                double radius=Math.sqrt(a*a+b*b+c*c);
                double shell=Math.exp(-Math.pow((radius-.30)/.012,2));
                double nucleus=Math.exp(-((a+.08)*(a+.08)+(b-.06)*(b-.06)+(c+.04)*(c+.04))/.003);
                pixels[y*width+x]=(byte)Math.round(255*Math.max(shell*.7,nucleus));
            }
            stack.addSlice(new ByteProcessor(width,height,pixels));
        }
        ImagePlus image=new ImagePlus("Native 2048 × 2048 × 40 full volume",stack);
        image.getCalibration().pixelDepth=40;image.setPosition(1,20,1);
        Path output=Files.createTempDirectory("fiji-vr-full-volume-");Fiji_VR.export(image,0,output);
        ViewerSession session=new ViewerSession(output);
        if(args.length>0 && args[0].equals("public")){TunnelConnection connection=new TunnelConnection();session.tunnel=connection;String remote=connection.connect(session.localOrigin(),"/"+session.token+"/volume.json",System.out::println,System.out::println);System.out.println(session.url(remote));}
        else System.out.println(session.url(session.localOrigin()));
        new CountDownLatch(1).await();
    }
}
