import { definePluginSettings } from "@api/Settings";
import { findGroupChildrenByChildId } from "@api/ContextMenu";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Menu, React, UserStore } from "@webpack/common";

const LOOPBACK = "http://127.0.0.1:35491";
const DISCORD_SECURE_ORIGINS = new Set(["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com"]);
const LOG_PREFIX = "[key-intercept]";

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
    timeout_end: string;
    enabled: boolean;
    order: number;
    disabled_at?: string;
};

type WhitelistItem = {
    server_name: string;
    discord_id: string;
};

type ScopeFilterMode = "whitelist" | "blacklist";

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
    blacklist: WhitelistItem[];
    filter_mode: ScopeFilterMode;
    pet_words: string[];
    censored_words: string[];
    drone_config: DroneConfig;
};

const farFuture = "9999-12-31T23:59:59.000Z";
const epoch = "1970-01-01T00:00:00.000Z";

type ModeTimeoutFieldKey =
    | "gag_end"
    | "pet_end"
    | "bimbo_end"
    | "horny_end"
    | "drone_end"
    | "uwu_end"
    | "censored_end";

const modeTimeoutFields: Array<{ key: ModeTimeoutFieldKey; label: string; }> = [
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
    { value: 1, label: "puppy" },
    { value: 2, label: "kitty" },
    { value: 3, label: "cow" },
    { value: 4, label: "fox" },
    { value: 5, label: "birb" },
    { value: 6, label: "bee" },
    { value: 7, label: "bun" }
] as const;

const petWordsByType: Record<number, string[]> = {
    1: ["woof", "ruff", "wruff", "arf"],
    2: ["meow", "mrow", "nya", "mreow", "mew"],
    3: ["moo", "mmmooo"],
    4: ["yip", "eeeekkkk", "waaaaaaaahh", "eeeee", "grrrrr", "grr-uff", "eeeek"],
    5: ["tweet", "squark", "chirp", "caw"],
    6: ["bzzzz", "buzz"],
    7: ["squeak", "pyon"]
};

