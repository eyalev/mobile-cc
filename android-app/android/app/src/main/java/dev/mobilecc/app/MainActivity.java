package dev.mobilecc.app;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LastScreenshotPlugin.class);
        super.onCreate(savedInstanceState);

        // The WebView ignores downloads by default; hand attachment responses
        // (e.g. /api/download) to Android's DownloadManager so files land in
        // the public Downloads dir. DownloadManager fetches the URL itself —
        // it reaches the tailnet host over the system Tailscale VPN.
        WebView wv = this.bridge.getWebView();
        if (wv != null) {
            wv.setDownloadListener(new DownloadListener() {
                @Override
                public void onDownloadStart(String url, String userAgent,
                        String contentDisposition, String mimetype, long contentLength) {
                    try {
                        String name = URLUtil.guessFileName(url, contentDisposition, mimetype);
                        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                        req.setMimeType(mimetype);
                        req.addRequestHeader("User-Agent", userAgent);
                        req.setNotificationVisibility(
                                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                        req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                        DownloadManager dm =
                                (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                        if (dm != null) {
                            dm.enqueue(req);
                            Toast.makeText(getApplicationContext(),
                                    "Downloading " + name, Toast.LENGTH_SHORT).show();
                        }
                    } catch (Exception e) {
                        Toast.makeText(getApplicationContext(),
                                "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
                    }
                }
            });
        }
    }
}
