import ij.ImagePlus;
import ij.ImageStack;
import ij.process.ColorProcessor;
import ij.process.ByteProcessor;
import ij.CompositeImage;
import ij.process.LUT;
import java.nio.file.*;
import java.util.concurrent.CountDownLatch;
public class ViewerPreview {
    public static void main(String[] args) throws Exception {
        int n=64;ImageStack stack=new ImageStack(n,n);
        for(int t=0;t<3;t++) for(int z=0;z<n;z++) for(int ch=0;ch<2;ch++) {
            int[] pixels=new int[n*n];
            for(int y=0;y<n;y++)for(int x=0;x<n;x++) {
                double a=(x-31.5)/n,b=(y-31.5)/n,c=(z-31.5)/n;
                double r=Math.sqrt(a*a+b*b+c*c);
                int signal=(int)(255*Math.exp(-Math.pow((r-(.22+.05*t))/.018,2)));
                int red=(int)(signal*(.5+a)),green=(int)(signal*(.5+b)),blue=signal;
                pixels[y*n+x]=(red<<16)|(green<<8)|blue;
                if((a+.16-.12*t)*(a+.16-.12*t)+(b-.1)*(b-.1)+c*c<.005) pixels[y*n+x]=0xff5030;
            }
            byte[] plane=new byte[n*n];
            for(int y=0;y<n;y++)for(int x=0;x<n;x++) {
                double a=(x-31.5)/n,b=(y-31.5)/n,c=(z-31.5)/n;
                double v=ch==0?Math.exp(-Math.pow((Math.sqrt(a*a+b*b+c*c)-(.22+.05*t))/.018,2)):Math.exp(-((a+.16-.12*t)*(a+.16-.12*t)+(b-.1)*(b-.1)+c*c)/.008);
                plane[y*n+x]=(byte)Math.round(v*255);
            }
            stack.addSlice(new ByteProcessor(n,n,plane));
        }
        ImagePlus image=new ImagePlus("5D cell · synthetic preview",stack); image.setDimensions(2,n,3); image=new CompositeImage(image,CompositeImage.COMPOSITE); ((CompositeImage)image).setChannelLut(LUT.createLutFromColor(java.awt.Color.CYAN),1); ((CompositeImage)image).setChannelLut(LUT.createLutFromColor(java.awt.Color.MAGENTA),2); image.setPosition(1,32,2); image.getCalibration().pixelDepth=1.5; image.getCalibration().frameInterval=2.5;image.getCalibration().setTimeUnit("sec");
        if(args.length>0 && args[0].equals("window")) {
            javax.swing.UIManager.setLookAndFeel(javax.swing.UIManager.getSystemLookAndFeelClassName());
            final ImagePlus previewImage=image;javax.swing.SwingUtilities.invokeLater(()->ViewerWindow.open(previewImage));
        } else {
            Path directory=Files.createTempDirectory("fiji-vr-rgb-preview-");Fiji_VR.export(image,192,directory);
            ViewerSession session=new ViewerSession(directory);System.out.println(session.url(session.localOrigin()));
            new CountDownLatch(1).await();
        }
    }
}
