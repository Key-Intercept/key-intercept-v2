import definePlugin, { OptionType } from "@api/Settings";
import { React } from "@webpack/common";

const LOOPBACK = "http://127.0.0.1:35491";

type LocalConfig = Record<string, unknown>;

async function readLocalConfig(): Promise<LocalConfig> {
    const response = await fetch(`${LOOPBACK}/config`);
    if (!response.ok) throw new Error(`Failed reading local config: ${response.status}`);
    return response.json();
}

async function saveLocalConfig(userId: string, config: LocalConfig) {
    const response = await fetch(`${LOOPBACK}/config`, {
        method: "PUT",
        headers: {
            "content-type": "application/json",
            "x-discord-user-id": userId
        },
        body: JSON.stringify({ config })
    });

    if (!response.ok) throw new Error(`Failed saving local config: ${response.status}`);
}

async function pushRemoteConfig(relayUrl: string, editorId: string, targetUserId: string, config: LocalConfig) {
    const response = await fetch(`${relayUrl.replace(/\/$/, "")}/users/${targetUserId}/config`, {
        method: "PUT",
        headers: {
            "content-type": "application/json"
        },
        body: JSON.stringify({
            editor_id: editorId,
            config
        })
    });

    if (!response.ok) throw new Error(`Relay update failed: ${response.status}`);
}

function ConfigPanel() {
    const [targetUserId, setTargetUserId] = React.useState("");
    const [rawConfig, setRawConfig] = React.useState("{}");
    const [status, setStatus] = React.useState("");

    return (
        <div>
            <h3>Key Intercept (Self-Hosted)</h3>
            <p>Read and write your local replacement config, or push to another online user through the relay.</p>
            <button
                onClick={async () => {
                    try {
                        const config = await readLocalConfig();
                        setRawConfig(JSON.stringify(config, null, 2));
                        setStatus("Loaded local config");
                    } catch (err) {
                        setStatus(String(err));
                    }
                }}
            >
                Load Local Config
            </button>
            <textarea
                style={{ width: "100%", minHeight: "180px", marginTop: "8px" }}
                value={rawConfig}
                onChange={e => setRawConfig(e.currentTarget.value)}
            />
            <input
                placeholder="Target user ID for remote update"
                value={targetUserId}
                onChange={e => setTargetUserId(e.currentTarget.value)}
                style={{ width: "100%", marginTop: "8px" }}
            />
            <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                <button
                    onClick={async () => {
                        try {
                            await saveLocalConfig(
                                Vencord.Webpack.Common.UserStore.getCurrentUser().id,
                                JSON.parse(rawConfig)
                            );
                            setStatus("Saved local config");
                        } catch (err) {
                            setStatus(String(err));
                        }
                    }}
                >
                    Save Local Config
                </button>
                <button
                    onClick={async () => {
                        try {
                            const selfId = Vencord.Webpack.Common.UserStore.getCurrentUser().id;
                            await pushRemoteConfig(
                                plugin.settings.store.relayUrl,
                                selfId,
                                targetUserId,
                                JSON.parse(rawConfig)
                            );
                            setStatus(`Pushed config update to ${targetUserId}`);
                        } catch (err) {
                            setStatus(String(err));
                        }
                    }}
                >
                    Push Remote Update
                </button>
            </div>
            <p>{status}</p>
        </div>
    );
}

const plugin = definePlugin({
    name: "KeyInterceptSelfHosted",
    description: "Local loopback + relay based key intercept configuration",
    authors: [{ name: "Key-Intercept" }],
    settings: {
        relayUrl: {
            type: OptionType.STRING,
            description: "Public relay URL",
            default: "http://127.0.0.1:45491"
        }
    },
    start() {},
    stop() {},
    UserProfileBadge: ConfigPanel
});

export default plugin;
