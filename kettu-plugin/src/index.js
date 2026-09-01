const LOG_PREFIX = "[key-intercept/kettu]";
const MOBILE_STATE_KEY = "key-intercept/mobile-loopback-state/v1";
const RELAY_URL_STORAGE_KEY = "key-intercept/relay-url";
const DEFAULT_RELAY_URL = "http://82.165.196.147:45491";
const farFuture = "9999-12-31T23:59:59.000Z";
const epoch = "1970-01-01T00:00:00.000Z";
const permanentTimestamp = new Date(farFuture).getTime();

const modeTimeoutFields = [
    { key: "gag_end", label: "Gag timeout" },
    { key: "pet_end", label: "Pet timeout" },
    { key: "bimbo_end", label: "Bimbo timeout" },
    { key: "horny_end", label: "Horny timeout" },
    { key: "drone_end", label: "Drone timeout" },
    { key: "uwu_end", label: "UWU timeout" },
    { key: "censored_end", label: "Censored timeout" }
];

const petTypeOptions = [
    { value: 1, label: "puppy" },
    { value: 2, label: "kitty" },
    { value: 3, label: "cow" },
    { value: 4, label: "fox" },
    { value: 5, label: "birb" },
    { value: 6, label: "bee" },
    { value: 7, label: "bun" }
];

const petWordsByType = {
    1: ["woof", "ruff", "wruff", "arf"],
    2: ["meow", "mrow", "nya", "mreow", "mew"],
    3: ["moo", "mmmooo"],
    4: ["yip", "eeeekkkk", "waaaaaaaahh", "eeeee", "grrrrr", "grr-uff", "eeeek"],
    5: ["tweet", "squark", "chirp", "caw"],
    6: ["bzzzz", "buzz"],
    7: ["squeak", "pyon"]
};

const defaultLocalConfig = {
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

let interceptConfig = cloneDefaultConfig();
let unpatchSendMessage = null;
let findByProps = null;
let ReactRef = null;
let ReactNativeRef = null;

function cloneDefaultConfig() {
    return JSON.parse(JSON.stringify(defaultLocalConfig));
}

function parseNumericInput(raw, fallback, options = {}) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    let output = value;
    if (options.min !== undefined) output = Math.max(options.min, output);
    if (options.max !== undefined) output = Math.min(options.max, output);
    return output;
}

function toLines(values) {
    return values.join("\n");
}

function fromLines(value) {
    return String(value || "")
        .split("\n")
        .map(v => v.trim())
        .filter(Boolean);
}

function buildConfigSnapshot(config, censoredWordsText) {
    const merged = mergeLocalConfig({
        ...config,
        pet_words: getPetWordsForType(config?.config?.pet_type, config?.pet_words),
        censored_words: fromLines(censoredWordsText)
    });
    return {
        merged,
        snapshot: JSON.stringify(merged)
    };
}

function createTimeoutAdjustmentDefaults() {
    return modeTimeoutFields.reduce((acc, field) => {
        acc[field.key] = "1";
        return acc;
    }, {});
}

