# Quick Install: Android Loopback

## What you need
- Android 9+
- Discord mobile mod (Kettu/Bunny/Vendetta)
- Internet connection for first-time setup

## Install in 5 taps
1. Download `key-intercept-loopback-android.apk` from the latest release.
2. Open APK and allow install from unknown sources if prompted.
3. Open **Key Intercept Loopback**.
4. Tap **Start Background Service**.
5. Tap **Fix Battery Optimization** and allow the exemption.

The app notification should read:
**Key Intercept Loopback is running in the background**

## Build with a custom loopback port (testing)
From `/home/runner/work/key-intercept-v2/key-intercept-v2/mobile/android-loopback`:

```sh
gradle :app:assembleDebug -PloopbackPort=46001
```

You can also use an environment variable:

```sh
KEY_INTERCEPT_LOOPBACK_PORT=46001 gradle :app:assembleDebug
```

## Developer mode relay defaults (testing)
To build with developer mode enabled across components:

```sh
KEY_INTERCEPT_DEVELOPER_MODE=1 gradle :app:assembleDebug -PdeveloperMode=true
```

This sets Android `BuildConfig.RELAY_PORT` default to `46001` unless you override `-PrelayPort` or `KEY_INTERCEPT_RELAY_PORT`.

## Plugin setup (one-time)
1. Open Kettu/Bunny plugin settings.
2. Add plugin source: `https://key-intercept.github.io/key-intercept-v2/`
3. Enable Key Intercept plugin.

## Diagnostics
- If loopback is not detected, keep the app open once and retry plugin sync.
- If service stops, re-open app and tap **Start Background Service**.
- If Android kills background activity, re-run **Fix Battery Optimization**.

## Screenshot checklist for release notes
- Home screen showing **Start Background Service**
- Running state text
- Persistent notification text
- Battery optimization prompt
