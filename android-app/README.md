# mobile-cc Android shell

A thin [Capacitor](https://capacitorjs.com/) WebView wrapper around the
**live mobile-cc daemon UI**. It exists for one reason the web platform
can't give you: **attach the phone's most recent screenshot to a message
with one tap**, with no picker and no Syncthing.

The web has no API to read "the latest screenshot" unattended
(`<input type=file>` always shows a picker). This shell adds a native
`LastScreenshot` plugin that reads MediaStore directly, and a daemon-side
web glue chip (`mobile-cc-native-screenshot.js`) that feeds the result
into the existing `ttyview-image-paste` pipeline.

> The UI is **never** reimplemented here. The WebView loads
> `https://mobile-cc.taild2ae6a.ts.net` (your daemon over Tailscale).
> Everything except the screenshot bridge is the same web app.

## Architecture

```
Capacitor shell (android-app/)
 ├─ WebView → https://mobile-cc.taild2ae6a.ts.net   (server.url in capacitor.config.json)
 └─ LastScreenshotPlugin.java  (native)
      → READ_MEDIA_IMAGES (API 33+) / READ_EXTERNAL_STORAGE (<33)
      → MediaStore query: BUCKET_DISPLAY_NAME = 'Screenshots', newest first
      → returns { dataUrl, name, mime, takenAt }

Daemon-served web glue (../assets/mobile-cc-native-screenshot.js)
 ├─ only active when window.Capacitor.isNativePlatform()  (no-op in a browser)
 ├─ 📷-clock chip in the input row
 └─ dataUrl → File → synthetic `drop` event → ttyview-image-paste attaches + uploads
```

**Two artifacts must ship together** for the feature to work end to end:
1. this APK (the native bridge), and
2. a rebuilt **mobile-cc daemon binary** (the web glue is baked into it via
   `include_bytes!` + `assets/installed.json`).

## Build

Requires JDK 17+ and the Android SDK (`local.properties` → `sdk.dir`).

```bash
cd android-app
npm install                       # Capacitor packages
npx cap sync android              # copy config/plugins into the android project
cd android
echo "sdk.dir=$HOME/Android/Sdk" > local.properties   # if missing
ANDROID_HOME=$HOME/Android/Sdk ./gradlew :app:assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

## Install (sideload)

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
# or copy the .apk to the phone and tap it (allow "install unknown apps")
```

On first tap of the 📷-clock chip the app requests media-read permission.
Grant it once; thereafter it's one tap → newest screenshot attached.

## Config

- **Target URL** — `capacitor.config.json` → `server.url`. Change it and
  re-run `npx cap sync android` + rebuild if your daemon moves.
- **appId** — `dev.mobilecc.app`.

## Notes / limitations

- Requires Tailscale up on the phone (same as the PWA) — the WebView
  loads a tailnet host.
- Debug APK is unsigned for distribution; fine for personal sideload. For
  a Play Store / shareable build, set up a release keystore + Play App
  Signing (see lingush-appv2's TWA playbook for the keystore mechanics).
- This is **not** a TWA. A TWA is just Chrome with no JS↔native bridge and
  could not expose `LastScreenshot`.
