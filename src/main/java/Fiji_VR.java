import ij.IJ;
import ij.ImagePlus;
import ij.WindowManager;
import ij.measure.Calibration;
import ij.plugin.PlugIn;
import ij.process.ImageProcessor;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.function.BooleanSupplier;

/** Calibrated spatial data of every channel and time point; original resolution by default. */
public class Fiji_VR implements PlugIn {
    public void run(String arg) {
        ImagePlus image = WindowManager.getCurrentImage();
        if (image == null) { IJ.noImage(); return; }
        javax.swing.SwingUtilities.invokeLater(() -> ViewerWindow.open(image, "preview".equals(arg)));
    }
    static void export(ImagePlus image, int maxAxis, Path output) throws IOException {
        export(image, maxAxis, output, () -> false);
    }
    static void export(ImagePlus image, int maxAxis, Path output, BooleanSupplier cancelled) throws IOException {
        int w=image.getWidth(), h=image.getHeight(), d=image.getNSlices(), frames=image.getNFrames();
        int channel=image.getC(), initial=image.getT();
        double ratio=maxAxis<=0?1.0:Math.min(1.0,maxAxis/(double)Math.max(w,Math.max(h,d)));
        int nx=Math.max(1,(int)Math.round(w*ratio)), ny=Math.max(1,(int)Math.round(h*ratio)), nz=Math.max(1,(int)Math.round(d*ratio));
        boolean rgb=image.getBitDepth()==24;
        int channels=image.getNChannels();
        long required;
        try {required=Math.multiplyExact(Math.multiplyExact(Math.multiplyExact(Math.multiplyExact((long)nx,ny),nz),rgb?4:1),Math.multiplyExact((long)frames,channels));}
        catch(ArithmeticException tooLarge){throw new IOException("This dataset is too large to export at original resolution.");}
        if (required > Files.getFileStore(output).getUsableSpace()) throw new IOException("There isn’t enough free space to prepare this multidimensional stack.");
        StringBuilder channelData=new StringBuilder("[");
        String selectedFiles="[]";float selectedMin=0,selectedMax=0;
        ij.process.LUT[] luts=image.getLuts();
        for(int ch=1;ch<=channels;ch++) {
            float min=Float.POSITIVE_INFINITY,max=Float.NEGATIVE_INFINITY;
            if (!rgb) for(int t=1;t<=frames;t++) {
                IJ.showStatus("Fiji VR: checking channel " + ch + ", time " + t + " / " + frames);
                for(int z=0;z<nz;z++) {
                    checkCancelled(cancelled);
                    ImageProcessor plane=plane(image,ch,t,z,nz);
                    for(int y=0;y<ny;y++)for(int x=0;x<nx;x++) {
                        float value=plane.getf(coordinate(x,w,nx),coordinate(y,h,ny));
                        if(Float.isFinite(value)) {min=Math.min(min,value);max=Math.max(max,value);}
                    }
                }
            }
            if(rgb) {min=0;max=255;} else if(!Float.isFinite(min)) {min=0;max=0;}
            StringBuilder files=new StringBuilder("[");
            for(int t=1;t<=frames;t++) {
                checkCancelled(cancelled);
                IJ.showStatus("Fiji VR: preparing C " + ch + " / " + channels + ", T " + t + " / " + frames);
                String filename=ch==channel?(t==initial?"volume.raw":"frame-"+t+".raw"):"channel-"+ch+"-frame-"+t+".raw";
                writeFrame(image,ch,t,nx,ny,nz,rgb,min,max,output.resolve(filename),cancelled);
                if(t>1)files.append(',');
                files.append('"').append(filename).append('"');
                IJ.showProgress((ch-1)*frames+t,channels*frames);
            }
            files.append(']');
            int tint=0xffffff;
            if(!rgb && ch<=luts.length) {tint=luts[ch-1].getRGB(255)&0xffffff;if(tint==0)tint=0xffffff;}
            if(ch>1)channelData.append(',');
            channelData.append("{\"name\":\"Channel ").append(ch).append("\",\"color\":\"#").append(String.format("%06x",tint)).append("\",\"sourceRange\":[").append(min).append(',').append(max).append("],\"frames\":").append(files).append('}');
            if(ch==channel) {selectedFiles=files.toString();selectedMin=min;selectedMax=max;}
        }
        channelData.append(']');
        Calibration c=image.getCalibration();
        double sx=positive(c.pixelWidth)*w/nx,sy=positive(c.pixelHeight)*h/ny,sz=positive(c.pixelDepth)*d/nz;
        double interval=Double.isFinite(c.frameInterval) && c.frameInterval>0 ? c.frameInterval : 0;
        String json="{\"originalShape\":["+w+","+h+","+d+"],\"spatialReduction\":"+(ratio<1.0)+",\"channelCount\":"+channels+",\"channels\":"+channelData+",\"slice\":"+image.getZ()+",\"sourceSlices\":"+d+",\"shape\":["+nx+","+ny+","+nz+"],\"spacing\":["+sx+","+sy+","+sz+"],\"unit\":\""+escape(c.getUnit())+"\",\"title\":\""+escape(image.getTitle())+"\",\"channel\":"+channel+",\"frame\":"+initial+",\"frameCount\":"+frames+",\"frames\":"+selectedFiles+",\"frameInterval\":"+interval+",\"timeUnit\":\""+escape(c.getTimeUnit())+"\",\"sourceRange\":["+selectedMin+","+selectedMax+"],\"encoding\":\""+(rgb?"rgba8":"uint8")+"\",\"order\":\"x-fastest\"}";
        Files.write(output.resolve("volume.json"),json.getBytes(StandardCharsets.UTF_8));
        IJ.showStatus("Fiji VR: ready");
    }
    private static int coordinate(int index,int original,int size) {return Math.min(original-1,(int)((index+.5)*original/size));}
    private static ImageProcessor plane(ImagePlus image,int channel,int frame,int z,int depth) {
        return image.getStack().getProcessor(image.getStackIndex(channel,coordinate(z,image.getNSlices(),depth)+1,frame));
    }
    private static void writeFrame(ImagePlus image,int channel,int frame,int nx,int ny,int nz,boolean rgb,float min,float max,Path path,BooleanSupplier cancelled) throws IOException {
        long rowBytes=(long)nx*(rgb?4:1);
        if(rowBytes>Integer.MAX_VALUE-8)throw new IOException("Image row is too large to export.");
        byte[] row=new byte[(int)rowBytes];double range=(double)max-min;
        try(OutputStream out=new BufferedOutputStream(Files.newOutputStream(path),65536)) {
            for(int z=0;z<nz;z++) {
                checkCancelled(cancelled);ImageProcessor source=plane(image,channel,frame,z,nz);
                for(int y=0;y<ny;y++) {
                    checkCancelled(cancelled);int i=0,py=coordinate(y,image.getHeight(),ny);
                    for(int x=0;x<nx;x++) {
                        int px=coordinate(x,image.getWidth(),nx);
                        if(rgb) {int color=source.getPixel(px,py);row[i++]=(byte)(color>>16);row[i++]=(byte)(color>>8);row[i++]=(byte)color;row[i++]=(byte)255;}
                        else {float value=source.getf(px,py);row[i++]=(byte)(Float.isFinite(value)&&range>0?Math.round(255*(value-(double)min)/range):0);}
                    }
                    out.write(row);
                }
            }
        }
    }
    private static void checkCancelled(BooleanSupplier cancelled) throws InterruptedIOException {
        if(cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Image preparation cancelled.");
    }
    private static double positive(double v) { return Double.isFinite(v) && v>0?v:1; }
    private static String escape(String s) {
        StringBuilder b=new StringBuilder();
        for(char c:s.toCharArray()) {
            if(c=='"' || c=='\\') b.append('\\').append(c);
            else if(c<32) b.append(String.format("\\u%04x",(int)c));
            else b.append(c);
        }
        return b.toString();
    }
}
