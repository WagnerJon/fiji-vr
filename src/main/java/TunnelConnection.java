import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.regex.*;
import java.util.zip.GZIPInputStream;

/** User-initiated HTTPS sharing; helper downloads are pinned and SHA-256 verified. */
final class TunnelConnection implements AutoCloseable {
    private volatile Process process;
    private final AtomicBoolean closed = new AtomicBoolean();
    private static final Pattern ADDRESS = Pattern.compile("https://(?!api\\.|www\\.)[a-z0-9-]+\\.trycloudflare\\.com");

    String connect(String origin, String healthPath, Consumer<String> progress, Consumer<String> disconnected) throws Exception {
        Path helper = install(progress);
        if (closed.get()) throw new IOException("Connection cancelled.");
        Path config = helper.getParent().resolve("empty-config.yml");
        Files.write(config, "{}\n".getBytes(StandardCharsets.UTF_8));
        synchronized (this) {
            if (closed.get()) throw new IOException("Connection cancelled.");
            process = new ProcessBuilder(helper.toString(), "tunnel", "--config", config.toString(), "--no-autoupdate", "--url", origin, "--protocol", "http2").redirectErrorStream(true).start();
        }
        progress.accept("Creating your headset link…");
        CompletableFuture<String> address = new CompletableFuture<>();
        Thread reader = new Thread(() -> {
            try (BufferedReader input = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = input.readLine()) != null) {
                    Matcher match = ADDRESS.matcher(line);
                    if (match.find()) address.complete(match.group());
                }
                if (!closed.get()) {
                    address.completeExceptionally(new IOException("The headset connection could not be established. Check your internet connection and try again."));
                    disconnected.accept("Headset sharing stopped. You can reconnect below.");
                }
            } catch (IOException error) {
                if (!closed.get()) { address.completeExceptionally(error); disconnected.accept("Headset connection lost. Please reconnect."); }
            }
        }, "Fiji VR headset link");
        reader.setDaemon(true); reader.start();
        try {
            String remote = address.get(75, TimeUnit.SECONDS);
            progress.accept("Checking your headset connection…");
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90);
            while (System.nanoTime() < deadline && !closed.get() && process.isAlive()) {
                HttpURLConnection check = null;
                try {
                    check = (HttpURLConnection)new URL(remote + healthPath).openConnection();
                    check.setConnectTimeout(3000); check.setReadTimeout(3000);
                    if (check.getResponseCode() == 200) {
                        try (InputStream body = check.getInputStream()) { while (body.read() != -1) { } }
                        return remote;
                    }
                } catch (IOException notReady) { /* DNS and routing can lag behind tunnel creation. */ }
                finally { if (check != null) check.disconnect(); }
                Thread.sleep(1000);
            }
            throw new IOException("The headset link did not become reachable in time.");
        } catch (Exception error) { close(); throw new IOException("Couldn’t connect the headset. Check your internet connection and try again. Desktop viewing is still available.", error); }
    }

    static String platform() throws IOException {
        String os = System.getProperty("os.name").toLowerCase(Locale.ROOT);
        String arch = System.getProperty("os.arch").toLowerCase(Locale.ROOT);
        String cpu = arch.equals("aarch64") || arch.equals("arm64") ? "arm64" : arch.equals("amd64") || arch.equals("x86_64") ? "amd64" : "unsupported";
        String family = os.contains("mac") ? "mac" : os.contains("win") ? "windows" : os.contains("linux") ? "linux" : "unsupported";
        if (cpu.equals("unsupported") || family.equals("unsupported") || (family.equals("windows") && !cpu.equals("amd64"))) throw new IOException("Automatic headset sharing is not available for this computer yet. Desktop viewing is available.");
        return family + "-" + cpu;
    }
    private Path install(Consumer<String> progress) throws Exception {
        Properties properties = new Properties();
        try (InputStream in = getClass().getResourceAsStream("/tunnel.properties")) {
            if (in == null) throw new IOException("Missing connection helper configuration.");
            properties.load(in);
        }
        String platform = platform(), expected = properties.getProperty(platform + ".sha256");
        Path base = System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("mac")
            ? Paths.get(System.getProperty("user.home"), "Library", "Application Support", "Fiji VR", "Connection")
            : Paths.get(System.getProperty("user.home"), ".fiji-vr", "connection");
        Path directory = base.resolve(properties.getProperty("version")).resolve(platform);
        Files.createDirectories(directory);
        boolean archive = Boolean.parseBoolean(properties.getProperty(platform + ".archive"));
        Path download = directory.resolve(archive ? "helper.tgz" : "helper.download");
        if (!Files.isRegularFile(download) || !sha256(download).equals(expected)) {
            progress.accept("Setting up headset connection (first launch)…");
            Path temporary = Files.createTempFile(directory, "download-", ".part");
            try {
                URLConnection connection = new URL(properties.getProperty(platform + ".url")).openConnection();
                connection.setConnectTimeout(20000); connection.setReadTimeout(30000);
                try (InputStream in = connection.getInputStream(); OutputStream out = Files.newOutputStream(temporary)) {
                    byte[] buffer = new byte[65536]; int n; long total = 0;
                    while ((n = in.read(buffer)) != -1) {
                        if (closed.get()) throw new IOException("Connection cancelled.");
                        total += n;
                        if (total > 150 * 1024 * 1024) throw new IOException("Connection helper download is too large.");
                        out.write(buffer, 0, n);
                    }
                }
                if (!sha256(temporary).equals(expected)) throw new IOException("The connection helper could not be verified. Please try again.");
                Files.move(temporary, download, StandardCopyOption.REPLACE_EXISTING);
            } finally { Files.deleteIfExists(temporary); }
        }
        if (closed.get()) throw new IOException("Connection cancelled.");
        Path executable = directory.resolve(platform.startsWith("windows") ? "cloudflared.exe" : "cloudflared");
        Path temporary = Files.createTempFile(directory, "executable-", ".part");
        try {
            if (archive) extractExecutable(download, temporary);
            else Files.copy(download, temporary, StandardCopyOption.REPLACE_EXISTING);
            if (!platform.startsWith("windows") && !temporary.toFile().setExecutable(true, true)) throw new IOException("Couldn’t prepare the connection helper.");
            Files.move(temporary, executable, StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temporary); }
        return executable;
    }
    static void extractExecutable(Path archive, Path destination) throws IOException {
        try (DataInputStream in = new DataInputStream(new GZIPInputStream(Files.newInputStream(archive)))) {
            byte[] header = new byte[512];
            while (true) {
                try { in.readFully(header); } catch (EOFException error) { break; }
                if (header[0] == 0) break;
                String name = new String(header, 0, 100, StandardCharsets.US_ASCII).split("\u0000", 2)[0];
                String octal = new String(header, 124, 12, StandardCharsets.US_ASCII).replace("\u0000", "").trim();
                long size;
                try { size = Long.parseLong(octal, 8); } catch (NumberFormatException error) { throw new IOException("Invalid helper archive.", error); }
                if (size < 0 || size > 150 * 1024 * 1024) throw new IOException("Invalid helper size.");
                boolean found = (name.equals("cloudflared") || name.equals("./cloudflared")) && (header[156] == '0' || header[156] == 0);
                OutputStream out = found ? Files.newOutputStream(destination) : null;
                try {
                    byte[] buffer = new byte[65536]; long left = size;
                    while (left > 0) {
                        int n = in.read(buffer, 0, (int)Math.min(buffer.length, left));
                        if (n < 0) throw new EOFException("Incomplete helper archive.");
                        if (out != null) out.write(buffer, 0, n);
                        left -= n;
                    }
                } finally { if (out != null) out.close(); }
                if (found) return;
                long padding = (512 - size % 512) % 512;
                while (padding-- > 0) in.readByte();
            }
        }
        throw new IOException("Connection helper was not found in its download.");
    }
    static String sha256(Path file) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream in = Files.newInputStream(file)) {
            byte[] buffer = new byte[65536]; int n;
            while ((n = in.read(buffer)) != -1) hash.update(buffer, 0, n);
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : hash.digest()) hex.append(String.format("%02x", b & 255));
        return hex.toString();
    }
    public synchronized void close() {
        closed.set(true);
        if (process != null) process.destroy();
    }
}
