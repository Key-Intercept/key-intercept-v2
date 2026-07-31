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
cargo test -p loopback-server -p relay-server -p key-intercept-installer
cargo check -p loopback-server -p relay-server -p key-intercept-installer
npm --prefix plugin test
```

## Installer (Rust, plugin + loopback)

Use:

When run from this repository (or any subdirectory inside it), the installer builds `loopback-server` from local source and installs the local plugin file.  
When local sources are not detected, it downloads pre-built artifacts from the latest successful GitHub Actions run, installs them locally, and configures startup.

```bash
cargo run -p key-intercept-installer -- \
  --owner-discord-id <OWNER_DISCORD_ID> \
  [--relay-server-url <RELAY_SERVER_URL>]
```

Default relay URL: `http://82.165.196.147:45491`

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

For Vencord custom userplugin workflow (clone/update Vencord, copy plugin into `src/userplugins`, patch CSP for Supabase, run `pnpm install`, workspace dependency add, build, inject), use:

```bash
cargo run -p key-intercept-installer -- \
  --owner-discord-id <OWNER_DISCORD_ID> \
  --plugin-install-mode vencord-custom
```

The relay server is intended for manual VPS deployment and is not included in installer automation.

## GitHub Actions workflows

- `CI`: runs plugin and Rust tests on pull requests and pushes.
- `Build and Release`: builds loopback/plugin artifacts plus installer packages for Linux/macOS/Windows and publishes a GitHub release asset set when a `v*` tag is pushed (or via manual dispatch with `release_tag`).
