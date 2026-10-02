# Quick Install: iOS Loopback (Silent Audio Keepalive)

## What you need
- iOS 16+
- Sideload method (AltStore/SideStore/TrollStore)
- Modified Discord client with plugin support

## Install flow
1. Download `key-intercept-loopback-ios.ipa` from the latest release.
2. Sideload the IPA using your preferred installer.
3. Open **Key Intercept Loopback**.
4. Tap **Start Loopback**.
5. Keep app permissions enabled for notifications.

The app should show:
**Key Intercept Loopback is running in the background**

The app enables silent audio keepalive in the background mode to keep the local service alive longer.

## Plugin setup (one-time)
1. Open your Discord mod plugin settings.
2. Add plugin source: `https://key-intercept.github.io/key-intercept-v2/`
3. Enable Key Intercept plugin.

## Diagnostics
- If sync fails, reopen app and tap **Start Loopback** again.
- If iOS suspends background tasks, reopen app and restart loopback.
- Ensure the sideload signature is still valid.

## Screenshot checklist for release notes
- App initial screen
- Running state text
- Start button state
- Notification permission prompt
