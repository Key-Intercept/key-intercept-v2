# key-intercept-v2

Self-hosted refactor split into three components:

1. **Vencord plugin** (`/plugin/keyInterceptSelfHosted.tsx`)
   - Restores the original key-intercept message transform pipeline (rules, gag, pet, bimbo, horny, uwu, censored, drone).
   - Reads/writes schema-shaped local config from the loopback service.
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

## Build and test

```bash
cargo test -p loopback-server
cargo check -p loopback-server -p relay-server -p key-intercept-installer
```

## Installer (Rust, plugin + loopback)

Use:

The installer downloads pre-built artifacts from the latest successful GitHub Actions run, installs them locally, and configures startup.

```bash
cargo run -p key-intercept-installer -- \
  --owner-discord-id <OWNER_DISCORD_ID> \
  [--relay-server-url <RELAY_SERVER_URL>]
```

By default it expects two artifact names in that latest successful run:
- `loopback-server-linux-x86_64`
- `key-intercept-plugin`

You can override artifact names with:
- `--loopback-artifact <name>`
- `--plugin-artifact <name>`

It installs:
- loopback binary to `~/.local/bin/key-intercept-loopback`
- plugin file to `~/.config/Vencord/plugins/keyInterceptSelfHosted.tsx`
- user systemd service `key-intercept-loopback.service`

The relay server is intended for manual VPS deployment and is not included in installer automation.
