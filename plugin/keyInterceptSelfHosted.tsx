import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { React, UserStore } from "@webpack/common";

const LOOPBACK = "http://127.0.0.1:35491";
const DISCORD_SECURE_ORIGINS = new Set(["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com"]);

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
const epoch = "1970-01-01T00:00:00.000Z";

type ModeTimeoutFieldKey =
    | "rules_end"
    | "gag_end"
    | "pet_end"
    | "bimbo_end"
    | "horny_end"
    | "drone_end"
    | "uwu_end"
    | "censored_end";

const modeTimeoutFields: Array<{ key: ModeTimeoutFieldKey; label: string; }> = [
    { key: "rules_end", label: "Rule groups timeout" },
    { key: "gag_end", label: "Gag timeout" },
    { key: "pet_end", label: "Pet timeout" },
    { key: "bimbo_end", label: "Bimbo timeout" },
    { key: "horny_end", label: "Horny timeout" },
    { key: "drone_end", label: "Drone timeout" },
    { key: "uwu_end", label: "UWU timeout" },
    { key: "censored_end", label: "Censored timeout" }
];

const permanentTimestamp = new Date(farFuture).getTime();

const petTypeOptions = [
    { value: 0, label: "Type 0" },
    { value: 1, label: "Type 1" },
    { value: 2, label: "Type 2" },
    { value: 3, label: "Type 3" }
] as const;

