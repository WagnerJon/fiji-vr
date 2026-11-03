import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.GZIPOutputStream;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** A private, expiring viewer. Only explicitly listed resources are served. */
final class ViewerSession implements AutoCloseable {
    final Path directory;
    final String token = UUID.randomUUID().toString().replace("-", "");
    final HttpServer server;
    final ExecutorService requests = Executors.newFixedThreadPool(4, runnable -> {
        Thread thread = new Thread(runnable, "Fiji VR request"); thread.setDaemon(true); return thread;
    });
    final AtomicBoolean closed = new AtomicBoolean();
    private final Set<String> resources = new HashSet<>(Arrays.asList("index.html", "viewer.js", "interaction.js", "timeline.js", "dimension-panel.js", "resolution.js", "volume-blocks.js", "volume-shader.js", "transfer.js", "local-transfer.js", "acceleration.js", "acceleration-worker.js", "render-performance.js", "vendor/three.module.js", "vendor/OrbitControls.js"));
    final Thread shutdown = new Thread(this::close, "Fiji VR cleanup");
    volatile TunnelConnection tunnel;
    private final List<HttpServer> localServers = new ArrayList<>();
    private volatile String headsetOrigin;

    /** Bind only private LAN interfaces, and only while headset sharing is active. */
    private static List<InetAddress> localAddresses() {
        List<InetAddress> addresses = new ArrayList<>();
        try {
        Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
        while (interfaces != null && interfaces.hasMoreElements()) {
            NetworkInterface network = interfaces.nextElement();
            if (!network.isUp() || network.isLoopback() || network.isPointToPoint() || network.isVirtual()) continue;
            Enumeration<InetAddress> entries = network.getInetAddresses();
            while (entries.hasMoreElements()) {
                InetAddress address = entries.nextElement();
                if (address instanceof Inet4Address && address.isSiteLocalAddress() && !addresses.contains(address)) addresses.add(address);
            }
        }
        } catch (SocketException unavailable) { /* Relay viewing remains available. */ }
        return addresses;
    }
    void startLocalSharing(String origin) throws IOException {startLocalSharing(origin,localAddresses());}
    void startLocalSharing(String origin,TunnelConnection owner) throws IOException {
        List<InetAddress> addresses=localAddresses();
        synchronized(this){if(!closed.get() && tunnel==owner)startLocalSharing(origin,addresses);}
    }
    synchronized void startLocalSharing(String origin, List<InetAddress> addresses) throws IOException {
        if (closed.get()) throw new IOException("This viewing session has ended.");
        stopLocalSharing();
        URI remote = URI.create(origin);
        if (!"https".equals(remote.getScheme()) || remote.getHost() == null || remote.getRawUserInfo() != null || !origin.equals(remote.getScheme()+"://"+remote.getRawAuthority())) throw new IOException("Invalid headset origin.");
        headsetOrigin=origin;
        for (InetAddress address : addresses) {
            if (!(address instanceof Inet4Address) || !(address.isSiteLocalAddress() || address.isLoopbackAddress())) continue;
            try {
                HttpServer local = HttpServer.create(new InetSocketAddress(address, 0), 16);
                local.setExecutor(requests);local.createContext("/", request -> handle(request, true));local.start();localServers.add(local);
            } catch (IOException | SecurityException unavailable) { /* Keep relay viewing available if a local interface is blocked. */ }
            if (localServers.size() >= 4) break;
        }
    }
    synchronized List<String> localBases() {
        List<String> urls = new ArrayList<>();
        for (HttpServer local : localServers) urls.add(url("http://"+local.getAddress().getAddress().getHostAddress()+":"+local.getAddress().getPort()));
        return urls;
    }
    synchronized void stopLocalSharing() {
        headsetOrigin=null;
        for (HttpServer local : localServers) local.stop(0);
        localServers.clear();
    }
    private String connectionManifest() {
        List<String> urls=localBases();
        StringBuilder json=new StringBuilder("{\"version\":1,\"session\":\"").append(token).append("\",\"localBases\":[");
        for (int i=0;i<urls.size();i++) {if(i>0)json.append(',');json.append('"').append(urls.get(i)).append('"');}
        return json.append("]}").toString();
    }
    private String connectionPolicy() {
        StringBuilder policy=new StringBuilder("'self'");
        for(String base:localBases()) policy.append(' ').append(URI.create(base).getScheme()).append("://").append(URI.create(base).getRawAuthority());
        return policy.toString();
    }

