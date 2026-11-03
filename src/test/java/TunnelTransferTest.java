import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.net.*;
import java.io.*;

/** Real public-link binary/body-length regression, sharing fabricated bytes only. */
public class TunnelTransferTest {
    public static void main(String[] args) throws Exception {
        Path folder=Files.createTempDirectory("fiji-vr-relay-transfer-");
        Files.write(folder.resolve("volume.json"),"{\"syntheticTransfer\":true}".getBytes(StandardCharsets.UTF_8));
        byte[] block=new byte[1024*1024];for(int i=0;i<block.length;i++)block[i]=(byte)(i*31+7);
        try(OutputStream file=Files.newOutputStream(folder.resolve("volume.raw"))){for(int i=0;i<70;i++)file.write(block);}
        ViewerSession session=new ViewerSession(folder);TunnelConnection tunnel=new TunnelConnection();session.tunnel=tunnel;
        try {
            String remote=tunnel.connect(session.localOrigin(),"/"+session.token+"/volume.json",System.out::println,System.out::println);
            System.out.println("Testing synthetic transfer: "+remote);
            verify(session.url(session.localOrigin()),123,2*1024*1024);
            verify(session.url(remote),123,2*1024*1024);
            if(args.length>0 && args[0].equals("large"))verify(session.url(remote),2*1024*1024,64*1024*1024);
            // Static ES module responses also pass through the generated link.
            HttpURLConnection js=(HttpURLConnection)new URL(session.url(remote)+"viewer.js").openConnection();js.setConnectTimeout(15000);js.setReadTimeout(45000);
            try {if(js.getResponseCode()!=200)throw new AssertionError("viewer script status");long count=0;try(InputStream in=js.getInputStream()){byte[] bytes=new byte[8192];int n;while((n=in.read(bytes))!=-1)count+=n;}long declared=js.getContentLengthLong();if(declared>=0 && count!=declared)throw new AssertionError("script body length");System.out.println("PASS: public viewer module, "+count+" bytes");}finally{js.disconnect();}
            System.out.println("PASS: public-link range/body lengths and fabricated content");
        }finally{session.close();}
    }
    static void verify(String base,long start,int length)throws Exception{
        HttpURLConnection c=(HttpURLConnection)new URL(base+"volume.raw").openConnection();c.setConnectTimeout(15000);c.setReadTimeout(45000);c.setRequestProperty("Range","bytes="+start+"-"+(start+length-1));
        try{
            if(c.getResponseCode()!=206)throw new AssertionError("range status "+c.getResponseCode());
            long received=0;try(InputStream in=c.getInputStream()){byte[] bytes=new byte[65536];int n;while((n=in.read(bytes))!=-1){for(int i=0;i<n;i++)if(bytes[i]!=(byte)((start+received+i)*31+7))throw new AssertionError("corrupt byte at "+received);received+=n;}}
            if(received!=length || (c.getContentLengthLong()>=0 && c.getContentLengthLong()!=received))throw new AssertionError("short body: "+received+" / "+length);
            System.out.println("PASS: "+(base.startsWith("http://127.")?"local":"public")+" range "+received+" bytes");
        }finally{c.disconnect();}
    }
}
