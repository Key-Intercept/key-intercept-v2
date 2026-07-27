#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <OWNER_DISCORD_ID> [RELAY_SERVER_URL]"
  exit 1
fi

OWNER_DISCORD_ID="$1"
RELAY_SERVER_URL="${2:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOOPBACK_BIN_DIR="${HOME}/.local/bin"
LOOPBACK_BIN="${LOOPBACK_BIN_DIR}/key-intercept-loopback"
VENCORD_PLUGIN_DIR="${VENCORD_PLUGIN_DIR:-${HOME}/.config/Vencord/plugins}"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SYSTEMD_USER_DIR}/key-intercept-loopback.service"

mkdir -p "${LOOPBACK_BIN_DIR}" "${VENCORD_PLUGIN_DIR}" "${SYSTEMD_USER_DIR}"

cargo build --release --manifest-path "${REPO_ROOT}/Cargo.toml" -p loopback-server
install -m 0755 "${REPO_ROOT}/target/release/loopback-server" "${LOOPBACK_BIN}"
install -m 0644 "${REPO_ROOT}/plugin/keyInterceptSelfHosted.tsx" "${VENCORD_PLUGIN_DIR}/keyInterceptSelfHosted.tsx"

cat > "${SERVICE_FILE}" <<SERVICE
[Unit]
Description=Key Intercept Loopback Server
After=network-online.target

[Service]
Type=simple
ExecStart=${LOOPBACK_BIN}
Environment=OWNER_DISCORD_ID=${OWNER_DISCORD_ID}
Environment=LOOPBACK_PORT=35491
Environment=KEY_INTERCEPT_CONFIG_PATH=${HOME}/.config/key-intercept/config.json
${RELAY_SERVER_URL:+Environment=RELAY_SERVER_URL=${RELAY_SERVER_URL}}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
SERVICE

systemctl --user daemon-reload
systemctl --user enable --now key-intercept-loopback.service

echo "Installed loopback server and plugin."
echo "Plugin file: ${VENCORD_PLUGIN_DIR}/keyInterceptSelfHosted.tsx"
echo "Service: key-intercept-loopback.service"