const defaultLocalConfig: LocalConfig = {
    config: {
        rules_end: farFuture,
        gag_end: epoch,
        pet_end: epoch,
        pet_amount: 0,
        pet_type: 0,
        bimbo_end: epoch,
        horny_end: epoch,
        bimbo_word_length: 12,
        drone_end: epoch,
        uwu_end: epoch,
        censored_end: epoch,
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

function isLoopbackHostname(hostname: string): boolean {
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function relayBaseUrl(relayUrl: string): string {
    const trimmed = relayUrl.trim();
    try {
        const parsed = new URL(trimmed);
        if (
            typeof window !== "undefined"
            && DISCORD_SECURE_ORIGINS.has(window.location.origin)
            && parsed.protocol === "http:"
            && !isLoopbackHostname(parsed.hostname)
        ) {
            parsed.protocol = "https:";
        }
        return parsed.toString().replace(/\/$/, "");
    } catch {
        return trimmed.replace(/\/$/, "");
    }
}

async function pushRemoteConfig(relayUrl: string, editorId: string, targetUserId: string, config: LocalConfig) {
    const response = await fetch(`${relayBaseUrl(relayUrl)}/users/${targetUserId}/config`, {
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

async function readRemoteConfig(relayUrl: string, requesterId: string, targetUserId: string): Promise<LocalConfig> {
    const response = await fetch(
        `${relayBaseUrl(relayUrl)}/users/${targetUserId}/config?requester_id=${encodeURIComponent(requesterId)}`
    );
    if (!response.ok) throw new Error(`Relay config read failed: ${response.status}`);
    return mergeLocalConfig(await response.json());
}

async function requestRemoteAccess(relayUrl: string, requesterId: string, targetUserId: string) {
    const response = await fetch(`${relayBaseUrl(relayUrl)}/users/${targetUserId}/access-requests`, {
        method: "POST",
        headers: {
            "content-type": "application/json"
        },
        body: JSON.stringify({ requester_id: requesterId })
    });
    if (!response.ok) throw new Error(`Relay access request failed: ${response.status}`);
}

async function getAccessRequests(relayUrl: string, ownerId: string) {
    const response = await fetch(
        `${relayBaseUrl(relayUrl)}/users/${ownerId}/access-requests?requester_id=${encodeURIComponent(ownerId)}`
    );
    if (!response.ok) throw new Error(`Failed loading access requests: ${response.status}`);
    return response.json() as Promise<{ requests: string[] }>;
}

async function approveAccessRequest(relayUrl: string, ownerId: string, requesterId: string) {
    const response = await fetch(
        `${relayBaseUrl(relayUrl)}/users/${ownerId}/access-requests/${encodeURIComponent(requesterId)}/approve`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify({ owner_id: ownerId })
        }
    );
    if (!response.ok) throw new Error(`Failed approving access request: ${response.status}`);
}

async function denyAccessRequest(relayUrl: string, ownerId: string, requesterId: string) {
    const response = await fetch(
        `${relayBaseUrl(relayUrl)}/users/${ownerId}/access-requests/${encodeURIComponent(requesterId)}?requester_id=${encodeURIComponent(ownerId)}`,
        { method: "DELETE" }
    );
    if (!response.ok) throw new Error(`Failed denying access request: ${response.status}`);
}

function toLines(values: string[]): string {
    return values.join("\n");
}

function fromLines(value: string): string[] {
    return value
        .split("\n")
        .map(v => v.trim())
        .filter(Boolean);
}

function createTimeoutAdjustmentDefaults(): Record<ModeTimeoutFieldKey, string> {
    return modeTimeoutFields.reduce((acc, field) => {
        acc[field.key] = "1";
        return acc;
    }, {} as Record<ModeTimeoutFieldKey, string>);
}

function formatCountdown(msRemaining: number): string {
    if (msRemaining <= 0) return "Expired";
    const totalSeconds = Math.floor(msRemaining / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(" ");
}

function formatTimeoutStatus(endIso: string, nowMs: number): string {
    const endMs = Date.parse(endIso);
    if (!Number.isFinite(endMs)) return "Invalid timestamp";
    if (endMs >= permanentTimestamp - 1000) return "Permanent";
    return formatCountdown(endMs - nowMs);
}

function getProfileUserId(props: any): string | null {
    const candidates = [
        props?.user?.id,
        props?.profileUserId,
        props?.userId,
        props?.profile?.userId,
        props?.displayProfile?.userId
    ];
    return candidates.find((id: unknown): id is string => typeof id === "string" && id.length > 0) ?? null;
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

function ConfigPanel(props: any) {
    const activeUserId = currentUser().id;
    const profileUserId = getProfileUserId(props) ?? activeUserId;
    const isOwnProfile = profileUserId === activeUserId;

    const [newEditorId, setNewEditorId] = React.useState("");
    const [allowedEditors, setAllowedEditors] = React.useState<string[]>([]);
    const [pendingRequests, setPendingRequests] = React.useState<string[]>([]);
    const [status, setStatus] = React.useState("");
    const [editableConfig, setEditableConfig] = React.useState<LocalConfig>(cloneDefaultConfig());
    const [petWordsText, setPetWordsText] = React.useState("");
    const [censoredWordsText, setCensoredWordsText] = React.useState("");
    const [timeoutAdjustments, setTimeoutAdjustments] = React.useState<Record<ModeTimeoutFieldKey, string>>(
        () => createTimeoutAdjustmentDefaults()
    );
    const [nowMs, setNowMs] = React.useState(() => Date.now());
    const [canViewRemote, setCanViewRemote] = React.useState(isOwnProfile);
    const skipAutosaveRef = React.useRef(true);
    const lastSavedSnapshotRef = React.useRef("");
    const stopKeyPropagation = React.useCallback((event: React.KeyboardEvent) => {
        event.stopPropagation();
    }, []);
    const stopMousePropagation = React.useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
    }, []);

    const sectionStyle: React.CSSProperties = {
        background: "#2b2d31",
        border: "1px solid #3f4147",
        borderRadius: "12px",
        padding: "12px"
    };
    const inputStyle: React.CSSProperties = {
        width: "100%",
        borderRadius: "8px",
        border: "1px solid #3f4147",
        background: "#1e1f22",
        color: "#f2f3f5",
        padding: "8px"
    };
    const buttonStyle: React.CSSProperties = {
        borderRadius: "8px",
        border: "1px solid #5865f2",
        background: "#5865f2",
        color: "white",
        padding: "8px 12px",
        cursor: "pointer"
    };

    const updateFromConfig = React.useCallback((config: LocalConfig) => {
        skipAutosaveRef.current = true;
        setEditableConfig(config);
        setPetWordsText(toLines(config.pet_words));
        setCensoredWordsText(toLines(config.censored_words));
        lastSavedSnapshotRef.current = JSON.stringify({
            ...config,
            pet_words: config.pet_words,
            censored_words: config.censored_words
        });
    }, []);

    const refresh = React.useCallback(async () => {
        if (isOwnProfile) {
            const [config, editors, requests] = await Promise.all([
                readLocalConfig(),
                getAllowedEditors(),
                getAccessRequests(settings.store.relayUrl, activeUserId).catch(() => ({ requests: [] }))
            ]);
            updateFromConfig(config);
            setAllowedEditors(editors.allowed_editors.sort());
            setPendingRequests(requests.requests.sort());
            setCanViewRemote(true);
            return;
        }

        try {
            const remote = await readRemoteConfig(settings.store.relayUrl, activeUserId, profileUserId);
            updateFromConfig(remote);
            setCanViewRemote(true);
        } catch (err) {
            setCanViewRemote(false);
            setStatus(String(err));
        }
    }, [activeUserId, isOwnProfile, profileUserId, updateFromConfig]);

    React.useEffect(() => {
        refresh().catch(err => setStatus(String(err)));
    }, [refresh]);

    React.useEffect(() => {
        const handle = setInterval(() => {
            setNowMs(Date.now());
        }, 1000);
        return () => clearInterval(handle);
    }, []);

    const setTimeoutValue = React.useCallback((field: ModeTimeoutFieldKey, nextIso: string) => {
        setEditableConfig(prev => ({
            ...prev,
            config: {
                ...prev.config,
                [field]: nextIso
            }
        }));
    }, []);

    const addTimeoutAmount = React.useCallback((field: ModeTimeoutFieldKey, multiplierSeconds: number) => {
        const amount = Number(timeoutAdjustments[field]);
        if (!Number.isFinite(amount) || amount <= 0) {
            setStatus(`Enter a positive number for ${field}`);
            return;
        }

        const currentEndMs = Date.parse(editableConfig.config[field]);
        const baseline = Number.isFinite(currentEndMs) && currentEndMs > nowMs ? currentEndMs : nowMs;
        const nextIso = new Date(baseline + amount * multiplierSeconds * 1000).toISOString();
        setTimeoutValue(field, nextIso);
        setStatus(`${field}: ${formatTimeoutStatus(nextIso, nowMs)}`);
    }, [editableConfig.config, nowMs, setTimeoutValue, timeoutAdjustments]);

    const setPermanentTimeout = React.useCallback((field: ModeTimeoutFieldKey) => {
        setTimeoutValue(field, farFuture);
        setStatus(`${field}: Permanent`);
    }, [setTimeoutValue]);

    const saveConfig = React.useCallback(async (baseConfig: LocalConfig) => {
        const mergedConfig = mergeLocalConfig({
            ...baseConfig,
            pet_words: fromLines(petWordsText),
            censored_words: fromLines(censoredWordsText)
        });
        if (isOwnProfile) {
            await saveLocalConfig(activeUserId, mergedConfig);
            setStatus("Auto-saved local config");
        } else {
            await pushRemoteConfig(settings.store.relayUrl, activeUserId, profileUserId, mergedConfig);
            setStatus(`Auto-saved ${profileUserId}'s config via relay`);
        }
        lastSavedSnapshotRef.current = JSON.stringify(mergedConfig);
    }, [activeUserId, censoredWordsText, isOwnProfile, petWordsText, profileUserId]);

    React.useEffect(() => {
        if (!(isOwnProfile || canViewRemote)) return;
        if (skipAutosaveRef.current) {
            skipAutosaveRef.current = false;
            return;
        }

        const nextConfig = mergeLocalConfig({
            ...editableConfig,
            pet_words: fromLines(petWordsText),
            censored_words: fromLines(censoredWordsText)
        });
        const nextSnapshot = JSON.stringify(nextConfig);
        if (nextSnapshot === lastSavedSnapshotRef.current) return;

        const handle = setTimeout(() => {
            saveConfig(nextConfig).catch(err => setStatus(`Auto-save failed: ${String(err)}`));
        }, 250);

        return () => clearTimeout(handle);
    }, [canViewRemote, censoredWordsText, editableConfig, isOwnProfile, petWordsText, saveConfig]);

    return (
        <div
            style={{ width: "100%", maxWidth: "760px", margin: "0 auto", color: "#f2f3f5", background: "#313338", border: "1px solid #3f4147", borderRadius: "16px", padding: "16px", display: "grid", gap: "12px" }}
            onKeyDown={stopKeyPropagation}
            onKeyUp={stopKeyPropagation}
            onMouseDown={stopMousePropagation}
            onClick={stopMousePropagation}
        >
            <div style={{ ...sectionStyle, background: "#2b2d31" }}>
                <h3 style={{ margin: 0 }}>key-intercept control center</h3>
                <p style={{ margin: "6px 0 0 0", color: "#b5bac1" }}>
                    {isOwnProfile ? "Your profile configuration" : `Viewing profile ${profileUserId}`}
                </p>
            </div>

            {!isOwnProfile && !canViewRemote && (
                <div style={sectionStyle}>
                    <p style={{ marginTop: 0 }}>You do not currently have permission to view this profile config.</p>
                    <button
                        style={buttonStyle}
                        onClick={async () => {
                            try {
                                await requestRemoteAccess(settings.store.relayUrl, activeUserId, profileUserId);
                                setStatus(`Requested config access from ${profileUserId}`);
                            } catch (err) {
                                setStatus(String(err));
                            }
                        }}
                    >
                        Request Access via Relay
                    </button>
                </div>
            )}

            {(isOwnProfile || canViewRemote) && (
                <>
                    <div style={sectionStyle}>
                        <strong>Mode timeouts</strong>
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                            {modeTimeoutFields.map(({ key, label }) => (
                                <div key={key} style={{ border: "1px solid #3f4147", borderRadius: "10px", padding: "10px", display: "grid", gap: "8px" }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                                        <strong>{label}</strong>
                                        <span style={{ color: "#b5bac1" }}>{formatTimeoutStatus(editableConfig.config[key], nowMs)}</span>
                                    </div>
                                    <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                        <input
                                            style={{ ...inputStyle, width: "110px" }}
                                            type="number"
                                            min={1}
                                            value={timeoutAdjustments[key]}
                                            onChange={e => {
                                                const nextValue = e.currentTarget.value;
                                                setTimeoutAdjustments(prev => ({
                                                    ...prev,
                                                    [key]: nextValue
                                                }));
                                            }}
                                        />
                                        <button style={buttonStyle} onClick={() => addTimeoutAmount(key, 1)}>Add Seconds</button>
                                        <button style={buttonStyle} onClick={() => addTimeoutAmount(key, 60)}>Add Minutes</button>
                                        <button style={buttonStyle} onClick={() => addTimeoutAmount(key, 3600)}>Add Hours</button>
                                        <button style={buttonStyle} onClick={() => setPermanentTimeout(key)}>Permanent</button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div style={sectionStyle}>
                        <strong>Numeric values</strong>
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                            <label>Pet amount (0-1)<input style={inputStyle} type="number" min={0} max={1} step={0.01} value={editableConfig.config.pet_amount} onChange={e => setEditableConfig(prev => ({ ...prev, config: { ...prev.config, pet_amount: Number(e.currentTarget.value) } }))} /></label>
                            <label>Bimbo word length<input style={inputStyle} type="number" min={1} value={editableConfig.config.bimbo_word_length} onChange={e => setEditableConfig(prev => ({ ...prev, config: { ...prev.config, bimbo_word_length: Number(e.currentTarget.value) } }))} /></label>
                            <label>Drone health (0-100)<input style={inputStyle} type="number" min={0} max={100} value={editableConfig.drone_config.drone_health} onChange={e => setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, drone_health: Number(e.currentTarget.value) } }))} /></label>
                        </div>
                    </div>

                    <div style={sectionStyle}>
                        <strong>Enum values</strong>
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                            <label>
                                Pet type
                                <select
                                    style={inputStyle}
                                    value={petTypeOptions.some(option => option.value === editableConfig.config.pet_type) ? editableConfig.config.pet_type : petTypeOptions[0].value}
                                    onChange={e => setEditableConfig(prev => ({
                                        ...prev,
                                        config: {
                                            ...prev.config,
                                            pet_type: Number(e.currentTarget.value)
                                        }
                                    }))}
                                >
                                    {petTypeOptions.map(option => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                </select>
                            </label>
                        </div>
                    </div>

                    <div style={sectionStyle}>
                        <strong>Text values</strong>
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                            <label>Censored replacement<input style={inputStyle} value={editableConfig.config.censored_replacement} onChange={e => setEditableConfig(prev => ({ ...prev, config: { ...prev.config, censored_replacement: e.currentTarget.value } }))} /></label>
                            <label>Drone term<input style={inputStyle} value={editableConfig.drone_config.drone_term} onChange={e => setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, drone_term: e.currentTarget.value } }))} /></label>
                            <label>Drone speech header<input style={inputStyle} value={editableConfig.drone_config.speech_header} onChange={e => setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, speech_header: e.currentTarget.value } }))} /></label>
                            <label>Drone speech footer<input style={inputStyle} value={editableConfig.drone_config.speech_footer} onChange={e => setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, speech_footer: e.currentTarget.value } }))} /></label>
                            <label>Drone action header<input style={inputStyle} value={editableConfig.drone_config.action_header} onChange={e => setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, action_header: e.currentTarget.value } }))} /></label>
                            <label>Drone action footer<input style={inputStyle} value={editableConfig.drone_config.action_footer} onChange={e => setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, action_footer: e.currentTarget.value } }))} /></label>
                            <label>Drone whisper header<input style={inputStyle} value={editableConfig.drone_config.whisper_header} onChange={e => setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, whisper_header: e.currentTarget.value } }))} /></label>
                            <label>Drone whisper footer<input style={inputStyle} value={editableConfig.drone_config.whisper_footer} onChange={e => setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, whisper_footer: e.currentTarget.value } }))} /></label>
                            <label>Drone loud header<input style={inputStyle} value={editableConfig.drone_config.loud_header} onChange={e => setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, loud_header: e.currentTarget.value } }))} /></label>
                            <label>Drone loud footer<input style={inputStyle} value={editableConfig.drone_config.loud_footer} onChange={e => setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, loud_footer: e.currentTarget.value } }))} /></label>
                        </div>
                    </div>

                    <div style={sectionStyle}>
                        <strong>Boolean toggles</strong>
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                            <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                <input
                                    type="checkbox"
                                    checked={editableConfig.config.debug}
                                    onChange={e => setEditableConfig(prev => ({ ...prev, config: { ...prev.config, debug: e.currentTarget.checked } }))}
                                />
                                Debug mode
                            </label>
                        </div>
                    </div>

                    <div style={sectionStyle}>
                        <strong>Word lists</strong>
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                            <label>Pet words (one per line)<textarea style={{ ...inputStyle, minHeight: "90px" }} value={petWordsText} onChange={e => setPetWordsText(e.currentTarget.value)} /></label>
                            <label>Censored words (one per line)<textarea style={{ ...inputStyle, minHeight: "90px" }} value={censoredWordsText} onChange={e => setCensoredWordsText(e.currentTarget.value)} /></label>
                        </div>
                    </div>

                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        <button style={buttonStyle} onClick={() => refresh().then(() => setStatus("Reloaded config")).catch(err => setStatus(String(err)))}>Reload</button>
                    </div>
                </>
            )}

            {isOwnProfile && (
                <>
                    <div style={sectionStyle}>
                        <strong>Allowed editors</strong>
                        <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                            <input
                                placeholder="Discord ID"
                                value={newEditorId}
                                onChange={e => setNewEditorId(e.currentTarget.value)}
                                style={inputStyle}
                            />
                            <button
                                style={buttonStyle}
                                onClick={async () => {
                                    try {
                                        await addAllowedEditor(activeUserId, newEditorId);
                                        setNewEditorId("");
                                        await refresh();
                                        setStatus("Added allowed editor");
                                    } catch (err) {
                                        setStatus(String(err));
                                    }
                                }}
                            >
                                Add
                            </button>
                        </div>
                        <ul style={{ marginBottom: 0 }}>
                            {allowedEditors.map(editor => (
                                <li key={editor} style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                                    <span>{editor}</span>
                                    <button
                                        style={{ ...buttonStyle, background: "#da373c", borderColor: "#da373c" }}
                                        onClick={async () => {
                                            try {
                                                await removeAllowedEditor(activeUserId, editor);
                                                await refresh();
                                                setStatus(`Removed ${editor}`);
                                            } catch (err) {
                                                setStatus(String(err));
                                            }
                                        }}
                                    >
                                        Remove
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>

                    <div style={sectionStyle}>
                        <strong>Pending relay access requests</strong>
                        <ul style={{ marginBottom: 0 }}>
                            {pendingRequests.length === 0 && <li>No pending requests</li>}
                            {pendingRequests.map(requesterId => (
                                <li key={requesterId} style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                                    <span>{requesterId}</span>
                                    <div style={{ display: "flex", gap: "8px" }}>
                                        <button
                                            style={buttonStyle}
                                            onClick={async () => {
                                                try {
                                                    await approveAccessRequest(settings.store.relayUrl, activeUserId, requesterId);
                                                    await refresh();
                                                    setStatus(`Approved ${requesterId}`);
                                                } catch (err) {
                                                    setStatus(String(err));
                                                }
                                            }}
                                        >
                                            Approve
                                        </button>
                                        <button
                                            style={{ ...buttonStyle, background: "#da373c", borderColor: "#da373c" }}
                                            onClick={async () => {
                                                try {
                                                    await denyAccessRequest(settings.store.relayUrl, activeUserId, requesterId);
                                                    await refresh();
                                                    setStatus(`Denied ${requesterId}`);
                                                } catch (err) {
                                                    setStatus(String(err));
                                                }
                                            }}
                                        >
                                            Deny
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                </>
            )}

            <p style={{ margin: 0, color: "#b5bac1" }}>{status}</p>
        </div>
    );
}

const settings = definePluginSettings({
    relayUrl: {
        type: OptionType.STRING,
        description: "Public relay URL",
        default: "https://82.165.196.147:45491"
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
