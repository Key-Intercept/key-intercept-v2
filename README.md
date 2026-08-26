# key-intercept-v2

Self-hosted refactor split into three components:

1. **Vencord plugin** (`/plugin/keyInterceptSelfHosted.tsx`)
   - Restores the original key-intercept message transform pipeline (rules, gag, pet, bimbo, horny, uwu, censored, drone).
   - Supports hybrid loopback transport:
     - `desktop_http`: reads/writes schema-shaped local config from the localhost loopback service.
     - `in_app_mobile`: uses in-app persistent storage and relay-backed sync queue.
     - `auto` (default): picks mobile in-app mode on mobile runtimes, localhost mode otherwise.
   - Exposes profile-embedded UI for config editing + allowed-editor ACL management.
   - Sends remote update commands through the relay server.

2. **Loopback server (Rust)** (`/loopback-server`)
   - Stores config locally at `~/.config/key-intercept/config.json`.
   - Tracks allowed editor Discord IDs.
   - Enforces ACLs when config is read/updated.
   - Optionally self-registers with relay via `RELAY_SERVER_URL`.

3. **Relay server (Rust)** (`/relay-server`)
   - Runs on VPS and tracks online users.
   - Forwards config fetch/update requests to registered loopback nodes.
   - Stores mobile snapshot state and queues remote updates for mobile owners while the app is closed.
   - Exposes `/users/:owner_id/mobile/snapshot` and `/users/:owner_id/mobile/sync` for mobile state upload/sync.

## Build and test

```bash
cargo test -p loopback-server -p relay-server -p key-intercept-installer
cargo check -p loopback-server -p relay-server -p key-intercept-installer
npm --prefix plugin test
```

## Installer (Rust, plugin + loopback)

Use:

When run from this repository (or any subdirectory inside it), the installer builds `loopback-server` from local source and uses the local plugin file.  
When local sources are not detected, it downloads pre-built artifacts from the latest successful GitHub Actions run, installs them locally, and configures startup.

```bash
cargo run -p key-intercept-installer -- \
  --owner-discord-id <OWNER_DISCORD_ID> \
  [--plugin-install-mode vencord-custom] \
  [--relay-server-url <RELAY_SERVER_URL>]
```

On Windows, if `--owner-discord-id` is omitted, the installer opens a GUI wizard to collect `OWNER_DISCORD_ID` and `RELAY_SERVER_URL`.  
On Linux/macOS, `--owner-discord-id` remains required and installer usage is CLI-only.

Default relay URL: `http://82.165.196.147:45491`

By default it expects two artifact names in that latest successful run:
- `loopback-server-linux-x86_64` (Linux)
- `loopback-server-macos-x86_64` (macOS)
- `loopback-server-windows-x86_64` (Windows)
- `key-intercept-plugin`

You can override artifact names with:
- `--loopback-artifact <name>`
- `--plugin-artifact <name>`

It installs:
- loopback binary to `~/.local/bin/key-intercept-loopback` on Unix, or `%LOCALAPPDATA%/Programs/key-intercept/key-intercept-loopback.exe` on Windows
- plugin file to `~/Vencord/src/userplugins/key-intercept/index.tsx` (removes and reclones `~/Vencord` automatically)
- startup service via user `systemd` unit on Unix, or `%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/key-intercept-loopback.cmd` on Windows

`--plugin-install-mode vencord-custom` is accepted for backward compatibility; custom Vencord installation is always used.

The relay server is intended for manual VPS deployment and is not included in installer automation.

## GitHub Actions workflows

- `CI`: runs plugin and Rust tests on pull requests and pushes.
- `Build and Release`: runs on pushes to `main`, auto-generates the next `vX.Y.Z` tag from the latest existing tag, builds loopback/plugin artifacts for installer downloads, builds installer packages for Linux/Windows, and publishes a GitHub release asset set.
