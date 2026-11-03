import java.net.*;
import java.io.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.awt.image.BufferedImage;
import com.google.zxing.*;
import com.google.zxing.common.HybridBinarizer;

/** Real loopback requests, URL access boundary, lifecycle, and decodable QR. */
public class SessionSmokeTest {
    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("fiji-vr-server-test-");
        Files.write(directory.resolve("volume.json"), "{}".getBytes(StandardCharsets.UTF_8));
        Files.write(directory.resolve("volume.raw"),new byte[]{1,2,3});
        Files.write(directory.resolve("frame-2.raw"),new byte[]{4,5,6});
        Files.write(directory.resolve("channel-2-frame-2.raw"),new byte[]{7,8,9});
        ViewerSession session = new ViewerSession(directory);
        String origin = session.localOrigin(), base = session.url(origin);
        try {
            check(request(base,"GET")==200,"viewer index");
            check(request(base+"viewer.js","GET")==200,"viewer script");
            check(request(base+"interaction.js","GET")==200,"packaged interaction module");
            check(request(base+"vendor/three.module.js","GET")==200,"offline Three.js");
            check(request(base+"vendor/OrbitControls.js","GET")==200,"offline controls");
            check(request(base+"volume.raw","HEAD")==200,"HEAD data");
            check(request(base+"volume.json","GET")==200,"metadata");
            check(request(base+"frame-2.raw","GET")==200,"time-series frame");
            check(request(base+"frame-99.raw","GET")==404,"missing time point");
            check(request(base+"timeline.js","GET")==200,"time-series module");
            check(request(base+"dimension-panel.js","GET")==200,"in-headset dimension panel");
            check(request(base+"channel-2-frame-2.raw","GET")==200,"multichannel time point");
            check(request(base+"channel-2-frame-99.raw","GET")==404,"missing channel/time");
            check(request(origin+"/volume.raw","GET")==404,"token required");
            check(request(base+"../volume.raw","GET")==404,"path traversal blocked");
            check(request(base+"%2e%2e/volume.raw","GET")==404,"encoded traversal blocked");
            check(request(base+"unknown","GET")==404,"allowlisted paths");
            check(request(base,"POST")==405,"read-only server");
            HttpURLConnection partial=(HttpURLConnection)new URL(base+"volume.raw").openConnection();
            partial.setRequestProperty("Range","bytes=1-2");
            try {
                check(partial.getResponseCode()==206,"partial frame response");
                check("bytes 1-2/3".equals(partial.getHeaderField("Content-Range")),"slice byte range header");
                try(InputStream body=partial.getInputStream()){check(body.read()==2 && body.read()==3 && body.read()==-1,"only requested bytes served");}
            } finally {partial.disconnect();}
            HttpURLConnection invalid=(HttpURLConnection)new URL(base+"volume.raw").openConnection();invalid.setRequestProperty("Range","bytes=4-8");
            try{check(invalid.getResponseCode()==416,"invalid slice range rejected");}finally{invalid.disconnect();}
            check(ViewerSession.byteRange("bytes=3000000000-3000000010",5000000000L)[0]==3000000000L,"large volume offsets use 64-bit addressing");
            check(request(base+"resolution.js","GET")==200,"original-resolution module packaged");
            check(request(base+"volume-blocks.js","GET")==200,"full-volume block renderer packaged");
            check(request(base+"volume-shader.js","GET")==200,"volume shader packaged");
            check(request(base+"transfer.js","GET")==200,"resumable transfer module packaged");
            check(request(base+"acceleration.js","GET")==200,"conservative acceleration module packaged");
            check(request(base+"acceleration-worker.js","GET")==200,"preprocessing worker packaged");
            check(request(base+"render-performance.js","GET")==200,"renderer timing module packaged");
            HttpURLConnection zipped=(HttpURLConnection)new URL(base+"volume.raw?chunk=0-2&compression=gzip").openConnection();
            try{check(zipped.getResponseCode()==200,"lossless chunk status");check("bytes 0-2/3".equals(zipped.getHeaderField("X-Fiji-Raw-Range")),"chunk identity");try(InputStream body=zipped.getInputStream()){check(body.read()==1 && body.read()==2 && body.read()==3 && body.read()==-1,"identity chunks retain all bytes");}}finally{zipped.disconnect();}
            byte[] repetitive=new byte[1024*1024];java.util.Arrays.fill(repetitive,(byte)42);Files.write(directory.resolve("frame-3.raw"),repetitive);
            HttpURLConnection compressed=(HttpURLConnection)new URL(base+"frame-3.raw?chunk=0-1048575&compression=gzip").openConnection();
            try{check(compressed.getResponseCode()==200,"compressed chunk status");check("gzip".equals(compressed.getHeaderField("X-Fiji-Encoding")),"lossless gzip selected");check(compressed.getContentLengthLong()<repetitive.length/20,"lossless transfer size reduced");try(InputStream body=new java.util.zip.GZIPInputStream(compressed.getInputStream())){long n=0;byte[] buffer=new byte[8192];int amount;while((amount=body.read(buffer))!=-1){for(int i=0;i<amount;i++)check(buffer[i]==42,"lossless pixel content");n+=amount;}check(n==repetitive.length,"lossless decoded size");}}finally{compressed.disconnect();}
            HttpURLConnection module=(HttpURLConnection)new URL(base+"viewer.js").openConnection();
            try{check(module.getResponseCode()==200,"known-length module status");long bytes=0;try(InputStream body=module.getInputStream()){byte[] b=new byte[8192];int n;while((n=body.read(b))!=-1)bytes+=n;}check(bytes==module.getContentLengthLong(),"module declared length matches exact body");check(module.getHeaderField("Cache-Control").contains("no-transform"),"relay response transformations disabled");}finally{module.disconnect();}
            String qrUrl="https://example.trycloudflare.com/0123456789abcdef0123456789abcdef/";
            BufferedImage qr = ViewerWindow.qrImage(qrUrl);
            int width=qr.getWidth(),height=qr.getHeight();
            int[] pixels=qr.getRGB(0,0,width,height,null,0,width);
            byte[] luminance=new byte[pixels.length];
            for(int i=0;i<pixels.length;i++) luminance[i]=(byte)(pixels[i]&255);
            LuminanceSource source = new LuminanceSource(width,height) {
                public byte[] getRow(int y,byte[] row) { byte[] result=new byte[width];System.arraycopy(luminance,y*width,result,0,width);return result; }
                public byte[] getMatrix() { return luminance; }
            };
            String decoded=new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(source))).getText();
            check(decoded.equals(qrUrl),"QR round-trip");
        } finally { session.close(); session.close(); }
        check(!Files.exists(directory),"temporary image deleted");
        try { request(base,"GET"); throw new AssertionError("server remained open"); } catch (IOException expected) { }
        System.out.println("PASS: real HTTP session, access boundaries, QR decode, stop and cleanup");
    }
    static int request(String url,String method) throws IOException {
        HttpURLConnection connection=(HttpURLConnection)new URL(url).openConnection();
        connection.setConnectTimeout(3000);connection.setReadTimeout(3000);connection.setRequestMethod(method);
        try { int code=connection.getResponseCode(); if(code==200 && method.equals("GET")) try(InputStream in=connection.getInputStream()){ byte[] b=new byte[8192];while(in.read(b)!=-1){} } return code; }
        finally { connection.disconnect(); }
    }
    static void check(boolean success,String message) { if(!success)throw new AssertionError(message); }
}
