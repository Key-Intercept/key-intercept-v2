const LOG_PREFIX = "[key-intercept/kettu]";
const MOBILE_STATE_KEY = "key-intercept/mobile-loopback-state/v1";
const RELAY_URL_STORAGE_KEY = "key-intercept/relay-url";
const DEFAULT_RELAY_URL = "http://82.165.196.147:45491";
const farFuture = "9999-12-31T23:59:59.000Z";
const epoch = "1970-01-01T00:00:00.000Z";

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

class NormalizedString {
    constructor(str) {
        this.str = str;
        this.nfkdStr = "";
        this.indices = [];
        this.rebuild();
    }

    replace(regex, fn) {
        const regexWithIndices = new RegExp(regex, "gid");
        let match;
        while ((match = regexWithIndices.exec(this.nfkdStr)) != null) {
            const [postStart, postEnd] = match.indices[0];
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

    convert(postStart, postEnd) {
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

async function uploadMobileSnapshot(relayUrl, ownerId) {
    const state = readMobileState(ownerId);
    const response = await fetch(`${relayBaseUrl(relayUrl)}/users/${ownerId}/mobile/snapshot`, {
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
    });
    if (!response.ok && response.status !== 404) {
        throw new Error(`Mobile snapshot sync failed: ${response.status}`);
    }
}

async function syncInAppLoopback(relayUrl, ownerId) {
    const local = readMobileState(ownerId);
    const response = await fetch(
        `${relayBaseUrl(relayUrl)}/users/${ownerId}/mobile/sync?requester_id=${encodeURIComponent(ownerId)}&after_revision=${local.revision}`,
        { cache: "no-store" }
    );
    if (response.status === 404) {
        await uploadMobileSnapshot(relayUrl, ownerId);
        return;
    }
    if (!response.ok) throw new Error(`Mobile relay sync failed: ${response.status}`);
    const payload = await response.json();
    const relayRevision = Number.isFinite(payload.revision) ? payload.revision : local.revision;
    if (relayRevision <= local.revision) return;

    writeMobileState({
        owner_discord_id: ownerId,
        config: mergeLocalConfig(payload.config),
        allowed_editors: Array.isArray(payload.allowed_editors) ? payload.allowed_editors : local.allowed_editors,
        revision: relayRevision,
        last_writer_id: typeof payload.last_writer_id === "string" ? payload.last_writer_id : ownerId
    });
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

async function bootstrapConfig() {
    const UserStore = findByProps?.("getCurrentUser", "getUser");
    const currentUser = UserStore?.getCurrentUser?.();
    if (!currentUser?.id) return;
    try {
        await syncInAppLoopback(currentRelayUrl(), currentUser.id);
        interceptConfig = mergeLocalConfig(readMobileState(currentUser.id).config);
        console.log(`${LOG_PREFIX} config ready`);
    } catch (err) {
        console.log(`${LOG_PREFIX} config sync failed`, err);
    }
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

const plugin = {
    onLoad: async () => {
        findByProps = globalThis?.vendetta?.metro?.findByProps ?? null;
        if (!findByProps) {
            throw new Error("Vendetta modules unavailable");
        }
        await bootstrapConfig();
        patchSendMessage();
    },
    onUnload: () => {
        if (unpatchSendMessage) {
            unpatchSendMessage();
            unpatchSendMessage = null;
        }
    }
};

export const onLoad = plugin.onLoad;
export const onUnload = plugin.onUnload;
export default plugin;
