# key-intercept-v2

Self-hosted refactor split into three components:

1. **Vencord plugin** (`/plugin/keyInterceptSelfHosted.tsx`)
   - Reads/writes local config from the loopback service.
   - Exposes profile-embedded UI for config editing.
   - Sends remote update commands through the relay server.

2. **Loopback server (Rust)** (`/loopback-server`)
   - Stores config locally at `~/.config/key-intercept/config.json`.
   - Tracks allowed editor Discord IDs.
   - Enforces ACLs when config is read/updated.
   - Optionally self-registers with relay via `RELAY_SERVER_URL`.

3. **Relay server (Rust)** (`/relay-server`)
   - Runs on VPS and tracks online users.
   - Forwards config fetch/update requests to registered loopback nodes.

## Build and test

```bash
cargo test -p loopback-server
cargo check -p loopback-server -p relay-server
```

## Installer (plugin + loopback)

Use:

```bash
./installer/install.sh <OWNER_DISCORD_ID> [RELAY_SERVER_URL]
```

This installs:
- loopback binary to `~/.local/bin/key-intercept-loopback`
- plugin file to `~/.config/Vencord/plugins/keyInterceptSelfHosted.tsx`
- user systemd service `key-intercept-loopback.service`

The relay server is intended for manual VPS deployment and is not included in installer automation.
