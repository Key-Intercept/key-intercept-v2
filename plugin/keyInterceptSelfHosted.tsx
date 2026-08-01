import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { React, UserStore } from "@webpack/common";

const LOOPBACK = "http://127.0.0.1:35491";

type Config = {
    rules_end: string;
    gag_end: string;
    pet_end: string;
    pet_amount: number;
    pet_type: number;
    bimbo_end: string;
    horny_end: string;
    bimbo_word_length: number;
    drone_end: string;
    uwu_end: string;
    censored_end: string;
    censored_replacement: string;
    debug: boolean;
};

type Rule = {
    rule_regex: string;
    rule_replacement: string;
    regex_normalize: boolean;
    enabled: boolean;
    chance_to_apply: number;
    order: number;
    group_id: number;
};

type RuleGroup = {
    id: number;
    disabled_at: string;
};

type WhitelistItem = {
    server_name: string;
    discord_id: string;
};

type DroneConfig = {
    drone_health: number;
    speech_header: string;
    speech_footer: string;
    action_header: string;
    action_footer: string;
    whisper_header: string;
    whisper_footer: string;
    loud_header: string;
    loud_footer: string;
    drone_term: string;
};

type LocalConfig = {
    config: Config;
    rules: Rule[];
    rules_groups: RuleGroup[];
    whitelist: WhitelistItem[];
    pet_words: string[];
    censored_words: string[];
    drone_config: DroneConfig;
};

const farFuture = "9999-12-31T23:59:59.000Z";

const defaultLocalConfig: LocalConfig = {
    config: {
        rules_end: farFuture,
        gag_end: "1970-01-01T00:00:00.000Z",
        pet_end: "1970-01-01T00:00:00.000Z",
        pet_amount: 0,
        pet_type: 0,
        bimbo_end: "1970-01-01T00:00:00.000Z",
        horny_end: "1970-01-01T00:00:00.000Z",
        bimbo_word_length: 12,
        drone_end: "1970-01-01T00:00:00.000Z",
        uwu_end: "1970-01-01T00:00:00.000Z",
        censored_end: "1970-01-01T00:00:00.000Z",
        censored_replacement: "*",
        debug: false
    },
    rules: [],
    rules_groups: [],
    whitelist: [],
    pet_words: [],
    censored_words: [],
    drone_config: {
        drone_health: 100,
        speech_header: "Acknowledged",
        speech_footer: "Compliance complete",
        action_header: "ACTION",
        action_footer: "ACTION COMPLETE",
        whisper_header: "WHISPER",
        whisper_footer: "WHISPER COMPLETE",
        loud_header: "LOUD",
        loud_footer: "LOUD COMPLETE",
        drone_term: "Drone"
    }
};

function cloneDefaultConfig(): LocalConfig {
    return JSON.parse(JSON.stringify(defaultLocalConfig)) as LocalConfig;
}

let interceptConfig: LocalConfig = cloneDefaultConfig();

function currentUser() {
    return UserStore.getCurrentUser();
}

const MessageStore = findByPropsLazy("getMessage", "getMessages");
const MessageActions = findByPropsLazy("editMessage");
const ChannelStore = findByPropsLazy("getChannel", "getDMFromUserId");
const GuildStore = findByPropsLazy("getGuild", "getGuilds");

function mergeLocalConfig(raw: unknown): LocalConfig {
    if (!raw || typeof raw !== "object") return cloneDefaultConfig();

    const asRecord = raw as Record<string, unknown>;
    return {
        config: {
            ...defaultLocalConfig.config,
            ...((asRecord.config as Record<string, unknown>) ?? {})
        } as Config,
        rules: Array.isArray(asRecord.rules) ? (asRecord.rules as Rule[]) : [],
        rules_groups: Array.isArray(asRecord.rules_groups) ? (asRecord.rules_groups as RuleGroup[]) : [],
        whitelist: Array.isArray(asRecord.whitelist) ? (asRecord.whitelist as WhitelistItem[]) : [],
        pet_words: Array.isArray(asRecord.pet_words) ? (asRecord.pet_words as string[]) : [],
        censored_words: Array.isArray(asRecord.censored_words) ? (asRecord.censored_words as string[]) : [],
        drone_config: {
            ...defaultLocalConfig.drone_config,
            ...((asRecord.drone_config as Record<string, unknown>) ?? {})
        } as DroneConfig
    };
}