function formatCountdown(msRemaining) {
    if (msRemaining <= 0) return "Expired";
    const totalSeconds = Math.floor(msRemaining / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(" ");
}

function formatTimeoutStatus(endIso, nowMs) {
    const endMs = Date.parse(endIso);
    if (!Number.isFinite(endMs)) return "Invalid timestamp";
    if (endMs >= permanentTimestamp - 1000) return "Permanent";
    return formatCountdown(endMs - nowMs);
}

function NormalizedString(str) {
    this.str = str;
    this.nfkdStr = "";
    this.indices = [];
    this.rebuild();
}

NormalizedString.prototype.replace = function (regex, fn) {
    const regexWithIndices = new RegExp(regex, "gi");
    let match;
    while ((match = regexWithIndices.exec(this.nfkdStr)) != null) {
        const postStart = match.index;
        const postEnd = postStart + match[0].length;
        const [preStart, preEnd] = this.convert(postStart, postEnd);
        this.str = this.str.substring(0, preStart) + fn(match[0]) + this.str.substring(preEnd);
        this.rebuild();
    }
    return this.str;
};

NormalizedString.prototype.rebuild = function () {
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
};

NormalizedString.prototype.convert = function (postStart, postEnd) {
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
};

function mergeScopeFilterItems(value) {
    return Array.isArray(value)
        ? value.map(item => {
            const server_name = typeof item.server_name === "string" ? item.server_name.trim() : "";
            const discord_id = typeof item.discord_id === "string" && /^\d*$/.test(item.discord_id)
                ? item.discord_id
                : "";
            return { server_name, discord_id };
        })
        : [];
}

function createSharedScopeList(whitelist, blacklist) {
    const merged = [...mergeScopeFilterItems(whitelist), ...mergeScopeFilterItems(blacklist)];
    const seen = new Set();
    return merged.filter(item => {
        const key = `${item.discord_id}::${item.server_name.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function mergeLocalConfig(raw) {
    if (!raw || typeof raw !== "object") return cloneDefaultConfig();

    const asRecord = raw;
    const nestedConfig = asRecord.config;
    const source = (
        nestedConfig
        && typeof nestedConfig === "object"
        && (
            Array.isArray(nestedConfig.rules)
            || Array.isArray(nestedConfig.rules_groups)
            || Array.isArray(nestedConfig.whitelist)
            || Array.isArray(nestedConfig.blacklist)
            || typeof nestedConfig.filter_mode === "string"
            || "drone_config" in nestedConfig
            || "pet_words" in nestedConfig
            || "censored_words" in nestedConfig
        )
    ) ? nestedConfig : asRecord;

    const mergedRules = Array.isArray(source.rules)
        ? source.rules.map((rule, index) => ({
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
        ? source.rules_groups.map((group, index) => {
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
    const sharedScopeList = createSharedScopeList(source.whitelist, source.blacklist);
    const mergedFilterMode = source.filter_mode === "blacklist" ? "blacklist" : "whitelist";

    return {
        config: {
            ...defaultLocalConfig.config,
            ...((source.config) ?? {})
        },
        rules: mergedRules,
        rules_groups: mergedGroups,
        whitelist: sharedScopeList,
        blacklist: sharedScopeList,
        filter_mode: mergedFilterMode,
        pet_words: Array.isArray(source.pet_words) ? source.pet_words : [],
        censored_words: Array.isArray(source.censored_words) ? source.censored_words : [],
        drone_config: {
            ...defaultLocalConfig.drone_config,
            ...((source.drone_config) ?? {})
        }
    };
}

function getPetWordsForType(petType, fallback = []) {
    return petWordsByType[petType] ?? fallback;
}

function getStorageBackend() {
    try {
        if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    } catch {
        // ignore
    }
    return null;
}

function relayBaseUrl(relayUrl) {
    return String(relayUrl || "").trim().replace(/\/$/, "");
}

function currentRelayUrl() {
    const storage = getStorageBackend();
    const configured = storage?.getItem(RELAY_URL_STORAGE_KEY)?.trim();
    return configured || DEFAULT_RELAY_URL;
}

function readMobileState(ownerId) {
    const storage = getStorageBackend();
    const key = `${MOBILE_STATE_KEY}:${ownerId}`;
    const raw = storage?.getItem(key);
    if (!raw) {
        const fresh = {
            owner_discord_id: ownerId,
            config: cloneDefaultConfig(),
            allowed_editors: [],
            revision: 0,
            last_writer_id: ownerId
        };
        if (storage) storage.setItem(key, JSON.stringify(fresh));
        return fresh;
    }

    try {
        const parsed = JSON.parse(raw);
        return {
            owner_discord_id: typeof parsed.owner_discord_id === "string" ? parsed.owner_discord_id : ownerId,
            config: mergeLocalConfig(parsed.config),
            allowed_editors: Array.isArray(parsed.allowed_editors) ? parsed.allowed_editors.filter(v => typeof v === "string") : [],
            revision: Number.isFinite(parsed.revision) ? Math.max(0, Math.floor(parsed.revision)) : 0,
            last_writer_id: typeof parsed.last_writer_id === "string" ? parsed.last_writer_id : ownerId
        };
    } catch {
        return {
            owner_discord_id: ownerId,
            config: cloneDefaultConfig(),
            allowed_editors: [],
            revision: 0,
            last_writer_id: ownerId
        };
    }
}

function writeMobileState(state) {
    const storage = getStorageBackend();
    const key = `${MOBILE_STATE_KEY}:${state.owner_discord_id}`;
    const normalized = {
        owner_discord_id: state.owner_discord_id,
        config: mergeLocalConfig(state.config),
        allowed_editors: Array.isArray(state.allowed_editors) ? state.allowed_editors : [],
        revision: Math.max(0, Math.floor(state.revision || 0)),
        last_writer_id: state.last_writer_id || state.owner_discord_id
    };
    if (storage) storage.setItem(key, JSON.stringify(normalized));
    return normalized;
}

function uploadMobileSnapshot(relayUrl, ownerId) {
    const state = readMobileState(ownerId);
    return fetch(`${relayBaseUrl(relayUrl)}/users/${ownerId}/mobile/snapshot`, {
        method: "POST",
        headers: {
            "content-type": "application/json"
        },
        body: JSON.stringify({
            owner_id: ownerId,
            revision: state.revision,
            last_writer_id: state.last_writer_id,
            config: state.config,
            allowed_editors: state.allowed_editors
        })
    }).then(response => {
        if (!response.ok && response.status !== 404) {
            throw new Error(`Mobile snapshot sync failed: ${response.status}`);
        }
    });
}

function syncInAppLoopback(relayUrl, ownerId) {
    const local = readMobileState(ownerId);
    return fetch(
        `${relayBaseUrl(relayUrl)}/users/${ownerId}/mobile/sync?requester_id=${encodeURIComponent(ownerId)}&after_revision=${local.revision}`,
        { cache: "no-store" }
    ).then(response => {
        if (response.status === 404) {
            return uploadMobileSnapshot(relayUrl, ownerId);
        }
        if (!response.ok) throw new Error(`Mobile relay sync failed: ${response.status}`);
        return response.json().then(payload => {
            const relayRevision = Number.isFinite(payload.revision) ? payload.revision : local.revision;
            if (relayRevision <= local.revision) return;

            writeMobileState({
                owner_discord_id: ownerId,
                config: mergeLocalConfig(payload.config),
                allowed_editors: Array.isArray(payload.allowed_editors) ? payload.allowed_editors : local.allowed_editors,
                revision: relayRevision,
                last_writer_id: typeof payload.last_writer_id === "string" ? payload.last_writer_id : ownerId
            });
        });
    });
}

function currentUser() {
    const UserStore = findByProps?.("getCurrentUser", "getUser");
    return UserStore?.getCurrentUser?.() ?? { id: "" };
}

function validateDiscordId(value) {
    return typeof value === "string" && /^\d+$/.test(value);
}

function readLocalConfig(ownerId) {
    return mergeLocalConfig(readMobileState(ownerId).config);
}

function saveLocalConfig(ownerId, config, editorId = ownerId) {
    const previous = readMobileState(ownerId);
    const mergedConfig = mergeLocalConfig(config);
    const nextState = writeMobileState({
        owner_discord_id: ownerId,
        config: mergedConfig,
        allowed_editors: previous.allowed_editors,
        revision: previous.revision + 1,
        last_writer_id: editorId
    });
    interceptConfig = mergedConfig;
    return uploadMobileSnapshot(currentRelayUrl(), ownerId).then(() => nextState);
}

function pushRemoteConfig(relayUrl, editorId, targetUserId, config) {
    return fetch(`${relayBaseUrl(relayUrl)}/users/${targetUserId}/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            editor_id: editorId,
            config: mergeLocalConfig(config)
        })
    }).then(response => {
        if (!response.ok) throw new Error(`Relay update failed: ${response.status}`);
    });
}

function readRemoteConfig(relayUrl, requesterId, targetUserId) {
    return fetch(
        `${relayBaseUrl(relayUrl)}/users/${targetUserId}/config?requester_id=${encodeURIComponent(requesterId)}`,
        { cache: "no-store" }
    ).then(response => {
        if (!response.ok) {
            const err = new Error(`Relay config read failed: ${response.status}`);
            err.status = response.status;
            throw err;
        }
        return response.json();
    }).then(payload => mergeLocalConfig(payload?.config ?? payload));
}

