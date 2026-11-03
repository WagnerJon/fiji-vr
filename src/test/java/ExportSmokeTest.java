import ij.ImagePlus;
import ij.ImageStack;
import ij.process.FloatProcessor;
import ij.process.ByteProcessor;
import ij.process.ColorProcessor;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Headless integration checks against real ImageJ classes. */
public class ExportSmokeTest {
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("fiji-vr-check-");
        try {
            ImageStack stack = new ImageStack(2, 2);
            stack.addSlice(new FloatProcessor(2, 2, new float[]{0, 10, Float.NaN, Float.POSITIVE_INFINITY}));
            stack.addSlice(new FloatProcessor(2, 2, new float[]{20, 30, 40, 50}));
            ImagePlus image = new ImagePlus("Test \"volume\"\n", stack);
            image.getCalibration().pixelWidth = 2;
            image.getCalibration().pixelHeight = 3;
            image.getCalibration().pixelDepth = 7;
            image.getCalibration().setUnit("um");
            Fiji_VR.export(image, 32, root);
            byte[] actual = Files.readAllBytes(root.resolve("volume.raw"));
            byte[] expected = {0,51,0,0,102,(byte)153,(byte)204,(byte)255};
            check(Arrays.equals(actual, expected), "normalization, non-finite handling, x-fastest/Z ordering");
            String json = new String(Files.readAllBytes(root.resolve("volume.json")), StandardCharsets.UTF_8);
            check(json.contains("\"spacing\":[2.0,3.0,7.0]"), "anisotropic calibration");
            check(json.contains("Test \\\"volume\\\""), "JSON escaping: " + json);
            check(image.getStack().getProcessor(2).getf(1,1) == 50, "source unchanged");

            ImageStack hyper = new ImageStack(1,1);
            for(int i=1;i<=8;i++) hyper.addSlice(new ByteProcessor(1,1,new byte[]{(byte)i}));
            ImagePlus multi = new ImagePlus("Hyperstack",hyper);
            multi.setDimensions(2,2,2); multi.setPosition(2,1,2);
            Fiji_VR.export(multi,32,root);
            check(Arrays.equals(Files.readAllBytes(root.resolve("volume.raw")),new byte[]{(byte)170,(byte)255}), "initial time Z planes use series-wide range");
            json = new String(Files.readAllBytes(root.resolve("volume.json")),StandardCharsets.UTF_8);
            check(json.contains("\"sourceRange\":[2.0,8.0]") && json.contains("\"channel\":2,\"frame\":2"), "hyperstack indexing");
            check(Arrays.equals(Files.readAllBytes(root.resolve("frame-1.raw")),new byte[]{0,85}), "earlier time point retains selected channel and Z order");
            check(json.contains("\"frameCount\":2") && json.contains("\"frames\":[\"frame-1.raw\",\"volume.raw\"]"), "time-series manifest and initial frame");
            check(multi.getC()==2 && multi.getT()==2, "source channel/time selection unchanged");
            check(Arrays.equals(Files.readAllBytes(root.resolve("channel-1-frame-1.raw")),new byte[]{0,85}), "all channels export earlier time and correct Z planes");
            check(Arrays.equals(Files.readAllBytes(root.resolve("channel-1-frame-2.raw")),new byte[]{(byte)170,(byte)255}), "all channels export later time independently");
            check(json.contains("\"channelCount\":2") && json.contains("\"channels\":[") && json.contains("channel-1-frame-2.raw"), "multichannel manifest");
            ImagePlus constant = new ImagePlus("Constant",new FloatProcessor(2,1,new float[]{5,5}));
            Fiji_VR.export(constant,32,root);
            check(Arrays.equals(Files.readAllBytes(root.resolve("volume.raw")),new byte[]{0,0}), "constant data");
            ImagePlus large = new ImagePlus("Downsample",new ByteProcessor(64,32));
            Fiji_VR.export(large,32,root);
            json = new String(Files.readAllBytes(root.resolve("volume.json")),StandardCharsets.UTF_8);
            check(json.contains("\"shape\":[32,16,1]") && json.contains("\"spacing\":[2.0,2.0,1.0]"), "bounded export preserves physical extent");
            ImageStack rgb = new ImageStack(2,1);
            rgb.addSlice(new ColorProcessor(2,1,new int[]{0xff0000,0x00ff00}));
            rgb.addSlice(new ColorProcessor(2,1,new int[]{0x0000ff,0x804020}));
            ImagePlus color = new ImagePlus("RGB",rgb);
            Fiji_VR.export(color,32,root);
            check(Arrays.equals(Files.readAllBytes(root.resolve("volume.raw")),new byte[]{(byte)255,0,0,(byte)255,0,(byte)255,0,(byte)255,0,0,(byte)255,(byte)255,(byte)128,64,32,(byte)255}), "RGB channel bytes across Z planes");
            json = new String(Files.readAllBytes(root.resolve("volume.json")),StandardCharsets.UTF_8);
            check(json.contains("\"encoding\":\"rgba8\""), "RGB encoding metadata");
            check(color.getStack().getProcessor(1).getPixel(0,0)==0xff0000, "RGB source unchanged");
            ImageStack rgbTime = new ImageStack(1,1);
            for(int colorValue:new int[]{0xff0000,0x00ff00,0x0000ff,0xff8040}) rgbTime.addSlice(new ColorProcessor(1,1,new int[]{colorValue}));
            ImagePlus rgb4d = new ImagePlus("RGB over time",rgbTime); rgb4d.setDimensions(1,2,2);rgb4d.setPosition(1,1,2);
            rgb4d.getCalibration().frameInterval=2.5;rgb4d.getCalibration().setTimeUnit("sec");
            Fiji_VR.export(rgb4d,32,root);
            check(Arrays.equals(Files.readAllBytes(root.resolve("frame-1.raw")),new byte[]{(byte)255,0,0,(byte)255,0,(byte)255,0,(byte)255}), "RGB first time point");
            check(Arrays.equals(Files.readAllBytes(root.resolve("volume.raw")),new byte[]{0,0,(byte)255,(byte)255,(byte)255,(byte)128,64,(byte)255}), "RGB initial time point");
            json = new String(Files.readAllBytes(root.resolve("volume.json")),StandardCharsets.UTF_8);
            check(json.contains("\"frameInterval\":2.5") && json.contains("\"timeUnit\":\"sec\""), "time calibration");
            try { Fiji_VR.export(rgb4d,32,root,()->true); throw new AssertionError("cancellation ignored"); }
            catch(java.io.InterruptedIOException expectedCancellation) { }
            byte[] originalPixels=new byte[2048*2048];
            for(int y=0;y<2048;y++)originalPixels[y*2048+1001]=(byte)255;
            originalPixels[2048*2048-1]=127;
            ImagePlus detail=new ImagePlus("2048 pixel detail",new ByteProcessor(2048,2048,originalPixels));
            Fiji_VR.export(detail,0,root);
            check(Arrays.equals(Files.readAllBytes(root.resolve("volume.raw")),originalPixels), "all 2048 × 2048 grayscale pixels and one-pixel-wide feature retained");
            json=new String(Files.readAllBytes(root.resolve("volume.json")),StandardCharsets.UTF_8);
            check(json.contains("\"shape\":[2048,2048,1]") && json.contains("\"spatialReduction\":false"), "original dimensions are the default export contract");
            ImagePlus rgbDetail=new ImagePlus("RGB detail",new ColorProcessor(2048,2,new int[4096]));
            rgbDetail.getProcessor().set(2047,1,0x12abef);Fiji_VR.export(rgbDetail,0,root);
            byte[] rgbBytes=Files.readAllBytes(root.resolve("volume.raw"));
            check(rgbBytes.length==2048*2*4 && rgbBytes[rgbBytes.length-4]==0x12 && (rgbBytes[rgbBytes.length-3]&255)==0xab && (rgbBytes[rgbBytes.length-2]&255)==0xef,"RGB high-resolution edge pixel retained");
            check(Fiji_VR.class.getResourceAsStream("/viewer/index.html") != null && Fiji_VR.class.getResourceAsStream("/viewer/viewer.js") != null, "viewer resources packaged");
            System.out.println("PASS: ImageJ export integration checks");
        } finally {
            ViewerSession.deletePreview(root);
        }
    }
    private static void check(boolean ok,String label) { if(!ok) throw new AssertionError(label); }
}
