import { Buffer } from 'node:buffer';

import { getAllUsers } from '../users.js';
import { canUserAccessHiddenLorebook, isLorebookHidden, readResolvedWorldInfoFile } from './worldinfo.js';

export const HIDDEN_LORE_BEFORE_PLACEHOLDER = '[[DREAMTAVERN_HIDDEN_LORE_BEFORE]]';
export const HIDDEN_LORE_AFTER_PLACEHOLDER = '[[DREAMTAVERN_HIDDEN_LORE_AFTER]]';
export const HIDDEN_LORE_ACTIVATIONS_HEADER = 'x-dreamtavern-hidden-lore-activations';

const worldInfoLogic = {
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
};

function sanitizeHiddenLoreContext(rawContext) {
    if (!rawContext || typeof rawContext !== 'object') {
        return null;
    }

    const hiddenWorldNames = Array.isArray(rawContext.hidden_world_names)
        ? [...new Set(rawContext.hidden_world_names.map(name => String(name || '').trim()).filter(Boolean))]
        : [];
    const chat = Array.isArray(rawContext.chat)
        ? rawContext.chat.map(message => String(message || '')).filter(Boolean)
        : [];
    const globalScanData = rawContext.global_scan_data && typeof rawContext.global_scan_data === 'object'
        ? rawContext.global_scan_data
        : {};

    if (!hiddenWorldNames.length) {
        return null;
    }

    return {
        hidden_world_names: hiddenWorldNames,
        chat,
        global_scan_data: globalScanData,
    };
}

