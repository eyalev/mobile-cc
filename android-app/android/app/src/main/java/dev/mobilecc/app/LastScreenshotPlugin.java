package dev.mobilecc.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * LastScreenshot — returns the newest image in the device's "Screenshots"
 * bucket as a data URL, so the web UI can attach it to a message with one tap
 * (no picker, no Syncthing). Reads MediaStore directly.
 */
@CapacitorPlugin(
    name = "LastScreenshot",
    permissions = {
        @Permission(alias = "mediaImages", strings = { Manifest.permission.READ_MEDIA_IMAGES }),
        @Permission(alias = "extStorage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class LastScreenshotPlugin extends Plugin {

    // READ_MEDIA_IMAGES is API 33+; older devices use READ_EXTERNAL_STORAGE.
    private String alias() {
        return Build.VERSION.SDK_INT >= 33 ? "mediaImages" : "extStorage";
    }

    /**
     * Open a URL in the system default browser (ACTION_VIEW) — explicitly NOT
     * an in-app Custom Tab and NOT this WebView. Used by the linkify menu's
     * "Open" action so URLs always leave the app.
     */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("no url");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("open failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void lastScreenshot(PluginCall call) {
        String a = alias();
        if (getPermissionState(a) != PermissionState.GRANTED) {
            requestPermissionForAlias(a, call, "permCallback");
            return;
        }
        doQuery(call);
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        if (getPermissionState(alias()) == PermissionState.GRANTED) {
            doQuery(call);
        } else {
            call.reject("Media permission denied");
        }
    }

    private void doQuery(PluginCall call) {
        ContentResolver cr = getContext().getContentResolver();
        Uri collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        String[] projection = {
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.DATE_ADDED
        };
        // Filter to the Screenshots bucket; portable across API levels.
        String selection = MediaStore.Images.Media.BUCKET_DISPLAY_NAME + " = ?";
        String[] args = { "Screenshots" };
        // Newest first; we just read row 0 (no LIMIT, portable pre/post Android 11).
        String sort = MediaStore.Images.Media.DATE_ADDED + " DESC";

        Cursor cursor = null;
        try {
            cursor = cr.query(collection, projection, selection, args, sort);
            if (cursor == null || !cursor.moveToFirst()) {
                call.reject("No screenshots found");
                return;
            }
            long id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID));
            String name = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME));
            String mime = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE));
            long dateAdded = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED));
            if (mime == null || mime.isEmpty()) mime = "image/png";

            Uri itemUri = Uri.withAppendedPath(collection, String.valueOf(id));
            byte[] bytes = readAll(cr, itemUri);
            if (bytes == null) {
                call.reject("Could not read screenshot bytes");
                return;
            }
            String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);

            JSObject ret = new JSObject();
            ret.put("dataUrl", "data:" + mime + ";base64," + b64);
            ret.put("name", name != null ? name : "screenshot");
            ret.put("mime", mime);
            ret.put("takenAt", dateAdded * 1000L); // DATE_ADDED is epoch seconds
            ret.put("bytes", bytes.length);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to read screenshot: " + e.getMessage(), e);
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    private byte[] readAll(ContentResolver cr, Uri uri) {
        InputStream in = null;
        try {
            in = cr.openInputStream(uri);
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (Exception e) {
            return null;
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignore) {}
        }
    }
}