async function readLocalConfig(): Promise<LocalConfig> {
    const response = await fetch(`${LOOPBACK}/config`, {
        headers: {
            "x-discord-user-id": currentUser().id
        }
    });
    if (!response.ok) throw new Error(`Failed reading local config: ${response.status}`);
    const payload = mergeLocalConfig(await response.json());
    interceptConfig = payload;
    return payload;
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
    interceptConfig = mergeLocalConfig(config);
}

async function getAllowedEditors() {
    const response = await fetch(`${LOOPBACK}/allowed-editors`);
    if (!response.ok) throw new Error(`Failed loading editors: ${response.status}`);
    return response.json() as Promise<{ allowed_editors: string[] }>;
}

async function addAllowedEditor(requesterId: string, editorId: string) {
    const response = await fetch(`${LOOPBACK}/allowed-editors`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-discord-user-id": requesterId
        },
        body: JSON.stringify({ editor_id: editorId })
    });

    if (!response.ok) throw new Error(`Failed adding editor: ${response.status}`);
}

async function removeAllowedEditor(requesterId: string, editorId: string) {
    const response = await fetch(`${LOOPBACK}/allowed-editors/${encodeURIComponent(editorId)}`, {
        method: "DELETE",
        headers: {
            "x-discord-user-id": requesterId
        }
    });

    if (!response.ok) throw new Error(`Failed removing editor: ${response.status}`);
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

class NormalizedString {
    str: string;
    nfkdStr: string;
    indices: { pre: [number, number]; post: [number, number] }[];

    constructor(str: string) {
        this.str = str;
        this.nfkdStr = "";
        this.indices = [];
        this.rebuild();
    }

    replace(regex: RegExp, fn: (match: string) => string): string {
        const regexWithIndices = new RegExp(regex, "gid");
        let match;
        while ((match = regexWithIndices.exec(this.nfkdStr)) != null) {
            const [postStart, postEnd] = match.indices![0]!;
            const [preStart, preEnd] = this.convert(postStart, postEnd);
            this.str = this.str.substring(0, preStart) + fn(match[0]) + this.str.substring(preEnd);
            this.rebuild();
        }
        return this.str;
    }

    rebuild() {
        this.nfkdStr = "";
        this.indices = [];

        for (let i = 0; i < this.str.length; i++) {
            let char = this.str[i];
            let preEnd = i + 1;
            const charCode = char.charCodeAt(0);

            if (charCode >= 0xd800 && charCode <= 0xdfff) {
                char = this.str.substring(i, i + 2);
                preEnd = i + 2;
                i++;
            }

            const normalized = char.normalize("NFKD");
            const postStart = this.nfkdStr.length;
            const postEnd = postStart + normalized.length;

            this.indices.push({ pre: [preEnd - char.length, preEnd], post: [postStart, postEnd] });
            this.nfkdStr += normalized;
        }
    }

    convert(postStart: number, postEnd: number): [number, number] {
        let preStart = -1;
        let preEnd = -1;

        for (const index of this.indices) {
            if (preStart === -1 && index.post[0] <= postStart && index.post[1] > postStart) {
                preStart = index.pre[0];
            }
            if (preEnd === -1 && index.post[0] < postEnd && index.post[1] >= postEnd) {
                preEnd = index.pre[1];
            }
        }

        return [preStart, preEnd];
    }
}

function isLink(word: string): boolean {
    return word.startsWith("http");
}

function shouldApply(endIso: string): boolean {
    return Date.now() <= new Date(endIso).getTime();
}

function shouldApplyRules(config: Config): boolean {
    return shouldApply(config.rules_end);
}

function shouldApplyGag(config: Config): boolean {
    return shouldApply(config.gag_end);
}

function shouldApplyPet(config: Config): boolean {
    return shouldApply(config.pet_end) && config.pet_amount !== 0;
}

function shouldApplyBimbo(config: Config): boolean {
    return shouldApply(config.bimbo_end);
}

function shouldApplyHorny(config: Config): boolean {
    return shouldApply(config.horny_end);
}

function shouldApplyDrone(config: Config): boolean {
    return shouldApply(config.drone_end);
}

function shouldApplyUWU(config: Config): boolean {
    return shouldApply(config.uwu_end);
}

function shouldApplyCensored(config: Config): boolean {
    return shouldApply(config.censored_end);
}

function applyRules(msg: string): string {
    if (!shouldApplyRules(interceptConfig.config)) return msg;

    let output = msg.normalize("NFKC");
    const groups = interceptConfig.rules_groups;
    const sortedRules = [...interceptConfig.rules].sort((a, b) => a.order - b.order);

    for (const rule of sortedRules) {
        let enabled = rule.enabled;
        for (const group of groups) {
            if (group.id === rule.group_id && new Date(group.disabled_at).getTime() > Date.now()) {
                enabled = true;
            }
        }

        if (!enabled) continue;

        const temp = new RegExp(rule.rule_regex.toString().replaceAll("\\\\", "\\"));
        const matchCallback = (match: string): string => {
            if (Math.random() > rule.chance_to_apply) return match;
            return match.replace(new RegExp(temp, "i"), rule.rule_replacement);
        };

        if (rule.regex_normalize) {
            output = new NormalizedString(output).replace(new RegExp(temp, "gi"), matchCallback);
        } else {
            output = output.replace(new RegExp(temp, "gi"), matchCallback);
        }
    }

    return output;
}

function applyUWU(msg: string): string {
    if (!shouldApplyUWU(interceptConfig.config)) return msg;

    let output = "";
    for (let word of msg.split(" ")) {
        if (isLink(word)) {
            output += `${word} `;
            continue;
        }

        word = word.replace(new RegExp("th", "gi"), "d");
        word = word.replace(new RegExp("r|l", "gi"), "w");
        word = word.replace(new RegExp("u", "gi"), "uw");
        word = word.replace(new RegExp("n([aeiou])", "gi"), "ny$1");
        word = word.replace(new RegExp("ove", "gi"), "uv");
        output += `${word} `;
    }

    return output;
}

function applyHorny(msg: string): string {
    if (!shouldApplyHorny(interceptConfig.config)) return msg;

    const hornyWords = ["hmmph", "nngh", "ahhh", "ooh", "oohh", "mmm", "hehe", "hehehe", "heheh", "eheh", "ehehe", "eheheh", "guhh", "pleasee", "need to cumm", "oh goshh", "ohhh", "ahhh", "cummm", "gggg"];
    let output = "";

    for (const word of msg.split(" ")) {
        if (!isLink(word) && Math.random() < 0.75) {
            output += `${hornyWords[Math.floor(Math.random() * hornyWords.length)]} `;
        }
        output += `${word} `;
    }

    return output;
}

function applyPet(msg: string): string {
    if (!shouldApplyPet(interceptConfig.config)) return msg;

    const petWords = interceptConfig.pet_words;
    if (petWords.length === 0) return msg;

    let output = "";
    for (const word of msg.split(" ")) {
        if (isLink(word)) {
            output += `${word} `;
            continue;
        }

        if (word.startsWith(":") && word.endsWith(":")) {
            output += `${word} `;
            continue;
        }

        if (Math.random() < interceptConfig.config.pet_amount) {
            output += petWords[Math.floor(Math.random() * petWords.length)];
        } else {
            output += word;
        }
        output += " ";
    }

    return output;
}

function applyBimbo(msg: string): string {
    if (!shouldApplyBimbo(interceptConfig.config)) return msg;

    let output = "";
    const pronouns = ["i", "you", "he", "she", "it", "we", "they", "is"];
    const maxWordLength = interceptConfig.config.bimbo_word_length;
    const likeChance = 0.1;
    const gargleWords = ["like", "hehe", "uhh", "totally", "so dumbb", "ummm", "hhhhh"];
    const punctuation = [".", ",", "!", "<", ">", "[", "]", "{", "}", "/", "?", ";", ":", "'", "@", "#", "~", "-", "_", "\"", ")", "(", "*", "&", "&", "^", "%", "$", "£", "+", "=", "`", "¬", "|", "\\"];

    for (const word of msg.split(" ")) {
        let changed = false;

        if (!isLink(word)) {
            if (pronouns.includes(word.toLowerCase())) {
                output += `${word} like totally `;
                changed = true;
            }

            let punctuationCount = 0;
            for (const char of word) {
                if (punctuation.includes(char)) punctuationCount++;
            }

            if (word.length - punctuationCount > maxWordLength) {
                output += `${word.substring(0, Math.max(maxWordLength - 2, 1))}uhhhh long words harddd hehe`;
                return output;
            }
        }

        if (!changed) output += `${word} `;
        if (Math.random() < likeChance && !isLink(word)) {
            output += `${gargleWords[Math.floor(Math.random() * (gargleWords.length - 1))]} `;
        }
    }

    return output;
}

function applyCensored(msg: string): string {
    if (!shouldApplyCensored(interceptConfig.config)) return msg;

    for (const word of interceptConfig.censored_words) {
        let replacement = "";
        for (let i = 0; i < word.length; i += interceptConfig.config.censored_replacement.length) {
            replacement += interceptConfig.config.censored_replacement;
        }
        msg = msg.replace(new RegExp(word, "gi"), replacement);
    }

    return msg;
}

function applyGag(msg: string): string {
    if (!shouldApplyGag(interceptConfig.config)) return msg;

    let output = "";
    let inEmote = false;
    const remainChars = ["a", "e", "i", "o", "u", "g", "h", "A", "E", "I", "O", "U", "G", "H", "?", "!", ".", ",", ":", ";", "#", "*", "-", "(", ")", "~"];

    for (const word of msg.split(" ")) {
        if (isLink(word)) {
            output += `${word} `;
            continue;
        }

        let outWord = "";
        for (const char of word) {
            if (char === ":" && !inEmote) {
                inEmote = true;
                outWord += char;
                continue;
            } else if (char === ":" && inEmote) {
                inEmote = false;
                outWord += char;
                continue;
            }

            if (inEmote) {
                outWord += char;
                continue;
            }

            if (remainChars.includes(char)) {
                outWord += char;
            } else {
                if (!(char.charCodeAt(0) >= 97 && char.charCodeAt(0) <= 122)) {
                    outWord += ["G", "H"][Math.floor(Math.random() * 2)];
                } else {
                    outWord += ["g", "h"][Math.floor(Math.random() * 2)];
                }
            }
        }
        output += `${outWord} `;
    }

    return output;
}

function getPreviousMessage(channelId: string) {
    const messages = MessageStore?.getMessages?.(channelId);
    if (!messages) return null;

    const list = Array.isArray(messages) ? messages : messages._array ?? Object.values(messages);
    return list.at(-1) ?? null;
}

function editPreviousMessage(channelId: string, messageId: string, newContent: string) {
    if (!MessageActions?.editMessage) return;
    MessageActions.editMessage(channelId, messageId, { content: newContent });
}

function applyDrone(msg: string, channelId: string): { message: string; editPreviousMessage?: { channelId: string; messageId: string; newContent: string } } {
    if (!shouldApplyDrone(interceptConfig.config)) return { message: msg };

    const drone = interceptConfig.drone_config;
    if (drone.drone_health < 10) {
        return { message: `\`${drone.drone_term} haaaaas receieved bzzzzt, ppplease provide repaiirs using beep '/repair', tthank youu. Returned Error: 0x7547372482\`` };
    }

    let containsLink = false;
    for (const word of msg.split(" ")) {
        if (isLink(word)) {
            containsLink = true;
        }
    }

    let output = "";
    if (!containsLink) {
        msg = msg
            .replace(new RegExp("\\bMe\\b", "gi"), drone.drone_term)
            .replace(new RegExp("\\bMy\\b", "gi"), "Its'")
            .replace(new RegExp("\\bI am\\b", "gi"), "It is")
            .replace(new RegExp("\\bI(')?m\\b", "gi"), "It is")
            .replace(new RegExp("\\bI\\b", "gi"), drone.drone_term);
    }

    for (const word of msg.split(" ")) {
        if (!isLink(word)) {
            if (Math.random() > (drone.drone_health / 100)) {
                output += Math.random() > 0.5 ? "`beep` " : "`bzzzt` ";
            }
        }
        output += `${word} `;
    }

    const tempOutput = output;
    output = "";
    let lastTriggered = 0;
    for (const word of tempOutput.split(" ")) {
        let outWord = "";
        if (!isLink(word)) {
            for (const char of word) {
                outWord += char;
                lastTriggered += 1;
                if (Math.random() + (lastTriggered / 100) - 1 > (drone.drone_health / 100) && char !== "`") {
                    lastTriggered = 0;
                    for (let i = 0; i < Math.floor(Math.random() * 10); i++) {
                        outWord += char;
                    }
                }
            }
        } else {
            outWord = word;
        }
        output += `${outWord} `;
    }

    const previousMessage = getPreviousMessage(channelId);
    const previousSenderId = previousMessage?.author?.id ?? null;
    const currentUserId = currentUser().id;

    let header = drone.speech_header;
    let footer = drone.speech_footer;

    if (msg.startsWith("**")) {
        header = drone.loud_header;
        footer = drone.loud_footer;
    } else if (msg.startsWith("*")) {
        header = drone.action_header;
        footer = drone.action_footer;
    } else if (msg.startsWith("-#")) {
        header = drone.whisper_header;
        footer = drone.whisper_footer;
    }

    const footerSuffix = `\n\`${footer}\``;
    const previousHadMatchingFooter = previousMessage?.content?.endsWith(footerSuffix) ?? false;
    const continuingOwnBlock = previousSenderId != null && previousSenderId === currentUserId;

    const editPrevious = continuingOwnBlock && previousHadMatchingFooter
        ? {
            channelId,
            messageId: previousMessage.id,
            newContent: previousMessage.content.replace(footerSuffix, "")
        }
        : undefined;

    output = `${output.trimEnd()}${footerSuffix}`;
    if (!continuingOwnBlock || !previousHadMatchingFooter) {
        output = `\`${header}\`\n${output}`;
    }

    return {
        message: output,
        editPreviousMessage: editPrevious
    };
}

function applyReplacements(msg: string, channelId: string): string {
    if (!interceptConfig?.config) return msg;

    const originalMsg = msg;
    msg = applyRules(msg);
    msg = applyUWU(msg);
    msg = applyHorny(msg);
    msg = applyPet(msg);
    msg = applyBimbo(msg);
    msg = applyCensored(msg);
    msg = applyGag(msg);

    const droneResult = applyDrone(msg, channelId);
    msg = droneResult.message;

    if (droneResult.editPreviousMessage) {
        editPreviousMessage(
            droneResult.editPreviousMessage.channelId,
            droneResult.editPreviousMessage.messageId,
            droneResult.editPreviousMessage.newContent
        );
    }

    if (interceptConfig.config.debug) {
        return `${msg}\n(original message: ${originalMsg})`;
    }

    return msg;
}

function ConfigPanel() {
    const [targetUserId, setTargetUserId] = React.useState("");
    const [newEditorId, setNewEditorId] = React.useState("");
    const [rawConfig, setRawConfig] = React.useState(JSON.stringify(interceptConfig, null, 2));
    const [allowedEditors, setAllowedEditors] = React.useState<string[]>([]);
    const [status, setStatus] = React.useState("");

    const refresh = React.useCallback(async () => {
        const [config, editors] = await Promise.all([readLocalConfig(), getAllowedEditors()]);
        setRawConfig(JSON.stringify(config, null, 2));
        setAllowedEditors(editors.allowed_editors.sort());
    }, []);

    React.useEffect(() => {
        refresh().catch(err => setStatus(String(err)));
    }, [refresh]);

    return (
        <div style={{ width: "100%", maxWidth: "720px", margin: "0 auto", color: "#eee", backgroundColor: "#1e1e1e", border: "2px solid #eee", borderRadius: "16px", padding: "16px" }}>
            <h3 style={{ marginTop: 0, textAlign: "center" }}>key-intercept control</h3>
            <p style={{ marginTop: 0 }}>Self-hosted config with original key-intercept transforms + relay/ACL controls.</p>
            <div style={{ display: "grid", gap: "8px" }}>
                <button onClick={async () => {
                    try {
                        await refresh();
                        setStatus("Loaded config + editors");
                    } catch (err) {
                        setStatus(String(err));
                    }
                }}>Reload</button>
                <textarea
                    style={{ width: "100%", minHeight: "220px", backgroundColor: "#111", color: "#eee", border: "1px solid #555", borderRadius: "8px", padding: "8px" }}
                    value={rawConfig}
                    onChange={e => setRawConfig(e.currentTarget.value)}
                />
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <button onClick={async () => {
                        try {
                            await saveLocalConfig(currentUser().id, mergeLocalConfig(JSON.parse(rawConfig)));
                            setStatus("Saved local config");
                        } catch (err) {
                            setStatus(String(err));
                        }
                    }}>Save Local Config</button>
                    <input
                        placeholder="Target owner ID"
                        value={targetUserId}
                        onChange={e => setTargetUserId(e.currentTarget.value)}
                        style={{ flex: 1, minWidth: "180px" }}
                    />
                    <button onClick={async () => {
                        try {
                            await pushRemoteConfig(settings.store.relayUrl, currentUser().id, targetUserId, mergeLocalConfig(JSON.parse(rawConfig)));
                            setStatus(`Pushed remote update to ${targetUserId}`);
                        } catch (err) {
                            setStatus(String(err));
                        }
                    }}>Push Remote Update</button>
                </div>
                <div style={{ borderTop: "1px solid #444", paddingTop: "8px" }}>
                    <strong>Allowed Editors</strong>
                    <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                        <input
                            placeholder="Discord ID"
                            value={newEditorId}
                            onChange={e => setNewEditorId(e.currentTarget.value)}
                            style={{ flex: 1 }}
                        />
                        <button onClick={async () => {
                            try {
                                await addAllowedEditor(currentUser().id, newEditorId);
                                setNewEditorId("");
                                await refresh();
                                setStatus("Added allowed editor");
                            } catch (err) {
                                setStatus(String(err));
                            }
                        }}>Add</button>
                    </div>
                    <ul style={{ marginBottom: 0 }}>
                        {allowedEditors.map(editor => (
                            <li key={editor} style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                                <span>{editor}</span>
                                <button onClick={async () => {
                                    try {
                                        await removeAllowedEditor(currentUser().id, editor);
                                        await refresh();
                                        setStatus(`Removed ${editor}`);
                                    } catch (err) {
                                        setStatus(String(err));
                                    }
                                }}>Remove</button>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
            <p style={{ marginBottom: 0 }}>{status}</p>
        </div>
    );
}

const settings = definePluginSettings({
    relayUrl: {
        type: OptionType.STRING,
        description: "Public relay URL",
        default: "http://82.165.196.147:45491"
    }
});

const plugin = definePlugin({
    name: "key-intercept",
    description: "Original key-intercept behavior with self-hosted loopback/relay config",
    authors: [{ name: "Tom", id: 277137325342064640n }],
    settings,
    async start() {
        try {
            await readLocalConfig();
        } catch (err) {
            console.error("key-intercept failed to load local config", err);
        }
    },
    stop() {},
    onBeforeMessageSend(channelId: string, msg: { content: string }) {
        const channel = ChannelStore?.getChannel?.(channelId);
        if (!channel || !interceptConfig?.config) return;

        let nameToCheck: string | null = null;
        let idToCheck: string | null = null;

        if (channel.guild_id) {
            const guild = GuildStore?.getGuild(channel.guild_id);
            nameToCheck = guild?.name ?? null;
            idToCheck = guild?.id ?? null;
        } else if (channel.name) {
            nameToCheck = channel.name;
        } else if (channel.recipients?.length > 0) {
            const activeUser = UserStore.getCurrentUser();
            const recipientNames = channel.recipients
                .filter((id: string) => id !== activeUser.id)
                .map((id: string) => UserStore.getUser(id)?.username)
                .filter(Boolean);
            nameToCheck = recipientNames.join(", ");
            idToCheck = channel.id ?? null;
        }

        const whitelist = interceptConfig.whitelist;
        if (whitelist.length > 0) {
            const nameMatches = !!nameToCheck && whitelist.some(item => item.server_name === nameToCheck);
            const idMatches = !!idToCheck && whitelist.some(item => item.discord_id === idToCheck);
            if ((nameToCheck || idToCheck) && !nameMatches && !idMatches) {
                return;
            }
        }

        const channelName = channel?.name?.toLowerCase?.() ?? "";
        if (channelName.includes("sfw") && !channelName.includes("nsfw")) return;

        msg.content = applyReplacements(msg.content, channelId);
    },
    userProfileBadge: {
        id: "key-intercept-controls",
        key: "key-intercept-controls",
        description: "key-intercept controls",
        component: ConfigPanel
    }
});

export default plugin;