const defaultLocalConfig: LocalConfig = {
    config: {
        rules_end: farFuture,
        gag_end: epoch,
        pet_end: epoch,
        pet_amount: 0,
        pet_type: 1,
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
    blacklist: [],
    filter_mode: "whitelist",
    pet_words: [...petWordsByType[1]],
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
    const nestedConfig = asRecord.config;
    const source = (
        nestedConfig
        && typeof nestedConfig === "object"
        && (
            Array.isArray((nestedConfig as Record<string, unknown>).rules)
            || Array.isArray((nestedConfig as Record<string, unknown>).rules_groups)
            || Array.isArray((nestedConfig as Record<string, unknown>).whitelist)
            || Array.isArray((nestedConfig as Record<string, unknown>).blacklist)
            || typeof (nestedConfig as Record<string, unknown>).filter_mode === "string"
            || "drone_config" in (nestedConfig as Record<string, unknown>)
            || "pet_words" in (nestedConfig as Record<string, unknown>)
            || "censored_words" in (nestedConfig as Record<string, unknown>)
        )
    ) ? nestedConfig as Record<string, unknown> : asRecord;

    const mergeScopeFilterItems = (value: unknown): WhitelistItem[] => Array.isArray(value)
        ? (value as Array<Record<string, unknown>>).map(item => {
            const server_name = typeof item.server_name === "string" ? item.server_name : "";
            const discord_id = typeof item.discord_id === "string" && /^\d*$/.test(item.discord_id)
                ? item.discord_id
                : "";
            return { server_name, discord_id };
        })
        : [];

    const mergedRules = Array.isArray(source.rules)
        ? (source.rules as Array<Record<string, unknown>>).map((rule, index) => ({
            rule_regex: typeof rule.rule_regex === "string" ? rule.rule_regex : "",
            rule_replacement: typeof rule.rule_replacement === "string" ? rule.rule_replacement : "",
            regex_normalize: Boolean(rule.regex_normalize),
            enabled: rule.enabled === undefined ? true : Boolean(rule.enabled),
            chance_to_apply: parseNumericInput(String(rule.chance_to_apply ?? "1"), 1, { min: 0, max: 1 }),
            order: parseNumericInput(String(rule.order ?? index), index, { min: 0 }),
            group_id: parseNumericInput(String(rule.group_id ?? 1), 1, { min: 1 })
        }))
        : [];
    const mergedGroups = Array.isArray(source.rules_groups)
        ? (source.rules_groups as Array<Record<string, unknown>>).map((group, index) => {
            const fallbackTimeout = typeof group.disabled_at === "string" ? group.disabled_at : farFuture;
            return {
                id: parseNumericInput(String(group.id ?? index + 1), index + 1, { min: 1 }),
                timeout_end: typeof group.timeout_end === "string" ? group.timeout_end : fallbackTimeout,
                enabled: group.enabled === undefined
                    ? (typeof group.disabled_at === "string" ? Date.parse(group.disabled_at) > Date.now() : true)
                    : Boolean(group.enabled),
                order: parseNumericInput(String(group.order ?? index), index, { min: 0 }),
                disabled_at: typeof group.disabled_at === "string" ? group.disabled_at : undefined
            };
        })
        : [];
    const mergedWhitelist = mergeScopeFilterItems(source.whitelist);
    const mergedBlacklist = mergeScopeFilterItems(source.blacklist);
    const mergedFilterMode: ScopeFilterMode = source.filter_mode === "blacklist" ? "blacklist" : "whitelist";

    return {
        config: {
            ...defaultLocalConfig.config,
            ...((source.config as Record<string, unknown>) ?? {})
        } as Config,
        rules: mergedRules,
        rules_groups: mergedGroups,
        whitelist: mergedWhitelist,
        blacklist: mergedBlacklist,
        filter_mode: mergedFilterMode,
        pet_words: Array.isArray(source.pet_words) ? (source.pet_words as string[]) : [],
        censored_words: Array.isArray(source.censored_words) ? (source.censored_words as string[]) : [],
        drone_config: {
            ...defaultLocalConfig.drone_config,
            ...((source.drone_config as Record<string, unknown>) ?? {})
        } as DroneConfig
    };
}

function getPetWordsForType(petType: number, fallback: string[] = []): string[] {
    return petWordsByType[petType] ?? fallback;
}

function configLogSummary(config: LocalConfig) {
    return {
        rules: config.rules.length,
        groups: config.rules_groups.length,
        whitelist: config.whitelist.length,
        blacklist: config.blacklist.length,
        filterMode: config.filter_mode,
        petAmount: config.config.pet_amount,
        petType: config.config.pet_type,
        timeouts: {
            gag_end: config.config.gag_end,
            pet_end: config.config.pet_end,
            bimbo_end: config.config.bimbo_end,
            horny_end: config.config.horny_end,
            drone_end: config.config.drone_end,
            uwu_end: config.config.uwu_end,
            censored_end: config.config.censored_end
        },
        drone: {
            drone_health: config.drone_config.drone_health,
            drone_term: config.drone_config.drone_term
        }
    };
}

async function readLocalConfig(): Promise<LocalConfig> {
    const userId = currentUser().id;
    console.info(`${LOG_PREFIX} readLocalConfig:start`, { userId });
    const response = await fetch(`${LOOPBACK}/config`, {
        cache: "no-store",
        headers: {
            "x-discord-user-id": userId
        }
    });
    if (!response.ok) {
        console.error(`${LOG_PREFIX} readLocalConfig:failed`, { userId, status: response.status });
        throw new Error(`Failed reading local config: ${response.status}`);
    }
    const payload = mergeLocalConfig(await response.json());
    interceptConfig = payload;
    console.info(`${LOG_PREFIX} readLocalConfig:success`, { userId, summary: configLogSummary(payload) });
    return payload;
}

async function saveLocalConfig(userId: string, config: LocalConfig) {
    console.info(`${LOG_PREFIX} saveLocalConfig:start`, { userId, summary: configLogSummary(config) });
    const response = await fetch(`${LOOPBACK}/config`, {
        method: "PUT",
        headers: {
            "content-type": "application/json",
            "x-discord-user-id": userId
        },
        body: JSON.stringify({ config })
    });

    if (!response.ok) {
        console.error(`${LOG_PREFIX} saveLocalConfig:failed`, { userId, status: response.status });
        throw new Error(`Failed saving local config: ${response.status}`);
    }
    interceptConfig = mergeLocalConfig(config);
    console.info(`${LOG_PREFIX} saveLocalConfig:success`, { userId, summary: configLogSummary(interceptConfig) });
}

async function getAllowedEditors() {
    const response = await fetch(`${LOOPBACK}/allowed-editors`, {
        cache: "no-store"
    });
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
    console.info(`${LOG_PREFIX} readRemoteConfig:start`, { requesterId, targetUserId });
    const response = await fetch(
        `${relayBaseUrl(relayUrl)}/users/${targetUserId}/config?requester_id=${encodeURIComponent(requesterId)}`,
        { cache: "no-store" }
    );
    if (!response.ok) {
        console.error(`${LOG_PREFIX} readRemoteConfig:failed`, {
            requesterId,
            targetUserId,
            status: response.status
        });
        throw new Error(`Relay config read failed: ${response.status}`);
    }
    const payload = mergeLocalConfig(await response.json());
    console.info(`${LOG_PREFIX} readRemoteConfig:success`, {
        requesterId,
        targetUserId,
        summary: configLogSummary(payload)
    });
    return payload;
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
        `${relayBaseUrl(relayUrl)}/users/${ownerId}/access-requests?requester_id=${encodeURIComponent(ownerId)}`,
        { cache: "no-store" }
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

function parseNumericInput(
    rawValue: string,
    previousValue: number,
    options?: { min?: number; max?: number; }
): number {
    if (rawValue.trim() === "") return previousValue;
    const nextValue = Number(rawValue);
    if (!Number.isFinite(nextValue)) return previousValue;

    let output = nextValue;
    if (options?.min !== undefined) output = Math.max(options.min, output);
    if (options?.max !== undefined) output = Math.min(options.max, output);
    return output;
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

function getProfilePanelOpenInfo(props: any): { isOpen: boolean; hasExplicitState: boolean } {
    const openStateCandidates = [
        props?.isOpen,
        props?.open,
        props?.isActive,
        props?.active,
        props?.isVisible,
        props?.visible
    ];
    const explicitState = openStateCandidates.find((value): value is boolean => typeof value === "boolean");
    return {
        isOpen: explicitState ?? true,
        hasExplicitState: explicitState !== undefined
    };
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
    if (!config) return false;
    if (!interceptConfig.rules.length || !interceptConfig.rules_groups.length) return false;
    return interceptConfig.rules_groups.some(group => group.enabled && shouldApply(group.timeout_end));
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
    const groups = [...interceptConfig.rules_groups]
        .filter(group => group.enabled && shouldApply(group.timeout_end))
        .sort((a, b) => a.order - b.order);

    for (const group of groups) {
        const sortedRules = [...interceptConfig.rules]
            .filter(rule => rule.group_id === group.id && rule.enabled)
            .sort((a, b) => a.order - b.order);

        for (const rule of sortedRules) {
            if (!rule.rule_regex) continue;
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

    const petWords = getPetWordsForType(interceptConfig.config.pet_type, interceptConfig.pet_words);
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

function scopeItemMatches(item: WhitelistItem, targetName: string | null, targetId: string | null): boolean {
    return (!!targetName && item.server_name === targetName) || (!!targetId && item.discord_id === targetId);
}

function normalizeScopeName(name: string | null): string {
    return (name ?? "").trim();
}

function normalizeScopeId(id: string | null): string {
    return id && /^\d+$/.test(id) ? id : "";
}

type ScopeTarget = {
    server_name: string;
    discord_id: string;
    label: string;
};

function removeScopeItem(list: WhitelistItem[], target: ScopeTarget): WhitelistItem[] {
    const targetName = normalizeScopeName(target.server_name);
    const targetId = normalizeScopeId(target.discord_id);
    return list.filter(item => !scopeItemMatches(item, targetName || null, targetId || null));
}

function upsertScopeItem(list: WhitelistItem[], target: ScopeTarget): WhitelistItem[] {
    const withoutTarget = removeScopeItem(list, target);
    return [...withoutTarget, { server_name: target.server_name, discord_id: target.discord_id }];
}

async function updateCurrentScopeList(target: ScopeTarget) {
    const nextConfig = mergeLocalConfig(interceptConfig);
    const activeListKey = nextConfig.filter_mode === "blacklist" ? "blacklist" : "whitelist";
    const currentList = nextConfig[activeListKey];
    const exists = currentList.some(item => scopeItemMatches(item, target.server_name || null, target.discord_id || null));
    nextConfig[activeListKey] = exists
        ? removeScopeItem(currentList, target)
        : upsertScopeItem(currentList, target);
    await saveLocalConfig(currentUser().id, nextConfig);
    return { listName: activeListKey, exists };
}

function buildScopeTargetFromGuild(guild?: { name?: string; id?: string; }): ScopeTarget | null {
    if (!guild) return null;
    const server_name = normalizeScopeName(guild.name ?? null);
    const discord_id = normalizeScopeId(guild.id ?? null);
    if (!server_name && !discord_id) return null;
    return {
        server_name,
        discord_id,
        label: server_name || discord_id
    };
}

function buildScopeTargetFromChannel(channel?: { guild_id?: string; id?: string; name?: string; recipients?: string[]; }): ScopeTarget | null {
    if (!channel || channel.guild_id) return null;
    const activeUser = UserStore.getCurrentUser();
    const recipientNames = (channel.recipients ?? [])
        .filter((id: string) => id !== activeUser.id)
        .map((id: string) => UserStore.getUser(id)?.username)
        .filter(Boolean) as string[];
    const server_name = normalizeScopeName(recipientNames.join(", ") || channel.name || "");
    const discord_id = normalizeScopeId(channel.id ?? null);
    if (!server_name && !discord_id) return null;
    return {
        server_name,
        discord_id,
        label: server_name || discord_id
    };
}

function ConfigPanel(props: any) {
    const activeUserId = currentUser().id;
    const profileUserId = getProfileUserId(props) ?? activeUserId;
    const isOwnProfile = profileUserId === activeUserId;
    const panelOpenInfo = getProfilePanelOpenInfo(props);
    const isPanelOpen = panelOpenInfo.isOpen;
    const hasExplicitPanelOpenState = panelOpenInfo.hasExplicitState;

    const [newEditorId, setNewEditorId] = React.useState("");
    const [allowedEditors, setAllowedEditors] = React.useState<string[]>([]);
    const [pendingRequests, setPendingRequests] = React.useState<string[]>([]);
    const [status, setStatus] = React.useState("");
    const [editableConfig, setEditableConfig] = React.useState<LocalConfig>(() => mergeLocalConfig(interceptConfig));
    const [censoredWordsText, setCensoredWordsText] = React.useState(() => toLines(interceptConfig.censored_words));
    const [timeoutAdjustments, setTimeoutAdjustments] = React.useState<Record<ModeTimeoutFieldKey, string>>(
        () => createTimeoutAdjustmentDefaults()
    );
    const [groupTimeoutAdjustments, setGroupTimeoutAdjustments] = React.useState<Record<number, string>>({});
    const [isRulesEditorOpen, setIsRulesEditorOpen] = React.useState(false);
    const [nowMs, setNowMs] = React.useState(() => Date.now());
    const [canViewRemote, setCanViewRemote] = React.useState(isOwnProfile);
    const skipAutosaveRef = React.useRef(true);
    const lastSavedSnapshotRef = React.useRef("");
    const saveQueueRef = React.useRef(Promise.resolve());
    const refreshInFlightRef = React.useRef(false);
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
    const sectionHeaderStyle: React.CSSProperties = {
        margin: 0,
        fontSize: "16px"
    };

    const updateFromConfig = React.useCallback((config: LocalConfig) => {
        skipAutosaveRef.current = true;
        setEditableConfig(config);
        setCensoredWordsText(toLines(config.censored_words));
        lastSavedSnapshotRef.current = JSON.stringify({
            ...config,
            pet_words: config.pet_words,
            censored_words: config.censored_words
        });
    }, []);

    const refresh = React.useCallback(async () => {
        if (refreshInFlightRef.current) return;
        refreshInFlightRef.current = true;
        console.info(`${LOG_PREFIX} refresh:start`, { activeUserId, profileUserId, isOwnProfile });
        try {
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
                console.info(`${LOG_PREFIX} refresh:success`, {
                    activeUserId,
                    profileUserId,
                    isOwnProfile,
                    summary: configLogSummary(config)
                });
                return;
            }

            const remote = await readRemoteConfig(settings.store.relayUrl, activeUserId, profileUserId);
            updateFromConfig(remote);
            setCanViewRemote(true);
            console.info(`${LOG_PREFIX} refresh:success`, {
                activeUserId,
                profileUserId,
                isOwnProfile,
                summary: configLogSummary(remote)
            });
        } catch (err) {
            setCanViewRemote(false);
            setStatus(String(err));
            console.error(`${LOG_PREFIX} refresh:failed`, { activeUserId, profileUserId, isOwnProfile, error: String(err) });
        } finally {
            refreshInFlightRef.current = false;
        }
    }, [activeUserId, isOwnProfile, profileUserId, updateFromConfig]);

    React.useEffect(() => {
        if (!isPanelOpen) return;
        refresh().catch(err => setStatus(String(err)));
    }, [isPanelOpen, refresh]);

    React.useEffect(() => {
        if (!isPanelOpen || hasExplicitPanelOpenState) return;
        const handle = setInterval(() => {
            const currentSnapshot = JSON.stringify({
                ...editableConfig,
                pet_words: getPetWordsForType(editableConfig.config.pet_type, editableConfig.pet_words),
                censored_words: fromLines(censoredWordsText)
            });
            if (currentSnapshot !== lastSavedSnapshotRef.current) return;
            refresh().catch(err => setStatus(String(err)));
        }, 1500);
        return () => clearInterval(handle);
    }, [censoredWordsText, editableConfig, hasExplicitPanelOpenState, isPanelOpen, refresh]);

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

    const setGroupTimeout = React.useCallback((groupId: number, nextIso: string) => {
        setEditableConfig(prev => ({
            ...prev,
            rules_groups: prev.rules_groups.map(group => (
                group.id === groupId ? { ...group, timeout_end: nextIso } : group
            ))
        }));
    }, []);

    const addGroupTimeoutAmount = React.useCallback((groupId: number, multiplierSeconds: number) => {
        const amount = Number(groupTimeoutAdjustments[groupId] ?? "1");
        if (!Number.isFinite(amount) || amount <= 0) {
            setStatus(`Enter a positive number for group ${groupId}`);
            return;
        }

        setEditableConfig(prev => ({
            ...prev,
            rules_groups: prev.rules_groups.map(group => {
                if (group.id !== groupId) return group;
                const currentEndMs = Date.parse(group.timeout_end);
                const baseline = Number.isFinite(currentEndMs) && currentEndMs > nowMs ? currentEndMs : nowMs;
                return {
                    ...group,
                    timeout_end: new Date(baseline + amount * multiplierSeconds * 1000).toISOString()
                };
            })
        }));
    }, [groupTimeoutAdjustments, nowMs]);

    const setGroupPermanentTimeout = React.useCallback((groupId: number) => {
        setGroupTimeout(groupId, farFuture);
    }, [setGroupTimeout]);

    const addRuleGroup = React.useCallback(() => {
        setEditableConfig(prev => {
            const nextGroupId = prev.rules_groups.reduce((maxId, group) => Math.max(maxId, group.id), 0) + 1;
            const nextOrder = prev.rules_groups.length;
            return {
                ...prev,
                rules_groups: [
                    ...prev.rules_groups,
                    { id: nextGroupId, timeout_end: farFuture, enabled: true, order: nextOrder }
                ]
            };
        });
    }, []);

    const removeRuleGroup = React.useCallback((groupId: number) => {
        setEditableConfig(prev => ({
            ...prev,
            rules_groups: prev.rules_groups.filter(group => group.id !== groupId),
            rules: prev.rules.filter(rule => rule.group_id !== groupId)
        }));
    }, []);

    const updateRuleGroup = React.useCallback((groupId: number, updater: (group: RuleGroup) => RuleGroup) => {
        setEditableConfig(prev => ({
            ...prev,
            rules_groups: prev.rules_groups.map(group => (group.id === groupId ? updater(group) : group))
        }));
    }, []);

    const addRuleToGroup = React.useCallback((groupId: number) => {
        setEditableConfig(prev => {
            const nextOrder = prev.rules
                .filter(rule => rule.group_id === groupId)
                .reduce((maxOrder, rule) => Math.max(maxOrder, rule.order), -1) + 1;
            return {
                ...prev,
                rules: [
                    ...prev.rules,
                    {
                        rule_regex: "",
                        rule_replacement: "",
                        regex_normalize: false,
                        enabled: true,
                        chance_to_apply: 1,
                        order: nextOrder,
                        group_id: groupId
                    }
                ]
            };
        });
    }, []);

    const updateRuleAtIndex = React.useCallback((ruleIndex: number, updater: (rule: Rule) => Rule) => {
        setEditableConfig(prev => ({
            ...prev,
            rules: prev.rules.map((rule, index) => (index === ruleIndex ? updater(rule) : rule))
        }));
    }, []);

    const removeRuleAtIndex = React.useCallback((ruleIndex: number) => {
        setEditableConfig(prev => ({
            ...prev,
            rules: prev.rules.filter((_, index) => index !== ruleIndex)
        }));
    }, []);

    const saveConfig = React.useCallback(async (baseConfig: LocalConfig, options?: { quiet?: boolean }) => {
        const mergedConfig = mergeLocalConfig({
            ...baseConfig,
            pet_words: getPetWordsForType(baseConfig.config.pet_type, baseConfig.pet_words),
            censored_words: fromLines(censoredWordsText)
        });
        console.info(`${LOG_PREFIX} saveConfig:start`, {
            activeUserId,
            profileUserId,
            isOwnProfile,
            quiet: Boolean(options?.quiet),
            summary: configLogSummary(mergedConfig)
        });
        if (isOwnProfile) {
            await saveLocalConfig(activeUserId, mergedConfig);
            if (!options?.quiet) setStatus("Auto-saved local config");
        } else {
            await pushRemoteConfig(settings.store.relayUrl, activeUserId, profileUserId, mergedConfig);
            if (!options?.quiet) setStatus(`Auto-saved ${profileUserId}'s config via relay`);
        }
        lastSavedSnapshotRef.current = JSON.stringify(mergedConfig);
        console.info(`${LOG_PREFIX} saveConfig:success`, {
            activeUserId,
            profileUserId,
            isOwnProfile,
            summary: configLogSummary(mergedConfig)
        });
    }, [activeUserId, censoredWordsText, isOwnProfile, profileUserId]);

    React.useEffect(() => {
        if (!(isOwnProfile || canViewRemote)) return;
        if (skipAutosaveRef.current) {
            skipAutosaveRef.current = false;
            return;
        }

        const nextConfig = mergeLocalConfig({
            ...editableConfig,
            pet_words: getPetWordsForType(editableConfig.config.pet_type, editableConfig.pet_words),
            censored_words: fromLines(censoredWordsText)
        });
        const nextSnapshot = JSON.stringify(nextConfig);
        if (nextSnapshot === lastSavedSnapshotRef.current) return;

        console.info(`${LOG_PREFIX} autosave:enqueue`, {
            activeUserId,
            profileUserId,
            isOwnProfile,
            summary: configLogSummary(nextConfig)
        });
        saveQueueRef.current = saveQueueRef.current
            .catch(() => {})
            .then(() => saveConfig(nextConfig))
            .catch(err => setStatus(`Auto-save failed: ${String(err)}`));
    }, [canViewRemote, censoredWordsText, editableConfig, isOwnProfile, saveConfig]);

    const renderTimeoutControls = (field: ModeTimeoutFieldKey, label: string) => (
        <div style={{ display: "grid", gap: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                <strong>{label}</strong>
                <span style={{ color: "#b5bac1" }}>{formatTimeoutStatus(editableConfig.config[field], nowMs)}</span>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <input
                    style={{ ...inputStyle, width: "110px" }}
                    type="number"
                    min={1}
                    value={timeoutAdjustments[field]}
                    onChange={e => {
                        const nextValue = e.currentTarget.value;
                        setTimeoutAdjustments(prev => ({
                            ...prev,
                            [field]: nextValue
                        }));
                    }}
                />
                <button style={buttonStyle} onClick={() => addTimeoutAmount(field, 1)}>Add Seconds</button>
                <button style={buttonStyle} onClick={() => addTimeoutAmount(field, 60)}>Add Minutes</button>
                <button style={buttonStyle} onClick={() => addTimeoutAmount(field, 3600)}>Add Hours</button>
                <button style={buttonStyle} onClick={() => setPermanentTimeout(field)}>Permanent</button>
            </div>
        </div>
    );

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
                        <h4 style={sectionHeaderStyle}>Gag</h4>
                        <div style={{ marginTop: "8px" }}>{renderTimeoutControls("gag_end", "Gag timeout")}</div>
                    </div>

                    <div style={sectionStyle}>
                        <h4 style={sectionHeaderStyle}>Pet</h4>
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                            {renderTimeoutControls("pet_end", "Pet timeout")}
                            <label>
                                Pet type
                                <select
                                    style={inputStyle}
                                    value={petTypeOptions.some(option => option.value === editableConfig.config.pet_type) ? editableConfig.config.pet_type : petTypeOptions[0].value}
                                    onChange={e => {
                                        const nextValue = Number(e.currentTarget.value);
                                        setEditableConfig(prev => ({
                                            ...prev,
                                            config: {
                                                ...prev.config,
                                                pet_type: nextValue
                                            }
                                        }));
                                    }}
                                >
                                    {petTypeOptions.map(option => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                Pet amount ({Math.round(editableConfig.config.pet_amount * 100)}%)
                                <input
                                    style={inputStyle}
                                    type="range"
                                    min={0}
                                    max={100}
                                    step={1}
                                    value={Math.round(editableConfig.config.pet_amount * 100)}
                                    onChange={e => {
                                        const nextValue = parseNumericInput(e.currentTarget.value, 100, { min: 0, max: 100 });
                                        setEditableConfig(prev => ({
                                            ...prev,
                                            config: {
                                                ...prev.config,
                                                pet_amount: nextValue / 100
                                            }
                                        }));
                                    }}
                                />
                            </label>
                        </div>
                    </div>

                    <div style={sectionStyle}>
                        <h4 style={sectionHeaderStyle}>Bimbo</h4>
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                            {renderTimeoutControls("bimbo_end", "Bimbo timeout")}
                            <label>Bimbo word length<input style={inputStyle} type="number" min={1} value={editableConfig.config.bimbo_word_length} onChange={e => {
                                const nextValue = e.currentTarget.value;
                                setEditableConfig(prev => ({ ...prev, config: { ...prev.config, bimbo_word_length: parseNumericInput(nextValue, prev.config.bimbo_word_length, { min: 1 }) } }));
                            }} /></label>
                        </div>
                    </div>

                    <div style={sectionStyle}>
                        <h4 style={sectionHeaderStyle}>Horny</h4>
                        <div style={{ marginTop: "8px" }}>{renderTimeoutControls("horny_end", "Horny timeout")}</div>
                    </div>

                    <div style={sectionStyle}>
                        <h4 style={sectionHeaderStyle}>Drone</h4>
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                            {renderTimeoutControls("drone_end", "Drone timeout")}
                            <label>Drone term<input style={inputStyle} value={editableConfig.drone_config.drone_term} onChange={e => {
                                const nextValue = e.currentTarget.value;
                                setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, drone_term: nextValue } }));
                            }} /></label>
                            <label>Drone speech header<input style={inputStyle} value={editableConfig.drone_config.speech_header} onChange={e => {
                                const nextValue = e.currentTarget.value;
                                setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, speech_header: nextValue } }));
                            }} /></label>
                            <label>Drone speech footer<input style={inputStyle} value={editableConfig.drone_config.speech_footer} onChange={e => {
                                const nextValue = e.currentTarget.value;
                                setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, speech_footer: nextValue } }));
                            }} /></label>
                            <label>Drone action header<input style={inputStyle} value={editableConfig.drone_config.action_header} onChange={e => {
                                const nextValue = e.currentTarget.value;
                                setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, action_header: nextValue } }));
                            }} /></label>
                            <label>Drone action footer<input style={inputStyle} value={editableConfig.drone_config.action_footer} onChange={e => {
                                const nextValue = e.currentTarget.value;
                                setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, action_footer: nextValue } }));
                            }} /></label>
                            <label>Drone whisper header<input style={inputStyle} value={editableConfig.drone_config.whisper_header} onChange={e => {
                                const nextValue = e.currentTarget.value;
                                setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, whisper_header: nextValue } }));
                            }} /></label>
                            <label>Drone whisper footer<input style={inputStyle} value={editableConfig.drone_config.whisper_footer} onChange={e => {
                                const nextValue = e.currentTarget.value;
                                setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, whisper_footer: nextValue } }));
                            }} /></label>
                            <label>Drone loud header<input style={inputStyle} value={editableConfig.drone_config.loud_header} onChange={e => {
                                const nextValue = e.currentTarget.value;
                                setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, loud_header: nextValue } }));
                            }} /></label>
                            <label>Drone loud footer<input style={inputStyle} value={editableConfig.drone_config.loud_footer} onChange={e => {
                                const nextValue = e.currentTarget.value;
                                setEditableConfig(prev => ({ ...prev, drone_config: { ...prev.drone_config, loud_footer: nextValue } }));
                            }} /></label>
                        </div>
                    </div>

                    <div style={sectionStyle}>
                        <h4 style={sectionHeaderStyle}>UWU</h4>
                        <div style={{ marginTop: "8px" }}>{renderTimeoutControls("uwu_end", "UWU timeout")}</div>
                    </div>

                    <div style={sectionStyle}>
                        <h4 style={sectionHeaderStyle}>Censored</h4>
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                            {renderTimeoutControls("censored_end", "Censored timeout")}
                            <label>Censored replacement<input style={inputStyle} value={editableConfig.config.censored_replacement} onChange={e => {
                                const nextValue = e.currentTarget.value;
                                setEditableConfig(prev => ({ ...prev, config: { ...prev.config, censored_replacement: nextValue } }));
                            }} /></label>
                            <label>Censored words (one per line)<textarea style={{ ...inputStyle, minHeight: "90px" }} value={censoredWordsText} onChange={e => setCensoredWordsText(e.currentTarget.value)} /></label>
                        </div>
                    </div>

                    <div style={sectionStyle}>
                        <h4 style={sectionHeaderStyle}>Scope Filter</h4>
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                            <label>
                                Filter mode
                                <select
                                    style={inputStyle}
                                    value={editableConfig.filter_mode}
                                    onChange={e => {
                                        const nextMode: ScopeFilterMode = e.currentTarget.value === "blacklist" ? "blacklist" : "whitelist";
                                        setEditableConfig(prev => ({ ...prev, filter_mode: nextMode }));
                                    }}
                                >
                                    <option value="whitelist">Whitelist mode (only listed servers/DMs are transformed)</option>
                                    <option value="blacklist">Blacklist mode (listed servers/DMs are skipped)</option>
                                </select>
                            </label>
                            <p style={{ margin: 0, color: "#b5bac1" }}>
                                Use the server or DM right-click menu to add/remove entries for the current mode.
                            </p>
                            <ul style={{ marginBottom: 0 }}>
                                {(editableConfig[editableConfig.filter_mode] ?? []).map((item, index) => (
                                    <li key={`${item.discord_id}-${item.server_name}-${index}`} style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                                        <span>{item.server_name || item.discord_id}</span>
                                        <button
                                            style={{ ...buttonStyle, background: "#da373c", borderColor: "#da373c" }}
                                            onClick={() => {
                                                setEditableConfig(prev => {
                                                    const listKey = prev.filter_mode === "blacklist" ? "blacklist" : "whitelist";
                                                    const nextList = prev[listKey].filter((_, itemIndex) => itemIndex !== index);
                                                    return { ...prev, [listKey]: nextList };
                                                });
                                            }}
                                        >
                                            Remove
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>

                    <div style={sectionStyle}>
                        <h4 style={sectionHeaderStyle}>Custom Rules</h4>
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                            <p style={{ margin: 0, color: "#b5bac1" }}>{editableConfig.rules_groups.length} group(s), {editableConfig.rules.length} rule(s)</p>
                            <button style={buttonStyle} onClick={() => setIsRulesEditorOpen(true)}>Open rules editor popup</button>
                            <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                <input
                                    type="checkbox"
                                    checked={editableConfig.config.debug}
                                    onChange={e => {
                                        const nextValue = e.currentTarget.checked;
                                        setEditableConfig(prev => ({ ...prev, config: { ...prev.config, debug: nextValue } }));
                                    }}
                                />
                                Debug mode
                            </label>
                        </div>
                    </div>

                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        <button style={buttonStyle} onClick={() => refresh().then(() => setStatus("Reloaded config")).catch(err => setStatus(String(err)))}>Reload</button>
                    </div>
                </>
            )}

            {(isOwnProfile || canViewRemote) && isRulesEditorOpen && (
                <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999, display: "grid", placeItems: "center", padding: "20px" }}>
                    <div style={{ width: "min(980px, 95vw)", maxHeight: "90vh", overflow: "auto", ...sectionStyle, background: "#1e1f22", display: "grid", gap: "10px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                            <h4 style={sectionHeaderStyle}>Custom Rules Editor</h4>
                            <button style={buttonStyle} onClick={() => setIsRulesEditorOpen(false)}>Close</button>
                        </div>

                        <button style={buttonStyle} onClick={addRuleGroup}>Add rule group</button>

                        {editableConfig.rules_groups.length === 0 && (
                            <p style={{ margin: 0, color: "#b5bac1" }}>No rule groups yet. Add one to start.</p>
                        )}

                        {[...editableConfig.rules_groups].sort((a, b) => a.order - b.order).map(group => {
                            const groupRules = editableConfig.rules
                                .map((rule, index) => ({ rule, index }))
                                .filter(item => item.rule.group_id === group.id)
                                .sort((a, b) => a.rule.order - b.rule.order);

                            return (
                                <div key={group.id} style={{ border: "1px solid #3f4147", borderRadius: "10px", padding: "10px", display: "grid", gap: "8px" }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                        <strong>Group #{group.id}</strong>
                                        <button style={{ ...buttonStyle, background: "#da373c", borderColor: "#da373c" }} onClick={() => removeRuleGroup(group.id)}>Remove Group</button>
                                    </div>
                                    <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                        <input
                                            type="checkbox"
                                            checked={group.enabled}
                                            onChange={e => updateRuleGroup(group.id, current => ({ ...current, enabled: e.currentTarget.checked }))}
                                        />
                                        Enabled
                                    </label>
                                    <label>Group order<input style={inputStyle} type="number" min={0} value={group.order} onChange={e => {
                                        const nextValue = parseNumericInput(e.currentTarget.value, group.order, { min: 0 });
                                        updateRuleGroup(group.id, current => ({ ...current, order: nextValue }));
                                    }} /></label>
                                    <div style={{ display: "grid", gap: "8px" }}>
                                        <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                                            <strong>Group timeout</strong>
                                            <span style={{ color: "#b5bac1" }}>{formatTimeoutStatus(group.timeout_end, nowMs)}</span>
                                        </div>
                                        <input style={inputStyle} value={group.timeout_end} onChange={e => setGroupTimeout(group.id, e.currentTarget.value)} />
                                        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                            <input
                                                style={{ ...inputStyle, width: "110px" }}
                                                type="number"
                                                min={1}
                                                value={groupTimeoutAdjustments[group.id] ?? "1"}
                                                onChange={e => setGroupTimeoutAdjustments(prev => ({ ...prev, [group.id]: e.currentTarget.value }))}
                                            />
                                            <button style={buttonStyle} onClick={() => addGroupTimeoutAmount(group.id, 1)}>Add Seconds</button>
                                            <button style={buttonStyle} onClick={() => addGroupTimeoutAmount(group.id, 60)}>Add Minutes</button>
                                            <button style={buttonStyle} onClick={() => addGroupTimeoutAmount(group.id, 3600)}>Add Hours</button>
                                            <button style={buttonStyle} onClick={() => setGroupPermanentTimeout(group.id)}>Permanent</button>
                                        </div>
                                    </div>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                        <strong>Rules</strong>
                                        <button style={buttonStyle} onClick={() => addRuleToGroup(group.id)}>Add Rule</button>
                                    </div>
                                    {groupRules.length === 0 && (
                                        <p style={{ margin: 0, color: "#b5bac1" }}>No rules in this group.</p>
                                    )}
                                    {groupRules.map(({ rule, index }) => (
                                        <div key={`${group.id}-${index}`} style={{ border: "1px solid #3f4147", borderRadius: "8px", padding: "8px", display: "grid", gap: "8px" }}>
                                            <label>Regex rule<input style={inputStyle} value={rule.rule_regex} onChange={e => updateRuleAtIndex(index, current => ({ ...current, rule_regex: e.currentTarget.value }))} /></label>
                                            <label>Replacement<input style={inputStyle} value={rule.rule_replacement} onChange={e => updateRuleAtIndex(index, current => ({ ...current, rule_replacement: e.currentTarget.value }))} /></label>
                                            <label>Trigger chance ({Math.round(rule.chance_to_apply * 100)}%)<input style={inputStyle} type="range" min={0} max={100} step={1} value={Math.round(rule.chance_to_apply * 100)} onChange={e => {
                                                const nextValue = parseNumericInput(e.currentTarget.value, 100, { min: 0, max: 100 });
                                                updateRuleAtIndex(index, current => ({ ...current, chance_to_apply: nextValue / 100 }));
                                            }} /></label>
                                            <label>Rule order<input style={inputStyle} type="number" min={0} value={rule.order} onChange={e => {
                                                const nextValue = parseNumericInput(e.currentTarget.value, rule.order, { min: 0 });
                                                updateRuleAtIndex(index, current => ({ ...current, order: nextValue }));
                                            }} /></label>
                                            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                                                <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                    <input type="checkbox" checked={rule.enabled} onChange={e => updateRuleAtIndex(index, current => ({ ...current, enabled: e.currentTarget.checked }))} />
                                                    Enabled
                                                </label>
                                                <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                    <input type="checkbox" checked={rule.regex_normalize} onChange={e => updateRuleAtIndex(index, current => ({ ...current, regex_normalize: e.currentTarget.checked }))} />
                                                    Normalize regex
                                                </label>
                                            </div>
                                            <button style={{ ...buttonStyle, background: "#da373c", borderColor: "#da373c" }} onClick={() => removeRuleAtIndex(index)}>Remove Rule</button>
                                        </div>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {isOwnProfile && (
                <>
                    <div style={sectionStyle}>
                        <h4 style={sectionHeaderStyle}>Allowed Editors</h4>
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
                        <h4 style={sectionHeaderStyle}>Pending Requests</h4>
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

        const scopeTarget = channel.guild_id
            ? buildScopeTargetFromGuild(GuildStore?.getGuild(channel.guild_id))
            : buildScopeTargetFromChannel(channel);
        const scopeName = scopeTarget?.server_name ?? null;
        const scopeId = scopeTarget?.discord_id ?? null;
        const scopeKnown = Boolean(scopeName || scopeId);

        if (interceptConfig.filter_mode === "blacklist") {
            if (interceptConfig.blacklist.some(item => scopeItemMatches(item, scopeName, scopeId))) return;
        } else if (interceptConfig.whitelist.length > 0) {
            const whitelistMatch = interceptConfig.whitelist.some(item => scopeItemMatches(item, scopeName, scopeId));
            if (scopeKnown && !whitelistMatch) return;
        }

        const channelName = channel?.name?.toLowerCase?.() ?? "";
        if (channelName.includes("sfw") && !channelName.includes("nsfw")) return;

        msg.content = applyReplacements(msg.content, channelId);
    },
    contextMenus: {
        "guild-context": (children, props) => {
            const target = buildScopeTargetFromGuild(props?.guild);
            if (!target) return;
            const listKey = interceptConfig.filter_mode === "blacklist" ? "blacklist" : "whitelist";
            const itemExists = interceptConfig[listKey].some(item => scopeItemMatches(item, target.server_name || null, target.discord_id || null));
            const anchor = findGroupChildrenByChildId("privacy", children);
            const menuItem = (
                <Menu.MenuItem
                    id="key-intercept-scope-filter-guild"
                    label={`${itemExists ? "Remove from" : "Add to"} ${listKey}: ${target.label}`}
                    action={() => {
                        updateCurrentScopeList(target).catch(err => {
                            console.error(`${LOG_PREFIX} failed to update scope list`, err);
                        });
                    }}
                />
            );
            if (anchor) {
                anchor.push(menuItem);
            } else {
                children.push(<Menu.MenuGroup>{menuItem}</Menu.MenuGroup>);
            }
        },
        "channel-context": (children, props) => {
            const target = buildScopeTargetFromChannel(props?.channel);
            if (!target) return;
            const listKey = interceptConfig.filter_mode === "blacklist" ? "blacklist" : "whitelist";
            const itemExists = interceptConfig[listKey].some(item => scopeItemMatches(item, target.server_name || null, target.discord_id || null));
            const anchor = findGroupChildrenByChildId(["mute-channel", "unmute-channel", "close-dm", "mark-read"], children);
            const menuItem = (
                <Menu.MenuItem
                    id="key-intercept-scope-filter-dm"
                    label={`${itemExists ? "Remove from" : "Add to"} ${listKey}: ${target.label}`}
                    action={() => {
                        updateCurrentScopeList(target).catch(err => {
                            console.error(`${LOG_PREFIX} failed to update scope list`, err);
                        });
                    }}
                />
            );
            if (anchor) {
                anchor.push(menuItem);
            } else {
                children.push(<Menu.MenuGroup>{menuItem}</Menu.MenuGroup>);
            }
        }
    },
    userProfileBadge: {
        id: "key-intercept-controls",
        key: "key-intercept-controls",
        description: "key-intercept controls",
        component: ConfigPanel
    }
});

export default plugin;