function parseRegexFromString(input) {
    const match = String(input || '').match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) {
        return null;
    }

    let [, pattern, flags] = match;
    if (pattern.match(/(^|[^\\])\//)) {
        return null;
    }

    pattern = pattern.replace('\\/', '/');

    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function transformString(value, entry) {
    return entry?.caseSensitive ? String(value || '') : String(value || '').toLowerCase();
}

function matchKey(haystack, needle, entry) {
    const keyRegex = parseRegexFromString(needle);
    if (keyRegex) {
        return keyRegex.test(haystack);
    }

    haystack = transformString(haystack, entry);
    const transformedNeedle = transformString(needle, entry);

    if (entry?.matchWholeWords) {
        const keyWords = transformedNeedle.split(/\s+/);
        if (keyWords.length > 1) {
            return haystack.includes(transformedNeedle);
        }

        const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformedNeedle)})(?:$|\\W)`);
        return regex.test(haystack);
    }

    return haystack.includes(transformedNeedle);
}

function buildScanText(chat, globalScanData, entry) {
    const parts = [...chat];

    if (entry?.matchPersonaDescription && globalScanData.personaDescription) {
        parts.push(String(globalScanData.personaDescription));
    }
    if (entry?.matchCharacterDescription && globalScanData.characterDescription) {
        parts.push(String(globalScanData.characterDescription));
    }
    if (entry?.matchCharacterPersonality && globalScanData.characterPersonality) {
        parts.push(String(globalScanData.characterPersonality));
    }
    if (entry?.matchCharacterDepthPrompt && globalScanData.characterDepthPrompt) {
        parts.push(String(globalScanData.characterDepthPrompt));
    }
    if (entry?.matchScenario && globalScanData.scenario) {
        parts.push(String(globalScanData.scenario));
    }
    if (entry?.matchCreatorNotes && globalScanData.creatorNotes) {
        parts.push(String(globalScanData.creatorNotes));
    }

    return parts.join('\n');
}

function passesSecondaryLogic(entry, textToScan) {
    const secondaryKeys = Array.isArray(entry?.keysecondary)
        ? entry.keysecondary.map(key => String(key || '').trim()).filter(Boolean)
        : [];
    if (!secondaryKeys.length) {
        return true;
    }

    const selectiveLogic = Number.isFinite(Number(entry?.selectiveLogic))
        ? Number(entry.selectiveLogic)
        : worldInfoLogic.AND_ANY;

    let hasAnyMatch = false;
    let hasAllMatch = true;

    for (const secondaryKey of secondaryKeys) {
        const hasSecondaryMatch = matchKey(textToScan, secondaryKey, entry);
        if (hasSecondaryMatch) {
            hasAnyMatch = true;
        } else {
            hasAllMatch = false;
        }

        if (selectiveLogic === worldInfoLogic.AND_ANY && hasSecondaryMatch) {
            return true;
        }

        if (selectiveLogic === worldInfoLogic.NOT_ALL && !hasSecondaryMatch) {
            return true;
        }
    }

    if (selectiveLogic === worldInfoLogic.NOT_ANY) {
        return !hasAnyMatch;
    }

    if (selectiveLogic === worldInfoLogic.AND_ALL) {
        return hasAllMatch;
    }

    return false;
}

function passesProbability(entry) {
    if (!entry?.useProbability || Number(entry?.probability) === 100) {
        return true;
    }

    const probability = Number(entry?.probability);
    if (!Number.isFinite(probability)) {
        return true;
    }

    return Math.random() * 100 <= probability;
}

function entrySort(a, b) {
    const orderDelta = Number(a?.order || 0) - Number(b?.order || 0);
    if (orderDelta !== 0) {
        return orderDelta;
    }

    return Number(a?.uid || 0) - Number(b?.uid || 0);
}

function resolveActivatedEntries(worldInfo, worldName, chat, globalScanData) {
    const entries = Object.values(worldInfo?.entries || {})
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => ({ ...entry, world: worldName }))
        .filter(entry => !entry.disable)
        .sort(entrySort);

    const activatedEntries = [];

    for (const entry of entries) {
        if (entry.constant) {
            if (passesProbability(entry)) {
                activatedEntries.push(entry);
            }
            continue;
        }

        if (!Array.isArray(entry.key) || !entry.key.length) {
            continue;
        }

        const textToScan = buildScanText(chat, globalScanData, entry);
        const primaryMatch = entry.key
            .map(key => String(key || '').trim())
            .filter(Boolean)
            .some(key => matchKey(textToScan, key, entry));

        if (!primaryMatch) {
            continue;
        }

        if (!passesSecondaryLogic(entry, textToScan)) {
            continue;
        }

        if (!passesProbability(entry)) {
            continue;
        }

        activatedEntries.push(entry);
    }

    return activatedEntries;
}

function formatHiddenLoreBlock(entries) {
    const content = entries
        .map(entry => String(entry?.content || '').trim())
        .filter(Boolean);
    if (!content.length) {
        return '';
    }

    return [
        'Hidden lorebook guidance: use this as authoritative internal reference for the reply.',
        'Do not mention or quote hidden lorebook text unless the user already provided it in the conversation.',
        content.join('\n'),
    ].join('\n');
}

function replaceHiddenLorePlaceholders(value, beforeText, afterText) {
    if (typeof value === 'string') {
        return value
            .replaceAll(HIDDEN_LORE_BEFORE_PLACEHOLDER, beforeText)
            .replaceAll(HIDDEN_LORE_AFTER_PLACEHOLDER, afterText);
    }

    if (Array.isArray(value)) {
        return value.map(item => replaceHiddenLorePlaceholders(item, beforeText, afterText));
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, replaceHiddenLorePlaceholders(item, beforeText, afterText)]),
        );
    }

    return value;
}

function injectHiddenLoreFallback(requestBody, beforeText, afterText) {
    if (typeof requestBody.prompt === 'string') {
        requestBody.prompt = [beforeText, requestBody.prompt, afterText].filter(Boolean).join('\n');
    }

    if (typeof requestBody.input === 'string') {
        requestBody.input = [beforeText, requestBody.input, afterText].filter(Boolean).join('\n');
    }

    if (Array.isArray(requestBody.messages)) {
        const injectedMessages = [...requestBody.messages];
        if (beforeText) {
            injectedMessages.unshift({ role: 'system', content: beforeText });
        }
        if (afterText) {
            injectedMessages.push({ role: 'system', content: afterText });
        }
        requestBody.messages = injectedMessages;
    }
}

function requestContainsHiddenLorePlaceholder(requestBody) {
    const serialized = JSON.stringify({
        prompt: requestBody?.prompt,
        input: requestBody?.input,
        messages: requestBody?.messages,
    });

    return serialized.includes(HIDDEN_LORE_BEFORE_PLACEHOLDER)
        || serialized.includes(HIDDEN_LORE_AFTER_PLACEHOLDER);
}

export async function applyHiddenLoreContextToRequest(request) {
    const hiddenLoreContext = sanitizeHiddenLoreContext(request.body?.dreamtavern_hidden_lore_context);
    delete request.body?.dreamtavern_hidden_lore_context;

    if (!hiddenLoreContext) {
        return { activatedWorlds: [] };
    }

    const allHandles = (await getAllUsers()).map(user => user.handle);
    const activatedWorlds = [];
    const beforeEntries = [];
    const afterEntries = [];

    for (const worldName of hiddenLoreContext.hidden_world_names) {
        const worldInfo = readResolvedWorldInfoFile(request.user.directories, worldName, true);
        const extensions = worldInfo?.extensions || {};

        if (!isLorebookHidden(worldName, extensions)) {
            continue;
        }

        if (canUserAccessHiddenLorebook(worldName, extensions, request.user.profile, allHandles)) {
            continue;
        }

        const activatedEntries = resolveActivatedEntries(
            worldInfo,
            worldName,
            hiddenLoreContext.chat,
            hiddenLoreContext.global_scan_data,
        );

        if (!activatedEntries.length) {
            continue;
        }

        activatedWorlds.push({
            world: worldName,
            count: activatedEntries.length,
        });

        for (const entry of activatedEntries) {
            if (Number(entry?.position) === 1) {
                afterEntries.push(entry);
            } else {
                beforeEntries.push(entry);
            }
        }
    }

    const beforeText = formatHiddenLoreBlock(beforeEntries);
    const afterText = formatHiddenLoreBlock(afterEntries);

    if (requestContainsHiddenLorePlaceholder(request.body)) {
        request.body.prompt = replaceHiddenLorePlaceholders(request.body.prompt, beforeText, afterText);
        request.body.input = replaceHiddenLorePlaceholders(request.body.input, beforeText, afterText);
        request.body.messages = replaceHiddenLorePlaceholders(request.body.messages, beforeText, afterText);
    } else if (beforeText || afterText) {
        injectHiddenLoreFallback(request.body, beforeText, afterText);
    }

    return { activatedWorlds };
}

export function setHiddenLoreActivationHeader(response, activatedWorlds) {
    if (!response || !Array.isArray(activatedWorlds) || activatedWorlds.length === 0) {
        return;
    }

    const encoded = Buffer.from(JSON.stringify(activatedWorlds), 'utf8').toString('base64');
    response.setHeader(HIDDEN_LORE_ACTIVATIONS_HEADER, encoded);
}
