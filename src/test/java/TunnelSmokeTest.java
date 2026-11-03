import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.net.*;
import java.io.*;

/** Optional internet integration check: only fabricated data is shared. */
public class TunnelSmokeTest {
    public static void main(String[] args) throws Exception {
        Path folder=Files.createTempDirectory("fiji-vr-tunnel-check-");
        Files.write(folder.resolve("volume.json"),"{\"syntheticTest\":true}".getBytes(StandardCharsets.UTF_8));
        Files.write(folder.resolve("volume.raw"),new byte[]{1,2,3});
        ViewerSession session=new ViewerSession(folder);
        TunnelConnection tunnel=new TunnelConnection();session.tunnel=tunnel;
        try {
            String origin=tunnel.connect(session.localOrigin(), "/" + session.token + "/volume.json",System.out::println,System.out::println);
            boolean ready=false;
            System.out.println("Testing synthetic session through " + origin);
            for(int i=0;i<20;i++) {
                try {
                    HttpURLConnection c=(HttpURLConnection)new URL(session.url(origin)+"volume.json").openConnection();
                    c.setConnectTimeout(5000);c.setReadTimeout(5000);
                    try {
                        if(c.getResponseCode()==200)try(InputStream in=c.getInputStream()){
                            ByteArrayOutputStream body=new ByteArrayOutputStream();byte[] bytes=new byte[256];int n;while((n=in.read(bytes))!=-1)body.write(bytes,0,n);
                            ready=new String(body.toByteArray(),StandardCharsets.UTF_8).contains("syntheticTest");
                        }
                    } finally {c.disconnect();}
                } catch(IOException error) { if(i==0) System.out.println(error.toString()); }
                if(ready)break;
                Thread.sleep(1000);
            }
            if(!ready)throw new AssertionError("HTTPS link did not serve the test fixture.");
            System.out.println("PASS: automatic verified helper download, HTTPS tunnel, remote test-data fetch");
        } finally {session.close();}
    }
}