    ViewerSession(Path directory) throws IOException {
        this.directory = directory;
        server = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 16);
        server.setExecutor(requests);
        server.createContext("/", this::handle);
        server.start();
        Runtime.getRuntime().addShutdownHook(shutdown);
    }
    String localOrigin() { return "http://127.0.0.1:" + server.getAddress().getPort(); }
    String url(String origin) { return origin + "/" + token + "/"; }
    private void handle(HttpExchange request) throws IOException { handle(request, false); }
    private void handle(HttpExchange request, boolean local) throws IOException {
        try {
            if (closed.get()) { request.sendResponseHeaders(410, -1); return; }
            String method = request.getRequestMethod();
            if (!method.equals("GET") && !method.equals("HEAD") && !(local && method.equals("OPTIONS"))) { request.getResponseHeaders().set("Allow", "GET, HEAD"); request.sendResponseHeaders(405, -1); return; }
            String path = request.getRequestURI().getPath();
            String prefix = "/" + token + "/";
            if (!path.startsWith(prefix)) { request.sendResponseHeaders(404, -1); return; }
            if (local) {
                InetAddress peer=request.getRemoteAddress().getAddress();
                if (headsetOrigin==null || !(peer.isSiteLocalAddress() || peer.isLoopbackAddress())) {request.sendResponseHeaders(403,-1);return;}
                String origin=request.getRequestHeaders().getFirst("Origin");
                String ownOrigin="http://"+request.getLocalAddress().getAddress().getHostAddress()+":"+request.getLocalAddress().getPort();
                if (origin!=null && !origin.equals(headsetOrigin) && !origin.equals(localOrigin()) && !origin.equals(ownOrigin)) {request.sendResponseHeaders(403,-1);return;}
                if(origin!=null){request.getResponseHeaders().set("Access-Control-Allow-Origin",origin);request.getResponseHeaders().set("Vary","Origin");}
                request.getResponseHeaders().set("Access-Control-Expose-Headers","Content-Range, Accept-Ranges, X-Fiji-Encoding, X-Fiji-Raw-Range");
                if (method.equals("OPTIONS")) {
                    request.getResponseHeaders().set("Access-Control-Allow-Methods","GET, HEAD");
                    request.getResponseHeaders().set("Access-Control-Allow-Headers","Range");
                    request.sendResponseHeaders(204,-1);return;
                }
            }
            String name = path.substring(prefix.length());
            if (name.isEmpty()) name = "index.html";
            InputStream data;
            long size;
            if (name.equals("connection.json")) {
                byte[] manifest=connectionManifest().getBytes(java.nio.charset.StandardCharsets.UTF_8);data=new ByteArrayInputStream(manifest);size=manifest.length;
            } else if (name.equals("volume.json") || name.equals("volume.raw") || name.matches("channel-[1-9][0-9]*-frame-[1-9][0-9]*\\.raw") || name.matches("frame-[1-9][0-9]*\\.raw")) {
                Path file = directory.resolve(name);
                if (!Files.isRegularFile(file)) { request.sendResponseHeaders(404, -1); return; }
                size = Files.size(file);
                if(name.endsWith(".raw") && request.getRequestURI().getRawQuery()!=null && request.getRequestURI().getRawQuery().startsWith("chunk=")) {
                    serveChunk(request,file,size,method);return;
                }
                data = new FileInputStream(file.toFile());
            } else if (resources.contains(name)) {
                data = ViewerSession.class.getResourceAsStream("/viewer/" + name);
                if (data == null) { request.sendResponseHeaders(404, -1); return; }
                try(InputStream resource=data;ByteArrayOutputStream bytes=new ByteArrayOutputStream()){
                    byte[] buffer=new byte[65536];int n;while((n=resource.read(buffer))!=-1)bytes.write(buffer,0,n);
                    byte[] body=bytes.toByteArray();data=new ByteArrayInputStream(body);size=body.length;
                }
            } else { request.sendResponseHeaders(404, -1); return; }
            try (InputStream source = data) {
                String type = name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream";
                request.getResponseHeaders().set("Content-Type", type);
                request.getResponseHeaders().set("Cache-Control", "private, no-store, no-transform");
                request.getResponseHeaders().set("Referrer-Policy", "no-referrer");
                request.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
                request.getResponseHeaders().set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src "+connectionPolicy()+"; frame-ancestors 'none'; base-uri 'none'");
                request.getResponseHeaders().set("Permissions-Policy", "xr-spatial-tracking=(self), local-network=(self)");
                long start=0,length=size;int code=200;
                String range=request.getRequestHeaders().getFirst("Range");
                if(name.endsWith(".raw") && size>=0) {
                    request.getResponseHeaders().set("Accept-Ranges","bytes");
                    if(range!=null) {
                        try {long[] bounds=byteRange(range,size);start=bounds[0];length=bounds[1]-start+1;code=206;
                            request.getResponseHeaders().set("Content-Range","bytes "+start+"-"+bounds[1]+"/"+size);
                        } catch(IllegalArgumentException invalid) {
                            request.getResponseHeaders().set("Content-Range","bytes */"+size);request.sendResponseHeaders(416,-1);return;
                        }
                    }
                }
                if (method.equals("HEAD")) {if(length>=0)request.getResponseHeaders().set("Content-Length",Long.toString(length));request.sendResponseHeaders(code,-1);return;}
                request.sendResponseHeaders(code,length<0?0:length);
                if(source instanceof FileInputStream)((FileInputStream)source).getChannel().position(start);
                else {long skipped=0;while(skipped<start){long n=source.skip(start-skipped);if(n<=0){if(source.read()<0)throw new EOFException();n=1;}skipped+=n;}}
                try(OutputStream body=request.getResponseBody()) {
                    byte[] buffer=new byte[65536];int n;long remaining=length;
                    while(remaining!=0 && (n=source.read(buffer,0,remaining<0?buffer.length:(int)Math.min(buffer.length,remaining)))!=-1){body.write(buffer,0,n);if(remaining>0)remaining-=n;}
                    if(remaining>0)throw new EOFException("Image file ended before the declared response length.");
                    body.flush();
                }
            }
        } finally { request.close(); }
    }
    private static void serveChunk(HttpExchange request,Path file,long total,String method) throws IOException {
        String query=request.getRequestURI().getRawQuery();
        if(!query.matches("chunk=[0-9]+-[0-9]+&compression=(gzip|identity)")){request.sendResponseHeaders(400,-1);return;}
        long[] bounds;
        try{bounds=byteRange("bytes="+query.substring(6,query.indexOf('&')),total);}catch(IllegalArgumentException invalid){request.sendResponseHeaders(416,-1);return;}
        long count=bounds[1]-bounds[0]+1;
        if(count>2*1024*1024){request.sendResponseHeaders(413,-1);return;}
        byte[] raw=new byte[(int)count];
        try(RandomAccessFile input=new RandomAccessFile(file.toFile(),"r")){input.seek(bounds[0]);input.readFully(raw);}
        boolean compress=query.endsWith("compression=gzip");
        ByteArrayOutputStream zipped=new ByteArrayOutputStream(compress?raw.length/2:0);
        if(compress)try(GZIPOutputStream gzip=new GZIPOutputStream(zipped){ {def.setLevel(1);} }){gzip.write(raw);}
        byte[] compressed=zipped.toByteArray();boolean useful=compress && compressed.length<raw.length;
        byte[] body=useful?compressed:raw;
        request.getResponseHeaders().set("Content-Type","application/octet-stream");
        request.getResponseHeaders().set("Cache-Control","private, no-store, no-transform");
        request.getResponseHeaders().set("X-Content-Type-Options","nosniff");
        request.getResponseHeaders().set("X-Fiji-Encoding",useful?"gzip":"identity");
        request.getResponseHeaders().set("X-Fiji-Raw-Range","bytes "+bounds[0]+"-"+bounds[1]+"/"+total);
        if(method.equals("HEAD")){request.getResponseHeaders().set("Content-Length",Integer.toString(body.length));request.sendResponseHeaders(200,-1);return;}
        request.sendResponseHeaders(200,body.length);
        try(OutputStream output=request.getResponseBody()){output.write(body);output.flush();}
    }
    static long[] byteRange(String header,long size) {
        if(!header.matches("bytes=[0-9]+-[0-9]*"))throw new IllegalArgumentException("Invalid range");
        String[] bounds=header.substring(6).split("-",-1);
        long start=Long.parseLong(bounds[0]),end=bounds[1].isEmpty()?size-1:Long.parseLong(bounds[1]);
        if(start<0 || start>=size || end<start)throw new IllegalArgumentException("Unsatisfiable range");
        return new long[]{start,Math.min(end,size-1)};
    }
    static void deletePreview(Path directory) throws IOException {
        try (DirectoryStream<Path> files = Files.newDirectoryStream(directory)) {
            for (Path file : files) Files.deleteIfExists(file);
        }
        Files.deleteIfExists(directory);
    }
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        TunnelConnection connection = tunnel;
        if (connection != null) connection.close();
        stopLocalSharing();server.stop(0); requests.shutdownNow();
        try { Runtime.getRuntime().removeShutdownHook(shutdown); } catch (IllegalStateException ignored) { }
        try { deletePreview(directory); } catch (IOException ignored) { directory.toFile().deleteOnExit(); }
    }
}