function requestRemoteAccess(relayUrl, requesterId, targetUserId) {
    return fetch(`${relayBaseUrl(relayUrl)}/users/${targetUserId}/access-requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requester_id: requesterId })
    }).then(response => {
        if (!response.ok) throw new Error(`Relay access request failed: ${response.status}`);
    });
}

function getAccessRequests(relayUrl, ownerId) {
    return fetch(
        `${relayBaseUrl(relayUrl)}/users/${ownerId}/access-requests?requester_id=${encodeURIComponent(ownerId)}`,
        { cache: "no-store" }
    ).then(response => {
        if (!response.ok) throw new Error(`Failed loading access requests: ${response.status}`);
        return response.json();
    }).then(payload => ({
        requests: Array.isArray(payload?.requests) ? payload.requests.filter(validateDiscordId) : []
    }));
}

function approveAccessRequest(relayUrl, ownerId, requesterId) {
    return fetch(
        `${relayBaseUrl(relayUrl)}/users/${ownerId}/access-requests/${encodeURIComponent(requesterId)}/approve`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ owner_id: ownerId })
        }
    ).then(response => {
        if (!response.ok) throw new Error(`Failed approving access request: ${response.status}`);
    });
}

function denyAccessRequest(relayUrl, ownerId, requesterId) {
    return fetch(
        `${relayBaseUrl(relayUrl)}/users/${ownerId}/access-requests/${encodeURIComponent(requesterId)}?requester_id=${encodeURIComponent(ownerId)}`,
        { method: "DELETE" }
    ).then(response => {
        if (!response.ok) throw new Error(`Failed denying access request: ${response.status}`);
    });
}

function getAllowedEditors(ownerId) {
    const state = readMobileState(ownerId);
    return {
        allowed_editors: Array.isArray(state.allowed_editors) ? state.allowed_editors.filter(validateDiscordId) : []
    };
}

function addAllowedEditor(ownerId, editorId) {
    if (!validateDiscordId(editorId)) throw new Error("Editor ID must be a numeric Discord ID");
    const state = readMobileState(ownerId);
    if (state.allowed_editors.includes(editorId)) return Promise.resolve();
    return writeMobileState({
        ...state,
        allowed_editors: [...state.allowed_editors, editorId],
        revision: state.revision + 1,
        last_writer_id: ownerId
    }) && uploadMobileSnapshot(currentRelayUrl(), ownerId);
}

function removeAllowedEditor(ownerId, editorId) {
    const state = readMobileState(ownerId);
    if (!state.allowed_editors.includes(editorId)) return Promise.resolve();
    return writeMobileState({
        ...state,
        allowed_editors: state.allowed_editors.filter(value => value !== editorId),
        revision: state.revision + 1,
        last_writer_id: ownerId
    }) && uploadMobileSnapshot(currentRelayUrl(), ownerId);
}

function getPreviousMessage(channelId) {
    const MessageStore = findByProps?.("getMessage", "getMessages");
    const messages = MessageStore?.getMessages?.(channelId);
    if (!messages) return null;
    const list = Array.isArray(messages) ? messages : messages._array ?? Object.values(messages);
    return list.at(-1) ?? null;
}

function editPreviousMessage(channelId, messageId, newContent) {
    const MessageActions = findByProps?.("editMessage");
    if (!MessageActions?.editMessage) return;
    MessageActions.editMessage(channelId, messageId, { content: newContent });
}

function isLink(word) {
    return word.startsWith("http");
}

function shouldApply(endIso) {
    return Date.now() <= new Date(endIso).getTime();
}

function shouldApplyRules(config) {
    if (!config) return false;
    if (!interceptConfig.rules.length || !interceptConfig.rules_groups.length) return false;
    return interceptConfig.rules_groups.some(group => group.enabled && shouldApply(group.timeout_end));
}

function applyRules(msg) {
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
            let temp;
            try {
                temp = new RegExp(rule.rule_regex.toString().replaceAll("\\\\", "\\"));
            } catch {
                continue;
            }
            const matchCallback = match => {
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

function applyUWU(msg) {
    if (!shouldApply(interceptConfig.config.uwu_end)) return msg;
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

function applyHorny(msg) {
    if (!shouldApply(interceptConfig.config.horny_end)) return msg;
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

function applyPet(msg) {
    if (!shouldApply(interceptConfig.config.pet_end) || interceptConfig.config.pet_amount === 0) return msg;
    const petWords = getPetWordsForType(interceptConfig.config.pet_type, interceptConfig.pet_words);
    if (!petWords.length) return msg;
    let output = "";
    for (const word of msg.split(" ")) {
        if (isLink(word) || (word.startsWith(":") && word.endsWith(":"))) {
            output += `${word} `;
            continue;
        }
        output += Math.random() < interceptConfig.config.pet_amount
            ? petWords[Math.floor(Math.random() * petWords.length)]
            : word;
        output += " ";
    }
    return output;
}

function applyBimbo(msg) {
    if (!shouldApply(interceptConfig.config.bimbo_end)) return msg;
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

function applyCensored(msg) {
    if (!shouldApply(interceptConfig.config.censored_end)) return msg;
    for (const word of interceptConfig.censored_words) {
        let replacement = "";
        for (let i = 0; i < word.length; i += interceptConfig.config.censored_replacement.length) {
            replacement += interceptConfig.config.censored_replacement;
        }
        msg = msg.replace(new RegExp(word, "gi"), replacement);
    }
    return msg;
}

function applyGag(msg) {
    if (!shouldApply(interceptConfig.config.gag_end)) return msg;
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
                outWord += (char.charCodeAt(0) >= 97 && char.charCodeAt(0) <= 122)
                    ? ["g", "h"][Math.floor(Math.random() * 2)]
                    : ["G", "H"][Math.floor(Math.random() * 2)];
            }
        }
        output += `${outWord} `;
    }
    return output;
}

function applyDrone(msg, channelId) {
    if (!shouldApply(interceptConfig.config.drone_end)) return { message: msg };
    const drone = interceptConfig.drone_config;
    if (drone.drone_health < 10) {
        return { message: `\`${drone.drone_term} haaaaas receieved bzzzzt, ppplease provide repaiirs using beep '/repair', tthank youu. Returned Error: 0x7547372482\`` };
    }

    let containsLink = false;
    for (const word of msg.split(" ")) {
        if (isLink(word)) containsLink = true;
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
        if (!isLink(word) && Math.random() > (drone.drone_health / 100)) {
            output += Math.random() > 0.5 ? "`beep` " : "`bzzzt` ";
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

    const UserStore = findByProps?.("getCurrentUser", "getUser");
    const previousMessage = getPreviousMessage(channelId);
    const previousSenderId = previousMessage?.author?.id ?? null;
    const currentUserId = UserStore?.getCurrentUser?.()?.id ?? null;

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
    return { message: output, editPreviousMessage: editPrevious };
}

function applyReplacements(msg, channelId) {
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

function scopeItemMatches(item, targetName, targetId) {
    return (!!targetName && item.server_name === targetName) || (!!targetId && item.discord_id === targetId);
}

function getSharedScopeList(config) {
    return createSharedScopeList(config.whitelist, config.blacklist);
}

function buildScopeTargetFromChannel(channel, UserStore) {
    if (!channel) return null;
    if (channel.guild_id) return null;
    const activeUser = UserStore?.getCurrentUser?.();
    const recipientNames = (channel.recipients ?? [])
        .filter(id => id !== activeUser?.id)
        .map(id => UserStore?.getUser?.(id)?.username)
        .filter(Boolean);
    const server_name = String(recipientNames.join(", ") || channel.name || "").trim();
    const discord_id = typeof channel.id === "string" && /^\d+$/.test(channel.id) ? channel.id : "";
    if (!server_name && !discord_id) return null;
    return { server_name, discord_id };
}

function buildScopeTargetFromGuild(guild) {
    if (!guild) return null;
    const server_name = String(guild.name ?? "").trim();
    const discord_id = typeof guild.id === "string" && /^\d+$/.test(guild.id) ? guild.id : "";
    if (!server_name && !discord_id) return null;
    return { server_name, discord_id };
}

function shouldApplyToScope(channelId) {
    const ChannelStore = findByProps?.("getChannel", "getDMFromUserId");
    const GuildStore = findByProps?.("getGuild", "getGuilds");
    const UserStore = findByProps?.("getCurrentUser", "getUser");
    const channel = ChannelStore?.getChannel?.(channelId);
    if (!channel) return true;

    const scopeTarget = channel.guild_id
        ? buildScopeTargetFromGuild(GuildStore?.getGuild?.(channel.guild_id))
        : buildScopeTargetFromChannel(channel, UserStore);
    const scopeName = scopeTarget?.server_name ?? null;
    const scopeId = scopeTarget?.discord_id ?? null;
    const scopeKnown = Boolean(scopeName || scopeId);
    const scopeList = getSharedScopeList(interceptConfig);

    if (interceptConfig.filter_mode === "blacklist") {
        if (scopeList.some(item => scopeItemMatches(item, scopeName, scopeId))) return false;
    } else if (scopeList.length > 0) {
        const whitelistMatch = scopeList.some(item => scopeItemMatches(item, scopeName, scopeId));
        if (scopeKnown && !whitelistMatch) return false;
    }

    const channelName = channel?.name?.toLowerCase?.() ?? "";
    if (channelName.includes("sfw") && !channelName.includes("nsfw")) return false;
    return true;
}

function bootstrapConfig() {
    const UserStore = findByProps?.("getCurrentUser", "getUser");
    const currentUser = UserStore?.getCurrentUser?.();
    if (!currentUser?.id) return Promise.resolve();
    return syncInAppLoopback(currentRelayUrl(), currentUser.id).then(() => {
        interceptConfig = mergeLocalConfig(readMobileState(currentUser.id).config);
        console.log(`${LOG_PREFIX} config ready`);
    }).catch(err => {
        console.log(`${LOG_PREFIX} config sync failed`, err);
    });
}

function patchSendMessage() {
    const before = globalThis?.vendetta?.patcher?.before;
    const MessageActions = findByProps?.("sendMessage");
    if (!before || !MessageActions?.sendMessage) {
        throw new Error("Could not find sendMessage patch target");
    }

    unpatchSendMessage = before("sendMessage", MessageActions, args => {
        try {
            const [channelId, messageData] = args;
            if (!channelId || !messageData || typeof messageData.content !== "string") return args;
            if (!shouldApplyToScope(channelId)) return args;
            messageData.content = applyReplacements(messageData.content, channelId);
            return args;
        } catch (err) {
            console.log(`${LOG_PREFIX} interception error`, err);
            return args;
        }
    });
}

function getProfileUserId(props) {
    const candidates = [
        props?.user?.id,
        props?.user?.user?.id,
        props?.profileUserId,
        props?.userId,
        props?.profile?.id,
        props?.profile?.user?.id,
        props?.profile?.userId,
        props?.displayProfile?.userId,
        props?.account?.id
    ];
    return candidates.find(value => typeof value === "string" && value.length > 0) ?? null;
}

function getProfilePanelOpenInfo(props) {
    const openStateCandidates = [
        props?.isOpen,
        props?.open,
        props?.isActive,
        props?.active,
        props?.isVisible,
        props?.visible
    ];
    const explicitState = openStateCandidates.find(value => typeof value === "boolean");
    return {
        isOpen: explicitState ?? true,
        hasExplicitState: explicitState !== undefined
    };
}

function getReactTools() {
    const React = ReactRef ?? globalThis?.vendetta?.metro?.common?.React ?? null;
    const ReactNative = ReactNativeRef ?? globalThis?.vendetta?.metro?.common?.ReactNative ?? null;
    return { React, ReactNative };
}

function ConfigPanel(props) {
    const { React, ReactNative } = getReactTools();
    if (!React || !ReactNative) return null;
    const { ScrollView, View, Text, TextInput, Pressable } = ReactNative;
    if (!ScrollView || !View || !Text || !TextInput || !Pressable) return null;
    const h = React.createElement;
    const activeUserId = currentUser().id;
    const profileUserId = getProfileUserId(props) ?? activeUserId;
    const isOwnProfile = profileUserId === activeUserId;
    const panelOpenInfo = getProfilePanelOpenInfo(props);
    const isPanelOpen = panelOpenInfo.isOpen;
    const hasExplicitPanelOpenState = panelOpenInfo.hasExplicitState;

    const [relayUrl, setRelayUrl] = React.useState(currentRelayUrl());
    const [status, setStatus] = React.useState("");
    const [newEditorId, setNewEditorId] = React.useState("");
    const [allowedEditors, setAllowedEditors] = React.useState([]);
    const [pendingRequests, setPendingRequests] = React.useState([]);
    const [canViewRemote, setCanViewRemote] = React.useState(isOwnProfile);
    const [editableConfig, setEditableConfig] = React.useState(() => mergeLocalConfig(interceptConfig));
    const [censoredWordsText, setCensoredWordsText] = React.useState(() => toLines(interceptConfig.censored_words));
    const [timeoutAdjustments, setTimeoutAdjustments] = React.useState(() => createTimeoutAdjustmentDefaults());
    const [groupTimeoutAdjustments, setGroupTimeoutAdjustments] = React.useState({});
    const [isRulesEditorOpen, setIsRulesEditorOpen] = React.useState(false);
    const [nowMs, setNowMs] = React.useState(() => Date.now());
    const skipAutosaveRef = React.useRef(true);
    const lastSavedSnapshotRef = React.useRef("");
    const saveQueueRef = React.useRef(Promise.resolve());
    const refreshInFlightRef = React.useRef(false);

    const updateFromConfig = React.useCallback(config => {
        const merged = mergeLocalConfig(config);
        interceptConfig = merged;
        skipAutosaveRef.current = true;
        setEditableConfig(merged);
        setCensoredWordsText(toLines(merged.censored_words));
        lastSavedSnapshotRef.current = JSON.stringify(merged);
    }, []);

    const refresh = React.useCallback(async () => {
        if (refreshInFlightRef.current || !isPanelOpen || !activeUserId) return;
        refreshInFlightRef.current = true;
        const nextRelayUrl = currentRelayUrl();
        setRelayUrl(nextRelayUrl);
        try {
            if (isOwnProfile) {
                await syncInAppLoopback(nextRelayUrl, activeUserId).catch(() => {});
                const local = readLocalConfig(activeUserId);
                updateFromConfig(local);
                setAllowedEditors(getAllowedEditors(activeUserId).allowed_editors.sort());
                const access = await getAccessRequests(nextRelayUrl, activeUserId).catch(() => ({ requests: [] }));
                setPendingRequests(access.requests.sort());
                setCanViewRemote(true);
                setStatus("Loaded local profile config");
                return;
            }

            const remote = await readRemoteConfig(nextRelayUrl, activeUserId, profileUserId);
            updateFromConfig(remote);
            setCanViewRemote(true);
            setStatus(`Loaded ${profileUserId}'s profile config`);
        } catch (err) {
            setCanViewRemote(false);
            if (err?.status === 403) {
                setStatus(`No access to ${profileUserId}'s config. Request permission below.`);
            } else {
                setStatus(String(err));
            }
        } finally {
            refreshInFlightRef.current = false;
        }
    }, [activeUserId, isOwnProfile, isPanelOpen, profileUserId, updateFromConfig]);

    React.useEffect(() => {
        refresh().catch(err => setStatus(String(err)));
    }, [refresh, isPanelOpen]);

    React.useEffect(() => {
        if (!isPanelOpen || hasExplicitPanelOpenState) return;
        const handle = setInterval(() => {
            const { snapshot } = buildConfigSnapshot(editableConfig, censoredWordsText);
            if (snapshot !== lastSavedSnapshotRef.current) return;
            refresh().catch(err => setStatus(String(err)));
        }, 1500);
        return () => clearInterval(handle);
    }, [censoredWordsText, editableConfig, hasExplicitPanelOpenState, isPanelOpen, refresh]);

    React.useEffect(() => {
        const handle = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(handle);
    }, []);

    const saveRelayUrl = React.useCallback(() => {
        const next = relayUrl.trim();
        const storage = getStorageBackend();
        if (!next) {
            setStatus("Relay URL cannot be empty");
            return;
        }
        storage?.setItem(RELAY_URL_STORAGE_KEY, next);
        setStatus("Saved relay URL");
    }, [relayUrl]);

    const saveStructuredConfig = React.useCallback(baseConfig => {
        if (!activeUserId) return Promise.resolve();
        const { merged } = buildConfigSnapshot(baseConfig, censoredWordsText);
        if (isOwnProfile) {
            return saveLocalConfig(activeUserId, merged, activeUserId).then(() => {
                lastSavedSnapshotRef.current = JSON.stringify(merged);
                setStatus("Auto-saved local profile config");
            }).catch(err => setStatus(`Auto-save failed: ${String(err)}`));
        }
        return pushRemoteConfig(currentRelayUrl(), activeUserId, profileUserId, merged).then(() => {
            lastSavedSnapshotRef.current = JSON.stringify(merged);
            setStatus(`Auto-saved ${profileUserId}'s profile config`);
        }).catch(err => setStatus(`Auto-save failed: ${String(err)}`));
    }, [activeUserId, censoredWordsText, isOwnProfile, profileUserId]);

    React.useEffect(() => {
        if (!(isOwnProfile || canViewRemote) || !isPanelOpen) return;
        if (skipAutosaveRef.current) {
            skipAutosaveRef.current = false;
            return;
        }
        const { merged, snapshot } = buildConfigSnapshot(editableConfig, censoredWordsText);
        if (snapshot === lastSavedSnapshotRef.current) return;
        setStatus("Auto-saving...");
        saveQueueRef.current = saveQueueRef.current
            .catch(() => {})
            .then(() => saveStructuredConfig(merged));
    }, [canViewRemote, censoredWordsText, editableConfig, isOwnProfile, isPanelOpen, saveStructuredConfig]);

    const setTimeoutValue = React.useCallback((field, nextIso) => {
        setEditableConfig(prev => ({
            ...prev,
            config: {
                ...prev.config,
                [field]: nextIso
            }
        }));
    }, []);

    const addTimeoutAmount = React.useCallback((field, multiplierSeconds) => {
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

    const setPermanentTimeout = React.useCallback(field => {
        setTimeoutValue(field, farFuture);
        setStatus(`${field}: Permanent`);
    }, [setTimeoutValue]);

    const setGroupTimeout = React.useCallback((groupId, nextIso) => {
        setEditableConfig(prev => ({
            ...prev,
            rules_groups: prev.rules_groups.map(group => (
                group.id === groupId ? { ...group, timeout_end: nextIso } : group
            ))
        }));
    }, []);

    const addGroupTimeoutAmount = React.useCallback((groupId, multiplierSeconds) => {
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

    const removeRuleGroup = React.useCallback(groupId => {
        setEditableConfig(prev => ({
            ...prev,
            rules_groups: prev.rules_groups.filter(group => group.id !== groupId),
            rules: prev.rules.filter(rule => rule.group_id !== groupId)
        }));
    }, []);

    const addRuleToGroup = React.useCallback(groupId => {
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

    const updateRuleAtIndex = React.useCallback((ruleIndex, updater) => {
        setEditableConfig(prev => ({
            ...prev,
            rules: prev.rules.map((rule, index) => (index === ruleIndex ? updater(rule) : rule))
        }));
    }, []);

    const removeRuleAtIndex = React.useCallback(ruleIndex => {
        setEditableConfig(prev => ({
            ...prev,
            rules: prev.rules.filter((_, index) => index !== ruleIndex)
        }));
    }, []);

    const cardStyle = {
        marginTop: 12,
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "#3f4147",
        backgroundColor: "#2b2d31"
    };

    const inputStyle = {
        color: "#f2f3f5",
        borderWidth: 1,
        borderColor: "#3f4147",
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        marginTop: 6
    };

    const button = (label, onPress, options = {}) => h(
        Pressable,
        {
            key: options.key ?? label,
            onPress,
            style: {
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 8,
                backgroundColor: options.danger ? "#da373c" : (options.active ? "#3ba55d" : "#5865f2"),
                marginTop: options.noTopMargin ? 0 : 6,
                marginRight: 6
            }
        },
        h(Text, { style: { color: "#ffffff", fontWeight: "600" } }, label)
    );

    const renderTimeoutControls = (field, label) => h(
        View,
        { style: { marginTop: 8 } },
        h(Text, { style: { color: "#f2f3f5", fontWeight: "600" } }, label),
        h(Text, { style: { color: "#b5bac1", marginTop: 4 } }, formatTimeoutStatus(editableConfig.config[field], nowMs)),
        h(TextInput, {
            value: timeoutAdjustments[field],
            onChangeText: value => setTimeoutAdjustments(prev => ({ ...prev, [field]: value })),
            keyboardType: "numeric",
            style: inputStyle
        }),
        h(View, { style: { marginTop: 6, flexDirection: "row", flexWrap: "wrap" } },
            button("+Sec", () => addTimeoutAmount(field, 1), { key: `${field}-sec`, noTopMargin: true }),
            button("+Min", () => addTimeoutAmount(field, 60), { key: `${field}-min`, noTopMargin: true }),
            button("+Hour", () => addTimeoutAmount(field, 3600), { key: `${field}-hour`, noTopMargin: true }),
            button("Permanent", () => setPermanentTimeout(field), { key: `${field}-perm`, noTopMargin: true })
        )
    );

    const section = (key, title, children) => h(
        View,
        { key, style: cardStyle },
        h(Text, { style: { color: "#f2f3f5", fontWeight: "700", fontSize: 15 } }, title),
        children
    );

    const scopeList = getSharedScopeList(editableConfig);

    const rulesEditor = !isRulesEditorOpen ? null : h(
        View,
        { style: cardStyle },
        h(Text, { style: { color: "#f2f3f5", fontWeight: "700", fontSize: 15 } }, "Custom Rules Editor"),
        button("Add rule group", addRuleGroup),
        ...[...editableConfig.rules_groups].sort((a, b) => a.order - b.order).map(group => {
            const groupRules = editableConfig.rules
                .map((rule, index) => ({ rule, index }))
                .filter(item => item.rule.group_id === group.id)
                .sort((a, b) => a.rule.order - b.rule.order);
            return h(
                View,
                {
                    key: `group-${group.id}`,
                    style: {
                        marginTop: 10,
                        borderWidth: 1,
                        borderColor: "#3f4147",
                        borderRadius: 10,
                        padding: 10
                    }
                },
                h(Text, { style: { color: "#f2f3f5", fontWeight: "700" } }, `Group #${group.id}`),
                h(View, { style: { marginTop: 6, flexDirection: "row", flexWrap: "wrap" } },
                    button(group.enabled ? "Enabled" : "Disabled", () => {
                        setEditableConfig(prev => ({
                            ...prev,
                            rules_groups: prev.rules_groups.map(current => (
                                current.id === group.id ? { ...current, enabled: !current.enabled } : current
                            ))
                        }));
                    }, { active: group.enabled, noTopMargin: true, key: `group-enabled-${group.id}` }),
                    button("Remove Group", () => removeRuleGroup(group.id), { danger: true, noTopMargin: true, key: `group-remove-${group.id}` }),
                    button("Add Rule", () => addRuleToGroup(group.id), { noTopMargin: true, key: `group-add-rule-${group.id}` })
                ),
                h(Text, { style: { color: "#b5bac1", marginTop: 6 } }, `Order: ${group.order}`),
                h(TextInput, {
                    value: String(group.order),
                    onChangeText: value => {
                        const nextValue = parseNumericInput(value, group.order, { min: 0 });
                        setEditableConfig(prev => ({
                            ...prev,
                            rules_groups: prev.rules_groups.map(current => (
                                current.id === group.id ? { ...current, order: nextValue } : current
                            ))
                        }));
                    },
                    keyboardType: "numeric",
                    style: inputStyle
                }),
                h(Text, { style: { color: "#b5bac1", marginTop: 6 } }, `Timeout: ${formatTimeoutStatus(group.timeout_end, nowMs)}`),
                h(TextInput, {
                    value: group.timeout_end,
                    onChangeText: value => setGroupTimeout(group.id, value),
                    autoCapitalize: "none",
                    autoCorrect: false,
                    style: inputStyle
                }),
                h(TextInput, {
                    value: groupTimeoutAdjustments[group.id] ?? "1",
                    onChangeText: value => setGroupTimeoutAdjustments(prev => ({ ...prev, [group.id]: value })),
                    keyboardType: "numeric",
                    style: inputStyle
                }),
                h(View, { style: { marginTop: 6, flexDirection: "row", flexWrap: "wrap" } },
                    button("+Sec", () => addGroupTimeoutAmount(group.id, 1), { noTopMargin: true, key: `group-sec-${group.id}` }),
                    button("+Min", () => addGroupTimeoutAmount(group.id, 60), { noTopMargin: true, key: `group-min-${group.id}` }),
                    button("+Hour", () => addGroupTimeoutAmount(group.id, 3600), { noTopMargin: true, key: `group-hour-${group.id}` }),
                    button("Permanent", () => setGroupTimeout(group.id, farFuture), { noTopMargin: true, key: `group-perm-${group.id}` })
                ),
                groupRules.length === 0
                    ? h(Text, { style: { color: "#b5bac1", marginTop: 6 } }, "No rules in this group")
                    : null,
                ...groupRules.map(({ rule, index }) => h(
                    View,
                    {
                        key: `rule-${group.id}-${index}`,
                        style: {
                            marginTop: 8,
                            borderWidth: 1,
                            borderColor: "#3f4147",
                            borderRadius: 8,
                            padding: 8
                        }
                    },
                    h(Text, { style: { color: "#f2f3f5" } }, "Regex"),
                    h(TextInput, {
                        value: rule.rule_regex,
                        onChangeText: value => updateRuleAtIndex(index, current => ({ ...current, rule_regex: value })),
                        autoCapitalize: "none",
                        autoCorrect: false,
                        style: inputStyle
                    }),
                    h(Text, { style: { color: "#f2f3f5", marginTop: 6 } }, "Replacement"),
                    h(TextInput, {
                        value: rule.rule_replacement,
                        onChangeText: value => updateRuleAtIndex(index, current => ({ ...current, rule_replacement: value })),
                        autoCapitalize: "none",
                        autoCorrect: false,
                        style: inputStyle
                    }),
                    h(Text, { style: { color: "#b5bac1", marginTop: 6 } }, `Chance: ${Math.round(rule.chance_to_apply * 100)}%`),
                    h(TextInput, {
                        value: String(Math.round(rule.chance_to_apply * 100)),
                        onChangeText: value => {
                            const nextValue = parseNumericInput(value, Math.round(rule.chance_to_apply * 100), { min: 0, max: 100 });
                            updateRuleAtIndex(index, current => ({ ...current, chance_to_apply: nextValue / 100 }));
                        },
                        keyboardType: "numeric",
                        style: inputStyle
                    }),
                    h(Text, { style: { color: "#b5bac1", marginTop: 6 } }, `Order: ${rule.order}`),
                    h(TextInput, {
                        value: String(rule.order),
                        onChangeText: value => {
                            const nextValue = parseNumericInput(value, rule.order, { min: 0 });
                            updateRuleAtIndex(index, current => ({ ...current, order: nextValue }));
                        },
                        keyboardType: "numeric",
                        style: inputStyle
                    }),
                    h(View, { style: { marginTop: 6, flexDirection: "row", flexWrap: "wrap" } },
                        button(rule.enabled ? "Rule Enabled" : "Rule Disabled", () => {
                            updateRuleAtIndex(index, current => ({ ...current, enabled: !current.enabled }));
                        }, { active: rule.enabled, noTopMargin: true, key: `rule-enabled-${group.id}-${index}` }),
                        button(rule.regex_normalize ? "Normalize On" : "Normalize Off", () => {
                            updateRuleAtIndex(index, current => ({ ...current, regex_normalize: !current.regex_normalize }));
                        }, { active: rule.regex_normalize, noTopMargin: true, key: `rule-normalize-${group.id}-${index}` }),
                        button("Remove Rule", () => removeRuleAtIndex(index), { danger: true, noTopMargin: true, key: `rule-remove-${group.id}-${index}` })
                    )
                ))
            );
        })
    );

    const editorRows = allowedEditors.map(editor => h(
        View,
        {
            key: `editor-${editor}`,
            style: {
                marginTop: 8,
                padding: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: "#3f4147"
            }
        },
        h(Text, { style: { color: "#f2f3f5", marginBottom: 6 } }, editor),
        button(`Remove ${editor}`, () => removeAllowedEditor(activeUserId, editor).then(refresh), { danger: true })
    ));

    const requestRows = pendingRequests.map(requesterId => h(
        View,
        {
            key: `request-${requesterId}`,
            style: {
                marginTop: 8,
                padding: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: "#3f4147"
            }
        },
        h(Text, { style: { color: "#f2f3f5" } }, requesterId),
        button(`Approve ${requesterId}`, () => approveAccessRequest(currentRelayUrl(), activeUserId, requesterId).then(refresh)),
        button(`Deny ${requesterId}`, () => denyAccessRequest(currentRelayUrl(), activeUserId, requesterId).then(refresh), { danger: true })
    ));

    return h(
        ScrollView,
        {
            style: { maxHeight: 720, width: "100%" },
            contentContainerStyle: {
                backgroundColor: "#313338",
                borderRadius: 12,
                padding: 12
            }
        },
        h(Text, { style: { color: "#f2f3f5", fontSize: 16, fontWeight: "700" } }, "key-intercept control center"),
        h(Text, { style: { color: "#b5bac1", marginTop: 4 } }, isOwnProfile ? "Your profile configuration" : `Viewing profile ${profileUserId}`),
        h(Text, { style: { color: "#b5bac1", marginTop: 4 } }, "Open this panel from any user profile to view or edit that user's config."),

        isOwnProfile ? section("relay-url", "Relay", h(
            View,
            null,
            h(Text, { style: { color: "#f2f3f5", marginTop: 6 } }, "Relay URL"),
            h(TextInput, {
                value: relayUrl,
                onChangeText: setRelayUrl,
                autoCapitalize: "none",
                autoCorrect: false,
                style: inputStyle
            }),
            button("Save Relay URL", saveRelayUrl)
        )) : null,

        !isOwnProfile && !canViewRemote ? section("access-request", "Access", h(
            View,
            null,
            h(Text, { style: { color: "#f2f3f5", marginTop: 6 } }, "You do not currently have permission to view this profile config."),
            button("Request Access via Relay", () => requestRemoteAccess(currentRelayUrl(), activeUserId, profileUserId).then(() => {
                setStatus(`Access request sent to ${profileUserId}`);
            }).catch(err => setStatus(`Access request failed: ${String(err)}`)))
        )) : null,

        (isOwnProfile || canViewRemote) ? section("gag", "Gag", renderTimeoutControls("gag_end", "Gag timeout")) : null,

        (isOwnProfile || canViewRemote) ? section("pet", "Pet", h(
            View,
            null,
            renderTimeoutControls("pet_end", "Pet timeout"),
            h(Text, { style: { color: "#f2f3f5", marginTop: 6 } }, "Pet type (1-7)"),
            h(TextInput, {
                value: String(editableConfig.config.pet_type),
                onChangeText: value => {
                    const nextValue = parseNumericInput(value, editableConfig.config.pet_type, { min: 1, max: petTypeOptions.length });
                    setEditableConfig(prev => ({
                        ...prev,
                        config: {
                            ...prev.config,
                            pet_type: nextValue
                        }
                    }));
                },
                keyboardType: "numeric",
                style: inputStyle
            }),
            h(Text, { style: { color: "#b5bac1", marginTop: 4 } }, petTypeOptions.map(option => `${option.value}:${option.label}`).join(" • ")),
            h(Text, { style: { color: "#f2f3f5", marginTop: 6 } }, `Pet amount (${Math.round(editableConfig.config.pet_amount * 100)}%)`),
            h(TextInput, {
                value: String(Math.round(editableConfig.config.pet_amount * 100)),
                onChangeText: value => {
                    const nextValue = parseNumericInput(value, Math.round(editableConfig.config.pet_amount * 100), { min: 0, max: 100 });
                    setEditableConfig(prev => ({
                        ...prev,
                        config: {
                            ...prev.config,
                            pet_amount: nextValue / 100
                        }
                    }));
                },
                keyboardType: "numeric",
                style: inputStyle
            })
        )) : null,

        (isOwnProfile || canViewRemote) ? section("bimbo", "Bimbo", h(
            View,
            null,
            renderTimeoutControls("bimbo_end", "Bimbo timeout"),
            h(Text, { style: { color: "#f2f3f5", marginTop: 6 } }, "Bimbo word length"),
            h(TextInput, {
                value: String(editableConfig.config.bimbo_word_length),
                onChangeText: value => {
                    const nextValue = parseNumericInput(value, editableConfig.config.bimbo_word_length, { min: 1 });
                    setEditableConfig(prev => ({
                        ...prev,
                        config: {
                            ...prev.config,
                            bimbo_word_length: nextValue
                        }
                    }));
                },
                keyboardType: "numeric",
                style: inputStyle
            })
        )) : null,

        (isOwnProfile || canViewRemote) ? section("horny", "Horny", renderTimeoutControls("horny_end", "Horny timeout")) : null,

        (isOwnProfile || canViewRemote) ? section("drone", "Drone", h(
            View,
            null,
            renderTimeoutControls("drone_end", "Drone timeout"),
            ...[
                ["Drone term", "drone_term"],
                ["Speech header", "speech_header"],
                ["Speech footer", "speech_footer"],
                ["Action header", "action_header"],
                ["Action footer", "action_footer"],
                ["Whisper header", "whisper_header"],
                ["Whisper footer", "whisper_footer"],
                ["Loud header", "loud_header"],
                ["Loud footer", "loud_footer"]
            ].map(([label, key]) => h(
                View,
                { key: `drone-${key}` },
                h(Text, { style: { color: "#f2f3f5", marginTop: 6 } }, label),
                h(TextInput, {
                    value: editableConfig.drone_config[key],
                    onChangeText: value => {
                        setEditableConfig(prev => ({
                            ...prev,
                            drone_config: {
                                ...prev.drone_config,
                                [key]: value
                            }
                        }));
                    },
                    autoCapitalize: "none",
                    autoCorrect: false,
                    style: inputStyle
                })
            ))
        )) : null,

        (isOwnProfile || canViewRemote) ? section("uwu", "UWU", renderTimeoutControls("uwu_end", "UWU timeout")) : null,

        (isOwnProfile || canViewRemote) ? section("censored", "Censored", h(
            View,
            null,
            renderTimeoutControls("censored_end", "Censored timeout"),
            h(Text, { style: { color: "#f2f3f5", marginTop: 6 } }, "Censored replacement"),
            h(TextInput, {
                value: editableConfig.config.censored_replacement,
                onChangeText: value => {
                    setEditableConfig(prev => ({
                        ...prev,
                        config: {
                            ...prev.config,
                            censored_replacement: value
                        }
                    }));
                },
                autoCapitalize: "none",
                autoCorrect: false,
                style: inputStyle
            }),
            h(Text, { style: { color: "#f2f3f5", marginTop: 6 } }, "Censored words (one per line)"),
            h(TextInput, {
                value: censoredWordsText,
                onChangeText: setCensoredWordsText,
                multiline: true,
                textAlignVertical: "top",
                autoCapitalize: "none",
                autoCorrect: false,
                style: {
                    ...inputStyle,
                    minHeight: 110
                }
            })
        )) : null,

        (isOwnProfile || canViewRemote) ? section("scope", "Scope Filter", h(
            View,
            null,
            h(Text, { style: { color: "#f2f3f5", marginTop: 6 } }, `Filter mode: ${editableConfig.filter_mode}`),
            h(View, { style: { marginTop: 6, flexDirection: "row", flexWrap: "wrap" } },
                button("Whitelist", () => setEditableConfig(prev => ({ ...prev, filter_mode: "whitelist" })), { active: editableConfig.filter_mode === "whitelist", noTopMargin: true, key: "scope-whitelist" }),
                button("Blacklist", () => setEditableConfig(prev => ({ ...prev, filter_mode: "blacklist" })), { active: editableConfig.filter_mode === "blacklist", noTopMargin: true, key: "scope-blacklist" })
            ),
            h(Text, { style: { color: "#b5bac1", marginTop: 6 } }, "Use server/DM context menu for quick add/remove. You can remove entries here."),
            scopeList.length
                ? scopeList.map((item, index) => h(
                    View,
                    {
                        key: `scope-${index}`,
                        style: {
                            marginTop: 8,
                            borderWidth: 1,
                            borderColor: "#3f4147",
                            borderRadius: 8,
                            padding: 8
                        }
                    },
                    h(Text, { style: { color: "#f2f3f5" } }, item.server_name || item.discord_id || "(empty)"),
                    button("Remove", () => {
                        setEditableConfig(prev => {
                            const nextList = getSharedScopeList(prev).filter((_, listIndex) => listIndex !== index);
                            return { ...prev, whitelist: nextList, blacklist: nextList };
                        });
                    }, { danger: true })
                ))
                : h(Text, { style: { color: "#b5bac1", marginTop: 6 } }, "No scope entries")
        )) : null,

        (isOwnProfile || canViewRemote) ? section("custom-rules", "Custom Rules", h(
            View,
            null,
            h(Text, { style: { color: "#b5bac1", marginTop: 6 } }, `${editableConfig.rules_groups.length} group(s), ${editableConfig.rules.length} rule(s)`),
            h(View, { style: { marginTop: 6, flexDirection: "row", flexWrap: "wrap" } },
                button(isRulesEditorOpen ? "Hide Rules Editor" : "Open Rules Editor", () => setIsRulesEditorOpen(open => !open), { noTopMargin: true, key: "rules-toggle" }),
                button(editableConfig.config.debug ? "Debug On" : "Debug Off", () => {
                    setEditableConfig(prev => ({
                        ...prev,
                        config: {
                            ...prev.config,
                            debug: !prev.config.debug
                        }
                    }));
                }, { active: editableConfig.config.debug, noTopMargin: true, key: "debug-toggle" })
            )
        )) : null,

        (isOwnProfile || canViewRemote) ? rulesEditor : null,

        (isOwnProfile || canViewRemote) ? section("sync-controls", "Sync", h(
            View,
            null,
            h(Text, { style: { color: "#b5bac1", marginTop: 6 } }, "Changes auto-save as you edit."),
            h(View, { style: { flexDirection: "row", flexWrap: "wrap", marginTop: 6 } },
                button("Reload", () => refresh().catch(err => setStatus(String(err))), { noTopMargin: true, key: "reload-config" })
            )
        )) : null,

        isOwnProfile ? section("allowed-editors", "Allowed Editors", h(
            View,
            null,
            h(TextInput, {
                value: newEditorId,
                onChangeText: setNewEditorId,
                placeholder: "Discord ID",
                placeholderTextColor: "#80848e",
                keyboardType: "numeric",
                style: inputStyle
            }),
            button("Add Editor", () => addAllowedEditor(activeUserId, newEditorId.trim()).then(() => {
                setNewEditorId("");
                return refresh();
            }).catch(err => setStatus(String(err)))),
            ...editorRows
        )) : null,

        isOwnProfile ? section("pending-requests", "Pending Requests", requestRows.length
            ? h(View, null, ...requestRows)
            : h(Text, { style: { color: "#b5bac1", marginTop: 6 } }, "No pending requests")) : null,

        h(Text, { style: { color: "#b5bac1", marginTop: 12 } }, status)
    );
}

const plugin = {
    onLoad: () => {
        findByProps = globalThis?.vendetta?.metro?.findByProps ?? null;
        ReactRef = globalThis?.vendetta?.metro?.common?.React ?? null;
        ReactNativeRef = globalThis?.vendetta?.metro?.common?.ReactNative ?? null;
        if (!findByProps) {
            throw new Error("Vendetta modules unavailable");
        }
        return bootstrapConfig().then(() => {
            patchSendMessage();
        });
    },
    onUnload: () => {
        if (unpatchSendMessage) {
            unpatchSendMessage();
            unpatchSendMessage = null;
        }
    },
    settings: ConfigPanel,
    userProfileBadge: {
        id: "key-intercept-controls",
        key: "key-intercept-controls",
        description: "key-intercept controls",
        component: ConfigPanel
    }
};

export const onLoad = plugin.onLoad;
export const onUnload = plugin.onUnload;
export default plugin;
