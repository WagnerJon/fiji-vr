import ij.ImagePlus;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.common.BitMatrix;
import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.awt.datatransfer.StringSelection;
import java.awt.event.*;
import java.awt.image.BufferedImage;
import java.net.URI;
import java.nio.file.*;
import java.util.concurrent.ExecutionException;

/** Non-modal session window. No terminal, file export dialog, or manual server setup. */
final class ViewerWindow extends JFrame {
    private static ViewerWindow current;
    private ViewerSession session;
    private volatile boolean disposed;
    private final JLabel state = new JLabel("Preparing your image…");
    private final JLabel qr = new JLabel(" ", SwingConstants.CENTER);
    private final JTextField address = new JTextField();
    private final JButton share = new JButton("Connect headset");
    private final JButton stop = new JButton("Stop sharing");
    private final JButton browser = new JButton("Open viewer");
    private final JButton copy = new JButton("Copy link");
    private final JProgressBar progress = new JProgressBar();

    static void open(ImagePlus image) {
        if (current != null) current.dispose();
        current = new ViewerWindow(image, false);
        current.setVisible(true);
    }
    static void open(ImagePlus image, boolean reduced) {
        if (current != null) current.dispose();
        current = new ViewerWindow(image, reduced);current.setVisible(true);
    }
    private ViewerWindow(ImagePlus image, boolean reduced) {
        super("Fiji VR");
        setDefaultCloseOperation(DISPOSE_ON_CLOSE);
        setMinimumSize(new Dimension(540, 610));
        JPanel content = new JPanel(); content.setLayout(new BoxLayout(content, BoxLayout.Y_AXIS));
        content.setBorder(new EmptyBorder(28, 30, 24, 30)); setContentPane(content);
        JLabel title = new JLabel("Your image. In your space.");
        title.setFont(title.getFont().deriveFont(Font.BOLD, 25f));
        title.setAlignmentX(LEFT_ALIGNMENT); content.add(title);
        JLabel description = new JLabel(image.getBitDepth() == 24 ? "RGB colors · 3D spatial viewer" : "Volume · 3D spatial viewer");
        if (image.getNChannels() > 1) description.setText(description.getText() + " · " + image.getNChannels() + " channels");
        if (image.getNFrames() > 1) description.setText(description.getText() + " · " + image.getNFrames() + " time points");
        description.setText(description.getText() + (reduced ? " · Reduced preview (192 px)" : " · Original " + image.getWidth() + " × " + image.getHeight()));
        description.setBorder(new EmptyBorder(8,0,22,0)); content.add(description);
        state.setAlignmentX(LEFT_ALIGNMENT); content.add(state);
        progress.setIndeterminate(true); progress.setMaximumSize(new Dimension(Integer.MAX_VALUE, 5));
        content.add(Box.createVerticalStrut(12)); content.add(progress);
        qr.setPreferredSize(new Dimension(250,250)); qr.setMaximumSize(new Dimension(Integer.MAX_VALUE,250)); qr.setAlignmentX(LEFT_ALIGNMENT);
        content.add(qr);
        address.setEditable(false); address.setMaximumSize(new Dimension(Integer.MAX_VALUE,32)); address.setAlignmentX(LEFT_ALIGNMENT);
        content.add(address); content.add(Box.createVerticalStrut(12));
        JPanel actions = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 0)); actions.setAlignmentX(LEFT_ALIGNMENT);
        actions.add(browser); actions.add(copy); actions.add(share); actions.add(stop); content.add(actions);
        browser.setEnabled(false); copy.setEnabled(false); share.setEnabled(false); stop.setVisible(false);
        JLabel note = new JLabel("<html><body style='width:350px'>Desktop viewing stays on this computer. Connecting a headset creates an HTTPS link through Cloudflare. On the same local network, choose Use local Wi-Fi in the viewer to transfer image data directly; allow local-network access if asked. Local transfers use HTTP on your network. If unavailable, the viewer labels its internet relay fallback. Anyone with the full link can view this session. The connection helper is installed automatically on first use.<br><br>Keep this window open while viewing. Close it to end the session.</body></html>");
        note.setFont(note.getFont().deriveFont(12f)); note.setForeground(new Color(95,95,100)); note.setBorder(new EmptyBorder(20,0,0,0));
        content.add(note);
        browser.addActionListener(event -> openBrowser(address.getText()));
        copy.addActionListener(event -> {
            try { Toolkit.getDefaultToolkit().getSystemClipboard().setContents(new StringSelection(address.getText()), null); state.setText("Link copied."); }
            catch (Exception error) { state.setText("Select the link and copy it to your clipboard."); }
        });
        share.addActionListener(event -> connect());
        stop.addActionListener(event -> stopSharing());
        pack(); setLocationRelativeTo(null);
        prepare(image, reduced);
    }
    private void prepare(ImagePlus image, boolean reduced) {
        new SwingWorker<ViewerSession, Void>() {
            protected ViewerSession doInBackground() throws Exception {
                Path directory = Files.createTempDirectory("fiji-vr-session-");
                try {
                    if (!image.lock()) throw new IllegalStateException("This image is busy. Close this window and try again when the current operation finishes.");
                    try { Fiji_VR.export(image, reduced ? 192 : 0, directory, () -> disposed); } finally { image.unlock(); }
                    return new ViewerSession(directory);
                } catch (Exception error) {
                    ViewerSession.deletePreview(directory); throw error;
                }
            }
            protected void done() {
                try {
                    ViewerSession ready = get();
                    if (disposed) { ready.close(); return; }
                    session = ready;
                    address.setText(session.url(session.localOrigin()));
                    state.setText("Ready on this Mac. Connect a headset to get a QR code.");
                    progress.setVisible(false); browser.setEnabled(true); copy.setEnabled(true); share.setEnabled(true);
                    qr.setText("Desktop viewer ready");
                    openBrowser(address.getText());
                } catch (Exception error) { if (!disposed) fail(error); }
            }
        }.execute();
    }
    private void connect() {
        if (session == null || disposed) return;
        share.setEnabled(false); progress.setVisible(true); stop.setVisible(true);
        TunnelConnection connection = new TunnelConnection(); session.tunnel = connection;
        new SwingWorker<String, Void>() {
            protected String doInBackground() throws Exception {
                String origin=connection.connect(session.localOrigin(), "/" + session.token + "/volume.json", message -> SwingUtilities.invokeLater(() -> {
                    if (!disposed && session.tunnel == connection) state.setText(message);
                }), message -> SwingUtilities.invokeLater(() -> {
                    if (!disposed && session.tunnel == connection) { stopSharing(); state.setText(message); }
                }));
                if(disposed || session.tunnel!=connection)throw new IllegalStateException("Connection cancelled.");
                session.startLocalSharing(origin,connection);
                if(disposed || session.tunnel!=connection)throw new IllegalStateException("Connection cancelled.");
                return origin;
            }
            protected void done() {
                try {
                    String origin = get();
                    if (disposed || session.tunnel != connection) { connection.close(); return; }
                    String url = session.url(origin);
                    address.setText(url); address.setCaretPosition(0);
                    qr.setText(null); qr.setIcon(new ImageIcon(qrImage(url)));
                    state.setText("Open in your headset. Choose Use local Wi-Fi for direct image transfer.");
                    progress.setVisible(false);
                } catch (Exception error) {
                    if (!disposed && session.tunnel == connection) { stopSharing(); fail(error); }
                }
            }
        }.execute();
    }
    private void stopSharing() {
        if (session == null) return;
        TunnelConnection connection = session.tunnel; session.tunnel = null;
        if (connection != null) connection.close();
        session.stopLocalSharing();
        address.setText(session.url(session.localOrigin()));
        qr.setIcon(null); qr.setText("Desktop viewer ready");
        share.setEnabled(true); stop.setVisible(false); progress.setVisible(false);
        state.setText("Headset sharing stopped. Desktop viewing is still available.");
    }
    static BufferedImage qrImage(String url) throws Exception {
        BitMatrix matrix = new QRCodeWriter().encode(url, BarcodeFormat.QR_CODE, 240, 240);
        BufferedImage image = new BufferedImage(matrix.getWidth(), matrix.getHeight(), BufferedImage.TYPE_INT_RGB);
        for (int y=0;y<matrix.getHeight();y++) for(int x=0;x<matrix.getWidth();x++) image.setRGB(x,y,matrix.get(x,y)?0x000000:0xffffff);
        return image;
    }
    private void openBrowser(String url) {
        Thread thread = new Thread(() -> {
            try {
                if (!Desktop.isDesktopSupported() || !Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) throw new IllegalStateException();
                Desktop.getDesktop().browse(URI.create(url));
            } catch (Exception error) { SwingUtilities.invokeLater(() -> { if (!disposed) state.setText("Copy the link into your browser to open the viewer."); }); }
        }, "Fiji VR open viewer"); thread.setDaemon(true); thread.start();
    }
    private void fail(Exception error) {
        Throwable cause = error instanceof ExecutionException ? error.getCause() : error;
        state.setText("Couldn’t complete setup."); progress.setVisible(false);
        JOptionPane.showMessageDialog(this, cause.getMessage() == null ? "Please try again." : cause.getMessage(), "Fiji VR", JOptionPane.INFORMATION_MESSAGE);
    }
    @Override public void dispose() {
        disposed = true;
        if (session != null) session.close();
        if (current == this) current = null;
        super.dispose();
    }
}
