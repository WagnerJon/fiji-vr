import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.io.*;
import java.util.concurrent.CountDownLatch;

/** Fabricated native-byte data only, for HTTPS bootstrap -> private-LAN browser checks. */
public class LocalNetworkPreview {
    public static void main(String[] args)throws Exception {
        Path folder=Files.createTempDirectory("fiji-vr-lan-preview-");
        byte[] block=new byte[1024*1024];int seed=123;
        try(OutputStream out=Files.newOutputStream(folder.resolve("volume.raw"))){for(int chunk=0;chunk<32;chunk++){for(int i=0;i<block.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;block[i]=(byte)seed;}out.write(block);}}
        Files.createLink(folder.resolve("frame-2.raw"),folder.resolve("volume.raw"));
        String meta="{\"title\":\"Synthetic local transfer test\",\"shape\":[512,512,128],\"spacing\":[1,1,4],\"unit\":\"pixel\",\"encoding\":\"uint8\",\"frame\":1,\"frameCount\":2,\"frames\":[\"volume.raw\",\"frame-2.raw\"],\"frameInterval\":1,\"timeUnit\":\"s\"}";
        Files.write(folder.resolve("volume.json"),meta.getBytes(StandardCharsets.UTF_8));
        ViewerSession session=new ViewerSession(folder);
        Runtime.getRuntime().addShutdownHook(new Thread(session::close));
        String remote="https://local-check.example.test";
        if(args.length==0 || !args[0].equals("local")) {
            TunnelConnection connection=new TunnelConnection();session.tunnel=connection;
            remote=connection.connect(session.localOrigin(),"/"+session.token+"/volume.json",System.out::println,System.out::println);
        }
        session.startLocalSharing(remote);
        session.server.createContext("/transport-check/",request->{
            byte[] html=Files.readAllBytes(Paths.get("tools/local-network-browser-check.html"));
            request.getResponseHeaders().set("Content-Type","text/html; charset=utf-8");request.sendResponseHeaders(200,html.length);
            try(OutputStream body=request.getResponseBody()){body.write(html);}finally{request.close();}
        });
        System.out.println("CHECK "+session.localOrigin()+"/transport-check/?bootstrap="+session.url(session.localOrigin())+"&headset="+session.url(remote));
        System.out.println("HEADSET "+session.url(remote));System.out.println("DESKTOP "+session.url(session.localOrigin()));
        System.out.println("LAN "+session.localBases());
        new CountDownLatch(1).await();
    }
}
