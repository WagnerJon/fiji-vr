import ij.ImagePlus;
import ij.ImageStack;
import ij.process.ColorProcessor;
import ij.process.ByteProcessor;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import java.util.concurrent.CountDownLatch;

public class HighResolutionPreview {
    public static void main(String[] args) throws Exception {
        ImagePlus image;
        if(args.length>0 && args[0].equals("slices")) {
            ImageStack stack=new ImageStack(2048,2048);
            for(int z=0;z<3;z++) {byte[] data=new byte[2048*2048];for(int y=0;y<2048;y++)for(int x=0;x<2048;x++)data[y*2048+x]=(byte)((x/8+y/8+z*85)%256);stack.addSlice(new ByteProcessor(2048,2048,data));}
            image=new ImagePlus("Original-resolution Z slices",stack);image.setPosition(1,2,1);
        } else {
            BufferedImage bitmap=new BufferedImage(2048,2048,BufferedImage.TYPE_INT_RGB);
            Graphics2D graphics=bitmap.createGraphics();graphics.setColor(new Color(8,18,35));graphics.fillRect(0,0,2048,2048);
            for(int x=0;x<2048;x+=8){graphics.setColor(x%128==0?new Color(90,180,200):new Color(35,60,75));graphics.drawLine(x,0,x,2047);graphics.drawLine(0,x,2047,x);}
            graphics.setFont(new Font("SansSerif",Font.BOLD,120));graphics.setColor(Color.WHITE);graphics.drawString("ORIGINAL",380,800);graphics.drawString("2048 × 2048",260,1020);
            graphics.setColor(Color.ORANGE);graphics.setStroke(new BasicStroke(1));graphics.drawLine(1001,1150,1001,1900);graphics.setFont(new Font("SansSerif",Font.PLAIN,60));graphics.drawString("1-pixel line",1050,1300);graphics.dispose();
            image=new ImagePlus("Original 2048 × 2048 detail",new ColorProcessor(bitmap));
        }
        Path directory=Files.createTempDirectory("fiji-vr-original-");Fiji_VR.export(image,0,directory);
        ViewerSession session=new ViewerSession(directory);System.out.println(session.url(session.localOrigin()));new CountDownLatch(1).await();
    }
}
