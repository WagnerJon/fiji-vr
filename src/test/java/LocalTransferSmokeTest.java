import java.net.*;
import java.io.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Real HTTP checks for optional LAN listeners, exact bytes and stop-sharing lifecycle. */
public class LocalTransferSmokeTest {
    static final String ORIGIN="https://headset.example.test";
    public static void main(String[] args) throws Exception {
        System.setProperty("sun.net.http.allowRestrictedHeaders","true");
        Path directory=Files.createTempDirectory("fiji-vr-local-test-");
        byte[] data=new byte[2*1024*1024];for(int i=0;i<data.length;i++)data[i]=(byte)(i*31);
        Files.write(directory.resolve("volume.raw"),data);Files.write(directory.resolve("volume.json"),"{}".getBytes(StandardCharsets.UTF_8));
        ViewerSession session=new ViewerSession(directory);String local=null;
        try {
            check(session.localBases().isEmpty(),"LAN closed before sharing");
            session.startLocalSharing(ORIGIN,Arrays.asList(InetAddress.getByName("127.0.0.1")));
            check(session.localBases().size()==1,"one explicit test listener");local=session.localBases().get(0);
            String manifest=new String(read(session.url(session.localOrigin())+"connection.json",null,null),StandardCharsets.UTF_8);
            check(manifest.contains(local)&&manifest.contains(session.token),"manifest identifies only current session endpoints");
            HttpURLConnection index=open(session.url(session.localOrigin()),"GET",null);
            try {check(index.getResponseCode()==200,"HTTPS bootstrap resources available");check(index.getHeaderField("Content-Security-Policy").contains(new URI(local).getAuthority()),"CSP permits exact LAN origin");}finally{index.disconnect();}
            HttpURLConnection range=open(local+"volume.raw","GET",ORIGIN);range.setRequestProperty("Range","bytes=1000000-1000999");
            try {check(range.getResponseCode()==206,"LAN range response");check(ORIGIN.equals(range.getHeaderField("Access-Control-Allow-Origin")),"exact headset CORS origin");check(range.getHeaderField("Access-Control-Expose-Headers").contains("X-Fiji-Raw-Range"),"chunk identity readable cross origin");byte[] part=bytes(range.getInputStream());check(part.length==1000,"native range size");for(int i=0;i<part.length;i++)check(part[i]==data[i+1000000],"native range pixels");}finally{range.disconnect();}
            HttpURLConnection chunk=open(local+"volume.raw?chunk=0-2097151&compression=identity","GET",ORIGIN);
            try {check(chunk.getResponseCode()==200,"LAN identity chunk");check("identity".equals(chunk.getHeaderField("X-Fiji-Encoding")),"LAN skips gzip work");check("bytes 0-2097151/2097152".equals(chunk.getHeaderField("X-Fiji-Raw-Range")),"LAN exact range identity");check(Arrays.equals(data,bytes(chunk.getInputStream())),"LAN chunk byte-exact");}finally{chunk.disconnect();}
            HttpURLConnection preflight=open(local+"volume.raw","OPTIONS",ORIGIN);preflight.setRequestProperty("Access-Control-Request-Method","GET");preflight.setRequestProperty("Access-Control-Request-Headers","Range");
            try{check(preflight.getResponseCode()==204,"CORS preflight");check("Range".equals(preflight.getHeaderField("Access-Control-Allow-Headers")),"only range header allowed");}finally{preflight.disconnect();}
            check(code(local+"volume.raw","GET","https://unrelated.example.test")==403,"unrelated website origin denied");
            check(code(local+"volume.raw","GET",new URI(local).getScheme()+"://"+new URI(local).getAuthority())==200,"own LAN origin accepted");
            check(code(local+"volume.raw","POST",ORIGIN)==405,"LAN read only");
            check(code(local.replace(session.token,"wrong")+"volume.raw","GET",ORIGIN)==404,"LAN bearer token enforced");
            check(code(local+"../volume.raw","GET",ORIGIN)==404,"LAN traversal denied");
            check(code(local+"unknown","GET",ORIGIN)==404,"LAN allowlist enforced");
            session.stopLocalSharing();check(session.localBases().isEmpty(),"LAN removed when sharing stops");
            try{code(local+"volume.raw","GET",ORIGIN);throw new AssertionError("LAN listener remained active");}catch(IOException expected){}
            check(code(session.url(session.localOrigin())+"volume.raw","GET",null)==200,"desktop remains available after stop sharing");
            check(new String(read(session.url(session.localOrigin())+"connection.json",null,null),StandardCharsets.UTF_8).contains("\"localBases\":[]"),"stale LAN addresses no longer advertised");
            session.startLocalSharing(ORIGIN,Arrays.asList(InetAddress.getByName("127.0.0.1")));local=session.localBases().get(0);
        } finally {session.close();}
        check(!Files.exists(directory),"LAN temporary image cleaned up");
        try{code(local+"volume.raw","GET",ORIGIN);throw new AssertionError("LAN open after close");}catch(IOException expected){}
        System.out.println("PASS: local image byte ranges, CORS, source pixels, token boundary, stop sharing and cleanup");
    }
    static HttpURLConnection open(String url,String method,String origin)throws IOException{
        HttpURLConnection connection=(HttpURLConnection)new URL(url).openConnection();connection.setConnectTimeout(3000);connection.setReadTimeout(3000);connection.setRequestMethod(method);if(origin!=null)connection.setRequestProperty("Origin",origin);return connection;
    }
    static int code(String url,String method,String origin)throws IOException{HttpURLConnection c=open(url,method,origin);try{return c.getResponseCode();}finally{c.disconnect();}}
    static byte[] read(String url,String origin,String range)throws IOException{HttpURLConnection c=open(url,"GET",origin);if(range!=null)c.setRequestProperty("Range",range);try{return bytes(c.getInputStream());}finally{c.disconnect();}}
    static byte[] bytes(InputStream input)throws IOException{try(InputStream in=input;ByteArrayOutputStream result=new ByteArrayOutputStream()){byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1)result.write(buffer,0,n);return result.toByteArray();}}
    static void check(boolean success,String message){if(!success)throw new AssertionError(message);}
}
