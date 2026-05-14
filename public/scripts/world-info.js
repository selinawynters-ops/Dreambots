/*
 * ============================================================================
 * DREAMTAVERN CUSTOMIZATION - World Info Frontend (Admin Controls & Hidden Lorebooks)
 * ============================================================================
 *
 * MODIFICATIONS FROM DEFAULT SILLYTAVERN:
 *
 * 1. ADMIN-ONLY LOREBOOK PUSH/SHARE:
 *    - Import getCurrentUserHandle() and isAdmin() from user.js
 *    - Push/Share buttons only visible to admin users
 *    - Non-admin users cannot push lorebooks to others
 *
 * 2. HIDDEN LOREBOOK SUPPORT FOR NON-ADMINS:
 *    - Non-admin users see hidden character-seeded lorebooks as "(hidden entries)"
 *    - Prefix lorebook names with "9z" for WorldInfoInfo extension detection
 *    - MutationObserver strips "9z" prefix from UI display
 *    - Badge counts remain accurate (full array length preserved)
 *
 * 3. WORLDINFOINFO EXTENSION INTEGRATION:
 *    - ensureWiiPanelObserver() - Sets up mutation observer for panel changes
 *    - Automatically strips "9z" prefix from lorebook headers in extension panel
 *    - Seamless integration without modifying extension code
 *
 * 4. PERMISSION-BASED UI:
 *    - Admin users see all lorebooks with full edit access
 *    - Non-admin users see pushed lorebooks as character-embedded (locked)
 *    - Hidden lorebooks collapsed into single placeholder for privacy
 *
 * RELATED FILES:
 *    - src/endpoints/worldinfo.js (backend push system)
 *    - src/endpoints/characters.js (character protection)
 *    - public/index.html (push/share button UI)
 *
 * ============================================================================
 */

import { Fuse } from '../lib.js';

import { saveSettings, substituteParams, getRequestHeaders, chat_metadata, this_chid, characters, saveCharacterDebounced, menu_type, eventSource, event_types, getExtensionPromptByName, saveMetadata, getCurrentChatId, extension_prompt_roles, create_save, createOrEditCharacter, name1, isCharacterDefinitionLocked, applyCharacterDefinitionLockState, getCharacters, setCharacterId, selectCharacterById, select_rm_characters } from '../script.js';
import { download, debounce, initScrollHeight, resetScrollHeight, parseJsonFile, extractDataFromPng, getFileBuffer, getCharaFilename, getSortableDelay, escapeRegex, PAGINATION_TEMPLATE, navigation_option, waitUntilCondition, isTrueBoolean, setValueByPath, flashHighlight, select2ModifyOptions, getSelect2OptionId, dynamicSelect2DataViaAjax, highlightRegex, select2ChoiceClickSubscribe, isFalseBoolean, getSanitizedFilename, checkOverwriteExistingData, getStringHash, parseStringArray, cancelDebounce, findChar, onlyUnique, equalsIgnoreCaseAndAccents, uuidv4, normalizeArray, getUniqueName, startsWithMatcher } from './utils.js';
import { extension_settings, getContext } from './extensions.js';
import { NOTE_MODULE_NAME, metadata_keys, shouldWIAddPrompt } from './authors-note.js';
import { isMobile } from './RossAscends-mods.js';
import { FILTER_TYPES, FilterHelper } from './filters.js';
import { getTokenCountAsync } from './tokenizers.js';
import { power_user } from './power-user.js';
import { isAdmin, getCurrentUserHandle } from './user.js';
import { getTagKeyForEntity } from './tags.js';
import { debounce_timeout, GENERATION_TYPE_TRIGGERS } from './constants.js';
import { getRegexedString, regex_placement } from './extensions/regex/engine.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from './slash-commands/SlashCommandEnumValue.js';
import { commonEnumProviders, enumIcons } from './slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandClosure } from './slash-commands/SlashCommandClosure.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { StructuredCloneMap } from './util/StructuredCloneMap.js';
import { renderTemplateAsync } from './templates.js';
import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';
import { getOrCreatePersonaDescriptor, setPersonaDescription, user_avatar } from './personas.js';

export const world_info_insertion_strategy = {
    evenly: 0,
    character_first: 1,
    global_first: 2,
};

export const world_info_logic = {
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
};

/**
 * @enum {number} Possible states of the WI evaluation
 */
export const scan_state = {
    /**
     * The scan will be stopped.
     */
    NONE: 0,
    /**
     * Initial state.
     */
    INITIAL: 1,
    /**
     * The scan is triggered by a recursion step.
     */
    RECURSION: 2,
    /**
     * The scan is triggered by a min activations depth skew.
     */
    MIN_ACTIVATIONS: 3,
};

const WI_ENTRY_HEADER_TEMPLATE = $('#entry_edit_template .world_entry');
const WI_ENTRY_EDIT_TEMPLATE = $('#entry_edit_template .world_entry_edit');

export let world_info = {};
export let selected_world_info = [];
/** @type {string[]} */
export let world_names;
const hidden_world_name_set = new Set();
const HIDDEN_LOREBOOK_PLACEHOLDER = '(hidden entries)';
export const HIDDEN_LORE_BEFORE_PLACEHOLDER = '[[DREAMTAVERN_HIDDEN_LORE_BEFORE]]';
export const HIDDEN_LORE_AFTER_PLACEHOLDER = '[[DREAMTAVERN_HIDDEN_LORE_AFTER]]';
export const HIDDEN_LORE_ACTIVATIONS_HEADER = 'x-dreamtavern-hidden-lore-activations';
export let world_info_depth = 2;

function normalizeHiddenLorebookName(name) {
    const worldName = String(name || '').trim();
    if (!worldName) return '';

    const normalizedWorldName = worldName.startsWith('9z') ? worldName.substring(2) : worldName;
    const hiddenSuffix = ` ${HIDDEN_LOREBOOK_PLACEHOLDER}`;
    return normalizedWorldName.endsWith(hiddenSuffix)
        ? normalizedWorldName.substring(0, normalizedWorldName.length - hiddenSuffix.length)
        : normalizedWorldName;
}

export function getLorebookDropdownDisplayName(name) {
    const normalizedWorldName = normalizeHiddenLorebookName(name);
    if (!normalizedWorldName) return '';

    return isHiddenPushedLorebookForDropdown(normalizedWorldName)
        ? `${normalizedWorldName} ${HIDDEN_LOREBOOK_PLACEHOLDER}`
        : normalizedWorldName;
}

/**
 * Check if a world name is a hidden pushed lorebook that should be excluded
 * from the user-facing dropdowns but kept in world_names for binding/loading.
 * @param {string} name World info name
 * @returns {boolean} True if it should be hidden from dropdowns
 */
/**
 * Checks if a lorebook name is a hidden pushed lorebook that should be
 * filtered from dropdown selectors (unless the user is admin or the creator).
 * @param {string} name - Lorebook name
 * @returns {boolean} True if the lorebook should be hidden from the dropdown
 */
export function isHiddenPushedLorebookForDropdown(name) {
    const worldName = String(name || '').trim();
    const normalizedWorldName = normalizeHiddenLorebookName(worldName);
    if (!normalizedWorldName) return false;
    return hidden_world_name_set.has(worldName) || hidden_world_name_set.has(normalizedWorldName);
}

function refreshWorldNameCaches(data) {
    world_names = data?.world_names?.length ? data.world_names : [];
    hidden_world_name_set.clear();

    for (const hiddenWorldName of data?.hidden_world_names ?? []) {
        const normalizedHiddenWorldName = String(hiddenWorldName || '').trim();
        if (normalizedHiddenWorldName) {
            hidden_world_name_set.add(normalizedHiddenWorldName);
        }
    }
}

function normalizeHandleForPushLock(value) {
    return String(value || '').trim().toLowerCase();
}

function isDdLorebookOwnedByHandle(worldName, handle) {
    const normalizedHandle = normalizeHandleForPushLock(handle);
    const normalizedWorldName = String(worldName || '').trim().toLowerCase();
    if (!normalizedHandle || !normalizedWorldName.startsWith('dd-')) return false;
    return normalizedWorldName.startsWith(`dd-${normalizedHandle}-`);
}

function getCharacterPushExtensionBySuffix(character, suffix) {
    const ext = character?.data?.extensions || {};
    const exactKeys = [suffix, `dreamtavern_${suffix}`];

    for (const key of exactKeys) {
        if (Object.prototype.hasOwnProperty.call(ext, key)) {
            return ext[key];
        }
    }

    for (const [key, value] of Object.entries(ext)) {
        if (key.endsWith(`_${suffix}`)) {
            return value;
        }
    }

    return undefined;
}

function getCharacterAuxWorldBooks(character, fileName) {
    const primaryWorld = String(character?.data?.extensions?.world || '').trim();
    const books = [];

    const settingsAuxBooks = world_info.charLore?.find((entry) => entry.name === fileName)?.extraBooks;
    if (Array.isArray(settingsAuxBooks)) {
        books.push(...settingsAuxBooks);
    }

    const pushAuxBooks = getCharacterPushExtensionBySuffix(character, 'aux_lorebooks');
    if (Array.isArray(pushAuxBooks)) {
        books.push(...pushAuxBooks);
    }

    const pushBundleBooks = getCharacterPushExtensionBySuffix(character, 'bundle_lorebooks');
    if (Array.isArray(pushBundleBooks)) {
        books.push(...pushBundleBooks);
    }

    return normalizeArray(books.map((name) => String(name || '').trim()).filter(Boolean))
        .filter((name) => name !== primaryWorld);
}

function getWorldInfoExtensionBySuffix(data, suffix) {
    const ext = data?.extensions || {};
    const exactKeys = [suffix, `dreamtavern_${suffix}`];

    for (const key of exactKeys) {
        if (Object.prototype.hasOwnProperty.call(ext, key)) {
            return ext[key];
        }
    }

    for (const [key, value] of Object.entries(ext)) {
        if (key.endsWith(`_${suffix}`)) {
            return value;
        }
    }

    return undefined;
}

function isAdminPrefixedLorebookName(name) {
    const value = String(name || '').trim();
    if (!value) return false;
    if (/^ADMIN-.+/iu.test(value)) return true;
    return /^ADMIN[a-z0-9._-]+-.+/iu.test(value);
}

function stripAdminLorebookPrefix(name) {
    const value = String(name || '').trim();
    if (!value) return '';
    if (/^ADMIN-.+/iu.test(value)) {
        return value.slice('ADMIN-'.length).trim();
    }

    const match = /^ADMIN([a-z0-9._-]+)-(.+)$/iu.exec(value);
    if (match) {
        return String(match[2] || '').trim();
    }

    return value;
}

function getLorebookNamingValidationError(name) {
    const value = String(name || '').trim();
    if (!value) {
        return 'Lorebook name cannot be empty.';
    }
    if (/^dd-/u.test(value)) {
        return /^dd-[a-z0-9._-]+-.+/u.test(value)
            ? ''
            : 'This lorebook name causes interference and must be renamed. Allowed prefixes are plain names, dd-{user-handle}-{BookName}, ADMIN-{BookName}, or ADMIN{user-handle}-{BookName}.';
    }
    if (/^ADMIN/u.test(value) || /^admin/u.test(value)) {
        return isAdminPrefixedLorebookName(value)
            ? ''
            : 'This lorebook name causes interference and must be renamed. Allowed prefixes are plain names, dd-{user-handle}-{BookName}, ADMIN-{BookName}, or ADMIN{user-handle}-{BookName}.';
    }
    return '';
}

function getSubmissionLorebookNamingValidationError(name) {
    const value = String(name || '').trim();
    const genericError = getLorebookNamingValidationError(value);
    if (genericError) return genericError;
    if (!value) return '';

    const currentHandle = String(getCurrentUserHandle() || '').trim().toLowerCase();
    const currentUserIsAdmin = Boolean(isAdmin());

    if (value.startsWith('dd-') && !currentUserIsAdmin) {
        if (!currentHandle || !value.startsWith(`dd-${currentHandle}-`)) {
            return `Your lorebook name must use your own dd-${currentHandle || '{user-handle}'}- prefix or stay plain before submission.`;
        }
    }

    if (isAdminPrefixedLorebookName(value)) {
        if (!currentUserIsAdmin) {
            return 'Only admins can submit lorebooks with ADMIN prefixes.';
        }
        if (currentHandle && currentHandle !== 'default-user') {
            const expectedPrefix = `ADMIN${currentHandle}-`;
            if (!value.startsWith(expectedPrefix)) {
                return `Admin submissions to the true admin must use the ${expectedPrefix}{BookName} naming convention.`;
            }
        }
    }

    return '';
}

function isPotentialHiddenPushWorldName(name) {
    const worldName = normalizeHiddenLorebookName(name);
    if (!worldName) return false;
    const normalizedWorldName = worldName.toLowerCase();
    return normalizedWorldName.startsWith('admin-') || normalizedWorldName.startsWith('dd-') || isAdminPrefixedLorebookName(worldName);
}

function isTrueishFlag(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function isHiddenLorebookRestrictedForUser(data, currentHandle) {
    const creatorHandle = String(
        data?._stwii_lorebook_creator
        || getWorldInfoExtensionBySuffix(data, 'creator')
        || '',
    ).trim().toLowerCase();
    const originalCreatorHandle = String(
        data?._stwii_lorebook_original_creator
        || getWorldInfoExtensionBySuffix(data, 'original_creator')
        || creatorHandle
        || '',
    ).trim().toLowerCase();
    const normalizedHandle = String(currentHandle || '').trim().toLowerCase();
    const isHidden = isTrueishFlag(data?._stwii_lorebook_hidden)
        || isTrueishFlag(getWorldInfoExtensionBySuffix(data, 'hidden'))
        || !!data?._dreamtavern_restricted
        || !!data?._stw_hidden_restricted;

    if (!isHidden) {
        return false;
    }

    if (creatorHandle && creatorHandle === normalizedHandle) {
        return false;
    }

    if (originalCreatorHandle && originalCreatorHandle === normalizedHandle) {
        return false;
    }

    return true;
}

function mapLoadedWorldInfoEntries(data, worldName) {
    if (!data?.entries) {
        return [];
    }

    const lorebookCreator = getWorldInfoExtensionBySuffix(data, 'creator') || '';
    const lorebookOriginalCreator = getWorldInfoExtensionBySuffix(data, 'original_creator') || lorebookCreator;
    const lorebookHidden = isTrueishFlag(getWorldInfoExtensionBySuffix(data, 'hidden'))
        || !!data?._dreamtavern_restricted
        || !!data?._stw_hidden_restricted;

    return Object.keys(data.entries)
        .map((key) => data.entries[key])
        .map(({ uid, ...rest }) => ({
            uid,
            world: worldName,
            _stwii_lorebook_hidden: lorebookHidden,
            _stwii_lorebook_creator: lorebookCreator,
            _stwii_lorebook_original_creator: lorebookOriginalCreator,
            _dreamtavern_restricted: !!data?._dreamtavern_restricted,
            _stw_hidden_restricted: !!data?._stw_hidden_restricted,
            ...rest,
        }));
}

function getRestrictedHiddenLoreContextForGeneration(chat, globalScanData) {
    /** @type {Set<string>} */
    const hiddenWorlds = new Set();
    const shouldIncludeHiddenWorld = (worldName) => {
        const normalizedWorldName = String(worldName || '').trim();
        if (!normalizedWorldName) return false;
        return isHiddenPushedLorebookForDropdown(normalizedWorldName)
            || isPotentialHiddenPushWorldName(normalizedWorldName);
    };

    const character = characters[this_chid];
    const primaryWorld = String(character?.data?.extensions?.world || '').trim();
    if (shouldIncludeHiddenWorld(primaryWorld)) {
        hiddenWorlds.add(primaryWorld);
    }

    const fileName = this_chid !== undefined && this_chid !== null ? getCharaFilename(this_chid) : '';
    for (const worldName of getCharacterAuxWorldBooks(character, fileName)) {
        if (shouldIncludeHiddenWorld(worldName)) {
            hiddenWorlds.add(worldName);
        }
    }

    for (const chatWorld of getChatLorebooks()) {
        if (shouldIncludeHiddenWorld(chatWorld)) {
            hiddenWorlds.add(chatWorld);
        }
    }

    const personaWorld = String(power_user.persona_description_lorebook || '').trim();
    if (shouldIncludeHiddenWorld(personaWorld)) {
        hiddenWorlds.add(personaWorld);
    }

    for (const selectedWorld of selected_world_info) {
        if (shouldIncludeHiddenWorld(selectedWorld)) {
            hiddenWorlds.add(selectedWorld);
        }
    }

    if (!hiddenWorlds.size) {
        return null;
    }

    return {
        hidden_world_names: [...hiddenWorlds],
        chat: [...chat],
        global_scan_data: { ...globalScanData },
    };
}

function isRestrictedHiddenWorldInfoEntry(entry, currentHandle = getCurrentUserHandle()) {
    if (!entry || typeof entry !== 'object') return false;

    const worldName = String(entry.world || '').trim();
    const normalizedWorldName = normalizeHiddenLorebookName(worldName);
    const isConventionHiddenBook = normalizedWorldName
        ? hidden_world_name_set.has(normalizedWorldName)
        : false;
    const isFlagHiddenBook = isHiddenLorebookRestrictedForUser(entry, currentHandle);

    return isConventionHiddenBook || isFlagHiddenBook;
}

function sanitizeWorldInfoEntryForClient(entry, currentHandle = getCurrentUserHandle()) {
    if (!entry || typeof entry !== 'object') return entry;
    if (!isRestrictedHiddenWorldInfoEntry(entry, currentHandle)) {
        return { ...entry };
    }

    return {
        uid: entry.uid,
        world: entry.world,
        disable: entry.disable,
        position: entry.position,
        role: entry.role,
        depth: entry.depth,
        outletName: entry.outletName,
        sticky: entry.sticky,
        cooldown: entry.cooldown,
        delay: entry.delay,
        constant: entry.constant,
        useProbability: entry.useProbability,
        probability: entry.probability,
        _stwii_source_world: entry._stwii_source_world,
        _stwii_lorebook_hidden: true,
        _stwii_redacted: true,
        _dreamtavern_restricted: true,
        _stw_hidden_restricted: true,
    };
}

function sanitizeWorldInfoEntryListForClient(entries, currentHandle = getCurrentUserHandle()) {
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => sanitizeWorldInfoEntryForClient(entry, currentHandle));
}

function sanitizeWorldInfoEntryMapForClient(entries, currentHandle = getCurrentUserHandle()) {
    if (!(entries instanceof Map)) return new Map();
    return new Map(
        Array.from(entries.entries()).map(([key, value]) => [key, sanitizeWorldInfoEntryForClient(value, currentHandle)]),
    );
}

function sanitizeWorldInfoScanDoneArgsForClient(args, currentHandle = getCurrentUserHandle()) {
    if (!args || typeof args !== 'object') return args;

    const sanitizedNewAll = sanitizeWorldInfoEntryListForClient(args.new?.all, currentHandle);
    const sanitizedNewSuccessful = sanitizeWorldInfoEntryListForClient(args.new?.successful, currentHandle);
    const sanitizedActivatedEntries = sanitizeWorldInfoEntryMapForClient(args.activated?.entries, currentHandle);
    const hasRestrictedHiddenLore = sanitizedNewAll.some((entry) => entry?._stwii_redacted)
        || sanitizedNewSuccessful.some((entry) => entry?._stwii_redacted)
        || Array.from(sanitizedActivatedEntries.values()).some((entry) => entry?._stwii_redacted);

    return {
        ...args,
        new: {
            ...args.new,
            all: sanitizedNewAll,
            successful: sanitizedNewSuccessful,
        },
        activated: {
            ...args.activated,
            entries: sanitizedActivatedEntries,
            text: hasRestrictedHiddenLore ? '[Redacted: hidden lorebook content]' : args.activated?.text,
        },
        sortedEntries: sanitizeWorldInfoEntryListForClient(args.sortedEntries, currentHandle),
    };
}

export function getServerHiddenLoreActivationsFromResponse(response) {
    const encoded = response?.headers?.get?.(HIDDEN_LORE_ACTIVATIONS_HEADER);
    if (!encoded) {
        return [];
    }

    try {
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        const decoded = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(decoded);
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .map((item) => {
                if (typeof item === 'string') {
                    const world = String(item || '').trim();
                    return world ? { world, count: 1 } : null;
                }

                if (!item || typeof item !== 'object') {
                    return null;
                }

                const world = String(item.world || item.name || '').trim();
                const count = Number(item.count);
                if (!world) {
                    return null;
                }

                return {
                    world,
                    count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1,
                };
            })
            .filter(Boolean);
    } catch (error) {
        console.warn('[WI] Failed to decode hidden lore activation header:', error);
        return [];
    }
}

export function clearServerHiddenLoreActivations() {
    delete chat_metadata.dreamtavernHiddenLoreActivationEntries;
    delete chat_metadata.stwiiLastAddedCount;
}

export async function emitServerHiddenLoreActivations(worldActivations) {
    const normalizedWorldActivations = (worldActivations || [])
        .map((item) => {
            if (typeof item === 'string') {
                const world = normalizeHiddenLorebookName(item);
                return world ? { world, count: 1 } : null;
            }

            if (!item || typeof item !== 'object') {
                return null;
            }

            const world = normalizeHiddenLorebookName(item.world || item.name || '');
            const count = Number(item.count);
            if (!world) {
                return null;
            }

            return {
                world,
                count: Number.isFinite(count) && count > 0 ? Math.max(1, Math.trunc(count)) : 1,
            };
        })
        .filter(Boolean);

    if (!normalizedWorldActivations.length) {
        return;
    }

    const entries = [];
    let totalOrder = 0;
    for (const { world, count } of normalizedWorldActivations) {
        for (let index = 0; index < count; index++) {
            entries.push({
                uid: `server_hidden_${totalOrder}_${index}_${getStringHash(`${world}:${index}`)}`,
                world: `9z${world}`,
                key: [],
                keysecondary: [],
                comment: '~(hidden entries)~',
                position: world_info_position.before,
                order: totalOrder,
                _stwii_source_world: world,
                _stwii_lorebook_hidden: true,
                _stwii_redacted: true,
                _dreamtavern_restricted: true,
                _stw_hidden_restricted: true,
            });
            totalOrder++;
        }
    }

    chat_metadata.stwiiLastAddedCount = entries.length;
    chat_metadata.dreamtavernHiddenLoreActivationEntries = entries.map(entry => ({ ...entry }));
    await eventSource.emit(event_types.WORLD_INFO_ACTIVATED, entries);
    ensureWiiPanelObserver();
}

function isPushedCharacterRecord(character) {
    if (!character) return false;
    const worldName = String(character?.data?.extensions?.world || '').trim().toLowerCase();
    if (isTrueishFlag(getCharacterPushExtensionBySuffix(character, 'pushed'))) return true;
    if (isAdminPrefixedLorebookName(worldName)) return true;
    if (worldName.startsWith('dd-')) return true;
    return false;
}

/**
 * Auto-link a pushed character to its hidden lorebook based on metadata.
 * Checks the existing world extension first; if missing or invalid,
 * searches world_names for a matching ADMIN-* or dd-* pattern.
 * @param {number} chid - Character index
 * @returns {boolean} True if the character is now linked to a lorebook
 */
function autoLinkPushedLorebook(chid) {
    const character = characters[chid];
    if (!character) return false;

    const currentWorld = String(character?.data?.extensions?.world || '').trim();
    if (currentWorld) {
        return true;
    }

    const exactPreferred = String(
        getCharacterPushExtensionBySuffix(character, 'pushed_lorebook_name')
        || getCharacterPushExtensionBySuffix(character, 'source_lorebook')
        || '',
    ).trim();
    if (exactPreferred && world_names.includes(exactPreferred)) {
        if (!character.data) character.data = {};
        if (!character.data.extensions) character.data.extensions = {};
        character.data.extensions.world = exactPreferred;
        console.log(`[AutoLink] Restored pushed character ${character.name || character.data?.name || chid} to exact lorebook: ${exactPreferred}`);
        return true;
    }

    const preferredCreator = normalizeHandleForPushLock(
        getCharacterPushExtensionBySuffix(character, 'creator')
        || getCharacterPushExtensionBySuffix(character, 'original_creator')
        || getCurrentUserHandle(),
    );
    const charName = String(character?.name || character?.data?.name || '').trim().toLowerCase();
    const candidates = Array.from(world_names || []).filter(Boolean).filter(worldName => {
        const name = String(worldName);
        return isAdminPrefixedLorebookName(name) || name.startsWith('dd-');
    });

    const preferred = candidates.find(worldName => {
        const lowered = String(worldName).toLowerCase();
        if (preferredCreator && lowered.startsWith(`dd-${preferredCreator}-`)) {
            return !charName || lowered.includes(charName);
        }
        return false;
    })
        || candidates.find(worldName => {
            const lowered = String(worldName).toLowerCase();
            return !!charName && lowered.includes(charName);
        })
        || candidates[0];

    if (!preferred) return false;

    if (!character.data) character.data = {};
    if (!character.data.extensions) character.data.extensions = {};
    character.data.extensions.world = preferred;
    console.log(`[AutoLink] Linked pushed character ${character.name || character.data?.name || chid} to lorebook: ${preferred}`);
    return true;
}

/**
 * Failsafe: ensure a pushed character's lorebook link is valid on character load.
 * If the link is broken or missing, attempt to re-link via autoLinkPushedLorebook.
 * @param {number} chid - Character index
 */
export function ensurePushedLoreBookLinked(chid) {
    const character = characters[chid];
    if (!character || !isPushedCharacterRecord(character)) return;

    const currentWorld = String(character?.data?.extensions?.world || '').trim();
    if (currentWorld) {
        setWorldInfoButtonClass(chid);
        return;
    }

    if (autoLinkPushedLorebook(chid)) {
        setWorldInfoButtonClass(chid);
    }
}
export let world_info_min_activations = 0; // if > 0, will continue seeking chat until minimum world infos are activated
export let world_info_min_activations_depth_max = 0; // used when (world_info_min_activations > 0)

export let world_info_budget = 25;
export let world_info_include_names = true;
export let world_info_recursive = false;
export let world_info_overflow_alert = false;
export let world_info_case_sensitive = false;
export let world_info_match_whole_words = false;
export let world_info_use_group_scoring = false;
export let world_info_character_strategy = world_info_insertion_strategy.character_first;
export let world_info_budget_cap = 0;
export let world_info_max_recursion_steps = 0;
const saveWorldDebounced = debounce(async (name, data) => await _save(name, data), debounce_timeout.relaxed);
const saveSettingsDebounced = debounce(() => {
    Object.assign(world_info, { globalSelect: selected_world_info });
    saveSettings();
}, debounce_timeout.relaxed);
const sortFn = (a, b) => b.order - a.order;
let updateEditor = (navigation, flashOnNav = true) => { console.debug('Triggered WI navigation', navigation, flashOnNav); };

// Do not optimize. updateEditor is a function that is updated by the displayWorldEntries with new data.
export const worldInfoFilter = new FilterHelper(() => updateEditor());
export const SORT_ORDER_KEY = 'world_info_sort_order';
export const METADATA_KEY = 'world_info';
const CHAT_LOREBOOK_LIMIT = 4;

function getChatLorebooks() {
    const rawValue = chat_metadata[METADATA_KEY];
    const availableWorlds = Array.isArray(world_names) ? world_names : [];
    const names = normalizeArray((Array.isArray(rawValue) ? rawValue : [rawValue])
        .map((name) => String(name || '').trim())
        .filter(Boolean));
    return names.filter((name) => availableWorlds.includes(name));
}

function getVisibleChatLorebooks() {
    return getChatLorebooks()
        .filter((name) => !isHiddenPushedLorebookForDropdown(name))
        .slice(0, CHAT_LOREBOOK_LIMIT);
}

function getHiddenChatLorebooks() {
    return getChatLorebooks()
        .filter((name) => isHiddenPushedLorebookForDropdown(name));
}

function getPrimaryChatLorebook() {
    return getChatLorebooks()[0] ?? '';
}

function getPrimaryVisibleChatLorebook() {
    return getVisibleChatLorebooks()[0] ?? '';
}

function setChatLorebooks(names, { preserveHidden = true } = {}) {
    const visible = normalizeArray((Array.isArray(names) ? names : [names])
        .map((name) => String(name || '').trim())
        .filter(Boolean))
        .filter((name) => !isHiddenPushedLorebookForDropdown(name))
        .slice(0, CHAT_LOREBOOK_LIMIT);
    const hidden = preserveHidden ? getHiddenChatLorebooks() : [];
    const next = normalizeArray([...visible, ...hidden]);

    if (next.length === 0) {
        delete chat_metadata[METADATA_KEY];
    } else if (next.length === 1) {
        chat_metadata[METADATA_KEY] = next[0];
    } else {
        chat_metadata[METADATA_KEY] = next;
    }

    $('.chat_lorebook_button').toggleClass('world_set', next.length > 0);
}

export const DEFAULT_DEPTH = 4;
export const DEFAULT_WEIGHT = 100;
export const MAX_SCAN_DEPTH = 1000;
const MAX_COMMENT_LENGTH = 100;
const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'];

// Typedef area
/**
 * @typedef {object} WIGlobalScanData The chat-independent data to be scanned. Each of
 *     these fields can be enabled for scanning per entry.
 * @property {string} personaDescription User persona description
 * @property {string} characterDescription Character description
 * @property {string} characterPersonality Character personality
 * @property {string} characterDepthPrompt Character depth prompt (sometimes referred to as character notes)
 * @property {string} scenario Character defined scenario
 * @property {string} creatorNotes Character creator notes
 * @property {string} trigger The type that triggered the scan, e.g. 'normal', 'continue', etc.
 */

/**
 * @typedef {object} WIScanEntry The entry that triggered the scan
 * @property {number} [scanDepth] The depth of the scan
 * @property {boolean} [caseSensitive] If the scan is case sensitive
 * @property {boolean} [matchWholeWords] If the scan should match whole words
 * @property {boolean} [useGroupScoring] If the scan should use group scoring
 * @property {boolean} [matchPersonaDescription] If the scan should match against the persona description
 * @property {boolean} [matchCharacterDescription] If the scan should match against the character description
 * @property {boolean} [matchCharacterPersonality] If the scan should match against the character personality
 * @property {boolean} [matchCharacterDepthPrompt] If the scan should match against the character depth prompt
 * @property {boolean} [matchScenario] If the scan should match against the character scenario
 * @property {boolean} [matchCreatorNotes] If the scan should match against the creator notes
 * @property {number} [uid] The UID of the entry that triggered the scan
 * @property {string} [world] The world info book of origin of the entry
 * @property {string[]} [key] The primary keys to scan for
 * @property {string[]} [keysecondary] The secondary keys to scan for
 * @property {number} [selectiveLogic] The logic to use for selective activation
 * @property {number} [sticky] The sticky value of the entry
 * @property {number} [cooldown] The cooldown of the entry
 * @property {number} [delay] The delay of the entry
 * @property {string[]} [decorators] Array of decorators for the entry
 * @property {number} [hash] The hash of the entry
 */

/**
 * @typedef {object} WITimedEffect Timed effect for world info
 * @property {number} hash Hash of the entry that triggered the effect
 * @property {number} start The chat index where the effect starts
 * @property {number} end The chat index where the effect ends
 * @property {boolean} protected The protected effect can't be removed if the chat does not advance
 */

/**
 * @typedef TimedEffectType Type of timed effect
 * @type {'sticky'|'cooldown'|'delay'}
 */

/**
 * @typedef {object} WIPromptResult
 * @property {string} worldInfoString - Complete world info string
 * @property {string} worldInfoBefore - World info that goes before the prompt
 * @property {string} worldInfoAfter - World info that goes after the prompt
 * @property {Array} worldInfoExamples - Array of example entries
 * @property {Array} worldInfoDepth - Array of depth entries
 * @property {Array} anBefore - Array of entries before Author's Note
 * @property {Array} anAfter - Array of entries after Author's Note
 * @property {{[key: string]: string[]}} outletEntries - Array of entries to be added to an outlet
 */

/**
 * @typedef {object} WIActivated
 * @property {string} worldInfoBefore The world info before the chat.
 * @property {string} worldInfoAfter The world info after the chat.
 * @property {any[]} EMEntries The entries for examples.
 * @property {any[]} WIDepthEntries The depth entries.
 * @property {any[]} ANBeforeEntries The entries before Author's Note.
 * @property {any[]} ANAfterEntries The entries after Author's Note.
 * @property {{[key: string]: string[]}} outletEntries - Array of entries to be added to an outlet
 * @property {Set<any>} allActivatedEntries All entries.
 */

/**
 * @typedef {object} WIEntryFieldDefinition
 * @property {any} default - Default value for the field
 * @property {string} type - Type of the field, can be 'string', 'number', 'boolean', 'array', 'enum'
 * @property {boolean} [excludeFromTemplate=false] - Whether to exclude this field from the template
 * @property {(value: any) => boolean} [arrayFilter] - Optional filter function for array fields to filter out unwanted values
 */
// End typedef area

/** @type {Readonly<WIGlobalScanData>} */
const defaultGlobalScanData = Object.freeze({
    trigger: 'normal',
    personaDescription: '',
    characterDescription: '',
    characterPersonality: '',
    characterDepthPrompt: '',
    scenario: '',
    creatorNotes: '',
});

/**
 * Represents a scanning buffer for one evaluation of World Info.
 */
class WorldInfoBuffer {
    /**
     * @type {Map<string, object>} Map of entries that need to be activated no matter what
     */
    static externalActivations = new Map();

    /**
     * @type {WIGlobalScanData} Chat independent data to be scanned, such as persona and character descriptions
     */
    #globalScanData = null;

    /**
     * @type {string[]} Array of messages sorted by ascending depth
     */
    #depthBuffer = [];

    /**
     * @type {string[]} Array of strings added by recursive scanning
     */
    #recurseBuffer = [];

    /**
     * @type {string[]} Array of strings added by prompt injections that are valid for the current scan
     */
    #injectBuffer = [];

    /**
     * @type {number} The skew of the global scan depth. Used in "min activations"
     */
    #skew = 0;

    /**
     * @type {number} The starting depth of the global scan depth.
     */
    #startDepth = 0;

    /**
     * Initialize the buffer with the given messages.
     * @param {string[]} messages Array of messages to add to the buffer
     * @param {WIGlobalScanData} globalScanData Chat independent context to be scanned
     */
    constructor(messages, globalScanData) {
        this.#initDepthBuffer(messages);
        this.#globalScanData = globalScanData;
    }

    /**
     * Populates the buffer with the given messages.
     * @param {string[]} messages Array of messages to add to the buffer
     * @returns {void} Hardly seen nothing down here
     */
    #initDepthBuffer(messages) {
        for (let depth = 0; depth < MAX_SCAN_DEPTH; depth++) {
            if (messages[depth]) {
                this.#depthBuffer[depth] = messages[depth].trim();
            }
            // break if last message is reached
            if (depth === messages.length - 1) {
                break;
            }
        }
    }

    /**
     * Gets a string that respects the case sensitivity setting
     * @param {string} str The string to transform
     * @param {WIScanEntry} entry The entry that triggered the scan
     * @returns {string} The transformed string
    */
    #transformString(str, entry) {
        const caseSensitive = entry.caseSensitive ?? world_info_case_sensitive;
        return caseSensitive ? str : str.toLowerCase();
    }

    /**
     * Gets all messages up to the given depth + recursion buffer.
     * @param {WIScanEntry} entry The entry that triggered the scan
     * @param {number} scanState The state of the scan
     * @returns {string} A slice of buffer until the given depth (inclusive)
     */
    get(entry, scanState) {
        let depth = entry.scanDepth ?? this.getDepth();
        if (depth <= this.#startDepth) {
            return '';
        }

        if (depth < 0) {
            console.error(`[WI] Invalid WI scan depth ${depth}. Must be >= 0`);
            return '';
        }

        if (depth > MAX_SCAN_DEPTH) {
            console.warn(`[WI] Invalid WI scan depth ${depth}. Truncating to ${MAX_SCAN_DEPTH}`);
            depth = MAX_SCAN_DEPTH;
        }

        const MATCHER = '\x01';
        const JOINER = '\n' + MATCHER;
        let result = MATCHER + this.#depthBuffer.slice(this.#startDepth, depth).join(JOINER);

        if (entry.matchPersonaDescription && this.#globalScanData.personaDescription) {
            result += JOINER + this.#globalScanData.personaDescription;
        }
        if (entry.matchCharacterDescription && this.#globalScanData.characterDescription) {
            result += JOINER + this.#globalScanData.characterDescription;
        }
        if (entry.matchCharacterPersonality && this.#globalScanData.characterPersonality) {
            result += JOINER + this.#globalScanData.characterPersonality;
        }
        if (entry.matchCharacterDepthPrompt && this.#globalScanData.characterDepthPrompt) {
            result += JOINER + this.#globalScanData.characterDepthPrompt;
        }
        if (entry.matchScenario && this.#globalScanData.scenario) {
            result += JOINER + this.#globalScanData.scenario;
        }
        if (entry.matchCreatorNotes && this.#globalScanData.creatorNotes) {
            result += JOINER + this.#globalScanData.creatorNotes;
        }

        if (this.#injectBuffer.length > 0) {
            result += JOINER + this.#injectBuffer.join(JOINER);
        }

        // Min activations should not include the recursion buffer
        if (this.#recurseBuffer.length > 0 && scanState !== scan_state.MIN_ACTIVATIONS) {
            result += JOINER + this.#recurseBuffer.join(JOINER);
        }

        return result;
    }

    /**
     * Matches the given string against the buffer.
     * @param {string} haystack The string to search in
     * @param {string} needle The string to search for
     * @param {WIScanEntry} entry The entry that triggered the scan
     * @returns {boolean} True if the string was found in the buffer
     */
    matchKeys(haystack, needle, entry) {
        // If the needle is a regex, we do regex pattern matching and override all the other options
        const keyRegex = parseRegexFromString(needle);
        if (keyRegex) {
            return keyRegex.test(haystack);
        }

        // Otherwise we do normal matching of plaintext with the chosen entry settings
        haystack = this.#transformString(haystack, entry);
        const transformedString = this.#transformString(needle, entry);
        const matchWholeWords = entry.matchWholeWords ?? world_info_match_whole_words;

        if (matchWholeWords) {
            const keyWords = transformedString.split(/\s+/);

            if (keyWords.length > 1) {
                return haystack.includes(transformedString);
            }
            else {
                // Use custom boundaries to include punctuation and other non-alphanumeric characters
                const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformedString)})(?:$|\\W)`);
                if (regex.test(haystack)) {
                    return true;
                }
            }
        } else {
            return haystack.includes(transformedString);
        }

        return false;
    }

    /**
     * Adds a message to the recursion buffer.
     * @param {string} message The message to add
     */
    addRecurse(message) {
        this.#recurseBuffer.push(message);
    }

    /**
     * Adds an injection to the buffer.
     * @param {string} message The injection to add
     */
    addInject(message) {
        this.#injectBuffer.push(message);
    }

    /**
     * Checks if the recursion buffer is not empty.
     * @returns {boolean} Returns true if the recursion buffer is not empty, otherwise false
     */
    hasRecurse() {
        return this.#recurseBuffer.length > 0;
    }

    /**
     * Increments skew to advance the scan range.
     */
    advanceScan() {
        this.#skew++;
    }

    /**
     * @returns {number} Settings' depth + current skew.
     */
    getDepth() {
        return world_info_depth + this.#skew;
    }

    /**
     * Get the externally activated version of the entry, if there is one.
     * @param {object} entry WI entry to check
     * @returns {object|undefined} the external version if the entry is forcefully activated, undefined otherwise
     */
    getExternallyActivated(entry) {
        return WorldInfoBuffer.externalActivations.get(`${entry.world}.${entry.uid}`);
    }

    /**
     * Clean-up the external effects for entries.
     */
    resetExternalEffects() {
        WorldInfoBuffer.externalActivations = new Map();
    }

    /**
     * Gets the match score for the given entry.
     * @param {WIScanEntry} entry Entry to check
     * @param {number} scanState The state of the scan
     * @returns {number} The number of key activations for the given entry
     */
    getScore(entry, scanState) {
        const bufferState = this.get(entry, scanState);
        let numberOfPrimaryKeys = 0;
        let numberOfSecondaryKeys = 0;
        let primaryScore = 0;
        let secondaryScore = 0;

        // Increment score for every key found in the buffer
        if (Array.isArray(entry.key)) {
            numberOfPrimaryKeys = entry.key.length;
            for (const key of entry.key) {
                if (this.matchKeys(bufferState, key, entry)) {
                    primaryScore++;
                }
            }
        }

        // Increment score for every secondary key found in the buffer
        if (Array.isArray(entry.keysecondary)) {
            numberOfSecondaryKeys = entry.keysecondary.length;
            for (const key of entry.keysecondary) {
                if (this.matchKeys(bufferState, key, entry)) {
                    secondaryScore++;
                }
            }
        }

        // No keys == no score
        if (!numberOfPrimaryKeys) {
            return 0;
        }

        // Only positive logic influences the score
        if (numberOfSecondaryKeys > 0) {
            switch (entry.selectiveLogic) {
                // AND_ANY: Add both scores
                case world_info_logic.AND_ANY:
                    return primaryScore + secondaryScore;
                // AND_ALL: Add both scores if all secondary keys are found, otherwise only primary score
                case world_info_logic.AND_ALL:
                    return secondaryScore === numberOfSecondaryKeys ? primaryScore + secondaryScore : primaryScore;
            }
        }

        return primaryScore;
    }
}

/**
 * Represents a timed effects manager for World Info.
 */
class WorldInfoTimedEffects {
    /**
     * Array of chat messages.
     * @type {string[]}
     */
    #chat = [];

    /**
     * Array of entries.
     * @type {WIScanEntry[]}
     */
    #entries = [];

    /**
     * Is this a dry run?
     * @type {boolean}
     */
    #isDryRun = false;

    /**
     * Buffer for active timed effects.
     * @type {Record<TimedEffectType, WIScanEntry[]>}
     */
    #buffer = {
        'sticky': [],
        'cooldown': [],
        'delay': [],
    };

    /**
     * Callbacks for effect types ending.
     * @type {Record<TimedEffectType, (entry: WIScanEntry) => void>}
     */
    #onEnded = {
        /**
         * Callback for when a sticky entry ends.
         * Sets an entry on cooldown immediately if it has a cooldown.
         * @param {WIScanEntry} entry Entry that ended sticky
         */
        'sticky': (entry) => {
            if (!entry.cooldown) {
                return;
            }

            const key = this.#getEntryKey(entry);
            const effect = this.#getEntryTimedEffect('cooldown', entry, true);
            chat_metadata.timedWorldInfo.cooldown[key] = effect;
            console.log(`[WI] Adding cooldown entry ${key} on ended sticky: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`);
            // Set the cooldown immediately for this evaluation
            this.#buffer.cooldown.push(entry);
        },

        /**
         * Callback for when a cooldown entry ends.
         * No-op, essentially.
         * @param {WIScanEntry} entry Entry that ended cooldown
         */
        'cooldown': (entry) => {
            console.debug('[WI] Cooldown ended for entry', entry.uid);
        },

        'delay': () => { },
    };

    /**
     * Initialize the timed effects with the given messages.
     * @param {string[]} chat Array of chat messages
     * @param {WIScanEntry[]} entries Array of entries
     * @param {boolean} isDryRun Whether the operation is a dry run
     */
    constructor(chat, entries, isDryRun = false) {
        this.#chat = chat;
        this.#entries = entries;
        this.#isDryRun = isDryRun;
        this.#ensureChatMetadata();
    }

    /**
     * Verify correct structure of chat metadata.
     */
    #ensureChatMetadata() {
        if (!chat_metadata.timedWorldInfo) {
            chat_metadata.timedWorldInfo = {};
        }

        ['sticky', 'cooldown'].forEach(type => {
            // Ensure the property exists and is an object
            if (!chat_metadata.timedWorldInfo[type] || typeof chat_metadata.timedWorldInfo[type] !== 'object') {
                chat_metadata.timedWorldInfo[type] = {};
            }

            // Clean up invalid entries
            Object.entries(chat_metadata.timedWorldInfo[type]).forEach(([key, value]) => {
                if (!value || typeof value !== 'object') {
                    delete chat_metadata.timedWorldInfo[type][key];
                }
            });
        });
    }

    /**
    * Gets a hash for a WI entry.
    * @param {WIScanEntry} entry WI entry
    * @returns {number} String hash
    */
    #getEntryHash(entry) {
        return entry.hash;
    }

    /**
     * Gets a unique-ish key for a WI entry.
     * @param {WIScanEntry} entry WI entry
     * @returns {string} String key for the entry
     */
    #getEntryKey(entry) {
        return `${entry.world}.${entry.uid}`;
    }

    /**
     * Gets a timed effect for a WI entry.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry
     * @param {boolean} isProtected If the effect should be protected
     * @returns {WITimedEffect} Timed effect for the entry
     */
    #getEntryTimedEffect(type, entry, isProtected) {
        return {
            hash: this.#getEntryHash(entry),
            start: this.#chat.length,
            end: this.#chat.length + Number(entry[type]),
            protected: !!isProtected,
        };
    }

    /**
     * Processes entries for a given type of timed effect.
     * @param {TimedEffectType} type Identifier for the type of timed effect
     * @param {WIScanEntry[]} buffer Buffer to store the entries
     * @param {(entry: WIScanEntry) => void} onEnded Callback for when a timed effect ends
     */
    #checkTimedEffectOfType(type, buffer, onEnded) {
        /** @type {[string, WITimedEffect][]} */
        const effects = Object.entries(chat_metadata.timedWorldInfo[type]);
        for (const [key, value] of effects) {
            console.log(`[WI] Processing ${type} entry ${key}`, value);
            const entry = this.#entries.find(x => String(this.#getEntryHash(x)) === String(value.hash));

            if (this.#chat.length <= Number(value.start) && !value.protected) {
                console.log(`[WI] Removing ${type} entry ${key} from timedWorldInfo: chat not advanced`, value);
                delete chat_metadata.timedWorldInfo[type][key];
                continue;
            }

            // Missing entries (they could be from another character's lorebook)
            if (!entry) {
                if (this.#chat.length >= Number(value.end)) {
                    console.log(`[WI] Removing ${type} entry from timedWorldInfo: entry not found and interval passed`, entry);
                    delete chat_metadata.timedWorldInfo[type][key];
                }
                continue;
            }

            // Ignore invalid entries (not configured for timed effects)
            if (!entry[type]) {
                console.log(`[WI] Removing ${type} entry from timedWorldInfo: entry not ${type}`, entry);
                delete chat_metadata.timedWorldInfo[type][key];
                continue;
            }

            if (this.#chat.length >= Number(value.end)) {
                console.log(`[WI] Removing ${type} entry from timedWorldInfo: ${type} interval passed`, entry);
                delete chat_metadata.timedWorldInfo[type][key];
                if (typeof onEnded === 'function') {
                    onEnded(entry);
                }
                continue;
            }

            buffer.push(entry);
            console.log(`[WI] Timed effect "${type}" applied to entry`, entry);
        }
    }

    /**
     * Processes entries for the "delay" timed effect.
     * @param {WIScanEntry[]} buffer Buffer to store the entries
     */
    #checkDelayEffect(buffer) {
        for (const entry of this.#entries) {
            if (!entry.delay) {
                continue;
            }

            if (this.#chat.length < entry.delay) {
                buffer.push(entry);
                console.log('[WI] Timed effect "delay" applied to entry', entry);
            }
        }

    }

    /**
     * Checks for timed effects on chat messages.
     */
    checkTimedEffects() {
        if (!this.#isDryRun) {
            this.#checkTimedEffectOfType('sticky', this.#buffer.sticky, this.#onEnded.sticky.bind(this));
            this.#checkTimedEffectOfType('cooldown', this.#buffer.cooldown, this.#onEnded.cooldown.bind(this));
        }
        this.#checkDelayEffect(this.#buffer.delay);
    }

    /**
     * Gets raw timed effect metadatum for a WI entry.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry
     * @returns {WITimedEffect} Timed effect for the entry
     */
    getEffectMetadata(type, entry) {
        if (!this.isValidEffectType(type)) {
            return null;
        }

        const key = this.#getEntryKey(entry);
        return chat_metadata.timedWorldInfo[type][key];
    }

    /**
     * Sets a timed effect for a WI entry.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry to check
     */
    #setTimedEffectOfType(type, entry) {
        // Skip if entry does not have the type (sticky or cooldown)
        if (!entry[type]) {
            return;
        }

        const key = this.#getEntryKey(entry);

        if (!chat_metadata.timedWorldInfo[type][key]) {
            const effect = this.#getEntryTimedEffect(type, entry, false);
            chat_metadata.timedWorldInfo[type][key] = effect;

            console.log(`[WI] Adding ${type} entry ${key}: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`);
        }
    }

    /**
     * Sets timed effects on chat messages.
     * @param {WIScanEntry[]} activatedEntries Entries that were activated
     */
    setTimedEffects(activatedEntries) {
        if (this.#isDryRun) return;
        for (const entry of activatedEntries) {
            this.#setTimedEffectOfType('sticky', entry);
            this.#setTimedEffectOfType('cooldown', entry);
        }
    }

    /**
     * Force set a timed effect for a WI entry.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry
     * @param {boolean} newState The state of the effect
     */
    setTimedEffect(type, entry, newState) {
        if (!this.isValidEffectType(type)) {
            return;
        }
        if (this.#isDryRun && type !== 'delay') {
            return;
        }

        const key = this.#getEntryKey(entry);
        delete chat_metadata.timedWorldInfo[type][key];

        if (newState) {
            const effect = this.#getEntryTimedEffect(type, entry, false);
            chat_metadata.timedWorldInfo[type][key] = effect;
            console.log(`[WI] Adding ${type} entry ${key}: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`);
        }
    }

    /**
     * Check if the string is a valid timed effect type.
     * @param {string} type Name of the timed effect
     * @returns {boolean} Is recognized type
     */
    isValidEffectType(type) {
        return typeof type === 'string' && ['sticky', 'cooldown', 'delay'].includes(type.trim().toLowerCase());
    }

    /**
     * Check if the current entry is sticky activated.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry to check
     * @returns {boolean} True if the entry is active
     */
    isEffectActive(type, entry) {
        if (!this.isValidEffectType(type)) {
            return false;
        }

        return this.#buffer[type]?.some(x => this.#getEntryHash(x) === this.#getEntryHash(entry)) ?? false;
    }

    /**
     * Clean-up previously set timed effects.
     */
    cleanUp() {
        for (const buffer of Object.values(this.#buffer)) {
            buffer.splice(0, buffer.length);
        }
    }
}

export function getWorldInfoSettings() {
    return {
        world_info,
        world_info_depth,
        world_info_min_activations,
        world_info_min_activations_depth_max,
        world_info_budget,
        world_info_include_names,
        world_info_recursive,
        world_info_overflow_alert,
        world_info_case_sensitive,
        world_info_match_whole_words,
        world_info_character_strategy,
        world_info_budget_cap,
        world_info_use_group_scoring,
        world_info_max_recursion_steps,
    };
}

/**
 * Updates the world info settings.
 * @param {WorldInfoSettings} settings - Settings object
 * @param {string[]} [activeWorldInfo] - Optional array of active world info names
 */
export function updateWorldInfoSettings(settings, activeWorldInfo) {
    console.debug('[WI] Updating world info settings', settings, activeWorldInfo);

    /** @type {Record<keyof WorldInfoSettings, (value: any) => void>} */
    const fields = {
        world_info_depth: (value) => world_info_depth = Number(value),
        world_info_min_activations: (value) => world_info_min_activations = Number(value),
        world_info_min_activations_depth_max: (value) => world_info_min_activations_depth_max = Number(value),
        world_info_budget: (value) => world_info_budget = Number(value),
        world_info_include_names: (value) => world_info_include_names = Boolean(value),
        world_info_recursive: (value) => world_info_recursive = Boolean(value),
        world_info_overflow_alert: (value) => world_info_overflow_alert = Boolean(value),
        world_info_case_sensitive: (value) => world_info_case_sensitive = Boolean(value),
        world_info_match_whole_words: (value) => world_info_match_whole_words = Boolean(value),
        world_info_character_strategy: (value) => world_info_character_strategy = Number(value),
        world_info_budget_cap: (value) => world_info_budget_cap = Number(value),
        world_info_use_group_scoring: (value) => world_info_use_group_scoring = Boolean(value),
        world_info_max_recursion_steps: (value) => world_info_max_recursion_steps = Number(value),
        // Unused
        world_info: (_value) => {},
    };

    for (const [key, setter] of Object.entries(fields)) {
        if (Object.hasOwn(settings, key)) {
            setter(settings[key]);
        }
    }

    if (Array.isArray(activeWorldInfo)) {
        delete settings.world_info;
        selected_world_info = activeWorldInfo;
    }

    saveSettingsDebounced();
}

export const world_info_position = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
};

export const wi_anchor_position = {
    before: 0,
    after: 1,
};

/**
 * The cache of all world info data that was loaded from the backend.
 *
 * Calling `loadWorldInfo` will fill this cache and utilize this cache, so should be the preferred way to load any world info data.
 * Only use the cache directly if you need synchronous access.
 *
 * This will return a deep clone of the data, so no way to modify the data without actually saving it.
 * Should generally be only used for readonly access.
 *
 * @type {StructuredCloneMap<string,object>}
 * */
export const worldInfoCache = new StructuredCloneMap({ cloneOnGet: true, cloneOnSet: false });

/**
 * MutationObserver that strips the "9z" prefix the WORLD_INFO_ACTIVATED
 * handler adds to hidden lorebook names.  The prefix is needed so the
 * WorldInfoInfo extension's built-in `isHiddenWorld()` recognises them,
 * but we don't want the raw "9z" to appear in the panel header.
 */
let _wiiObserverReady = false;
function ensureWiiPanelObserver() {
    if (_wiiObserverReady) return;
    const panel = document.querySelector('.stwii--panel');
    if (!panel) return; // extension not loaded yet – will retry on next emit
    _wiiObserverReady = true;

    const redactHiddenWorldHeader = (element) => {
        if (!element) return;
        const rawText = String(element.textContent || '').trim();
        const normalizedText = rawText.startsWith('9z') ? rawText.substring(2) : rawText;
        const sourceWorldName = normalizeHiddenLorebookName(
            element.dataset.hiddenLorebookSourceName || normalizedText,
        );
        if (!sourceWorldName || !isHiddenPushedLorebookForDropdown(sourceWorldName)) return;

        element.dataset.hiddenLorebookSourceName = sourceWorldName;
        element.dataset.hiddenLorebookRedacted = 'true';
        element.setAttribute('title', `${sourceWorldName} ~${HIDDEN_LOREBOOK_PLACEHOLDER}~`);

        if (element.dataset.hiddenLorebookRenderedName === sourceWorldName) return;

        const titleSpan = document.createElement('span');
        titleSpan.className = 'stwii-hidden-world-title';
        titleSpan.textContent = sourceWorldName;

        const noteSpan = document.createElement('span');
        noteSpan.className = 'stwii-hidden-world-note';
        noteSpan.textContent = `~${HIDDEN_LOREBOOK_PLACEHOLDER}~`;

        element.replaceChildren(titleSpan, noteSpan);
        element.dataset.hiddenLorebookRenderedName = sourceWorldName;
    };

    panel.querySelectorAll('.stwii--world').forEach(redactHiddenWorldHeader);

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.classList?.contains('stwii--world')) {
                    redactHiddenWorldHeader(node);
                }
                node.querySelectorAll?.('.stwii--world').forEach(redactHiddenWorldHeader);
            }
        }
    });
    observer.observe(panel, { childList: true, subtree: true });
}

/**
 * Gets the world info based on chat messages.
 * @param {string[]} chat - The chat messages to scan, in reverse order.
 * @param {number} maxContext - The maximum context size of the generation.
 * @param {boolean} isDryRun - If true, the function will not emit any events.
 * @param {WIGlobalScanData} globalScanData Chat independent context to be scanned
 * @returns {Promise<WIPromptResult>} The world info string and depth.
 */
export async function getWorldInfoPrompt(chat, maxContext, isDryRun, globalScanData) {
    let worldInfoString = '', worldInfoBefore = '', worldInfoAfter = '';
    let hasRestrictedHiddenLore = false;

    const activatedWorldInfo = await checkWorldInfo(chat, maxContext, isDryRun, globalScanData);
    worldInfoBefore = activatedWorldInfo.worldInfoBefore;
    worldInfoAfter = activatedWorldInfo.worldInfoAfter;
    worldInfoString = worldInfoBefore + worldInfoAfter;
    const loreExclusionInfo = activatedWorldInfo.loreExclusionInfo || {};
    const hiddenLoreContext = getRestrictedHiddenLoreContextForGeneration(chat, globalScanData);

    if (hiddenLoreContext?.hidden_world_names?.length) {
        hasRestrictedHiddenLore = true;
        worldInfoBefore = worldInfoBefore
            ? `${HIDDEN_LORE_BEFORE_PLACEHOLDER}\n${worldInfoBefore}`
            : HIDDEN_LORE_BEFORE_PLACEHOLDER;
        worldInfoAfter = worldInfoAfter
            ? `${worldInfoAfter}\n${HIDDEN_LORE_AFTER_PLACEHOLDER}`
            : HIDDEN_LORE_AFTER_PLACEHOLDER;
        worldInfoString = worldInfoBefore + worldInfoAfter;
    }

    if (!isDryRun && activatedWorldInfo.allActivatedEntries && activatedWorldInfo.allActivatedEntries.size > 0) {
        const arg = Array.from(activatedWorldInfo.allActivatedEntries.values()).map(entry => ({ ...entry }));
        const handle = getCurrentUserHandle();

        hasRestrictedHiddenLore = hasRestrictedHiddenLore || arg.some((entry) => {
            const worldName = entry.world || '';
            const normalizedWorldName = normalizeHiddenLorebookName(worldName);
            const isConventionHiddenBook = hidden_world_name_set.has(normalizedWorldName);
            const isFlagHiddenBook = isHiddenLorebookRestrictedForUser(entry, handle);
            return isConventionHiddenBook || isFlagHiddenBook;
        });

        // Prefix hidden lorebook names with "9z" so the WorldInfoInfo
        // extension's built-in isHiddenWorld() recognises them, but keep the
        // raw lorebook name in the event payload so each hidden book remains
        // its own group in the activation panel.
        for (const entry of arg) {
            const w = entry.world || '';
            const normalizedWorldName = normalizeHiddenLorebookName(w);
            const isConventionHiddenBook = hidden_world_name_set.has(normalizedWorldName);
            const isFlagHiddenBook = isHiddenLorebookRestrictedForUser(entry, handle);
            const isHiddenBook = isConventionHiddenBook || isFlagHiddenBook;
            if (isHiddenBook && !w.startsWith('9z')) {
                entry._stwii_source_world = normalizedWorldName;
                entry.world = '9z' + normalizedWorldName;
            }
        }
        // Ensure the panel observer is ready to strip the "9z" prefix
        // from displayed world-name headers after the extension renders.
        ensureWiiPanelObserver();

        const emittedEntries = sanitizeWorldInfoEntryListForClient(arg, handle);
        await eventSource.emit(event_types.WORLD_INFO_ACTIVATED, emittedEntries);
    }

    return {
        worldInfoString,
        worldInfoBefore,
        worldInfoAfter,
        hasRestrictedHiddenLore,
        hiddenLoreContext,
        worldInfoExamples: activatedWorldInfo.EMEntries ?? [],
        worldInfoDepth: activatedWorldInfo.WIDepthEntries ?? [],
        anBefore: activatedWorldInfo.ANBeforeEntries ?? [],
        anAfter: activatedWorldInfo.ANAfterEntries ?? [],
        outletEntries: activatedWorldInfo.outletEntries ?? {},
        loreExclusionInfo,
    };
}

export function setWorldInfoSettings(settings, data) {
    if (settings.world_info_depth !== undefined)
        world_info_depth = Number(settings.world_info_depth);
    if (settings.world_info_min_activations !== undefined)
        world_info_min_activations = Number(settings.world_info_min_activations);
    if (settings.world_info_min_activations_depth_max !== undefined)
        world_info_min_activations_depth_max = Number(settings.world_info_min_activations_depth_max);
    if (settings.world_info_budget !== undefined)
        world_info_budget = Number(settings.world_info_budget);
    if (settings.world_info_include_names !== undefined)
        world_info_include_names = Boolean(settings.world_info_include_names);
    if (settings.world_info_recursive !== undefined)
        world_info_recursive = Boolean(settings.world_info_recursive);
    if (settings.world_info_overflow_alert !== undefined)
        world_info_overflow_alert = Boolean(settings.world_info_overflow_alert);
    if (settings.world_info_case_sensitive !== undefined)
        world_info_case_sensitive = Boolean(settings.world_info_case_sensitive);
    if (settings.world_info_match_whole_words !== undefined)
        world_info_match_whole_words = Boolean(settings.world_info_match_whole_words);
    if (settings.world_info_character_strategy !== undefined)
        world_info_character_strategy = Number(settings.world_info_character_strategy);
    if (settings.world_info_budget_cap !== undefined)
        world_info_budget_cap = Number(settings.world_info_budget_cap);
    if (settings.world_info_use_group_scoring !== undefined)
        world_info_use_group_scoring = Boolean(settings.world_info_use_group_scoring);
    if (settings.world_info_max_recursion_steps !== undefined)
        world_info_max_recursion_steps = Number(settings.world_info_max_recursion_steps);

    // Migrate old settings
    if (world_info_budget > 100) {
        world_info_budget = 25;
    }

    if (world_info_use_group_scoring === undefined) {
        world_info_use_group_scoring = false;
    }

    // Reset selected world from old string and delete old keys
    // TODO: Remove next release
    const existingWorldInfo = settings.world_info;
    if (typeof existingWorldInfo === 'string') {
        delete settings.world_info;
        selected_world_info = [existingWorldInfo];
    } else if (Array.isArray(existingWorldInfo)) {
        delete settings.world_info;
        selected_world_info = existingWorldInfo;
    }

    world_info = settings.world_info ?? {};

    $('#world_info_depth_counter').val(world_info_depth);
    $('#world_info_depth').val(world_info_depth);

    $('#world_info_min_activations_counter').val(world_info_min_activations);
    $('#world_info_min_activations').val(world_info_min_activations);

    $('#world_info_min_activations_depth_max_counter').val(world_info_min_activations_depth_max);
    $('#world_info_min_activations_depth_max').val(world_info_min_activations_depth_max);

    $('#world_info_budget_counter').val(world_info_budget);
    $('#world_info_budget').val(world_info_budget);

    $('#world_info_include_names').prop('checked', world_info_include_names);
    $('#world_info_recursive').prop('checked', world_info_recursive);
    $('#world_info_overflow_alert').prop('checked', world_info_overflow_alert);
    $('#world_info_case_sensitive').prop('checked', world_info_case_sensitive);
    $('#world_info_match_whole_words').prop('checked', world_info_match_whole_words);
    $('#world_info_use_group_scoring').prop('checked', world_info_use_group_scoring);

    $(`#world_info_character_strategy option[value='${world_info_character_strategy}']`).prop('selected', true);
    $('#world_info_character_strategy').val(world_info_character_strategy);

    $('#world_info_budget_cap').val(world_info_budget_cap);
    $('#world_info_budget_cap_counter').val(world_info_budget_cap);

    $('#world_info_max_recursion_steps').val(world_info_max_recursion_steps);
    $('#world_info_max_recursion_steps_counter').val(world_info_max_recursion_steps);

    refreshWorldNameCaches(data);

    // Add to existing selected WI if it exists
    selected_world_info = selected_world_info.concat(settings.world_info?.globalSelect?.filter((e) => world_names.includes(e)) ?? []);

    if (world_names.length > 0) {
        $('#world_info').empty();
    }

    world_names.forEach((item, i) => {
        const displayName = getLorebookDropdownDisplayName(item);
        // Global activation dropdown: exclude hidden lorebooks from user-facing list.
        if (!isHiddenPushedLorebookForDropdown(item)) {
            const globalListOption = new Option(displayName, i.toString(), selected_world_info.includes(item), selected_world_info.includes(item));
            globalListOption.dataset.worldName = item;
            $('#world_info').append(globalListOption);
        }
        const editorListOption = new Option(displayName, i.toString());
        editorListOption.dataset.worldName = item;
        $('#world_editor_select').append(editorListOption);
    });

    $('#world_info_sort_order').val(accountStorage.getItem(SORT_ORDER_KEY) || '0');
    $('#world_info').trigger('change');
    $('#world_editor_select').trigger('change');

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        $('.chat_lorebook_button').toggleClass('world_set', getChatLorebooks().length > 0);
        // Pre-cache the world info data for the chat for quicker first prompt generation
        await getSortedEntries();
    });

    eventSource.on(event_types.WORLDINFO_FORCE_ACTIVATE, (entries) => {
        for (const entry of entries) {
            if (!Object.hasOwn(entry, 'world') || !Object.hasOwn(entry, 'uid')) {
                console.error('[WI] WORLDINFO_FORCE_ACTIVATE requires all entries to have both world and uid fields, entry IGNORED', entry);
            } else {
                WorldInfoBuffer.externalActivations.set(`${entry.world}.${entry.uid}`, entry);
                console.log('[WI] WORLDINFO_FORCE_ACTIVATE added entry', entry);
            }
        }
    });

    // Add slash commands
    registerWorldInfoSlashCommands();
}

/**
 * Reloads the editor with the specified world info file
 * @param {string} file - The file to load in the editor
 * @param {boolean} [loadIfNotSelected=false] - Indicates whether to load the file even if it's not currently selected
 */
export function reloadEditor(file, loadIfNotSelected = false) {
    const currentIndex = Number($('#world_editor_select').val());
    const selectedIndex = world_names.indexOf(file);
    if (selectedIndex !== -1 && (loadIfNotSelected || currentIndex === selectedIndex)) {
        $('#world_editor_select').val(selectedIndex).trigger('change');
    }
}

//MARK: regWISlashCommands
function registerWorldInfoSlashCommands() {
    /**
     * Gets a *rough* approximation of the current chat context.
     * Normally, it is provided externally by the prompt builder.
     * Don't use for anything critical!
     * @returns {string[]}
     */
    function getScanningChat() {
        return getContext().chat.filter(x => !x.is_system).map(x => x.mes);
    }

    async function getEntriesFromFile(file) {
        if (!file) {
            toastr.warning(t`Valid World Info file name is required`);
            return '';
        }

            // The "9z" prefix is added by the WORLD_INFO_ACTIVATED handler so the
            // WorldInfoInfo extension's built-in hidden-book logic can recognize
            // hidden lorebooks. Strip that UI-only marker before loading entries.
            const checkFile = normalizeHiddenLorebookName(file);
            const data = await loadWorldInfo(checkFile);

        if (!data || !('entries' in data)) {
                toastr.warning(t`Valid World Info file name is required`);
            return '';
        }

            if (data?._stw_hidden_restricted || isHiddenLorebookRestrictedForUser(data, getCurrentUserHandle())) return '';

        const entries = Object.values(data.entries);

        if (!entries || entries.length === 0) {
            console.debug(`[WorldInfo] Skipping empty World Info file: ${file}`);
            return '';
        }

        return entries;
    }

    /**
     * Gets the name of the persona-bound lorebook.
     * @param {import('./slash-commands/SlashCommand.js').NamedArguments} args Named arguments
     * @param {string} _unnamedArg not used
     * @returns {Promise<string>} The name of the persona-bound lorebook
     */
    async function getPersonaBookCallback({ name, create }, _unnamedArg) {
        let bookName = power_user.persona_description_lorebook || '';
        if (bookName) {
            return bookName;
        }

        if (isTrueBoolean(String(create))) {
            const newName = await createWorldWithName(name, `Persona Book ${name1}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 64));
            power_user.persona_description_lorebook = newName;
            setPersonaDescription();
            saveSettingsDebounced();
            return newName;
        }

        return '';
    }

    /**
     * Gets the name of the character-bound lorebook.
     * @param {import('./slash-commands/SlashCommand.js').NamedArguments} args Named arguments
     * @param {string} characterIdentifier Character name
     * @returns {Promise<string>} The name of the character-bound lorebook, a JSON string of the character's lorebooks, or an empty string
     */
    async function getCharBookCallback({ type, name, create }, characterIdentifier) {
        const context = getContext();
        if (context.groupId && !characterIdentifier) throw new Error('This command is not available in groups without providing a character name');
        type = String(type ?? '').trim().toLowerCase() || 'primary';
        characterIdentifier = String(characterIdentifier ?? '') || context.characters[context.characterId]?.avatar || null;
        const character = findChar({ name: characterIdentifier });
        if (!character) {
            toastr.error(t`Character not found.`);
            return '';
        }
        const books = [];
        if (type === 'all' || type === 'primary' && character.data?.extensions?.world) {
            books.push(character.data.extensions.world);
        }
        if (type === 'all' || type === 'additional') {
            const fileName = getCharaFilename(context.characters.indexOf(character));
            const extraCharLore = world_info.charLore?.find((e) => e.name === fileName);
            if (extraCharLore && Array.isArray(extraCharLore.extraBooks)) {
                books.push(...extraCharLore.extraBooks.filter(onlyUnique).filter(Boolean));
            }
        }

        if (isTrueBoolean(String(create)) && books.length === 0) {
            const newName = await createWorldWithName(name, `Character Book ${character.name}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 64));
            // Also assign the book now - additional if requested, otherwise as primary
            if (type === 'additional') {
                await charUpdateAddAuxWorld(character.avatar, newName);
            }
            else {
                await charUpdatePrimaryWorld(newName);
            }
            // Refresh UI, if needed
            setWorldInfoButtonClass(this_chid);
            books.push(newName);
        }

        return type === 'primary' ? (books[0] ?? '') : JSON.stringify(books.filter(onlyUnique).filter(Boolean));
    }

    /**
     * Gets the name of the chat-bound lorebook. Creates a new one if it doesn't exist.
     * @param {import('./slash-commands/SlashCommand.js').NamedArguments} args Named arguments
     * @returns {Promise<string>} The name of the chat-bound lorebook
     */
    async function getChatBookCallback(args) {
        const chatId = getCurrentChatId();

        if (!chatId) {
            toastr.warning(t`Open a chat to get a name of the chat-bound lorebook`);
            return '';
        }

        const chatWorld = getPrimaryChatLorebook();
        if (chatWorld) {
            return chatWorld;
        }

        if (isFalseBoolean(String(args.create))) {
            return '';
        }

        const name = await createWorldWithName(args.name, `Chat Book ${getCurrentChatId()}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 64));

        setChatLorebooks(name);
        await saveMetadata();
        return name;
    }

    async function createWorldWithName(possibleName = undefined, fallbackName = undefined) {
        let newName = (() => {
            // Use the provided name if it's not in use
            if (typeof possibleName === 'string') {
                const name = String(possibleName);
                if (world_names.includes(name)) {
                    throw new Error('This World Info file name is already in use');
                }
                return name;
            }

            // Replace non-alphanumeric characters with underscores, cut to 64 characters
            return fallbackName ?? `Lorebook (${uuidv4()})`;
        })();

        // Make sure the name is unique
        newName = getUniqueName(newName, world_names.includes.bind(world_names));

        await createNewWorldInfo(newName);
        return newName;
    }

    async function findBookEntryCallback(args, value) {
        const file = args.file;
        const field = args.field || 'key';

        const entries = await getEntriesFromFile(file);

        if (!entries) {
            return '';
        }

        if (typeof newWorldInfoEntryTemplate[field] === 'boolean') {
            const isTrue = isTrueBoolean(value);
            const isFalse = isFalseBoolean(value);

            if (isTrue) {
                value = String(true);
            }

            if (isFalse) {
                value = String(false);
            }
        }

        const fuse = new Fuse(entries, {
            keys: [{ name: field, weight: 1 }],
            includeScore: true,
            threshold: 0.3,
        });

        const results = fuse.search(value);

        if (!results || results.length === 0) {
            return '';
        }

        const result = results[0]?.item?.uid;

        if (result === undefined) {
            return '';
        }

        return result;
    }

    async function getEntryFieldCallback(args, uid) {
        const file = args.file;
        const field = args.field || 'content';
        const tags = getContext().tags;

        const entries = await getEntriesFromFile(file);

        if (!entries) {
            return '';
        }

        const entry = entries.find(x => String(x.uid) === String(uid));

        if (!entry) {
            toastr.warning('Valid UID is required');
            return '';
        }

        if (!Object.hasOwn(newWorldInfoEntryDefinition, field)) {
            toastr.warning('Valid field name is required');
            return '';
        }

        // handle special cases, otherwise execute default logic
        let fieldValue;
        switch (field) {
            case 'characterFilterNames':
                if (entry.characterFilter) {
                    fieldValue = entry.characterFilter.names;
                }
                break;
            case 'characterFilterTags':
                if (entry.characterFilter) {
                    if (!entry.characterFilter.tags) {
                        return '';
                    }
                    //Find the tag objects corresponding to each ID in the array, then return the names
                    fieldValue = tags.filter((tag) => entry.characterFilter.tags.includes(tag.id)).map((tag) => tag.name);
                }
                break;
            case 'characterFilterExclude':
                if (entry.characterFilter) {
                    fieldValue = entry.characterFilter.isExclude;
                }
                break;
            default:
                fieldValue = entry[field] ?? newWorldInfoEntryDefinition[field]?.default;
        }

        if (fieldValue === undefined) {
            return '';
        }

        if (Array.isArray(fieldValue)) {
            return JSON.stringify(fieldValue.map(x => substituteParams(x)));
        }

        return substituteParams(String(fieldValue));
    }

    async function createEntryCallback(args, content) {
        const file = args.file;
        const key = args.key;

        const data = await loadWorldInfo(file);

        if (!data || !('entries' in data)) {
            toastr.warning('Valid World Info file name is required');
            return '';
        }

        const entry = createWorldInfoEntry(file, data);

        if (key) {
            entry.key.push(key);
            entry.addMemo = true;
            entry.comment = key;
        }

        if (content) {
            entry.content = content;
        }

        await saveWorldInfo(file, data);
        reloadEditor(file);

        return String(entry.uid);
    }

    async function setEntryFieldCallback(args, value) {
        const file = args.file;
        const uid = args.uid;
        const field = args.field || 'content';
        const tags = getContext().tags;

        // characterFilter is an object with internal fields we need to access, which may also may be null and need to be populated
        const createCharacterFilterFieldObjectIfNeeded = (currentEntry) => {
            if (!currentEntry.characterFilter) {
                Object.assign(
                    currentEntry,
                    {
                        characterFilter: {
                            isExclude: false,
                            names: [],
                            tags: [],
                        },
                    },
                );
            }
        };

        if (value === undefined) {
            toastr.warning('Value is required');
            return '';
        }

        value = value.replace(/\\([{}|])/g, '$1');

        const data = await loadWorldInfo(file);

        if (!data || !('entries' in data)) {
            toastr.warning('Valid World Info file name is required');
            return '';
        }

        const entry = data.entries[uid];

        if (!entry) {
            toastr.warning('Valid UID is required');
            return '';
        }

        if (!Object.hasOwn(newWorldInfoEntryDefinition, field)) {
            toastr.warning('Valid field name is required');
            return '';
        }

        // Init a default value for the field if it does not exist
        if (!Object.hasOwn(entry, field)) {
            entry[field] = newWorldInfoEntryDefinition[field].default;
        }

        // Use an array filter if it exists for the field
        const arrayFilter = newWorldInfoEntryDefinition[field]?.arrayFilter || (() => true);

        // handle special cases, otherwise execute default logic
        let tagNames;
        let charNames;
        switch (field) {
            case 'characterFilterNames':
                createCharacterFilterFieldObjectIfNeeded(entry);
                charNames = parseStringArray(value);
                entry.characterFilter.names = charNames
                    .map((name) => getCharaFilename(null, { manualAvatarKey: findChar({ name, allowAvatar: true, preferCurrentChar: false, quiet: true })?.avatar }))
                    .filter(Boolean)
                    .filter(onlyUnique);
                setWIOriginalDataValue(data, uid, 'character_filter', entry.characterFilter);
                break;
            case 'characterFilterTags':
                createCharacterFilterFieldObjectIfNeeded(entry);
                tagNames = parseStringArray(value);
                //Find the tag objects corresponding to each name in the user array, then return an array of the corresponding IDs
                entry.characterFilter.tags = tags.filter((tag) => tagNames.includes(tag.name)).map((tag) => tag.id);
                setWIOriginalDataValue(data, uid, 'character_filter', entry.characterFilter);
                break;
            case 'characterFilterExclude':
                createCharacterFilterFieldObjectIfNeeded(entry);
                entry.characterFilter.isExclude = isTrueBoolean(value);
                setWIOriginalDataValue(data, uid, 'character_filter', entry.characterFilter);
                break;
            default:
                if (Array.isArray(entry[field])) {
                    entry[field] = parseStringArray(value).filter(arrayFilter);
                } else if (typeof entry[field] === 'boolean') {
                    entry[field] = isTrueBoolean(value);
                } else if (typeof entry[field] === 'number') {
                    entry[field] = Number(value);
                } else {
                    entry[field] = value;
                }

                if (originalWIDataKeyMap[field]) {
                    setWIOriginalDataValue(data, uid, originalWIDataKeyMap[field], entry[field]);
                }
        }

        await saveWorldInfo(file, data);
        reloadEditor(file);
        return '';
    }

    async function getTimedEffectCallback(args, value) {
        if (!getCurrentChatId()) {
            throw new Error('This command can only be used in chat');
        }

        const file = args.file;
        const uid = value;
        const effect = args.effect;

        const entries = await getEntriesFromFile(file);

        if (!entries) {
            return '';
        }

        /** @type {WIScanEntry} */
        const entry = structuredClone(entries.find(x => String(x.uid) === String(uid)));

        if (!entry) {
            toastr.warning('Valid UID is required');
            return '';
        }

        entry.world = file; // Required by the timed effects manager
        const chat = getScanningChat();
        const timedEffects = new WorldInfoTimedEffects(chat, [entry]);

        if (!timedEffects.isValidEffectType(effect)) {
            toastr.warning('Valid effect type is required');
            return '';
        }

        const data = timedEffects.getEffectMetadata(effect, entry);

        if (String(args.format).trim().toLowerCase() === ARGUMENT_TYPE.NUMBER) {
            return String(data ? (data.end - chat.length) : 0);
        }

        return String(!!data);
    }

    async function setTimedEffectCallback(args, value) {
        if (!getCurrentChatId()) {
            throw new Error('This command can only be used in chat');
        }

        const file = args.file;
        const uid = args.uid;
        const effect = args.effect;

        if (value === undefined) {
            toastr.warning('New state is required');
            return '';
        }

        const entries = await getEntriesFromFile(file);

        if (!entries) {
            return '';
        }

        /** @type {WIScanEntry} */
        const entry = structuredClone(entries.find(x => String(x.uid) === String(uid)));

        if (!entry) {
            toastr.warning('Valid UID is required');
            return '';
        }

        entry.world = file; // Required by the timed effects manager
        const chat = getScanningChat();
        const timedEffects = new WorldInfoTimedEffects(chat, [entry]);

        if (!timedEffects.isValidEffectType(effect)) {
            toastr.warning('Valid effect type is required');
            return '';
        }

        if (!entry[effect]) {
            toastr.warning('This entry does not have the selected effect. Configure it in the editor first.');
            return '';
        }

        const getNewEffectState = () => {
            const currentState = !!timedEffects.getEffectMetadata(effect, entry);

            if (['toggle', 't', ''].includes(value.trim().toLowerCase())) {
                return !currentState;
            }

            if (isTrueBoolean(value)) {
                return true;
            }

            if (isFalseBoolean(value)) {
                return false;
            }

            return currentState;
        };

        const newEffectState = getNewEffectState();
        timedEffects.setTimedEffect(effect, entry, newEffectState);

        await saveMetadata();
        toastr.success(`Timed effect "${effect}" for entry ${entry.uid} is now ${newEffectState ? 'active' : 'inactive'}`);

        return '';
    }

    /** A collection of local enum providers for this context of world info */
    const localEnumProviders = {
        /** All possible fields that can be set in a WI entry */
        wiEntryFields: () => Object.entries(newWorldInfoEntryDefinition).map(([key, value]) =>
            new SlashCommandEnumValue(key, `[${value.type}] default: ${(typeof value.default === 'string' ? `'${value.default}'` : JSON.stringify(value.default))}`,
                enumTypes.enum, enumIcons.getDataTypeIcon(value.type))),

        /** All existing UIDs based on the file argument as world name */
        wiUids: (/** @type {import('./slash-commands/SlashCommandExecutor.js').SlashCommandExecutor} */ executor) => {
            const file = executor.namedArgumentList.find(it => it.name == 'file')?.value;
            if (file instanceof SlashCommandClosure) throw new Error('Argument \'file\' does not support closures');
            // Try find world from cache
            if (!worldInfoCache.has(file)) return [];
            const world = worldInfoCache.get(file);
            if (!world) return [];
            return Object.entries(world.entries).map(([uid, data]) =>
                new SlashCommandEnumValue(uid, `${data.comment ? `${data.comment}: ` : ''}${data.key.join(', ')}${data.keysecondary?.length ? ` [${Object.entries(world_info_logic).find(([_, value]) => value == data.selectiveLogic)[0]}] ${data.keysecondary.join(', ')}` : ''} [${getWiPositionString(data)}]`,
                    enumTypes.enum, enumIcons.getWiStatusIcon(data)));
        },

        timedEffects: () => [
            new SlashCommandEnumValue('sticky', 'Stays active for N messages', enumTypes.enum, '📌'),
            new SlashCommandEnumValue('cooldown', 'Cooldown for N messages', enumTypes.enum, '⌛'),
        ],
    };

    function getWiPositionString(entry) {
        switch (entry.position) {
            case world_info_position.before: return '↑Char';
            case world_info_position.after: return '↓Char';
            case world_info_position.EMTop: return '↑EM';
            case world_info_position.EMBottom: return '↓EM';
            case world_info_position.ANTop: return '↑AT';
            case world_info_position.ANBottom: return '↓AT';
            case world_info_position.atDepth: return `@D${enumIcons.getRoleIcon(entry.role)}`;
            default: return '<Unknown>';
        }
    }

    async function getGlobalBooksCallback() {
        if (!selected_world_info?.length) {
            return JSON.stringify([]);
        }

        let entries = selected_world_info.slice();

        console.debug(`[WI] Selected global world info has ${entries.length} entries`, selected_world_info);

        return JSON.stringify(entries);
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'world',
        callback: onWorldInfoChange,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'state', 'set world state', [ARGUMENT_TYPE.STRING], false, false, null, commonEnumProviders.boolean('onOffToggle')(),
            ),
            new SlashCommandNamedArgument(
                'silent', 'suppress toast messages', [ARGUMENT_TYPE.BOOLEAN], false,
            ),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'world name',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.worlds,
            }),
        ],
        helpString: `
            <div>
                Sets active World, or unsets if no args provided, use <code>state=off</code> and <code>state=toggle</code> to deactivate or toggle a World, use <code>silent=true</code> to suppress toast messages.
            </div>
        `,
        aliases: [],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getchatbook',
        callback: getChatBookCallback,
        returns: 'lorebook name',
        helpString: 'Get a name of the chat-bound lorebook or create a new one if was unbound, and pass it down the pipe.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'lorebook name if creating a new one, will be auto-generated otherwise',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'create',
                description: 'create a new lorebook if it doesn\'t exist',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'true',
            }),
        ],
        aliases: ['getchatlore', 'getchatwi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getglobalbooks',
        callback: getGlobalBooksCallback,
        returns: 'list of selected lorebook names',
        helpString: 'Get a list of names of the selected global lorebooks and pass it down the pipe.',
        aliases: ['getgloballore', 'getglobalwi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getpersonabook',
        callback: getPersonaBookCallback,
        returns: 'lorebook name',

        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'lorebook name if creating a new one, will be auto-generated otherwise',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'create',
                description: 'create a new lorebook if it doesn\'t exist',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
        ],
        helpString: 'Get a name of the current persona-bound lorebook and pass it down the pipe. Returns empty string if persona lorebook is not set.',
        aliases: ['getpersonalore', 'getpersonawi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getcharbook',
        callback: getCharBookCallback,
        returns: 'lorebook name or a list of lorebook names',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'type',
                description: 'type of the lorebook to get, returns a list for "all" and "additional"',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['primary', 'additional', 'all'],
                defaultValue: 'primary',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'lorebook name if creating a new one, will be auto-generated otherwise',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'create',
                description: 'create a new lorebook if it doesn\'t exist',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Character name - or unique character identifier (avatar key). If not provided, the current character is used.',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: commonEnumProviders.characters('character'),
            }),
        ],
        helpString: 'Get a name of the character-bound lorebook and pass it down the pipe. Returns empty string if character lorebook is not set. Does not work in group chats without providing a character avatar name.',
        aliases: ['getcharlore', 'getcharwi'],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'findentry',
        aliases: ['findlore', 'findwi'],
        returns: 'UID',
        callback: findBookEntryCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field value for fuzzy match (default: key)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'key',
                enumList: localEnumProviders.wiEntryFields(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'texts', ARGUMENT_TYPE.STRING, true, true,
            ),
        ],
        helpString: `
            <div>
                Find a UID of the record from the specified book using the fuzzy match of a field value (default: key) and pass it down the pipe.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/findentry file=chatLore field=key Shadowfang</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getentryfield',
        aliases: ['getlorefield', 'getwifield'],
        callback: getEntryFieldCallback,
        returns: 'field value',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field to retrieve (default: content)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'content',
                enumList: localEnumProviders.wiEntryFields(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.wiUids,
            }),
        ],
        helpString: `
            <div>
                Get a field value (default: content) of the record with the UID from the specified book and pass it down the pipe.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/getentryfield file=chatLore field=content 123</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'createentry',
        callback: createEntryCallback,
        aliases: ['createlore', 'createwi'],
        returns: 'UID of the new record',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            new SlashCommandNamedArgument(
                'key', 'record key', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'content', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
            <div>
                Create a new record in the specified book with the key and content (both are optional) and pass the UID down the pipe.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/createentry file=chatLore key=Shadowfang The sword of the king</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'setentryfield',
        callback: setEntryFieldCallback,
        aliases: ['setlorefield', 'setwifield'],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'uid',
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.wiUids,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field name (default: content)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'content',
                enumList: localEnumProviders.wiEntryFields(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'value', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
            <div>
                Set a field value (default: content) of the record with the UID from the specified book. To set multiple values for key fields, use comma-delimited list as a value.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/setentryfield file=chatLore uid=123 field=key Shadowfang,sword,weapon</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-set-timed-effect',
        callback: setTimedEffectCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'uid',
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.wiUids,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'effect',
                description: 'effect name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.timedEffects,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'new state of the effect',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('onOffToggle')(),
            }),
        ],
        helpString: `
            <div>
                Set a timed effect for the record with the UID from the specified book. The duration must be set in the entry itself.
                Will only be applied for the current chat. Enabling an effect that was already active refreshes the duration.
                If the last chat message is swiped or deleted, the effect will be removed.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/wi-set-timed-effect file=chatLore uid=123 effect=sticky on</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-get-timed-effect',
        callback: getTimedEffectCallback,
        helpString: `
            <div>
                Get the current state of the timed effect for the record with the UID from the specified book.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <code>/wi-get-timed-effect file=chatLore format=bool effect=sticky 123</code> - returns true or false if the effect is active or not
                    </li>
                    <li>
                        <code>/wi-get-timed-effect file=chatLore format=number effect=sticky 123</code> - returns the remaining duration of the effect, or 0 if inactive
                    </li>
                </ul>
            </div>
        `,
        returns: 'state of the effect',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'effect',
                description: 'effect name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.timedEffects,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'format',
                description: 'output format',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: ARGUMENT_TYPE.BOOLEAN,
                enumList: [ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.NUMBER],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.wiUids,
            }),
        ],
    }));
}


/**
 * Loads the given world into the World Editor.
 *
 * @param {string} name - The name of the world
 * @return {Promise<void>} A promise that resolves when the world editor is loaded
 */
export async function showWorldEditor(name) {
    if (!name) {
        await hideWorldEditor();
        return;
    }

    const wiData = await loadWorldInfo(name);
    await displayWorldEntries(name, wiData);
}

/**
 * Loads world info from the backend.
 *
 * This function will return from `worldInfoCache` if it has already been loaded before.
 *
 * @param {string} name - The name of the world to load
 * @return {Promise<Object|null>} A promise that resolves to the loaded world information, or null if the request fails.
 */
export async function loadWorldInfo(name) {
    if (!name) {
        return;
    }

    if (worldInfoCache.has(name)) {
        return worldInfoCache.get(name);
    }

    const response = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: name }),
        cache: 'no-cache',
    });

    if (response.ok) {
        const data = await response.json();
        worldInfoCache.set(name, data);
        return data;
    }

    return null;
}

export async function updateWorldInfoList() {
    const result = await fetch('/api/settings/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (result.ok) {
        const data = await result.json();
        const editorSelectedOption = $('#world_editor_select').find(':selected');
        const editorSelected = String(
            editorSelectedOption.data('worldName')
            || world_names?.[Number(editorSelectedOption.val())]
            || '',
        );
        refreshWorldNameCaches(data);
        $('#world_info').find('option[value!=""]').remove();
        $('#world_editor_select').find('option[value!=""]').remove();

        world_names.forEach((item, i) => {
            const displayName = getLorebookDropdownDisplayName(item);
            // Global activation dropdown: exclude hidden lorebooks from user-facing list.
            if (!isHiddenPushedLorebookForDropdown(item)) {
                const globalListOption = new Option(displayName, i.toString());
                globalListOption.selected = selected_world_info.includes(item);
                globalListOption.dataset.worldName = item;
                $('#world_info').append(globalListOption);
            }
            const editorListOption = new Option(displayName, i.toString());
            editorListOption.selected = editorSelected === item;
            editorListOption.dataset.worldName = item;
            $('#world_editor_select').append(editorListOption);
        });
    }
}

async function hideWorldEditor() {
    await displayWorldEntries(null, null);
}

function getWIElement(name) {
    const wiElement = $('#world_info').children().filter(function () {
        return $(this).text().toLowerCase() === name.toLowerCase();
    });

    return wiElement;
}

/**
 * Adds missing fields to WI entries that are present in the entry template, but not in the data.
 * Additionally verify that array/object fields are of the expected type.
 * @param {any[]} data WI entries
 * @returns {any[]} Data with backfilled fields
 */
function addMissingWorldInfoFields(data) {
    data.forEach((entry) => {
        // Add missing fields from the template
        Object.entries(newWorldInfoEntryTemplate).forEach(([key, value]) => {
            if (!Object.hasOwn(entry, key)) {
                entry[key] = structuredClone(value);
            }
        });

        // Ensure that the key is always an array
        if (!Array.isArray(entry.key)) {
            console.debug('[WI] Fixing invalid "key" field for entry', entry);
            entry.key = [];
        }

        // Ensure that the keysecondary is always an array
        if (!Array.isArray(entry.keysecondary)) {
            console.debug('[WI] Fixing invalid "keysecondary" field for entry', entry);
            entry.keysecondary = [];
        }

        // Ensure that the characterFilter is an object with the expected structure
        if (!entry.characterFilter || typeof entry.characterFilter !== 'object' || Array.isArray(entry.characterFilter)) {
            entry.characterFilter = {
                isExclude: false,
                names: [],
                tags: [],
            };
        }
    });

    return data;
}

/**
 * Sorts the given data based on the selected sort option
 *
 * @param {any[]} data WI entries
 * @param {object} [options={}] - Optional arguments
 * @param {{sortField?: string, sortOrder?: string, sortRule?: string}} [options.customSort={}] - Custom sort options, instead of the chosen UI sort
 * @returns {any[]} Sorted data
 */
export function sortWorldInfoEntries(data, { customSort = null } = {}) {
    const option = $('#world_info_sort_order').find(':selected');
    const sortField = customSort?.sortField ?? option.data('field');
    const sortOrder = customSort?.sortOrder ?? option.data('order');
    const sortRule = customSort?.sortRule ?? option.data('rule');
    const orderSign = sortOrder === 'asc' ? 1 : -1;

    if (!data.length) return data;

    /** @type {(a: any, b: any) => number} */
    let primarySort;

    // Secondary and tertiary it will always be sorted by Order descending, and last UID ascending
    // This is the most sensible approach for sorts where the primary sort has a lot of equal values
    const secondarySort = (a, b) => b.order - a.order;
    const tertiarySort = (a, b) => a.uid - b.uid;

    // If we have a search term for WI, we are sorting by weighting scores
    if (sortRule === 'search') {
        primarySort = (a, b) => {
            const aScore = worldInfoFilter.getScore(FILTER_TYPES.WORLD_INFO_SEARCH, a.uid);
            const bScore = worldInfoFilter.getScore(FILTER_TYPES.WORLD_INFO_SEARCH, b.uid);
            return aScore - bScore;
        };
    }
    else if (sortRule === 'custom') {
        // First by display index
        primarySort = (a, b) => {
            const aValue = a.displayIndex;
            const bValue = b.displayIndex;
            return aValue - bValue;
        };
    } else if (sortRule === 'priority') {
        // First constant, then normal, then disabled.
        primarySort = (a, b) => {
            const aValue = a.disable ? 2 : a.constant ? 0 : 1;
            const bValue = b.disable ? 2 : b.constant ? 0 : 1;
            return aValue - bValue;
        };
    } else {
        primarySort = (a, b) => {
            const aValue = a[sortField];
            const bValue = b[sortField];

            // Sort strings
            if (typeof aValue === 'string' && typeof bValue === 'string') {
                if (sortRule === 'length') {
                    // Sort by string length
                    return orderSign * (aValue.length - bValue.length);
                } else {
                    // Sort by A-Z ordinal
                    return orderSign * aValue.localeCompare(bValue);
                }
            }

            // Sort numbers
            return orderSign * (Number(aValue) - Number(bValue));
        };
    }

    data.sort((a, b) => {
        return primarySort(a, b) || secondarySort(a, b) || tertiarySort(a, b);
    });

    return data;
}

function nullWorldInfo() {
    toastr.info('Create or import a new World Info file first.', 'World Info is not set', { timeOut: 10000, preventDuplicates: true });
}

/** @type {Select2Option[]} Cache all keys as selectable dropdown option */
const worldEntryKeyOptionsCache = [];

/**
 * Update the cache and all select options for the keys with new values to display
 * @param {string[]|Select2Option[]} keyOptions - An array of options to update
 * @param {object} options - Optional arguments
 * @param {boolean?} [options.remove=false] - Whether the option was removed, so the count should be reduced - otherwise it'll be increased
 * @param {boolean?} [options.reset=false] - Whether the cache should be reset. Reset will also not trigger update of the controls, as we expect them to be redrawn anyway
 */
function updateWorldEntryKeyOptionsCache(keyOptions, { remove = false, reset = false } = {}) {
    if (!keyOptions.length) return;
    /** @type {Select2Option[]} */
    const options = keyOptions.map(x => typeof x === 'string' ? { id: getSelect2OptionId(x), text: x } : x);
    if (reset) worldEntryKeyOptionsCache.length = 0;
    options.forEach(option => {
        // Update the cache list
        let cachedEntry = worldEntryKeyOptionsCache.find(x => x.id == option.id);
        if (cachedEntry) {
            cachedEntry.count += !remove ? 1 : -1;
        } else if (!remove) {
            worldEntryKeyOptionsCache.push(option);
            cachedEntry = option;
            cachedEntry.count = 1;
        }
    });

    // Sort by count DESC and then alphabetically
    worldEntryKeyOptionsCache.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

function clearEntryList($list) {
    console.time('clearEntryList');

    // List already empty, skipping cleanup
    if (!$list.children().length) {
        console.timeEnd('clearEntryList');
        return;
    }

    // Unsubscribe from toggle events, so that mass open won't create new drawers
    $list.find('.inline-drawer').off('inline-drawer-toggle');

    // Step 1: Clean all <option> elements within <select>
    $list.find('option').each(function () {
        const $option = $(this);
        $option.off();
        $.cleanData([$option[0]]);
        $option.remove();
    });

    // Step 2: Clean all <select> elements
    $list.find('select').each(function () {
        const $select = $(this);
        // Remove Select2-related data and container if present
        if ($select.data('select2')) {
            try {
                $select.select2('destroy');
            } catch (e) {
                console.debug('Select2 destroy failed:', e);
            }
        }
        const $container = $select.parent();
        if ($container.length) {
            $container.find('*').off();
            $.cleanData($container.find('*').get());
            $container.remove();
        }

        $select.off();
        $.cleanData([$select[0]]);
    });

    // Step 3: Clean <div>, <span>, <input>
    $list.find('div, span, input').each(function () {
        const $elem = $(this);
        $elem.off();
        $.cleanData([$elem[0]]);
        $elem.remove();
    });

    const totalElementsOfAnyKindLeftInList = $list.children().length;

    // Final cleanup
    if (totalElementsOfAnyKindLeftInList) {
        console.time('empty');
        $list.empty();
        console.timeEnd('empty');
    }

    console.timeEnd('clearEntryList');
}

//MARK: displayWorldEntries
async function displayWorldEntries(name, data, navigation = navigation_option.none, flashOnNav = true) {
    updateEditor = async (navigation, flashOnNav = true) => await displayWorldEntries(name, data, navigation, flashOnNav);

    const worldEntriesList = $('#world_popup_entries_list');
    clearEntryList(worldEntriesList);
    worldEntriesList.show();

    if (!data || !('entries' in data)) {
        $('#world_popup_new').off('click').on('click', nullWorldInfo);
        $('#world_popup_name_button').off('click').on('click', nullWorldInfo);
        $('#world_popup_export').off('click').on('click', nullWorldInfo);
        $('#world_popup_delete').off('click').on('click', nullWorldInfo);
        $('#world_duplicate').off('click').on('click', nullWorldInfo);
        worldEntriesList.hide();
        $('#world_info_pagination').html('');
        return;
    }

    // Block display of hidden/restricted lorebooks for non-creator users
    const isHidden = isTrueishFlag(getWorldInfoExtensionBySuffix(data, 'hidden')) || !!data?._dreamtavern_restricted || !!data?._stw_hidden_restricted;
    const hiddenCreator = String(getWorldInfoExtensionBySuffix(data, 'creator') || '').trim().toLowerCase();
    const hiddenOriginalCreator = String(getWorldInfoExtensionBySuffix(data, 'original_creator') || hiddenCreator || '').trim().toLowerCase();
    const currentHandle = String(getCurrentUserHandle() || '').trim().toLowerCase();
    const canViewHiddenLorebook = !isHidden || currentHandle === hiddenCreator || currentHandle === hiddenOriginalCreator;
    if (!canViewHiddenLorebook) {
        $('#world_popup_new').off('click').on('click', nullWorldInfo);
        $('#world_popup_name_button').off('click').on('click', nullWorldInfo);
        $('#world_popup_export').off('click').on('click', nullWorldInfo);
        $('#world_popup_delete').off('click').on('click', nullWorldInfo);
        $('#world_duplicate').off('click').on('click', nullWorldInfo);
        worldEntriesList.hide();
        $('#world_info_pagination').html('');
        return;
    }

    // Check if lorebook is locked for this user
    const isLocked = isTrueishFlag(getWorldInfoExtensionBySuffix(data, 'locked'));
    const lockCreator = String(getWorldInfoExtensionBySuffix(data, 'creator') || '').trim().toLowerCase();
    const lockOriginalCreator = String(getWorldInfoExtensionBySuffix(data, 'original_creator') || lockCreator || '').trim().toLowerCase();
    const canEdit = !isLocked || currentHandle === lockCreator || currentHandle === lockOriginalCreator;

    // Show lock indicator
    if (isLocked && !canEdit) {
        $('#world_popup_new').off('click').on('click', () => toastr.warning('This lorebook is locked', 'Read Only'));
        $('#world_popup_name_button').off('click').on('click', () => toastr.warning('This lorebook is locked', 'Read Only'));
        $('#world_popup_delete').off('click').on('click', () => toastr.warning('This lorebook is locked', 'Read Only'));
        $('#world_popup_new, #world_popup_name_button, #world_popup_delete').css('opacity', '0.4');
    } else {
        $('#world_popup_new, #world_popup_name_button, #world_popup_delete').css('opacity', '');
    }

    // Regardless of whether success is displayed or not. Make sure the delete button is available.
    // Do not put this code behind.
    if (canEdit) $('#world_popup_delete').off('click').on('click', async () => {
        const confirmation = await Popup.show.confirm(`Delete the World/Lorebook: "${name}"?`, 'This action is irreversible!');
        if (!confirmation) {
            return;
        }

        if (world_info.charLore) {
            world_info.charLore.forEach((charLore, index) => {
                if (charLore.extraBooks?.includes(name)) {
                    const tempCharLore = charLore.extraBooks.filter((e) => e !== name);
                    if (tempCharLore.length === 0) {
                        world_info.charLore.splice(index, 1);
                    } else {
                        charLore.extraBooks = tempCharLore;
                    }
                }
            });

            saveSettingsDebounced();
        }

        // Selected world_info automatically refreshes
        await deleteWorldInfo(name);
    });

    // Before printing the WI, we check if we should enable/disable search sorting
    verifyWorldInfoSearchSortRule();

    function getDataArray(callback) {
        // Convert the data.entries object into an array
        let entriesArray = Object.keys(data.entries).map(uid => {
            const entry = data.entries[uid];
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return null;
            }
            entry.displayIndex = entry.displayIndex ?? entry.uid;
            return entry;
        }).filter(entry => entry !== null);

        // Apply the filter and do the chosen sorting
        entriesArray = addMissingWorldInfoFields(entriesArray);
        entriesArray = worldInfoFilter.applyFilters(entriesArray);
        entriesArray = sortWorldInfoEntries(entriesArray);

        // Cache keys
        const keys = entriesArray.flatMap(entry => [...entry.key, ...entry.keysecondary]);
        updateWorldEntryKeyOptionsCache(keys, { reset: true });

        // Run the callback for printing this
        typeof callback === 'function' && callback(entriesArray);
        return entriesArray;
    }

    const storageKey = 'WI_PerPage';
    const perPageDefault = 25;
    let startPage = 1;

    if (navigation === navigation_option.previous) {
        startPage = $('#world_info_pagination').pagination('getCurrentPageNum');
    }

    if (typeof navigation === 'number' && Number(navigation) >= 0) {
        const data = getDataArray();
        const uidIndex = data.findIndex(x => x.uid === navigation);
        const perPage = Number(accountStorage.getItem(storageKey)) || perPageDefault;
        startPage = Math.floor(uidIndex / perPage) + 1;
    }

    $('#world_info_pagination').pagination({
        dataSource: getDataArray,
        pageSize: Number(accountStorage.getItem(storageKey)) || perPageDefault,
        sizeChangerOptions: [10, 25, 50, 100, 500, 1000],
        showSizeChanger: true,
        pageRange: 1,
        pageNumber: startPage,
        position: 'top',
        showPageNumbers: false,
        prevText: '<',
        nextText: '>',
        formatNavigator: PAGINATION_TEMPLATE,
        showNavigator: true,
        callback: async function (/** @type {object[]} */ page) {
            try {
                clearEntryList(worldEntriesList);

                const keywordHeaders = await renderTemplateAsync('worldInfoKeywordHeaders');
                const blocks = [];

                for (const entry of page) {
                    try {
                        const block = await getWorldEntry(name, data, entry);
                        if (block) {
                            blocks.push(block);
                        }
                    } catch (error) {
                        console.error(`Error while processing entry ${entry.uid}:`, error);
                    }
                }

                const isCustomOrder = $('#world_info_sort_order').find(':selected').data('rule') === 'custom';
                if (!isCustomOrder) {
                    blocks.forEach(block => {
                        block.find('.drag-handle').remove();
                    });
                }

                worldEntriesList.append(keywordHeaders);
                worldEntriesList.append(blocks);
            } catch (error) {
                console.error('Error while rendering WI entries:', error);
            }
        },
        afterSizeSelectorChange: function (e) {
            accountStorage.setItem(storageKey, e.target.value);
        },
        afterPaging: function () {
            $('#world_popup_entries_list textarea[name="comment"]').each(function () {
                initScrollHeight($(this));
            });
        },
    });

    if (typeof navigation === 'number' && Number(navigation) >= 0) {
        const selector = `#world_popup_entries_list [uid="${navigation}"]`;
        waitUntilCondition(() => document.querySelector(selector) !== null).finally(() => {
            const element = $(selector);

            if (element.length === 0) {
                console.log(`Could not find element for uid ${navigation}`);
                return;
            }

            const elementOffset = element.offset();
            const parentOffset = element.parent().offset();
            const scrollOffset = elementOffset.top - parentOffset.top;
            $('#WorldInfo').scrollTop(scrollOffset);
            if (flashOnNav) flashHighlight(element);
        });
    }

    $('#world_popup_new').off('click').on('click', () => {
        const entry = createWorldInfoEntry(name, data);
        if (entry) updateEditor(entry.uid);
    });

    $('#world_popup_name_button').off('click').on('click', async () => {
        await renameWorldInfo(name, data);
    });

    $('#world_backfill_memos').off('click').on('click', async () => {
        let counter = 0;
        for (const entry of Object.values(data.entries)) {
            if (!entry.comment && Array.isArray(entry.key) && entry.key.length > 0) {
                entry.comment = entry.key.join(', ').slice(0, MAX_COMMENT_LENGTH);
                setWIOriginalDataValue(data, entry.uid, 'comment', entry.comment);
                counter++;
            }
        }

        if (counter > 0) {
            toastr.info(`Backfilled ${counter} titles`);
            await saveWorldInfo(name, data);
            updateEditor(navigation_option.previous);
        }
    });

    $('#world_apply_current_sorting').off('click').on('click', async () => {
        const entryCount = Object.keys(data.entries).length;
        const moreThan100 = entryCount > 100;

        let content = '<span>' + t`Apply your current sorting to the "Order" field. The Order values will go down from the chosen number.` + '</span>';
        if (moreThan100) {
            content += '<div class="m-t-1"><i class="fa-solid fa-triangle-exclamation" style="color: #FFD43B;"></i> ' + t`More than 100 entries in this world. If you don't choose a number higher than that, the lower entries will default to 0.<br />(Usual default: 100)<br />Minimum: ${entryCount}` + '</div>';
        }

        const result = await Popup.show.input(t`Apply Current Sorting`, content, '100', { okButton: t`Apply`, cancelButton: 'Cancel' });
        if (!result) return;

        const start = Number(result);
        if (isNaN(start) || start < 0) {
            toastr.error(t`Invalid number: ${result}`, t`Apply Current Sorting`);
            return;
        }
        if (start < entryCount) {
            toastr.warning(t`A number lower than the entry count has been chosen. All entries below that will default to 0.`, t`Apply Current Sorting`);
        }

        // We need to sort the entries here, as the data source isn't sorted
        const entries = Object.values(data.entries);
        sortWorldInfoEntries(entries);

        let updated = 0, current = start;
        for (const entry of entries) {
            const newOrder = Math.max(current--, 0);
            if (entry.order === newOrder) continue;

            entry.order = newOrder;
            setWIOriginalDataValue(data, entry.order, 'order', entry.order);
            updated++;
        }

        if (updated > 0) {
            toastr.info(`Updated ${updated} Order values`, 'Apply Custom Sorting');
            await saveWorldInfo(name, data, true);
            updateEditor(navigation_option.previous);
        } else {
            toastr.info('All values up to date', 'Apply Custom Sorting');
        }
    });

    $('#world_popup_export').off('click').on('click', () => {
        if (name && data) {
            const jsonValue = JSON.stringify(data);
            const fileName = `${name}.json`;
            download(jsonValue, fileName, 'application/json');
        }
    });

    $('#world_duplicate').off('click').on('click', async () => {
        const tempName = getFreeWorldName();
        const finalName = await Popup.show.input('Create a new World Info?', 'Enter a name for the new file:', tempName);

        if (finalName) {
            await saveWorldInfo(finalName, data, true);
            await updateWorldInfoList();

            const selectedIndex = world_names.indexOf(finalName);
            if (selectedIndex !== -1) {
                $('#world_editor_select').val(selectedIndex).trigger('change');
            } else {
                await hideWorldEditor();
            }
        }
    });

    // Check if a sortable instance exists
    if (worldEntriesList.sortable('instance') !== undefined) {
        // Destroy the instance
        worldEntriesList.sortable('destroy');
    }

    worldEntriesList.sortable({
        items: '.world_entry',
        delay: getSortableDelay(),
        handle: '.drag-handle',
        stop: async function (_event, _ui) {
            const firstEntryUid = $('#world_popup_entries_list .world_entry').first().data('uid');
            const minDisplayIndex = data?.entries[firstEntryUid]?.displayIndex ?? 0;
            $('#world_popup_entries_list .world_entry').each(function (index) {
                const uid = $(this).data('uid');

                // Update the display index in the data array
                const item = data.entries[uid];

                if (!item) {
                    console.debug(`Could not find entry with uid ${uid}`);
                    return;
                }

                item.displayIndex = minDisplayIndex + index;
                setWIOriginalDataValue(data, uid, 'extensions.display_index', item.displayIndex);
            });

            console.table(Object.keys(data.entries).map(uid => data.entries[uid]).map(x => ({ uid: x.uid, key: x.key.join(','), displayIndex: x.displayIndex })));

            await saveWorldInfo(name, data);
        },
    });

    //$("#world_popup_entries_list").disableSelection();
}

export const originalWIDataKeyMap = {
    'displayIndex': 'extensions.display_index',
    'excludeRecursion': 'extensions.exclude_recursion',
    'preventRecursion': 'extensions.prevent_recursion',
    'delayUntilRecursion': 'extensions.delay_until_recursion',
    'selectiveLogic': 'selectiveLogic',
    'comment': 'comment',
    'constant': 'constant',
    'order': 'insertion_order',
    'depth': 'extensions.depth',
    'probability': 'extensions.probability',
    'position': 'extensions.position',
    'role': 'extensions.role',
    'content': 'content',
    'enabled': 'enabled',
    'key': 'keys',
    'keysecondary': 'secondary_keys',
    'selective': 'selective',
    'matchWholeWords': 'extensions.match_whole_words',
    'useGroupScoring': 'extensions.use_group_scoring',
    'caseSensitive': 'extensions.case_sensitive',
    'matchPersonaDescription': 'extensions.match_persona_description',
    'matchCharacterDescription': 'extensions.match_character_description',
    'matchCharacterPersonality': 'extensions.match_character_personality',
    'matchCharacterDepthPrompt': 'extensions.match_character_depth_prompt',
    'matchScenario': 'extensions.match_scenario',
    'matchCreatorNotes': 'extensions.match_creator_notes',
    'scanDepth': 'extensions.scan_depth',
    'automationId': 'extensions.automation_id',
    'vectorized': 'extensions.vectorized',
    'groupOverride': 'extensions.group_override',
    'groupWeight': 'extensions.group_weight',
    'sticky': 'extensions.sticky',
    'cooldown': 'extensions.cooldown',
    'delay': 'extensions.delay',
    'triggers': 'extensions.triggers',
    'ignoreBudget': 'extensions.ignore_budget',
};

/** Checks the state of the current search, and adds/removes the search sorting option accordingly */
function verifyWorldInfoSearchSortRule() {
    const searchTerm = worldInfoFilter.getFilterData(FILTER_TYPES.WORLD_INFO_SEARCH);
    const searchOption = $('#world_info_sort_order option[data-rule="search"]');
    const selector = $('#world_info_sort_order');
    const isHidden = searchOption.attr('hidden') !== undefined;

    // If we have a search term, we are displaying the sorting option for it
    if (searchTerm && isHidden) {
        searchOption.removeAttr('hidden');
        selector.val(searchOption.attr('value') || '0');
        flashHighlight(selector);
    }
    // If search got cleared, we make sure to hide the option and go back to the one before
    if (!searchTerm && !isHidden) {
        searchOption.attr('hidden', '');
        selector.val(accountStorage.getItem(SORT_ORDER_KEY) || '0');
    }
}

/**
 * Sets the value of a specific key in the original data entry corresponding to the given uid
 * This needs to be called whenever you update JSON data fields.
 * Use `originalWIDataKeyMap` to find the correct value to be set.
 *
 * @param {object} data - The data object containing the original data entries.
 * @param {number} uid - The unique identifier of the data entry.
 * @param {string} key - The key of the value to be set.
 * @param {any} value - The value to be set.
 */
export function setWIOriginalDataValue(data, uid, key, value) {
    if (data.originalData && Array.isArray(data.originalData.entries)) {
        let originalEntry = data.originalData.entries.find(x => x.uid === uid);

        if (!originalEntry) {
            return;
        }

        setValueByPath(originalEntry, key, value);
    }
}

/**
 * Deletes the original data entry corresponding to the given uid from the provided data object
 *
 * @param {object} data - The data object containing the original data entries
 * @param {string} uid - The unique identifier of the data entry to be deleted
 */
export function deleteWIOriginalDataValue(data, uid) {
    if (data.originalData && Array.isArray(data.originalData.entries)) {
        // Non-strict equality is used here to allow for both string and number comparisons
        // @eslint-disable-next-line eqeqeq
        const originalIndex = data.originalData.entries.findIndex(x => x.uid == uid);

        if (originalIndex >= 0) {
            data.originalData.entries.splice(originalIndex, 1);
        }
    }
}

/** @typedef {import('./utils.js').Select2Option} Select2Option */

/**
 * Splits a given input string that contains one or more keywords or regexes, separated by commas.
 *
 * Each part can be a valid regex following the pattern `/myregex/flags` with optional flags. Commas inside the regex are allowed, slashes have to be escaped like this: `\/`
 * If a regex doesn't stand alone, it is not treated as a regex.
 *
 * @param {string} input - One or multiple keywords or regexes, separated by commas
 * @returns {string[]} An array of keywords and regexes
 */
export function splitKeywordsAndRegexes(input) {
    /** @type {string[]} */
    let keywordsAndRegexes = [];

    // We can make this easy. Instead of writing another function to find and parse regexes,
    // we gonna utilize the custom tokenizer that also handles the input.
    // No need for validation here
    const addFindCallback = (/** @type {Select2Option} */ item) => {
        keywordsAndRegexes.push(item.text);
    };

    const { term } = customTokenizer({ _type: 'custom_call', term: input }, undefined, addFindCallback);
    const finalTerm = term.trim();
    if (finalTerm) {
        addFindCallback({ id: getSelect2OptionId(finalTerm), text: finalTerm });
    }

    return keywordsAndRegexes;
}

/**
 * Tokenizer parsing input and splitting it into keywords and regexes
 *
 * @param {{_type: string, term: string}} input - The typed input
 * @param {{options: object}} _selection - The selection even object (?)
 * @param {function(Select2Option):void} callback - The original callback function to call if an item should be inserted
 * @returns {{term: string}} - The remaining part that is untokenized in the textbox
 */
function customTokenizer(input, _selection, callback) {
    let current = input.term;

    let insideRegex = false, regexClosed = false;

    // Go over the input and check the current state, if we can get a token
    for (let i = 0; i < current.length; i++) {
        let char = current[i];

        // If we find an unascaped slash, set the current regex state
        if (char === '/' && (i === 0 || current[i - 1] !== '\\')) {
            if (!insideRegex) insideRegex = true;
            else if (!regexClosed) regexClosed = true;
        }

        // If a comma is typed, we tokenize the input.
        // unless we are inside a possible regex, which would allow commas inside
        if (char === ',') {
            // We take everything up till now and consider this a token
            const token = current.slice(0, i).trim();

            // Now how we test if this is a regex? And not a finished one, but a half-finished one?
            // We use the state remembered from above to check whether the delimiter was opened but not closed yet.
            // We don't check validity here if we are inside a regex, because it might only get valid after its finished. (Closing brackets, etc)
            // Validity will be finally checked when the next comma is typed.
            if (insideRegex && !regexClosed) {
                continue;
            }

            // So now the comma really means the token is done.
            // We take the token up till now, and insert it. Empty will be skipped.
            if (token) {
                const isRegex = isValidRegex(token);

                // Last chance to check for valid regex again. Because it might have been valid while typing, but now is not valid anymore and contains commas we need to split.
                if (token.startsWith('/') && !isRegex) {
                    const tokens = token.split(',').map(x => x.trim());
                    tokens.forEach(x => callback({ id: getSelect2OptionId(x), text: x }));
                } else {
                    callback({ id: getSelect2OptionId(token), text: token });
                }
            }

            // Now remove the token from the current input, and the comma too
            current = current.slice(i + 1);
            insideRegex = false;
            regexClosed = false;
            i = 0;
        }
    }

    // At the end, just return the left-over input
    return { term: current };
}

/**
 * Validates if a string is a valid slash-delimited regex, that can be parsed and executed
 *
 * This is a wrapper around `parseRegexFromString`
 *
 * @param {string} input - A delimited regex string
 * @returns {boolean} Whether this would be a valid regex that can be parsed and executed
 */
function isValidRegex(input) {
    return parseRegexFromString(input) !== null;
}

/**
 * Gets a real regex object from a slash-delimited regex string
 *
 * This function works with `/` as delimiter, and each occurance of it inside the regex has to be escaped.
 * Flags are optional, but can only be valid flags supported by JavaScript's `RegExp` (`g`, `i`, `m`, `s`, `u`, `y`).
 *
 * @param {string} input - A delimited regex string
 * @returns {RegExp|null} The regex object, or null if not a valid regex
 */
export function parseRegexFromString(input) {
    // Extracting the regex pattern and flags
    let match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) {
        return null; // Not a valid regex format
    }

    let [, pattern, flags] = match;

    // If we find any unescaped slash delimiter, we also exit out.
    // JS doesn't care about delimiters inside regex patterns, but for this to be a valid regex outside of our implementation,
    // we have to make sure that our delimiter is correctly escaped. Or every other engine would fail.
    if (pattern.match(/(^|[^\\])\//)) {
        return null;
    }

    // Now we need to actually unescape the slash delimiters, because JS doesn't care about delimiters
    pattern = pattern.replace('\\/', '/');

    // Then we return the regex. If it fails, it was invalid syntax.
    try {
        return new RegExp(pattern, flags);
    } catch (e) {
        return null;
    }
}

/**
 * Enables the input helper for keys in a World Info entry.
 * @param {object} params - Parameters for enabling the keys input helper.
 * @param {JQuery<HTMLElement>} params.template - The template element containing the input.
 * @param {object} params.entry - The entry object containing the keys.
 * @param {string} params.entryPropName - The property name of the entry that holds the keys.
 * @param {string} params.originalDataValueName - The name of the original data value to be set.
 * @param {string} params.name - The name of the world info entry.
 * @param {object} params.data - The data object containing entries.
 */
function enableKeysInputHelper({ template, entry, entryPropName, originalDataValueName, name, data }) {
    const isFancyInput = !isMobile() && !power_user.wi_key_input_plaintext;
    const input = isFancyInput ? template.find(`select[name="${entryPropName}"]`) : template.find(`textarea[name="${entryPropName}"]`);
    input.data('uid', entry.uid);
    input.on('click', function (event) {
        event.stopPropagation();
    });

    function templateStyling(item, { searchStyle = false } = {}) {
        const content = $('<span>').addClass('item').text(item.text).attr('title', `${item.text}\n\nClick to edit`);
        const isRegex = isValidRegex(item.text);
        if (isRegex) {
            content.html(highlightRegex(item.text));
            content.addClass('regex_item').prepend($('<span>').addClass('regex_icon').text('•*').attr('title', 'Regex'));
        }
        if (searchStyle && item.count) {
            const wrapper = $('<span>').addClass('result_block').append(content);
            wrapper.append($('<span>').addClass('item_count').text(item.count).attr('title', `Used as a key ${item.count} ${item.count != 1 ? 'times' : 'time'} in this lorebook`));
            return wrapper;
        }
        return content;
    }

    if (isFancyInput) {
        select2ModifyOptions(input, entry[entryPropName], { select: true, changeEventArgs: { skipReset: true, noSave: true } });
        input.select2({
            ajax: dynamicSelect2DataViaAjax(() => worldEntryKeyOptionsCache),
            tags: true,
            tokenSeparators: [','],
            // @ts-ignore
            tokenizer: customTokenizer,
            placeholder: input.attr('placeholder'),
            templateResult: item => templateStyling(item, { searchStyle: true }),
            templateSelection: item => templateStyling(item),
        });

        // TypeScript-safe event handler
        /**
         * @param {Event} _event
         * @param {{ skipReset?: boolean, noSave?: boolean }} [arg]
         */
        input.on('change', async function (_event, arg) {
            const uid = $(this).data('uid');
            const keys = ($(this).select2('data')).map(x => x.text);
            const skipReset = arg?.skipReset ?? false;
            const noSave = arg?.noSave ?? false;
            if (!skipReset) await resetScrollHeight(this);
            if (!noSave) {
                data.entries[uid][entryPropName] = keys;
                setWIOriginalDataValue(data, uid, originalDataValueName, data.entries[uid][entryPropName]);
                await saveWorldInfo(name, data);
            }
            $(this).toggleClass('empty', !data.entries[uid][entryPropName].length);
            // Update the commentInput's placeholder for primary keys
            if (entryPropName === 'key') {
                const commentInput = $(_event.currentTarget).closest('.world_entry_form').find('textarea[name="comment"]');
                setCommentPlaceholder(data.entries[uid][entryPropName].join(', '), commentInput);
            }
        });

        input.toggleClass('empty', !entry[entryPropName].length);
        input.on('select2:select', event => updateWorldEntryKeyOptionsCache([event.params.data]));
        input.on('select2:unselect', event => updateWorldEntryKeyOptionsCache([event.params.data], { remove: true }));

        select2ChoiceClickSubscribe(input, target => {
            const key = $(target.closest('.regex-highlight, .item')).text();
            const selected = input.val();
            if (!Array.isArray(selected)) return;
            var index = selected.indexOf(getSelect2OptionId(key));
            if (index > -1) selected.splice(index, 1);
            input.val(selected).trigger('change');
            updateWorldEntryKeyOptionsCache([key], { remove: true });
            input.next('span.select2-container').find('textarea').val(key).trigger('input');
        }, { openDrawer: true });
    } else {
        template.find(`select[name="${entryPropName}"]`).hide();
        input.show();
        /**
        * @param {Event} _event
        * @param {{ skipReset?: boolean, noSave?: boolean }} [arg]
        */
        input.on('change', async function (_event, arg) {
            const uid = $(this).data('uid');
            const value = String($(this).val());
            const skipReset = arg?.skipReset ?? false;
            const noSave = arg?.noSave ?? false;
            if (!skipReset) await resetScrollHeight(this);
            if (!noSave) {
                data.entries[uid][entryPropName] = splitKeywordsAndRegexes(value);
                setWIOriginalDataValue(data, uid, originalDataValueName, data.entries[uid][entryPropName]);
                await saveWorldInfo(name, data);
                $(this).toggleClass('empty', !data.entries[uid][entryPropName].length);
            }
            // Update the commentInput's placeholder for primary keys
            if (entryPropName === 'key') {
                const commentInput = $(_event.currentTarget).closest('.world_entry_form').find('textarea[name="comment"]');
                setCommentPlaceholder(value, commentInput);
            }
        });
        input.val(entry[entryPropName].join(', ')).trigger('input', { skipReset: true });
    }
    return { isFancy: isFancyInput, control: input };
}

/**
 * Helper to handle match checkboxes for WI entries.
 * @param {object} params - Parameters for handling match checkboxes.
 * @param {JQuery<HTMLElement>} params.template - The template element containing the checkbox.
 * @param {object} params.entry - The entry object containing the checkbox state.
 * @param {string} params.fieldName - The name of the checkbox field.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 */
function handleMatchCheckboxHelper({ template, entry, fieldName, data, name }) {
    const key = originalWIDataKeyMap[fieldName];
    const checkBoxElem = template.find(`input[type="checkbox"][name="${fieldName}"]`);
    checkBoxElem.data('uid', entry.uid);
    checkBoxElem.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = $(this).prop('checked');
        data.entries[uid][fieldName] = value;
        setWIOriginalDataValue(data, uid, key, data.entries[uid][fieldName]);
        !noSave && await saveWorldInfo(name, data);
    });
    checkBoxElem.prop('checked', !!entry[fieldName]).trigger('input', { noSave: true });
}

/**
 * Helper to update position/order display.
 * @param {object} params - Parameters for updating position/order display.
 * @param {JQuery<HTMLElement>} params.template - The template element containing the display.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.uid - The unique identifier of the entry to update.
 */
function updatePosOrdDisplayHelper({ template, data, uid }) {
    let entry = data.entries[uid];
    let posText = entry.position;
    switch (entry.position) {
        case 0: posText = '↑CD'; break;
        case 1: posText = 'CD↓'; break;
        case 2: posText = '↑AN'; break;
        case 3: posText = 'AN↓'; break;
        case 4: posText = `@D${entry.depth}`; break;
    }
    template.find('.world_entry_form_position_value').text(`(${posText} ${entry.order})`);
}

/**
 * Helper to initialize character filter select2.
 * @param {JQuery<HTMLElement>} characterFilter - The select element for character filter.
 */
function initCharacterFilterSelect2Helper(characterFilter) {
    if (!isMobile()) {
        $(characterFilter).select2({
            width: '100%',
            placeholder: t`Tie this entry to specific characters or characters with specific tags`,
            allowClear: true,
            closeOnSelect: false,
        });
    }
}

/**
 * Helper to fill character and tag options for character filter.
 * @param {object} params - Parameters for filling options.
 * @param {JQuery<HTMLElement>} params.characterFilter - The select element to fill with options.
 * @param {object} params.entry - The entry object containing character filter data.
 */
function fillCharacterAndTagOptionsHelper({ characterFilter, entry }) {
    const characters = getContext().characters;
    characters.forEach((character) => {
        const option = document.createElement('option');
        const name = character.avatar.replace(/\.[^/.]+$/, '') ?? character.name;
        option.innerText = name;
        option.selected = entry.characterFilter?.names?.includes(name);
        option.setAttribute('data-type', 'character');
        characterFilter.append(option);
    });
    const tags = getContext().tags;
    tags.forEach((tag) => {
        const option = document.createElement('option');
        option.innerText = `[Tag] ${tag.name}`;
        option.selected = entry.characterFilter?.tags?.includes(tag.id);
        option.value = tag.id;
        option.setAttribute('data-type', 'tag');
        characterFilter.append(option);
    });
}

/**
 * Helper to handle character filter changes.
 * @param {object} params - Parameters for handling character filter changes.
 * @param {JQuery<HTMLElement>} params.characterFilter - The select element for character filter.
 * @param {object} params.data - The data object containing entries.
 * @param {object} params.entry - The entry object to update.
 * @param {string} params.name - The name of the world info to save changes to.
 */
function handleCharacterFilterChangeHelper({ characterFilter, data, entry, name }) {
    characterFilter.on('mousedown change', async function (e) {
        if (world_names.length === 0) {
            e.preventDefault();
            return;
        }
        const uid = $(this).data('uid');
        const selected = $(this).find(':selected');
        if ((!selected || selected?.length === 0) && !data.entries[uid].characterFilter?.isExclude) {
            delete data.entries[uid].characterFilter;
        } else {
            const names = selected.filter('[data-type="character"]').map((_, e) => e instanceof HTMLOptionElement && e.innerText).toArray();
            const tags = selected.filter('[data-type="tag"]').map((_, e) => e instanceof HTMLOptionElement && e.value).toArray();
            Object.assign(
                data.entries[uid],
                {
                    characterFilter: {
                        isExclude: data.entries[uid].characterFilter?.isExclude ?? false,
                        names: names,
                        tags: tags,
                    },
                },
            );
        }
        setWIOriginalDataValue(data, uid, 'character_filter', data.entries[uid].characterFilter);
        await saveWorldInfo(name, data);
    });
}

/**
 * Helper to handle probability input.
 * @param {object} params - Parameters for handling probability input.
 * @param {JQuery<HTMLElement>} params.probabilityInput - The input element for probability.
 * @param {object} params.data - The data object containing entries.
 * @param {object} params.entry - The entry object to update.
 * @param {string} params.name - The name of the world info to save changes to.
 */
function handleProbabilityInputHelper({ probabilityInput, data, entry, name }) {
    probabilityInput.data('uid', entry.uid);
    probabilityInput.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = Number($(this).val());
        data.entries[uid].probability = !isNaN(value) ? value : null;
        if (data.entries[uid].probability !== null) {
            data.entries[uid].probability = Math.min(100, Math.max(0, data.entries[uid].probability));
            if (data.entries[uid].probability !== value) {
                $(this).val(data.entries[uid].probability);
            }
        }
        setWIOriginalDataValue(data, uid, 'extensions.probability', data.entries[uid].probability);
        !noSave && await saveWorldInfo(name, data);
    });
    probabilityInput.val(entry.probability).trigger('input', { noSave: true });
    probabilityInput.css('width', 'calc(3em + 15px)');
}

/**
 * Helper to handle probability toggle.
 * @param {object} params - Parameters for handling probability toggle.
 * @param {JQuery<HTMLElement>} params.probabilityToggle - The toggle element for probability.
 * @param {object} params.data - The data object containing entries.
 * @param {object} params.entry - The entry object to update.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {JQuery<HTMLElement>} params.probabilityInput - The input element for probability.
 */
function handleProbabilityToggleHelper({ probabilityToggle, data, entry, name, probabilityInput }) {
    probabilityToggle.data('uid', entry.uid);
    probabilityToggle.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = $(this).prop('checked');
        data.entries[uid].useProbability = value;
        const probabilityContainer = $(this).closest('.world_entry').find('.probabilityContainer');
        !noSave && await saveWorldInfo(name, data);
        value ? probabilityContainer.show() : probabilityContainer.hide();
        if (value && data.entries[uid].probability === null) {
            data.entries[uid].probability = 100;
        }
        if (!value) {
            data.entries[uid].probability = null;
        }
        probabilityInput.val(data.entries[uid].probability).trigger('input', { noSave });
    });
    probabilityToggle.prop('checked', true).trigger('input', { noSave: true });
    probabilityToggle.parent().hide();
}

/**
 * Helper to handle select2 dropdowns for boolean selects.
 * @param {object} params - Parameters for handling boolean selects.
 * @param {JQuery<HTMLElement>} params.selectElem - The select element for boolean values.
 * @param {object} params.entry - The entry object containing the boolean value.
 * @param {string} params.entryKey - The key in the entry object for the boolean value.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 */
function handleBooleanSelectHelper({ selectElem, entry, entryKey, data, name }) {
    selectElem.data('uid', entry.uid);
    selectElem.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = $(this).val();
        data.entries[uid][entryKey] = value === 'null' ? null : value === 'true';
        setWIOriginalDataValue(data, uid, `extensions.${entryKey.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)}`, data.entries[uid][entryKey]);
        !noSave && await saveWorldInfo(name, data);
    });
    selectElem.val((entry[entryKey] === null || entry[entryKey] === undefined) ? 'null' : entry[entryKey] ? 'true' : 'false').trigger('input', { noSave: true });
}

/**
 * Helper to handle input fields for numbers.
 * @param {object} params - Parameters for handling number inputs.
 * @param {JQuery<HTMLElement>} params.inputElem - The input element for the number.
 * @param {object} params.entry - The entry object containing the number value.
 * @param {string} params.entryKey - The key in the entry object for the number value.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {number} params.min - The minimum value for the number input.
 * @param {number} params.max - The maximum value for the number input.
 * @param {boolean} [params.clamp=false] - Whether to clamp the value within the min and max range.
 */
function handleNumberInputHelper({ inputElem, entry, entryKey, data, name, min, max, clamp = false }) {
    inputElem.data('uid', entry.uid);
    inputElem.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        let value = Number($(this).val());
        if (clamp) {
            if (value < min) {
                value = min;
                $(this).val(min);
            } else if (value > max) {
                value = max;
                $(this).val(max);
            }
        }
        data.entries[uid][entryKey] = !isNaN(value) ? value : null;
        setWIOriginalDataValue(data, uid, `extensions.${entryKey.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)}`, data.entries[uid][entryKey]);
        !noSave && await saveWorldInfo(name, data);
    });
    inputElem.val(entry[entryKey] ?? (clamp ? min : '')).trigger('input', { noSave: true });
}

/**
 * Helper to handle tri-state selector for constant/normal/vectorized.
 * @param {object} params - Parameters for handling the entry state selector.
 * @param {JQuery<HTMLElement>} params.entryStateSelector - The select element for entry state.
 * @param {object} params.entry - The entry object containing the state.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 */
function handleEntryStateSelectorHelper({ entryStateSelector, entry, data, name }) {
    entryStateSelector.data('uid', entry.uid);
    entryStateSelector.on('click', function (event) {
        event.stopPropagation();
    });
    entryStateSelector.on('input', async function (_, { noSave = false } = {}) {
        const uid = entry.uid;
        const value = $(this).val();
        switch (value) {
            case 'constant':
                data.entries[uid].constant = true;
                data.entries[uid].vectorized = false;
                setWIOriginalDataValue(data, uid, 'constant', true);
                setWIOriginalDataValue(data, uid, 'extensions.vectorized', false);
                break;
            case 'normal':
                data.entries[uid].constant = false;
                data.entries[uid].vectorized = false;
                setWIOriginalDataValue(data, uid, 'constant', false);
                setWIOriginalDataValue(data, uid, 'extensions.vectorized', false);
                break;
            case 'vectorized':
                data.entries[uid].constant = false;
                data.entries[uid].vectorized = true;
                setWIOriginalDataValue(data, uid, 'constant', false);
                setWIOriginalDataValue(data, uid, 'extensions.vectorized', true);
                break;
        }
        !noSave && await saveWorldInfo(name, data);
    });
    const entryState = () => entry.constant === true ? 'constant' : entry.vectorized === true ? 'vectorized' : 'normal';
    entryStateSelector.find(`option[value=${entryState()}]`).prop('selected', true).trigger('input', { noSave: true });
}

/**
 * Helper to handle kill switch toggle.
 * @param {object} params - Parameters for handling the kill switch toggle.
 * @param {JQuery<HTMLElement>} params.entryKillSwitch - The toggle element for the kill switch.
 * @param {object} params.entry - The entry object containing the state.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {JQuery<HTMLElement>} params.template - The template element for the entry.
 */
function handleEntryKillSwitchHelper({ entryKillSwitch, entry, data, name, template }) {
    entryKillSwitch.data('uid', entry.uid);
    entryKillSwitch.on('click', async function () {
        const uid = entry.uid;
        data.entries[uid].disable = !data.entries[uid].disable;
        const isActive = !data.entries[uid].disable;
        setWIOriginalDataValue(data, uid, 'enabled', isActive);
        template.toggleClass('disabledWIEntry', !isActive);
        entryKillSwitch.toggleClass('fa-toggle-off', !isActive);
        entryKillSwitch.toggleClass('fa-toggle-on', isActive);
        await saveWorldInfo(name, data);
    });
    const isActive = !entry.disable;
    template.toggleClass('disabledWIEntry', !isActive);
    entryKillSwitch.toggleClass('fa-toggle-off', !isActive);
    entryKillSwitch.toggleClass('fa-toggle-on', isActive);
}

/**
 * Update commentInput's placeholder.
 * @param {string} keys Text to display in commentInput's placeholder.
 * @param {JQuery<HTMLElement>} commentInput The comment input element.
 */
function setCommentPlaceholder(keys, commentInput) {
    // Limit placeholder text to avoid performance issues.
    keys = keys.slice(0, MAX_COMMENT_LENGTH);
    commentInput.attr('placeholder', (keys || t`Entry Title/Memo`));
}

/**
 * Main function to build the WI entry editor template.
 * @param {string} name - The name of the world info file.
 * @param {object} data - The world info data object.
 * @param {object} entry - The entry object to be edited.
 */
export async function getWorldEntry(name, data, entry) {
    if (!data.entries[entry.uid]) return;

    const headerTemplate = WI_ENTRY_HEADER_TEMPLATE.clone();
    headerTemplate.data('uid', entry.uid);
    headerTemplate.attr('uid', entry.uid);

    if (typeof power_user.wi_key_input_plaintext === 'undefined') power_user.wi_key_input_plaintext = true;

    // Comment
    const commentInput = headerTemplate.find('textarea[name="comment"]');

    //Update the commentInput's placeholder.
    const keys = entry['key'].join(', ');
    setCommentPlaceholder(keys, commentInput);

    commentInput.data('uid', entry.uid);
    commentInput.on('input', async function (_, { skipReset = false, noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = $(this).val();
        !skipReset && await resetScrollHeight(this);
        data.entries[uid].comment = value;
        setWIOriginalDataValue(data, uid, 'comment', data.entries[uid].comment);
        !noSave && await saveWorldInfo(name, data);
    });
    commentInput.val(entry.comment).trigger('input', { skipReset: true, noSave: true });

    // Order
    const orderInput = headerTemplate.find('input[name="order"]');
    orderInput.data('uid', entry.uid);
    orderInput.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = Number($(this).val());
        data.entries[uid].order = !isNaN(value) ? value : 0;
        updatePosOrdDisplayHelper({ template: headerTemplate, data, uid });
        setWIOriginalDataValue(data, uid, 'insertion_order', data.entries[uid].order);
        !noSave && await saveWorldInfo(name, data);
    });
    orderInput.val(entry.order).trigger('input', { noSave: true });
    orderInput.css('width', 'calc(3em + 15px)');

    // Probability
    handleProbabilityInputHelper({ probabilityInput: headerTemplate.find('input[name="probability"]'), data, entry, name });

    // Depth
    handleNumberInputHelper({
        inputElem: headerTemplate.find('input[name="depth"]'),
        entry, entryKey: 'depth', data, name, min: 0, max: MAX_SCAN_DEPTH, clamp: false,
    });
    headerTemplate.find('input[name="depth"]').css('width', 'calc(3em + 15px)');

    // Position
    if (entry.position === undefined) entry.position = 0;
    const positionInput = headerTemplate.find('select[name="position"]');
    positionInput.data('uid', entry.uid);
    positionInput.on('click', e => e.stopPropagation());
    positionInput.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = Number($(this).val());
        data.entries[uid].position = !isNaN(value) ? value : 0;
        const depthInput = headerTemplate.find('input[name="depth"]');
        if (value === world_info_position.atDepth) {
            depthInput.prop('disabled', false);
            depthInput.css('visibility', 'visible');
            const role = Number($(this).find(':selected').data('role'));
            data.entries[uid].role = role;
        } else {
            depthInput.prop('disabled', true);
            depthInput.css('visibility', 'hidden');
            data.entries[uid].role = null;
        }
        updatePosOrdDisplayHelper({ template: headerTemplate, data, uid });
        setWIOriginalDataValue(data, uid, 'position', data.entries[uid].position == 0 ? 'before_char' : 'after_char');
        setWIOriginalDataValue(data, uid, 'extensions.position', data.entries[uid].position);
        setWIOriginalDataValue(data, uid, 'extensions.role', data.entries[uid].role);
        !noSave && await saveWorldInfo(name, data);
    });
    const roleValue = entry.position === world_info_position.atDepth ? String(entry.role ?? extension_prompt_roles.SYSTEM) : '';
    headerTemplate.find(`select[name="position"] option[value="${entry.position}"][data-role="${roleValue}"]`).prop('selected', true).trigger('input', { noSave: true });

    // Tri-state selector
    handleEntryStateSelectorHelper({
        entryStateSelector: headerTemplate.find('select[name="entryStateSelector"]'),
        entry, data, name,
    });

    // Kill switch
    handleEntryKillSwitchHelper({
        entryKillSwitch: headerTemplate.find('div[name="entryKillSwitch"]'),
        entry, data, name, template: headerTemplate,
    });

    // Duplicate/delete/move buttons
    headerTemplate.find('.duplicate_entry_button').data('uid', entry.uid).on('click', async function () {
        const uid = $(this).data('uid');
        const entryDup = duplicateWorldInfoEntry(data, uid);
        if (entryDup) {
            await saveWorldInfo(name, data);
            updateEditor(entryDup.uid);
        }
    });
    headerTemplate.find('.delete_entry_button').data('uid', entry.uid).on('click', async function (e) {
        e.stopPropagation();
        const uid = $(this).data('uid');
        const deleted = await deleteWorldInfoEntry(data, uid);
        if (!deleted) return;
        deleteWIOriginalDataValue(data, uid);
        await saveWorldInfo(name, data);
        updateEditor(navigation_option.previous);
    });
    headerTemplate.find('.move_entry_button').attr('data-uid', entry.uid).attr('data-current-world', name).on('click', async function (e) {
        e.stopPropagation();
        const sourceUid = $(this).attr('data-uid');
        const sourceWorld = $(this).attr('data-current-world');
        const sourceWorldInfo = await loadWorldInfo(sourceWorld);
        if (!sourceWorldInfo) return;
        const sourceName = sourceWorldInfo.entries[sourceUid]?.comment;
        if (sourceName === undefined) return;
        const select = document.createElement('select');
        select.id = 'move_entry_target_select';
        select.classList.add('text_pole', 'wide100p', 'marginTop10');
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = `-- ${t`Select Target Lorebook`} --`;
        select.appendChild(defaultOption);
        let selectableWorldCount = 0;
        world_names.forEach(worldName => {
            if (worldName !== sourceWorld) {
                const option = document.createElement('option');
                option.value = world_names.indexOf(worldName).toString();
                option.textContent = worldName;
                select.appendChild(option);
                selectableWorldCount++;
            }
        });
        if (selectableWorldCount === 0) {
            toastr.warning(t`There are no other lorebooks to move to.`);
            return;
        }
        const wrapper = document.createElement('div');
        wrapper.textContent = t`Move/Copy '${sourceName}' to:`;
        const container = document.createElement('div');
        container.appendChild(wrapper);
        container.appendChild(select);
        let selectedWorldIndex = -1;
        select.addEventListener('change', function () {
            selectedWorldIndex = this.value === '' ? -1 : Number(this.value);
        });
        const popup = new Popup(container, POPUP_TYPE.CONFIRM, '', {
            cancelButton: t`Cancel`,
            customButtons: [
                { text: t`Move`, result: POPUP_RESULT.CUSTOM1 },
                { text: t`Copy`, result: POPUP_RESULT.CUSTOM2 },
            ],
        });
        popup.okButton.style.display = 'none'; // Hide the default OK button
        const popupConfirm = await popup.show();
        if (!popupConfirm) return;
        if (selectedWorldIndex === -1) return;
        const selectedValue = world_names[selectedWorldIndex];
        if (!selectedValue) {
            toastr.warning(t`Please select a target lorebook.`);
            return;
        }
        const deleteOriginal = popupConfirm === POPUP_RESULT.CUSTOM1;
        await moveWorldInfoEntry(sourceWorld, selectedValue, sourceUid, { deleteOriginal });
    });

    let drawerInitialized = false;
    let drawerDestroyTimeout = null;
    headerTemplate.find('.inline-drawer').on('inline-drawer-toggle', function () {
        if (drawerDestroyTimeout) {
            clearTimeout(drawerDestroyTimeout);
            drawerDestroyTimeout = null;
        }
        if (drawerInitialized) {
            drawerDestroyTimeout = setTimeout(() => {
                // Drawer was reopened, so we don't destroy it
                if (editOutlet.is(':visible')) {
                    return;
                }
                drawerInitialized = false;
                clearEntryList(editOutlet);
                drawerDestroyTimeout = null;
            }, debounce_timeout.relaxed);
        } else {
            drawerInitialized = true;
            addEditorDrawerContent();
        }
    });

    const editOutlet = headerTemplate.find('.inline-drawer-outlet');

    function addEditorDrawerContent() {
        const editTemplate = WI_ENTRY_EDIT_TEMPLATE.clone();

        // UID display
        editTemplate.find('.world_entry_form_uid_value').text(`(UID: ${entry.uid})`);

        // Key inputs
        const keyInput = enableKeysInputHelper({ template: editTemplate, entry, entryPropName: 'key', originalDataValueName: 'keys', name, data });
        const keySecondaryInput = enableKeysInputHelper({ template: editTemplate, entry, entryPropName: 'keysecondary', originalDataValueName: 'secondary_keys', name, data });
        if (!keyInput.isFancy) initScrollHeight(keyInput.control);
        if (!keySecondaryInput.isFancy) initScrollHeight(keySecondaryInput.control);

        // Key input switch
        editTemplate.find('.switch_input_type_icon').on('click', function () {
            power_user.wi_key_input_plaintext = !power_user.wi_key_input_plaintext;
            saveSettingsDebounced();
            const uid = ($(this).parents('.world_entry')).data('uid');
            updateEditor(uid, false);
            $(`.world_entry[uid="${uid}"] .inline-drawer-icon`).trigger('click');
        }).each((_, icon) => {
            $(icon).attr('title', $(icon).data(power_user.wi_key_input_plaintext ? 'tooltip-on' : 'tooltip-off'));
            $(icon).text($(icon).data(power_user.wi_key_input_plaintext ? 'icon-on' : 'icon-off'));
        });

        // Probability toggle
        handleProbabilityToggleHelper({
            probabilityToggle: editTemplate.find('input[name="useProbability"]'),
            data, entry, name,
            probabilityInput: headerTemplate.find('input[name="probability"]'),
        });

        // Comment toggle
        const commentToggle = editTemplate.find('input[name="addMemo"]');
        commentToggle.data('uid', entry.uid);
        commentToggle.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).prop('checked');
            const commentContainer = $(this).closest('.world_entry').find('.commentContainer');
            data.entries[uid].addMemo = value;
            !noSave && await saveWorldInfo(name, data);
            value ? commentContainer.show() : commentContainer.hide();
        });
        commentToggle.prop('checked', true).trigger('input', { noSave: true });
        commentToggle.parent().hide();

        // Logic AND/NOT
        const selectiveLogicDropdown = editTemplate.find('select[name="entryLogicType"]');
        selectiveLogicDropdown.data('uid', entry.uid);
        selectiveLogicDropdown.on('click', e => e.stopPropagation());
        selectiveLogicDropdown.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = Number($(this).val());
            data.entries[uid].selectiveLogic = !isNaN(value) ? value : world_info_logic.AND_ANY;
            setWIOriginalDataValue(data, uid, 'selectiveLogic', data.entries[uid].selectiveLogic);
            !noSave && await saveWorldInfo(name, data);
        });
        editTemplate.find(`select[name="entryLogicType"] option[value=${entry.selectiveLogic}]`).prop('selected', true).trigger('input', { noSave: true });

        // Selective
        const selectiveInput = editTemplate.find('input[name="selective"]');
        selectiveInput.data('uid', entry.uid);
        selectiveInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).prop('checked');
            data.entries[uid].selective = value;
            setWIOriginalDataValue(data, uid, 'selective', data.entries[uid].selective);
            !noSave && await saveWorldInfo(name, data);
            const keysecondary = $(this).closest('.world_entry').find('.keysecondary');
            const keysecondarytextpole = $(this).closest('.world_entry').find('.keysecondarytextpole');
            const keyprimaryselect = $(this).closest('.world_entry').find('.keyprimaryselect');
            const keyprimaryHeight = keyprimaryselect.outerHeight();
            keysecondarytextpole.css('height', keyprimaryHeight + 'px');
            value ? keysecondary.show() : keysecondary.hide();
        });
        selectiveInput.prop('checked', true).trigger('input', { noSave: true });
        selectiveInput.parent().hide();

        // Character filter
        const characterFilterLabel = editTemplate.find('label[for="characterFilter"] > small');
        characterFilterLabel.text(entry.characterFilter?.isExclude ? 'Exclude Character(s)' : 'Filter to Character(s)');
        const characterExclusionInput = editTemplate.find('input[name="character_exclusion"]');
        characterExclusionInput.data('uid', entry.uid);
        characterExclusionInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).prop('checked');
            characterFilterLabel.text(value ? 'Exclude Character(s)' : 'Filter to Character(s)');
            if (data.entries[uid].characterFilter) {
                if (!value && data.entries[uid].characterFilter.names.length === 0 && data.entries[uid].characterFilter.tags.length === 0) {
                    delete data.entries[uid].characterFilter;
                } else {
                    data.entries[uid].characterFilter.isExclude = value;
                }
            } else if (value) {
                Object.assign(data.entries[uid], { characterFilter: { isExclude: true, names: [], tags: [] } });
            }
            if (data.entries[uid]?.characterFilter?.names?.length > 0) {
                for (const name of [...data.entries[uid].characterFilter.names]) {
                    if (!getContext().characters.find(x => x.avatar.replace(/\.[^/.]+$/, '') === name)) {
                        data.entries[uid].characterFilter.names = data.entries[uid].characterFilter.names.filter(x => x !== name);
                    }
                }
            }
            setWIOriginalDataValue(data, uid, 'character_filter', data.entries[uid].characterFilter);
            !noSave && await saveWorldInfo(name, data);
        });
        characterExclusionInput.prop('checked', entry.characterFilter?.isExclude ?? false).trigger('input', { noSave: true });

        const characterFilter = editTemplate.find('select[name="characterFilter"]');
        characterFilter.data('uid', entry.uid);
        initCharacterFilterSelect2Helper(characterFilter);
        fillCharacterAndTagOptionsHelper({ characterFilter, entry });
        handleCharacterFilterChangeHelper({ characterFilter, data, entry, name });

        // Content
        const counter = editTemplate.find('.world_entry_form_token_counter');
        const countTokensDebounced = debounce(async function (counter, value) {
            const numberOfTokens = await getTokenCountAsync(value);
            $(counter).text(numberOfTokens);
        }, debounce_timeout.relaxed);
        const contentInputId = `world_entry_content_${entry.uid}`;
        const contentInput = editTemplate.find('textarea[name="content"]');
        contentInput.data('uid', entry.uid);
        contentInput.attr('id', contentInputId);
        contentInput.on('input', async function (_, { skipCount, noSave } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).val();
            data.entries[uid].content = value;
            setWIOriginalDataValue(data, uid, 'content', data.entries[uid].content);
            !noSave && await saveWorldInfo(name, data);
            if (!skipCount) countTokensDebounced(counter, value);
        });
        contentInput.val(entry.content).trigger('input', { skipCount: true, noSave: true });
        editTemplate.find('.editor_maximize').attr('data-for', contentInputId);

        // Outlet name
        const outletNameInput = editTemplate.find('input[name="outletName"]');
        outletNameInput.data('uid', entry.uid);
        outletNameInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).val();
            data.entries[uid].outletName = value;
            setWIOriginalDataValue(data, uid, 'extensions.outlet_name', data.entries[uid].outletName);
            !noSave && await saveWorldInfo(name, data);
        });
        outletNameInput.val(entry.outletName ?? '').trigger('input', { noSave: true });
        setTimeout(() => createEntryInputAutocomplete(outletNameInput, getOutletNameCallback(data), { allowMultiple: true }), 1);

        // Scan depth
        const scanDepthInput = editTemplate.find('input[name="scanDepth"]');
        scanDepthInput.data('uid', entry.uid);
        scanDepthInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const isEmpty = $(this).val() === '';
            const value = Number($(this).val());
            if (value < 0) {
                $(this).val(0).trigger('input');
                toastr.warning('Scan depth cannot be negative');
                return;
            }
            if (value > MAX_SCAN_DEPTH) {
                $(this).val(MAX_SCAN_DEPTH).trigger('input');
                toastr.warning(`Scan depth cannot exceed ${MAX_SCAN_DEPTH}`);
                return;
            }
            data.entries[uid].scanDepth = !isEmpty && !isNaN(value) && value >= 0 && value <= MAX_SCAN_DEPTH ? Math.floor(value) : null;
            setWIOriginalDataValue(data, uid, 'extensions.scan_depth', data.entries[uid].scanDepth);
            !noSave && await saveWorldInfo(name, data);
        });
        scanDepthInput.val(entry.scanDepth ?? null).trigger('input', { noSave: true });

        // Group
        const groupInput = editTemplate.find('input[name="group"]');
        groupInput.data('uid', entry.uid);
        groupInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = String($(this).val()).trim();
            data.entries[uid].group = value;
            setWIOriginalDataValue(data, uid, 'extensions.group', data.entries[uid].group);
            !noSave && await saveWorldInfo(name, data);
        });
        groupInput.val(entry.group ?? '').trigger('input', { noSave: true });
        setTimeout(() => createEntryInputAutocomplete(groupInput, getInclusionGroupCallback(data), { allowMultiple: true }), 1);

        // Inclusion priority
        const groupOverrideInput = editTemplate.find('input[name="groupOverride"]');
        groupOverrideInput.data('uid', entry.uid);
        groupOverrideInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).prop('checked');
            data.entries[uid].groupOverride = value;
            setWIOriginalDataValue(data, uid, 'extensions.group_override', data.entries[uid].groupOverride);
            !noSave && await saveWorldInfo(name, data);
        });
        groupOverrideInput.prop('checked', entry.groupOverride).trigger('input', { noSave: true });

        // Group weight
        handleNumberInputHelper({
            inputElem: editTemplate.find('input[name="groupWeight"]'),
            entry, entryKey: 'groupWeight', data, name, min: 1, max: 10000, clamp: true,
        });

        // Sticky, cooldown, delay
        handleNumberInputHelper({
            inputElem: editTemplate.find('input[name="sticky"]'),
            entry, entryKey: 'sticky', data, name, min: 1, max: 10000, clamp: false,
        });
        handleNumberInputHelper({
            inputElem: editTemplate.find('input[name="cooldown"]'),
            entry, entryKey: 'cooldown', data, name, min: 1, max: 10000, clamp: false,
        });
        handleNumberInputHelper({
            inputElem: editTemplate.find('input[name="delay"]'),
            entry, entryKey: 'delay', data, name, min: 1, max: 10000, clamp: false,
        });

        // Exclude/prevent recursion
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'excludeRecursion', data, name });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'preventRecursion', data, name });

        // Delay until recursion
        const delayUntilRecursionInput = editTemplate.find('input[name="delay_until_recursion"]');
        delayUntilRecursionInput.data('uid', entry.uid);
        const delayUntilRecursionLevelInput = editTemplate.find('input[name="delayUntilRecursionLevel"]');
        delayUntilRecursionLevelInput.data('uid', entry.uid);
        delayUntilRecursionInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const toggled = $(this).prop('checked');
            const value = toggled ? data.entries[uid].delayUntilRecursion || true : false;
            if (!toggled) delayUntilRecursionLevelInput.val('');
            data.entries[uid].delayUntilRecursion = value;
            setWIOriginalDataValue(data, uid, 'extensions.delay_until_recursion', data.entries[uid].delayUntilRecursion);
            !noSave && await saveWorldInfo(name, data);
        });
        delayUntilRecursionInput.prop('checked', entry.delayUntilRecursion).trigger('input', { noSave: true });
        delayUntilRecursionLevelInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const content = $(this).val();
            const value = content === '' ? (typeof data.entries[uid].delayUntilRecursion === 'boolean' ? data.entries[uid].delayUntilRecursion : true)
                : content === 1 ? true
                    : !isNaN(Number(content)) ? Number(content)
                        : false;
            data.entries[uid].delayUntilRecursion = value;
            setWIOriginalDataValue(data, uid, 'extensions.delay_until_recursion', data.entries[uid].delayUntilRecursion);
            !noSave && await saveWorldInfo(name, data);
        });
        delayUntilRecursionLevelInput.val(['number', 'string'].includes(typeof entry.delayUntilRecursion) ? entry.delayUntilRecursion : '').trigger('input', { noSave: true });

        // Boolean selects
        handleBooleanSelectHelper({ selectElem: editTemplate.find('select[name="caseSensitive"]'), entry, entryKey: 'caseSensitive', data, name });
        handleBooleanSelectHelper({ selectElem: editTemplate.find('select[name="matchWholeWords"]'), entry, entryKey: 'matchWholeWords', data, name });
        handleBooleanSelectHelper({ selectElem: editTemplate.find('select[name="useGroupScoring"]'), entry, entryKey: 'useGroupScoring', data, name });

        // Match checkboxes
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchPersonaDescription', data, name });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchCharacterDescription', data, name });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchCharacterPersonality', data, name });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchCharacterDepthPrompt', data, name });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchScenario', data, name });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchCreatorNotes', data, name });

        // Automation ID
        const automationIdInput = editTemplate.find('input[name="automationId"]');
        automationIdInput.data('uid', entry.uid);
        automationIdInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).val();
            data.entries[uid].automationId = value;
            setWIOriginalDataValue(data, uid, 'extensions.automation_id', data.entries[uid].automationId);
            !noSave && await saveWorldInfo(name, data);
        });
        automationIdInput.val(entry.automationId ?? '').trigger('input', { noSave: true });
        setTimeout(() => createEntryInputAutocomplete(automationIdInput, getAutomationIdCallback(data)), 1);

        // Generation Type Triggers
        const generationTypeTriggers = editTemplate.find('select[name="triggers"]');
        generationTypeTriggers.data('uid', entry.uid);
        generationTypeTriggers.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).val();
            data.entries[uid].triggers = Array.isArray(value) ? value : [];
            setWIOriginalDataValue(data, uid, 'extensions.triggers', data.entries[uid].triggers);
            !noSave && await saveWorldInfo(name, data);
        });
        if (!isMobile()) {
            generationTypeTriggers.select2({
                placeholder: t`All types (default)`,
                width: '100%',
                closeOnSelect: false,
                allowClear: true,
            });
        }
        generationTypeTriggers
            .val(Array.isArray(entry.triggers) ? entry.triggers : [])
            .trigger('input', { noSave: true })
            .trigger('change');

        // Ignore budget
        const ignoreBudgetInput = editTemplate.find('input[name="ignoreBudget"]');
        ignoreBudgetInput.data('uid', entry.uid);
        ignoreBudgetInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).prop('checked');
            data.entries[uid].ignoreBudget = value;
            setWIOriginalDataValue(data, uid, 'extensions.ignore_budget', data.entries[uid].ignoreBudget);
            !noSave && await saveWorldInfo(name, data);
        });
        ignoreBudgetInput.prop('checked', entry.ignoreBudget ?? false).trigger('input', { noSave: true });

        countTokensDebounced(counter, contentInput.val());

        editTemplate.find('.inline-drawer-content').css('display', 'none');
        editOutlet.append(editTemplate);
    }

    headerTemplate.find('.inline-drawer-content').css('display', 'none');

    return headerTemplate;
}


/**
 * Builds a jQuery UI autocomplete callback: (control, request, response) => void
 * @param {object} [opt={}] - Optional arguments
 * @param {{entries: Record<string, any>}} [opt.data]   - Your WI data
 * @param {(entry:any)=>string|string[]|null|undefined} [opt.collectValues] - Extract values from one entry
 * @param {() => Iterable<string>} [opt.includeExtras] - Optional global extras to include
 * @param {(ctx:{result:string[], control:JQuery, input:any, haystack:string[]})=>string[]} [opt.postFilter] - Optional final filter step (for special rules like your "group" de-dupe logic)
 */
function buildAutocompleteCallback({ data, collectValues, includeExtras = () => [], postFilter } = {}) {
    return function (control, input, output) {
        const uid = $(control).data('uid');

        // Collect unique values from all *other* entries
        const values = new Set();
        for (const entry of Object.values(data.entries ?? {})) {
            if (entry?.uid == uid) continue;
            const raw = collectValues(entry);
            if (raw == null) continue;
            const arr = Array.isArray(raw) ? raw : [raw];
            for (const v of arr) {
                const s = String(v).trim();
                if (s) values.add(s);
            }
        }

        // Add optional global extras
        for (const v of includeExtras()) {
            const s = String(v).trim();
            if (s) values.add(s);
        }

        // Sort stable & locale-aware
        const haystack = Array.from(values).sort((a, b) => a.localeCompare(b));

        // Case-insensitive contains
        const needle = String(input.term ?? '').toLowerCase();
        let result = haystack.filter(x => x.toLowerCase().includes(needle));

        // Optional final-pass semantics
        if (postFilter) {
            result = postFilter({ result, control: $(control), input, haystack });
        }

        output(result);
    };
}

/**
 * Splits a string into an array of strings, separated by commas and trimmed
 * @param {string} s - The string to split
 * @returns {string[]} An array of strings, separated by commas and trimmed
 */
const splitCsv = s => String(s ?? '').split(/,\s*/).filter(Boolean);

/**
 * Get the inclusion groups for the autocomplete.
 * @param {any} data WI data
 * @returns {(input: any, output: any) => any} Callback function for the autocomplete
 */
function getInclusionGroupCallback(data) {
    return buildAutocompleteCallback({
        data,
        collectValues: entry => entry.group ? splitCsv(entry.group) : [],
        postFilter: ({ result, control, input, haystack }) => {
            const thisGroups = splitCsv(String($(control).val()));
            const needle = String(input.term ?? '').toLowerCase();
            const hasExactMatch = haystack.some(x => x.toLowerCase() === needle);

            // include suggestion if it contains the needle AND
            // (not already present OR (exact match typed && appears only once))
            return result.filter(x =>
                !thisGroups.includes(x) ||
                (hasExactMatch && thisGroups.filter(g => g === x).length === 1),
            );
        },
    });
}

function getAutomationIdCallback(data) {
    return buildAutocompleteCallback({
        data,
        collectValues: entry => entry.automationId != null ? [String(entry.automationId)] : [],
        includeExtras: () =>
            ('quickReplyApi' in globalThis && globalThis.quickReplyApi?.listAutomationIds)
                ? globalThis.quickReplyApi.listAutomationIds()
                : [],
    });
}

function getOutletNameCallback(data) {
    return buildAutocompleteCallback({
        data,
        collectValues: entry => entry.position === world_info_position.outlet && entry.outletName ? [entry.outletName] : [],
    });
}

/**
 * Create an autocomplete for an input element.
 * @param {JQuery<HTMLElement>} input - Input element to attach the autocomplete to
 * @param {(control: JQuery<HTMLElement>, input: any, output: any) => any} callback - Source data callbacks
 * @param {object} [options={}] - Optional arguments
 * @param {boolean} [options.allowMultiple=false] - Whether to allow multiple comma-separated values
 */
function createEntryInputAutocomplete(input, callback, { allowMultiple = false } = {}) {
    const handleSelect = (event, ui) => {
        // Prevent default autocomplete select, so we can manually set the value
        event.preventDefault();
        if (!allowMultiple) {
            $(input).val(ui.item.value).trigger('input').trigger('blur');
        } else {
            var terms = String($(input).val()).split(/,\s*/);
            terms.pop(); // remove the current input
            terms.push(ui.item.value); // add the selected item
            $(input).val(terms.filter(x => x).join(', ')).trigger('input').trigger('blur');
        }
    };

    $(input).autocomplete({
        minLength: 0,
        source: function (request, response) {
            if (!allowMultiple) {
                callback(input, request, response);
            } else {
                const term = request.term.split(/,\s*/).pop();
                request.term = term;
                callback(input, request, response);
            }
        },
        select: handleSelect,
    });

    $(input).on('focus click', function () {
        $(input).autocomplete('search', allowMultiple ? String($(input).val()).split(/,\s*/).pop() : String($(input).val()));
    });
}


/**
 * Duplicate a WI entry by copying all of its properties and assigning a new uid
 * @param {*} data - The data of the book
 * @param {number} uid - The uid of the entry to copy in this book
 * @returns {*} The new WI duplicated entry
 */
export function duplicateWorldInfoEntry(data, uid) {
    if (!data || !('entries' in data) || !data.entries[uid]) {
        return;
    }

    // Exclude uid and gather the rest of the properties
    const originalData = structuredClone(data.entries[uid]);
    delete originalData.uid;

    // Create new entry and copy over data
    const entry = createWorldInfoEntry(data.name, data);
    Object.assign(entry, originalData);

    return entry;
}

/**
 * Deletes a WI entry, with a user confirmation dialog
 * @param {*[]} data - The data of the book
 * @param {number} uid - The uid of the entry to copy in this book
 * @param {object} [options={}] - Optional arguments
 * @param {boolean} [options.silent=false] - Whether to prompt the user for deletion or just do it
 * @returns {Promise<boolean>} Whether the entry deletion was successful
 */
export async function deleteWorldInfoEntry(data, uid, { silent = false } = {}) {
    if (!data || !('entries' in data)) {
        return;
    }

    const confirmation = silent || await Popup.show.confirm(t`Delete the entry with UID: ${uid}?`, t`This action is irreversible!`);
    if (!confirmation) {
        return false;
    }

    delete data.entries[uid];
    return true;
}

/**
 * Definitions of types for new WI entries
 *
 * Use `newEntryTemplate` if you just need the template that contains default values
 *
 * @type {{[key: string]: WIEntryFieldDefinition}}
 */
export const newWorldInfoEntryDefinition = {
    key: { default: [], type: 'array' },
    keysecondary: { default: [], type: 'array' },
    comment: { default: '', type: 'string' },
    content: { default: '', type: 'string' },
    constant: { default: false, type: 'boolean' },
    vectorized: { default: false, type: 'boolean' },
    selective: { default: true, type: 'boolean' },
    selectiveLogic: { default: world_info_logic.AND_ANY, type: 'enum' },
    addMemo: { default: false, type: 'boolean' },
    order: { default: 100, type: 'number' },
    position: { default: 0, type: 'number' },
    disable: { default: false, type: 'boolean' },
    ignoreBudget: { default: false, type: 'boolean' },
    excludeRecursion: { default: false, type: 'boolean' },
    preventRecursion: { default: false, type: 'boolean' },
    matchPersonaDescription: { default: false, type: 'boolean' },
    matchCharacterDescription: { default: false, type: 'boolean' },
    matchCharacterPersonality: { default: false, type: 'boolean' },
    matchCharacterDepthPrompt: { default: false, type: 'boolean' },
    matchScenario: { default: false, type: 'boolean' },
    matchCreatorNotes: { default: false, type: 'boolean' },
    delayUntilRecursion: { default: 0, type: 'number' },
    probability: { default: 100, type: 'number' },
    useProbability: { default: true, type: 'boolean' },
    depth: { default: DEFAULT_DEPTH, type: 'number' },
    outletName: { default: '', type: 'string' },
    group: { default: '', type: 'string' },
    groupOverride: { default: false, type: 'boolean' },
    groupWeight: { default: DEFAULT_WEIGHT, type: 'number' },
    scanDepth: { default: null, type: 'number?' },
    caseSensitive: { default: null, type: 'boolean?' },
    matchWholeWords: { default: null, type: 'boolean?' },
    useGroupScoring: { default: null, type: 'boolean?' },
    automationId: { default: '', type: 'string' },
    role: { default: 0, type: 'enum' },
    sticky: { default: null, type: 'number?' },
    cooldown: { default: null, type: 'number?' },
    delay: { default: null, type: 'number?' },
    characterFilterNames: { default: [], type: 'array', excludeFromTemplate: true },
    characterFilterTags: { default: [], type: 'array', excludeFromTemplate: true },
    characterFilterExclude: { default: false, type: 'boolean', excludeFromTemplate: true },
    triggers: { default: [], type: 'array', arrayFilter: (value) => GENERATION_TYPE_TRIGGERS.includes(value) },
};

export const newWorldInfoEntryTemplate = Object.fromEntries(
    Object.entries(newWorldInfoEntryDefinition).filter(([_, value]) => !value.excludeFromTemplate).map(([key, value]) => [key, value.default]),
);

/**
 * Creates a new world info entry from template.
 * @param {string} _name Name of the WI (unused)
 * @param {any} data WI data
 * @returns {object | undefined} New entry object or undefined if failed
 */
export function createWorldInfoEntry(_name, data) {
    const newUid = getFreeWorldEntryUid(data);

    if (!Number.isInteger(newUid)) {
        console.error('Couldn\'t assign UID to a new entry');
        return;
    }

    const newEntry = { uid: newUid, ...structuredClone(newWorldInfoEntryTemplate) };
    data.entries[newUid] = newEntry;

    return newEntry;
}

async function _save(name, data) {
    // Prevent double saving if both immediate and debounced save are called
    cancelDebounce(saveWorldDebounced);

    console.log('[wi _save] name:', JSON.stringify(name), '| has data:', !!data, '| has entries:', !!(data?.entries), '| entries count:', Object.keys(data?.entries || {}).length);

    const response = await fetch('/api/worldinfo/edit', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: name, data: data }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '(no body)');
        console.error('[wi _save] FAILED', response.status, response.statusText, '| server said:', body);
    }
    await eventSource.emit(event_types.WORLDINFO_UPDATED, name, data);
}


/**
 * Saves the world info
 *
 * This will also refresh the `worldInfoCache`.
 * Note, for performance reasons the saved cache will not make a deep clone of the data.
 * It is your responsibility to not modify the saved data object after calling this function, or there will be data inconsistencies.
 * Call `loadWorldInfoData` or query directly from cache if you need the object again.
 *
 * @param {string} name - The name of the world info
 * @param {any} data - The data to be saved
 * @param {boolean} [immediately=false] - Whether to save immediately or use debouncing
 * @return {Promise<void>} A promise that resolves when the world info is saved
 */
export async function saveWorldInfo(name, data, immediately = false) {
    if (!name || !data) {
        return;
    }

    // Update cache immediately, so any future call can pull from this
    worldInfoCache.set(name, data);

    if (immediately) {
        return await _save(name, data);
    }

    saveWorldDebounced(name, data);
}

async function renameWorldInfo(name, data) {
    const oldName = name;
    const newName = await Popup.show.input('Rename World Info', 'Enter a new name:', oldName);

    if (oldName === newName || !newName) {
        console.debug('World info rename cancelled');
        return;
    }
    if (equalsIgnoreCaseAndAccents(oldName, newName)) {
        toastr.warning(t`Name not accepted, as it is the same as before (ignoring case and accents).`, t`Rename World Info`);
        return;
    }

    const entryPreviouslySelected = selected_world_info.findIndex((e) => e === oldName);

    await saveWorldInfo(newName, data, true);
    await deleteWorldInfo(oldName);

    const existingCharLores = world_info.charLore?.filter((e) => e.extraBooks.includes(oldName));
    if (existingCharLores && existingCharLores.length > 0) {
        existingCharLores.forEach((charLore) => {
            const tempCharLore = charLore.extraBooks.filter((e) => e !== oldName);
            tempCharLore.push(newName);
            charLore.extraBooks = tempCharLore;
        });
        saveSettingsDebounced();
    }

    if (entryPreviouslySelected !== -1) {
        const wiElement = getWIElement(newName);
        wiElement.prop('selected', true);
        $('#world_info').trigger('change');
    }

    const selectedIndex = world_names.indexOf(newName);
    if (selectedIndex !== -1) {
        $('#world_editor_select').val(selectedIndex).trigger('change');
    }
}

/**
 * Deletes a world info with the given name
 *
 * @param {string} worldInfoName - The name of the world info to delete
 * @returns {Promise<boolean>} A promise that resolves to true if the world info was successfully deleted, false otherwise
 */
export async function deleteWorldInfo(worldInfoName) {
    if (!world_names.includes(worldInfoName)) {
        return false;
    }

    const response = await fetch('/api/worldinfo/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: worldInfoName }),
    });

    if (!response.ok) {
        return false;
    }

    if (worldInfoCache.has(worldInfoName)) {
        worldInfoCache.delete(worldInfoName);
    }

    const existingWorldIndex = selected_world_info.findIndex((e) => e === worldInfoName);
    if (existingWorldIndex !== -1) {
        selected_world_info.splice(existingWorldIndex, 1);
        saveSettingsDebounced();
    }

    await updateWorldInfoList();
    $('#world_editor_select').trigger('change');

    if ($('#character_world').val() === worldInfoName) {
        $('#character_world').val('').trigger('change');
        $('#character_world_unlink').val('true');
        setWorldInfoButtonClass(undefined, false);
        if (menu_type != 'create') {
            saveCharacterDebounced();
        }
    }

    if (power_user.persona_description_lorebook === worldInfoName) {
        power_user.persona_description_lorebook = '';
        if (power_user.personas[user_avatar]) {
            const object = getOrCreatePersonaDescriptor();
            object.lorebook = '';
        }
        $('#persona_lore_button').toggleClass('world_set', false);
        saveSettingsDebounced();
    }

    return true;
}

export function getFreeWorldEntryUid(data) {
    if (!data || !('entries' in data)) {
        return null;
    }

    const MAX_UID = 1_000_000; // <- should be safe enough :)
    for (let uid = 0; uid < MAX_UID; uid++) {
        if (uid in data.entries) {
            continue;
        }
        return uid;
    }

    return null;
}

export function getFreeWorldName() {
    const MAX_FREE_NAME = 100_000;
    for (let index = 1; index < MAX_FREE_NAME; index++) {
        const newName = `New World (${index})`;
        if (world_names.includes(newName)) {
            continue;
        }
        return newName;
    }

    return undefined;
}

/**
 * Creates a new world info/lorebook with the given name.
 * Checks if a world with the same name already exists, providing a warning or optionally a user confirmation dialog.
 *
 * @param {string} worldName - The name of the new world info
 * @param {Object} options - Optional parameters
 * @param {boolean} [options.interactive=false] - Whether to show a confirmation dialog when overwriting an existing world
 * @returns {Promise<boolean>} - True if the world info was successfully created, false otherwise
 */
export async function createNewWorldInfo(worldName, { interactive = false } = {}) {
    const worldInfoTemplate = { entries: {} };

    if (!worldName) {
        return false;
    }

    const sanitizedWorldName = await getSanitizedFilename(worldName);

    const allowed = await checkOverwriteExistingData('World Info', world_names, sanitizedWorldName, { interactive: interactive, actionName: 'Create', deleteAction: (existingName) => deleteWorldInfo(existingName) });
    if (!allowed) {
        return false;
    }

    await saveWorldInfo(worldName, worldInfoTemplate, true);
    await updateWorldInfoList();

    const selectedIndex = world_names.indexOf(worldName);
    if (selectedIndex !== -1) {
        $('#world_editor_select').val(selectedIndex).trigger('change');
    } else {
        await hideWorldEditor();
    }

    return true;
}

async function getCharacterLore() {
    const character = characters[this_chid];
    const name = character?.name;
    /** @type {Set<string>} */
    let worldsToSearch = new Set();

    const baseWorldName = character?.data?.extensions?.world;
    if (baseWorldName) {
        worldsToSearch.add(baseWorldName);
    }

    const fileName = getCharaFilename(this_chid);
    const extraWorldBooks = getCharacterAuxWorldBooks(character, fileName);
    const chatWorlds = getChatLorebooks();
    if (extraWorldBooks.length > 0) {
        worldsToSearch = new Set([...worldsToSearch, ...extraWorldBooks]);
    }

    if (!worldsToSearch.size) {
        return [];
    }

    let entries = [];
    for (const worldName of worldsToSearch) {
        if (selected_world_info.includes(worldName)) {
            console.debug(`[WI] Character ${name}'s world ${worldName} is already activated in global world info! Skipping...`);
            continue;
        }

        if (chatWorlds.includes(worldName)) {
            console.debug(`[WI] Character ${name}'s world ${worldName} is already activated in chat lore! Skipping...`);
            continue;
        }

        if (power_user.persona_description_lorebook === worldName) {
            console.debug(`[WI] Character ${name}'s world ${worldName} is already activated in persona lore! Skipping...`);
            continue;
        }

        const data = await loadWorldInfo(worldName);
        const newEntries = mapLoadedWorldInfoEntries(data, worldName);
        entries = entries.concat(newEntries);

        if (!newEntries.length) {
            console.debug(`[WI] Character ${name}'s world ${worldName} could not be found or is empty`);
        }
    }

    console.debug(`[WI] Character ${name}'s lore has ${entries.length} world info entries`, [...worldsToSearch]);
    return entries;
}

async function getGlobalLore() {
    if (!selected_world_info?.length) {
        return [];
    }

    let entries = [];
    for (const worldName of selected_world_info) {
        const data = await loadWorldInfo(worldName);
        const newEntries = mapLoadedWorldInfoEntries(data, worldName);
        entries = entries.concat(newEntries);
    }

    console.debug(`[WI] Global world info has ${entries.length} entries`, selected_world_info);

    return entries;
}

async function getChatLore() {
    const chatWorlds = getChatLorebooks();

    if (chatWorlds.length === 0) {
        return [];
    }

    let entries = [];
    for (const chatWorld of chatWorlds) {
        if (selected_world_info.includes(chatWorld)) {
            console.debug(`[WI] Chat world ${chatWorld} is already activated in global world info! Skipping...`);
            continue;
        }

        const data = await loadWorldInfo(chatWorld);
        const newEntries = mapLoadedWorldInfoEntries(data, chatWorld);
        entries = entries.concat(newEntries);
    }

    console.debug(`[WI] Chat lore has ${entries.length} entries`, chatWorlds);

    return entries;
}

async function getPersonaLore() {
    const chatWorlds = getChatLorebooks();
    const personaWorld = power_user.persona_description_lorebook;

    if (!personaWorld) {
        return [];
    }

    if (chatWorlds.includes(personaWorld)) {
        console.debug(`[WI] Persona world ${personaWorld} is already activated in chat world! Skipping...`);
        return [];
    }

    if (selected_world_info.includes(personaWorld)) {
        console.debug(`[WI] Persona world ${personaWorld} is already activated in global world info! Skipping...`);
        return [];
    }

    const data = await loadWorldInfo(personaWorld);
    const entries = mapLoadedWorldInfoEntries(data, personaWorld);

    console.debug(`[WI] Persona lore has ${entries.length} entries`, [personaWorld]);

    return entries;
}

export async function getSortedEntries() {
    try {
        const [
            globalLore,
            characterLore,
            chatLore,
            personaLore,
        ] = await Promise.all([
            getGlobalLore(),
            getCharacterLore(),
            getChatLore(),
            getPersonaLore(),
        ]);

        await eventSource.emit(event_types.WORLDINFO_ENTRIES_LOADED, { globalLore, characterLore, chatLore, personaLore });

        let entries;

        switch (Number(world_info_character_strategy)) {
            case world_info_insertion_strategy.evenly:
                entries = [...globalLore, ...characterLore].sort(sortFn);
                break;
            case world_info_insertion_strategy.character_first:
                entries = [...characterLore.sort(sortFn), ...globalLore.sort(sortFn)];
                break;
            case world_info_insertion_strategy.global_first:
                entries = [...globalLore.sort(sortFn), ...characterLore.sort(sortFn)];
                break;
            default:
                console.error('[WI] Unknown WI insertion strategy:', world_info_character_strategy, 'defaulting to evenly');
                entries = [...globalLore, ...characterLore].sort(sortFn);
                break;
        }

        // Chat lore always goes first, then persona lore, then the rest
        entries = [...chatLore.sort(sortFn), ...personaLore.sort(sortFn), ...entries];

        // Calculate hash and parse decorators. Split maps to preserve old hashes.
        entries = entries.map((entry) => {
            const [decorators, content] = parseDecorators(entry.content || '');
            return { ...entry, decorators, content };
        }).map((entry) => {
            const hash = getStringHash(JSON.stringify(entry));
            return { ...entry, hash };
        });

        console.debug(`[WI] Found ${entries.length} world lore entries. Sorted by strategy`, Object.entries(world_info_insertion_strategy).find((x) => x[1] === world_info_character_strategy));

        // Need to deep clone the entries to avoid modifying the cached data
        return structuredClone(entries);
    }
    catch (e) {
        console.error(e);
        return [];
    }
}


/**
 * Parse decorators from worldinfo content
 * @param {string} content The content to parse
 * @returns {[string[],string]} The decorators found in the content and the content without decorators
*/
function parseDecorators(content) {
    /**
     * Check if the decorator is known
     * @param {string} data string to check
     * @returns {boolean} true if the decorator is known
    */
    const isKnownDecorator = (data) => {
        if (data.startsWith('@@@')) {
            data = data.substring(1);
        }

        for (let i = 0; i < KNOWN_DECORATORS.length; i++) {
            if (data.startsWith(KNOWN_DECORATORS[i])) {
                return true;
            }
        }
        return false;
    };

    if (content.startsWith('@@')) {
        let newContent = content;
        const splited = content.split('\n');
        let decorators = [];
        let fallbacked = false;

        for (let i = 0; i < splited.length; i++) {
            if (splited[i].startsWith('@@')) {
                if (splited[i].startsWith('@@@') && !fallbacked) {
                    continue;
                }

                if (isKnownDecorator(splited[i])) {
                    decorators.push(splited[i].startsWith('@@@') ? splited[i].substring(1) : splited[i]);
                    fallbacked = false;
                }
                else {
                    fallbacked = true;
                }
            } else {
                newContent = splited.slice(i).join('\n');
                break;
            }
        }
        return [decorators, newContent];
    }

    return [[], content];

}

/**
 * Performs a scan on the chat and returns the world info activated.
 * @param {string[]} chat The chat messages to scan, in reverse order.
 * @param {number} maxContext The maximum context size of the generation.
 * @param {boolean} isDryRun Whether to perform a dry run.
 * @param {WIGlobalScanData} globalScanData Chat independent context to be scanned
 * @returns {Promise<WIActivated>} The world info activated.
 */
//MARK: checkWorldInfo
export async function checkWorldInfo(chat, maxContext, isDryRun, globalScanData = defaultGlobalScanData) {
    const context = getContext();
    const buffer = new WorldInfoBuffer(chat, globalScanData);

    console.debug(`[WI] --- START WI SCAN (on ${chat.length} messages, trigger = ${globalScanData.trigger})${isDryRun ? ' (DRY RUN)' : ''} ---`);

    // Combine the chat

    // Add the depth or AN if enabled
    // Put this code here since otherwise, the chat reference is modified
    for (const key of Object.keys(context.extensionPrompts)) {
        if (context.extensionPrompts[key]?.scan) {
            const prompt = await getExtensionPromptByName(key);
            if (prompt) {
                buffer.addInject(prompt);
            }
        }
    }

    /** @type {scan_state} */
    let scanState = scan_state.INITIAL;
    let token_budget_overflowed = false;
    let count = 0;
    let allActivatedEntries = new Map();
    let failedProbabilityChecks = new Set();
    let allActivatedText = '';

    // Track lore entries excluded due to budget limits
    const loreExclusionInfo = {
        totalEntriesScanned: 0,
        entriesActivated: 0,
        entriesExcludedByBudget: 0,
        budgetExceededAt: null,
    };

    let budget = Math.round(world_info_budget * maxContext / 100) || 1;

    if (world_info_budget_cap > 0 && budget > world_info_budget_cap) {
        console.debug(`[WI] Budget ${budget} exceeds cap ${world_info_budget_cap}, using cap`);
        budget = world_info_budget_cap;
    }

    console.debug(`[WI] Context size: ${maxContext}; WI budget: ${budget} (max% = ${world_info_budget}%, cap = ${world_info_budget_cap})`);
    const sortedEntries = await getSortedEntries();
    const timedEffects = new WorldInfoTimedEffects(chat, sortedEntries, isDryRun);

    timedEffects.checkTimedEffects();

    if (sortedEntries.length === 0) {
        return { worldInfoBefore: '', worldInfoAfter: '', WIDepthEntries: [], EMEntries: [], ANBeforeEntries: [], ANAfterEntries: [], outletEntries: {}, allActivatedEntries: new Set() };
    }

    /** @type {number[]} Represents the delay levels for entries that are delayed until recursion */
    const availableRecursionDelayLevels = [...new Set(sortedEntries
        .filter(entry => entry.delayUntilRecursion)
        .map(entry => entry.delayUntilRecursion === true ? 1 : entry.delayUntilRecursion),
    )].sort((a, b) => a - b);
    // Already preset with the first level
    let currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0;
    if (currentRecursionDelayLevel > 0 && availableRecursionDelayLevels.length) {
        console.debug('[WI] Preparing first delayed recursion level', currentRecursionDelayLevel, '. Still delayed:', availableRecursionDelayLevels);
    }

    console.debug(`[WI] --- SEARCHING ENTRIES (on ${sortedEntries.length} entries) ---`);

    while (scanState) {
        //if world_info_max_recursion_steps is non-zero min activations are disabled, and vice versa
        if (world_info_max_recursion_steps && world_info_max_recursion_steps <= count) {
            console.debug('[WI] Search stopped by reaching max recursion steps', world_info_max_recursion_steps);
            break;
        }

        // Track how many times the loop has run. May be useful for debugging.
        count++;

        console.debug(`[WI] --- LOOP #${count} START ---`);
        console.debug('[WI] Scan state', Object.entries(scan_state).find(x => x[1] === scanState));

        // Until decided otherwise, we set the loop to stop scanning after this
        let nextScanState = scan_state.NONE;

        // Loop and find all entries that can activate here
        let activatedNow = new Set();

        for (const entry of sortedEntries) {
            // Logging preparation
            let headerLogged = false;
            function log(...args) {
                if (!headerLogged) {
                    console.debug(
                        `[WI] Entry ${entry.uid}`,
                        `from '${entry.world}' processing`,
                        sanitizeWorldInfoEntryForClient(entry),
                    );
                    headerLogged = true;
                }
                console.debug(`[WI] Entry ${entry.uid}`, ...args);
            }

            // Already processed, considered and then skipped entries should still be skipped
            if (failedProbabilityChecks.has(entry) || allActivatedEntries.has(`${entry.world}.${entry.uid}`)) {
                continue;
            }

            if (entry.disable == true) {
                log('disabled');
                continue;
            }

            // Check for generation type trigger filter
            if (Array.isArray(entry.triggers) && entry.triggers.length > 0) {
                const isTriggered = entry.triggers.includes(globalScanData.trigger);
                if (!isTriggered) {
                    log(`skipped by generation type trigger filter (${globalScanData.trigger} ∉ ${entry.triggers})`);
                    continue;
                }
            }

            // Check if this entry applies to the character or if it's excluded
            if (entry.characterFilter && entry.characterFilter?.names?.length > 0) {
                const nameIncluded = entry.characterFilter.names.includes(getCharaFilename());
                const filtered = entry.characterFilter.isExclude ? nameIncluded : !nameIncluded;

                if (filtered) {
                    log('filtered out by character');
                    continue;
                }
            }

            if (entry.characterFilter && entry.characterFilter?.tags?.length > 0) {
                const tagKey = getTagKeyForEntity(this_chid);

                if (tagKey) {
                    const tagMapEntry = context.tagMap[tagKey];

                    if (Array.isArray(tagMapEntry)) {
                        // If tag map intersects with the tag exclusion list, skip
                        const includesTag = tagMapEntry.some((tag) => entry.characterFilter.tags.includes(tag));
                        const filtered = entry.characterFilter.isExclude ? includesTag : !includesTag;

                        if (filtered) {
                            log('filtered out by tag');
                            continue;
                        }
                    }
                }
            }

            const isSticky = timedEffects.isEffectActive('sticky', entry);
            const isCooldown = timedEffects.isEffectActive('cooldown', entry);
            const isDelay = timedEffects.isEffectActive('delay', entry);

            if (isDelay) {
                log('suppressed by delay');
                continue;
            }

            if (isCooldown && !isSticky) {
                log('suppressed by cooldown');
                continue;
            }

            // Only use checks for recursion flags if the scan step was activated by recursion
            if (scanState !== scan_state.RECURSION && entry.delayUntilRecursion && !isSticky) {
                log('suppressed by delay until recursion');
                continue;
            }

            if (scanState === scan_state.RECURSION && entry.delayUntilRecursion && entry.delayUntilRecursion > currentRecursionDelayLevel && !isSticky) {
                log('suppressed by delay until recursion level', entry.delayUntilRecursion, '. Currently', currentRecursionDelayLevel);
                continue;
            }

            if (scanState === scan_state.RECURSION && world_info_recursive && entry.excludeRecursion && !isSticky) {
                log('suppressed by exclude recursion');
                continue;
            }

            if (entry.decorators.includes('@@activate')) {
                log('activated by @@activate decorator');
                activatedNow.add(entry);
                continue;
            }

            if (entry.decorators.includes('@@dont_activate')) {
                log('suppressed by @@dont_activate decorator');
                continue;
            }

            if (buffer.getExternallyActivated(entry)) {
                log('externally activated');
                activatedNow.add(buffer.getExternallyActivated(entry));
                continue;
            }

            // Now do checks for immediate activations
            if (entry.constant) {
                log('activated because of constant');
                activatedNow.add(entry);
                continue;
            }

            if (isSticky) {
                log('activated because active sticky');
                activatedNow.add(entry);
                continue;
            }

            if (!Array.isArray(entry.key) || !entry.key.length) {
                log('has no keys defined, skipped');
                continue;
            }

            // Cache the text to scan before the loop, it won't change its content
            const textToScan = buffer.get(entry, scanState);

            // PRIMARY KEYWORDS
            let primaryKeyMatch = entry.key.find(key => {
                const substituted = substituteParams(key);
                return substituted && buffer.matchKeys(textToScan, substituted.trim(), entry);
            });

            if (!primaryKeyMatch) {
                // Don't write logs for simple no-matches
                continue;
            }

            const hasSecondaryKeywords = (
                entry.selective && //all entries are selective now
                Array.isArray(entry.keysecondary) && //always true
                entry.keysecondary.length //ignore empties
            );

            if (!hasSecondaryKeywords) {
                // Handle cases where secondary is empty
                log('activated by primary key match', primaryKeyMatch);
                activatedNow.add(entry);
                continue;
            }


            // SECONDARY KEYWORDS
            const selectiveLogic = entry.selectiveLogic ?? 0; // If selectiveLogic isn't found, assume it's AND, only do this once per entry
            log('Entry with primary key match', primaryKeyMatch, 'has secondary keywords. Checking with logic logic', Object.entries(world_info_logic).find(x => x[1] === entry.selectiveLogic));

            /** @type {() => boolean} */
            function matchSecondaryKeys() {
                let hasAnyMatch = false;
                let hasAllMatch = true;
                for (let keysecondary of entry.keysecondary) {
                    const secondarySubstituted = substituteParams(keysecondary);
                    const hasSecondaryMatch = secondarySubstituted && buffer.matchKeys(textToScan, secondarySubstituted.trim(), entry);

                    if (hasSecondaryMatch) hasAnyMatch = true;
                    if (!hasSecondaryMatch) hasAllMatch = false;

                    // Simplified AND ANY / NOT ALL if statement. (Proper fix for PR#1356 by Bronya)
                    // If AND ANY logic and the main checks pass OR if NOT ALL logic and the main checks do not pass
                    if (selectiveLogic === world_info_logic.AND_ANY && hasSecondaryMatch) {
                        log('activated. (AND ANY) Found match secondary keyword', secondarySubstituted);
                        return true;
                    }
                    if (selectiveLogic === world_info_logic.NOT_ALL && !hasSecondaryMatch) {
                        log('activated. (NOT ALL) Found not matching secondary keyword', secondarySubstituted);
                        return true;
                    }
                }

                // Handle NOT ANY logic
                if (selectiveLogic === world_info_logic.NOT_ANY && !hasAnyMatch) {
                    log('activated. (NOT ANY) No secondary keywords found', entry.keysecondary);
                    return true;
                }

                // Handle AND ALL logic
                if (selectiveLogic === world_info_logic.AND_ALL && hasAllMatch) {
                    log('activated. (AND ALL) All secondary keywords found', entry.keysecondary);
                    return true;
                }

                return false;
            }

            const matched = matchSecondaryKeys();
            if (!matched) {
                log('skipped. Secondary keywords not satisfied', entry.keysecondary);
                continue;
            }

            // Success logging was already done inside the function, so just add the entry
            activatedNow.add(entry);
            continue;
        }

        console.debug(`[WI] Search done. Found ${activatedNow.size} possible entries.`);

        // Sort the entries for the probability and the budget limit checks
        const newEntries = [...activatedNow]
            .sort((a, b) => {
                const isASticky = timedEffects.isEffectActive('sticky', a) ? 1 : 0;
                const isBSticky = timedEffects.isEffectActive('sticky', b) ? 1 : 0;
                return isBSticky - isASticky || sortedEntries.indexOf(a) - sortedEntries.indexOf(b);
            });


        let newContent = '';
        const textToScanTokens = await getTokenCountAsync(allActivatedText);

        filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);

        console.debug('[WI] --- PROBABILITY CHECKS ---');
        !newEntries.length && console.debug('[WI] No probability checks to do');

        let ignoresBudget = newEntries.filter(e => e.ignoreBudget).length;

        for (const entry of newEntries) {
            ignoresBudget -= (entry.ignoreBudget ? 1 : 0);
            if (token_budget_overflowed && !entry.ignoreBudget) {
                if (ignoresBudget > 0) {
                    continue;
                }
                break;
            }

            function verifyProbability() {
                // If we don't need to roll, it's always true
                if (!entry.useProbability || entry.probability === 100) {
                    console.debug(`WI entry ${entry.uid} does not use probability`);
                    return true;
                }

                const isSticky = timedEffects.isEffectActive('sticky', entry);
                if (isSticky) {
                    console.debug(`WI entry ${entry.uid} is sticky, does not need to re-roll probability`);
                    return true;
                }

                const rollValue = Math.random() * 100;
                if (rollValue <= entry.probability) {
                    console.debug(`WI entry ${entry.uid} passed probability check of ${entry.probability}%`);
                    return true;
                }

                failedProbabilityChecks.add(entry);
                return false;
            }

            const success = verifyProbability();
            if (!success) {
                console.debug(
                    `WI entry ${entry.uid} failed probability check, removing from activated entries`,
                    sanitizeWorldInfoEntryForClient(entry),
                );
                continue;
            }

            // Substitute macros inline, for both this checking and also future processing
            entry.content = substituteParams(entry.content);
            newContent += `${entry.content}\n`;

            if (!entry.ignoreBudget && (textToScanTokens + (await getTokenCountAsync(newContent))) >= budget) {
                if (!token_budget_overflowed) {
                    console.debug('[WI] --- BUDGET OVERFLOW CHECK ---');
                    if (world_info_overflow_alert) {
                        console.warn(`[WI] budget of ${budget} reached, stopping after ${allActivatedEntries.size} entries`);
                        toastr.warning(`World info budget reached after ${allActivatedEntries.size} entries.`, 'World Info');
                    } else {
                        console.debug(`[WI] budget of ${budget} reached, stopping after ${allActivatedEntries.size} entries`);
                    }
                    token_budget_overflowed = true;
                }
                // Track the excluded entry
                loreExclusionInfo.entriesExcludedByBudget++;
                loreExclusionInfo.budgetExceededAt = entry.uid;
                continue;
            }

            allActivatedEntries.set(`${entry.world}.${entry.uid}`, entry);
            console.debug(
                `[WI] Entry ${entry.uid} activation successful, adding to prompt`,
                sanitizeWorldInfoEntryForClient(entry),
            );
        }

        // Only entries that were actually added to allActivatedEntries count as successful.
        // This excludes probability failures and budget-excluded entries.
        const successfulNewEntries = newEntries.filter(x => allActivatedEntries.get(`${x.world}.${x.uid}`) === x);
        const successfulNewEntriesForRecursion = successfulNewEntries.filter(x => !x.preventRecursion);

        console.debug(`[WI] --- LOOP #${count} RESULT ---`);
        if (!newEntries.length) {
            console.debug('[WI] No new entries activated.');
        } else if (!successfulNewEntries.length) {
            console.debug('[WI] Probability checks failed for all activated entries. No new entries activated.');
        } else {
            console.debug(
                `[WI] Successfully activated ${successfulNewEntries.length} new entries to prompt. ${allActivatedEntries.size} total entries activated.`,
                sanitizeWorldInfoEntryListForClient(successfulNewEntries),
            );
        }

        function logNextState(...args) {
            args.length && console.debug(args.shift(), ...args);
            console.debug('[WI] Setting scan state', Object.entries(scan_state).find(x => x[1] === scanState));
        }

        // After processing and rolling entries is done, see if we should continue with normal recursion
        if (world_info_recursive && !token_budget_overflowed && successfulNewEntriesForRecursion.length) {
            nextScanState = scan_state.RECURSION;
            logNextState('[WI] Found', successfulNewEntriesForRecursion.length, 'new entries for recursion');
        }

        // If we are inside min activations scan, and we have recursive buffer, we should do a recursive scan before increasing the buffer again
        // There might be recurse-trigger-able entries that match the buffer, so we need to check that
        if (world_info_recursive && !token_budget_overflowed && scanState === scan_state.MIN_ACTIVATIONS && buffer.hasRecurse()) {
            nextScanState = scan_state.RECURSION;
            logNextState('[WI] Min Activations run done, whill will always be followed by a recursive scan');
        }

        // If scanning is planned to stop, but min activations is set and not satisfied, check if we should continue
        const minActivationsNotSatisfied = world_info_min_activations > 0 && (allActivatedEntries.size < world_info_min_activations);
        if (!nextScanState && !token_budget_overflowed && minActivationsNotSatisfied) {
            console.debug('[WI] --- MIN ACTIVATIONS CHECK ---');

            let over_max = (
                world_info_min_activations_depth_max > 0 &&
                buffer.getDepth() > world_info_min_activations_depth_max
            ) || (buffer.getDepth() > chat.length);

            if (!over_max) {
                nextScanState = scan_state.MIN_ACTIVATIONS; // loop
                logNextState(`[WI] Min activations not reached (${allActivatedEntries.size}/${world_info_min_activations}), advancing depth to ${buffer.getDepth() + 1}, starting another scan`);
                buffer.advanceScan();
            } else {
                console.debug(`[WI] Min activations not reached (${allActivatedEntries.size}/${world_info_min_activations}), but reached on of depth. Stopping`);
            }
        }

        // If the scan is done, but we still have open "delay until recursion" levels, we should continue with the next one
        if (nextScanState === scan_state.NONE && availableRecursionDelayLevels.length) {
            nextScanState = scan_state.RECURSION;
            currentRecursionDelayLevel = availableRecursionDelayLevels.shift();
            logNextState('[WI] Open delayed recursion levels left. Preparing next delayed recursion level', currentRecursionDelayLevel, '. Still delayed:', availableRecursionDelayLevels);
        }

        // Final check if we should really continue scan, and extend the current WI recurse buffer
        const curScanState = scanState;
        scanState = nextScanState;
        if (scanState) {
            const text = successfulNewEntriesForRecursion
                .map(x => x.content).join('\n');
            if (text) {
                buffer.addRecurse(text);
                allActivatedText = (text + '\n' + allActivatedText);
            }
        } else {
            logNextState('[WI] Scan done. No new entries to prompt. Stopping.');
        }

        // Fire an event after each scan loop, so extensions can hook into the current scanning state
        const scanDoneArgs = {
            state: {
                current: curScanState,
                next: scanState,
                loopCount: count,
            },
            new: {
                all: newEntries,
                successful: successfulNewEntries,
            },
            activated: {
                entries: allActivatedEntries,
                text: allActivatedText,
            },
            sortedEntries,
            recursionDelay: {
                availableLevels: availableRecursionDelayLevels,
                currentLevel: currentRecursionDelayLevel,
            },
            budget: {
                current: budget,
                overflowed: token_budget_overflowed,
            },
            timedEffects,
        };
        const emittedScanDoneArgs = sanitizeWorldInfoScanDoneArgsForClient(scanDoneArgs);
        await eventSource.emit(event_types.WORLDINFO_SCAN_DONE, emittedScanDoneArgs);

        // Some fields are allowed to be changed by listeners, those will be handled here manually. They can be updated via changed the args from the listeners.
        // Any array provided directly can be modified by updating it's elements, adding or removing elements. This has to be done consistently.
        if (emittedScanDoneArgs.state.next !== scanState) {
            logNextState('[WI] Scan state changed from', scanState, 'to', emittedScanDoneArgs.state.next);
            scanState = emittedScanDoneArgs.state.next;
        }
        const scanDoneHasRestrictedHiddenLore = emittedScanDoneArgs.activated?.text === '[Redacted: hidden lorebook content]';
        if (!scanDoneHasRestrictedHiddenLore) {
            allActivatedText = emittedScanDoneArgs.activated.text;
        }
        currentRecursionDelayLevel = emittedScanDoneArgs.recursionDelay.currentLevel;
        budget = emittedScanDoneArgs.budget.current;
        token_budget_overflowed = emittedScanDoneArgs.budget.overflowed;
    }

    console.debug('[WI] --- BUILDING PROMPT ---');

    // Forward-sorted list of entries for joining
    const WIBeforeEntries = [];
    const WIAfterEntries = [];
    const EMEntries = [];
    const ANTopEntries = [];
    const ANBottomEntries = [];
    const WIDepthEntries = [];
    /** @type {{[key: string]: string[]}} */
    const WIOutletEntries = {};

    // Appends from insertion order 999 to 1. Use unshift for this purpose
    // TODO (kingbri): Change to use WI Anchor positioning instead of separate top/bottom arrays
    [...allActivatedEntries.values()].sort(sortFn).forEach((entry) => {
        const regexDepth = entry.position === world_info_position.atDepth ? (entry.depth ?? DEFAULT_DEPTH) : null;
        const content = getRegexedString(entry.content, regex_placement.WORLD_INFO, { depth: regexDepth, isMarkdown: false, isPrompt: true });

        // Diagnostic: Log if content was modified by regex
        if (content !== entry.content) {
            if (isRestrictedHiddenWorldInfoEntry(entry)) {
                console.warn(
                    `[WI] Entry ${entry.uid} from '${entry.world}' was modified by regex script, but content logging is redacted for hidden lorebook entries. Original length: ${entry.content.length}, Modified length: ${content.length}.`,
                );
            } else {
                console.warn(`[WI] Entry ${entry.uid} was modified by regex script. Original length: ${entry.content.length}, Modified length: ${content.length}. Entry: ${entry.uid} (${entry.world})`);
                console.debug('[WI] Original:', entry.content.substring(0, 100));
                console.debug('[WI] Modified:', content.substring(0, 100));
            }
        }

        if (!content) {
            console.debug(
                `[WI] Entry ${entry.uid}`,
                'skipped adding to prompt due to empty content',
                sanitizeWorldInfoEntryForClient(entry),
            );
            return;
        }

        switch (entry.position) {
            case world_info_position.before:
                WIBeforeEntries.unshift(content);
                break;
            case world_info_position.after:
                WIAfterEntries.unshift(content);
                break;
            case world_info_position.EMTop:
                EMEntries.unshift(
                    { position: wi_anchor_position.before, content: content },
                );
                break;
            case world_info_position.EMBottom:
                EMEntries.unshift(
                    { position: wi_anchor_position.after, content: content },
                );
                break;
            case world_info_position.ANTop:
                ANTopEntries.unshift(content);
                break;
            case world_info_position.ANBottom:
                ANBottomEntries.unshift(content);
                break;
            case world_info_position.atDepth: {
                const existingDepthIndex = WIDepthEntries.findIndex((e) => e.depth === (entry.depth ?? DEFAULT_DEPTH) && e.role === (entry.role ?? extension_prompt_roles.SYSTEM));
                if (existingDepthIndex !== -1) {
                    WIDepthEntries[existingDepthIndex].entries.unshift(content);
                } else {
                    WIDepthEntries.push({
                        depth: entry.depth,
                        entries: [content],
                        role: entry.role ?? extension_prompt_roles.SYSTEM,
                    });
                }
                break;
            }
            case world_info_position.outlet: {
                if (!entry.outletName) {
                    console.warn(`[WI] Entry ${entry.uid} has position 'outlet' but no outlet name. Skipping.`);
                    break;
                }
                if (Array.isArray(WIOutletEntries[entry.outletName])) {
                    WIOutletEntries[entry.outletName].push(content);
                } else {
                    WIOutletEntries[entry.outletName] = [content];
                }
                break;
            }
            default:
                break;
        }
    });

    const worldInfoBefore = WIBeforeEntries.length ? WIBeforeEntries.join('\n') : '';
    const worldInfoAfter = WIAfterEntries.length ? WIAfterEntries.join('\n') : '';

    if (shouldWIAddPrompt) {
        const originalAN = context.extensionPrompts[NOTE_MODULE_NAME].value;
        const ANWithWI = `${ANTopEntries.join('\n')}\n${originalAN}\n${ANBottomEntries.join('\n')}`.replace(/(^\n)|(\n$)/g, '');
        context.setExtensionPrompt(NOTE_MODULE_NAME, ANWithWI, chat_metadata[metadata_keys.position], chat_metadata[metadata_keys.depth], extension_settings.note.allowWIScan, chat_metadata[metadata_keys.role]);
    }

    timedEffects.setTimedEffects(Array.from(allActivatedEntries.values()));
    buffer.resetExternalEffects();
    timedEffects.cleanUp();

    console.log(
        `[WI] ${isDryRun ? 'Hypothetically adding' : 'Adding'} ${allActivatedEntries.size} entries to prompt`,
        sanitizeWorldInfoEntryListForClient(Array.from(allActivatedEntries.values())),
    );
    console.debug(`[WI] --- DONE${isDryRun ? ' (DRY RUN)' : ''} ---`);

    // Track total scanned and activated for statistics
    loreExclusionInfo.totalEntriesScanned = sortedEntries.length;
    loreExclusionInfo.entriesActivated = allActivatedEntries.size;

    return { worldInfoBefore, worldInfoAfter, EMEntries, WIDepthEntries, ANBeforeEntries: ANTopEntries, ANAfterEntries: ANBottomEntries, outletEntries: WIOutletEntries, allActivatedEntries: new Set(allActivatedEntries.values()), loreExclusionInfo };
}

/**
 * Only leaves entries with the highest key matching score in each group.
 * @param {Record<string, WIScanEntry[]>} groups The groups to filter
 * @param {WorldInfoBuffer} buffer The buffer to use for scoring
 * @param {(entry: WIScanEntry) => void} removeEntry The function to remove an entry
 * @param {number} scanState The current scan state
 * @param {Map<string, boolean>} hasStickyMap The sticky entries map
 */
function filterGroupsByScoring(groups, buffer, removeEntry, scanState, hasStickyMap) {
    for (const [key, group] of Object.entries(groups)) {
        // Group scoring is disabled both globally and for the group entries
        if (!world_info_use_group_scoring && !group.some(x => x.useGroupScoring)) {
            console.debug(`[WI] Skipping group scoring for group '${key}'`);
            continue;
        }

        // If the group has any sticky entries, the rest are already removed by the timed effects filter
        const hasAnySticky = hasStickyMap.get(key);
        if (hasAnySticky) {
            console.debug(`[WI] Skipping group scoring check, group '${key}' has sticky entries`);
            continue;
        }

        const scores = group.map(entry => buffer.getScore(entry, scanState));
        const maxScore = Math.max(...scores);
        console.debug(`[WI] Group '${key}' max score:`, maxScore);
        //console.table(group.map((entry, i) => ({ uid: entry.uid, key: JSON.stringify(entry.key), score: scores[i] })));

        for (let i = 0; i < group.length; i++) {
            const isScored = group[i].useGroupScoring ?? world_info_use_group_scoring;

            if (!isScored) {
                continue;
            }

            if (scores[i] < maxScore) {
                console.debug(`[WI] Entry ${group[i].uid}`, `removed as score loser from inclusion group '${key}'`, group[i]);
                removeEntry(group[i]);
                group.splice(i, 1);
                scores.splice(i, 1);
                i--;
            }
        }
    }
}

/**
 * Removes entries on cooldown and forces sticky entries as winners.
 * @param {Record<string, WIScanEntry[]>} groups The groups to filter
 * @param {WorldInfoTimedEffects} timedEffects The timed effects to use
 * @param {(entry: WIScanEntry) => void} removeEntry The function to remove an entry
 * @returns {Map<string, boolean>} If any sticky entries were found
 */
function filterGroupsByTimedEffects(groups, timedEffects, removeEntry) {
    /** @type {Map<string, boolean>} */
    const hasStickyMap = new Map();

    for (const [key, group] of Object.entries(groups)) {
        hasStickyMap.set(key, false);

        // If the group has any sticky entries, leave only the sticky entries
        const stickyEntries = group.filter(x => timedEffects.isEffectActive('sticky', x));
        if (stickyEntries.length) {
            for (const entry of group) {
                if (stickyEntries.includes(entry)) {
                    continue;
                }

                console.debug(`[WI] Entry ${entry.uid}`, `removed as a non-sticky loser from inclusion group '${key}'`, entry);
                removeEntry(entry);
            }

            hasStickyMap.set(key, true);
        }

        // It should not be possible for an entry on cooldown/delay to event get into the grouping phase but @Wolfsblvt told me to leave it here.
        const cooldownEntries = group.filter(x => timedEffects.isEffectActive('cooldown', x));
        if (cooldownEntries.length) {
            console.debug(`[WI] Inclusion group '${key}' has entries on cooldown. They will be removed.`, cooldownEntries);
            for (const entry of cooldownEntries) {
                removeEntry(entry);
            }
        }

        const delayEntries = group.filter(x => timedEffects.isEffectActive('delay', x));
        if (delayEntries.length) {
            console.debug(`[WI] Inclusion group '${key}' has entries with delay. They will be removed.`, delayEntries);
            for (const entry of delayEntries) {
                removeEntry(entry);
            }
        }
    }

    return hasStickyMap;
}

/**
 * Filters entries by inclusion groups.
 * @param {object[]} newEntries Entries activated on current recursion level
 * @param {Map<string, object>} allActivatedEntries Map of all activated entries
 * @param {WorldInfoBuffer} buffer The buffer to use for scanning
 * @param {number} scanState The current scan state
 * @param {WorldInfoTimedEffects} timedEffects The timed effects currently active
 */
function filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects) {
    console.debug('[WI] --- INCLUSION GROUP CHECKS ---');

    const grouped = newEntries.filter(x => x.group).reduce((acc, item) => {
        item.group.split(/,\s*/).filter(x => x).forEach(group => {
            if (!acc[group]) {
                acc[group] = [];
            }
            acc[group].push(item);
        });
        return acc;
    }, {});

    if (Object.keys(grouped).length === 0) {
        console.debug('[WI] No inclusion groups found');
        return;
    }

    const removeEntry = (entry) => newEntries.splice(newEntries.indexOf(entry), 1);
    function removeAllBut(group, chosen, logging = true) {
        for (const entry of group) {
            if (entry === chosen) {
                continue;
            }

            if (logging) console.debug(`[WI] Entry ${entry.uid}`, `removed as loser from inclusion group '${entry.group}'`, entry);
            removeEntry(entry);
        }
    }

    const hasStickyMap = filterGroupsByTimedEffects(grouped, timedEffects, removeEntry);
    filterGroupsByScoring(grouped, buffer, removeEntry, scanState, hasStickyMap);

    for (const [key, group] of Object.entries(grouped)) {
        console.debug(`[WI] Checking inclusion group '${key}' with ${group.length} entries`, group);

        // If the group has any sticky entries, the rest are already removed by the timed effects filter
        const hasAnySticky = hasStickyMap.get(key);
        if (hasAnySticky) {
            console.debug(`[WI] Skipping inclusion group check, group '${key}' has sticky entries`);
            continue;
        }

        if (Array.from(allActivatedEntries.values()).some(x => x.group === key)) {
            console.debug(`[WI] Skipping inclusion group check, group '${key}' was already activated`);
            // We need to forcefully deactivate all other entries in the group
            removeAllBut(group, null, false);
            continue;
        }

        if (!Array.isArray(group) || group.length <= 1) {
            console.debug('[WI] Skipping inclusion group check, only one entry');
            continue;
        }

        // Check for group prio
        const prios = group.filter(x => x.groupOverride).sort(sortFn);
        if (prios.length) {
            console.debug(`[WI] Entry ${prios[0].uid}`, `activated as prio winner from inclusion group '${key}'`, prios[0]);
            removeAllBut(group, prios[0]);
            continue;
        }

        // Do weighted random using entry's weight
        const totalWeight = group.reduce((acc, item) => acc + (item.groupWeight ?? DEFAULT_WEIGHT), 0);
        const rollValue = Math.random() * totalWeight;
        let currentWeight = 0;
        let winner = null;

        for (const entry of group) {
            currentWeight += (entry.groupWeight ?? DEFAULT_WEIGHT);

            if (rollValue <= currentWeight) {
                console.debug(`[WI] Entry ${entry.uid}`, `activated as roll winner from inclusion group '${key}'`, entry);
                winner = entry;
                break;
            }
        }

        if (!winner) {
            console.debug(`[WI] Failed to activate inclusion group '${key}', no winner found`);
            continue;
        }

        // Remove every group item from newEntries but the winner
        removeAllBut(group, winner);
    }
}

function convertAgnaiMemoryBook(inputObj) {
    const outputObj = { entries: {} };

    inputObj.entries.forEach((entry, index) => {
        outputObj.entries[index] = {
            ...newWorldInfoEntryTemplate,
            uid: index,
            key: entry.keywords,
            keysecondary: [],
            comment: entry.name,
            content: entry.entry,
            constant: false,
            selective: false,
            vectorized: false,
            selectiveLogic: world_info_logic.AND_ANY,
            order: entry.weight,
            position: 0,
            disable: !entry.enabled,
            addMemo: !!entry.name,
            excludeRecursion: false,
            delayUntilRecursion: false,
            displayIndex: index,
            probability: 100,
            useProbability: true,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: DEFAULT_WEIGHT,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: extension_prompt_roles.SYSTEM,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            ignoreBudget: false,
        };
    });

    return outputObj;
}

function convertRisuLorebook(inputObj) {
    const outputObj = { entries: {} };

    inputObj.data.forEach((entry, index) => {
        outputObj.entries[index] = {
            ...newWorldInfoEntryTemplate,
            uid: index,
            key: entry.key.split(',').map(x => x.trim()),
            keysecondary: entry.secondkey ? entry.secondkey.split(',').map(x => x.trim()) : [],
            comment: entry.comment,
            content: entry.content,
            constant: entry.alwaysActive,
            selective: entry.selective,
            vectorized: false,
            selectiveLogic: world_info_logic.AND_ANY,
            order: entry.insertorder,
            position: world_info_position.before,
            disable: false,
            addMemo: true,
            excludeRecursion: false,
            delayUntilRecursion: false,
            displayIndex: index,
            probability: entry.activationPercent ?? 100,
            useProbability: entry.activationPercent ?? true,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: DEFAULT_WEIGHT,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: extension_prompt_roles.SYSTEM,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            ignoreBudget: false,
        };
    });

    return outputObj;
}

function convertNovelLorebook(inputObj) {
    const outputObj = {
        entries: {},
    };

    inputObj.entries.forEach((entry, index) => {
        const displayName = entry.displayName;
        const addMemo = displayName !== undefined && displayName.trim() !== '';

        outputObj.entries[index] = {
            ...newWorldInfoEntryTemplate,
            uid: index,
            key: entry.keys,
            keysecondary: [],
            comment: displayName || '',
            content: entry.text,
            constant: false,
            selective: false,
            vectorized: false,
            selectiveLogic: world_info_logic.AND_ANY,
            order: entry.contextConfig?.budgetPriority ?? 0,
            position: 0,
            disable: !entry.enabled,
            addMemo: addMemo,
            excludeRecursion: false,
            delayUntilRecursion: false,
            displayIndex: index,
            probability: 100,
            useProbability: true,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: DEFAULT_WEIGHT,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: extension_prompt_roles.SYSTEM,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            ignoreBudget: false,
        };
    });

    return outputObj;
}

export function convertCharacterBook(characterBook) {
    const result = { entries: {}, originalData: characterBook };

    characterBook.entries.forEach((entry, index) => {
        // Not in the spec, but this is needed to find the entry in the original data
        if (entry.id === undefined) {
            entry.id = index;
        }

        result.entries[entry.id] = {
            ...newWorldInfoEntryTemplate,
            uid: entry.id,
            key: entry.keys,
            keysecondary: entry.secondary_keys || [],
            comment: entry.comment || '',
            content: entry.content,
            constant: entry.constant || false,
            selective: entry.selective || false,
            order: entry.insertion_order,
            position: entry.extensions?.position ?? (entry.position === 'before_char' ? world_info_position.before : world_info_position.after),
            excludeRecursion: entry.extensions?.exclude_recursion ?? false,
            preventRecursion: entry.extensions?.prevent_recursion ?? false,
            delayUntilRecursion: entry.extensions?.delay_until_recursion ?? false,
            disable: !entry.enabled,
            addMemo: !!entry.comment,
            displayIndex: entry.extensions?.display_index ?? index,
            probability: entry.extensions?.probability ?? 100,
            useProbability: entry.extensions?.useProbability ?? true,
            depth: entry.extensions?.depth ?? DEFAULT_DEPTH,
            selectiveLogic: entry.extensions?.selectiveLogic ?? world_info_logic.AND_ANY,
            outletName: entry.extensions?.outlet_name ?? '',
            group: entry.extensions?.group ?? '',
            groupOverride: entry.extensions?.group_override ?? false,
            groupWeight: entry.extensions?.group_weight ?? DEFAULT_WEIGHT,
            scanDepth: entry.extensions?.scan_depth ?? null,
            caseSensitive: entry.extensions?.case_sensitive ?? null,
            matchWholeWords: entry.extensions?.match_whole_words ?? null,
            useGroupScoring: entry.extensions?.use_group_scoring ?? null,
            automationId: entry.extensions?.automation_id ?? '',
            role: entry.extensions?.role ?? extension_prompt_roles.SYSTEM,
            vectorized: entry.extensions?.vectorized ?? false,
            sticky: entry.extensions?.sticky ?? null,
            cooldown: entry.extensions?.cooldown ?? null,
            delay: entry.extensions?.delay ?? null,
            matchPersonaDescription: entry.extensions?.match_persona_description ?? false,
            matchCharacterDescription: entry.extensions?.match_character_description ?? false,
            matchCharacterPersonality: entry.extensions?.match_character_personality ?? false,
            matchCharacterDepthPrompt: entry.extensions?.match_character_depth_prompt ?? false,
            matchScenario: entry.extensions?.match_scenario ?? false,
            matchCreatorNotes: entry.extensions?.match_creator_notes ?? false,
            extensions: entry.extensions ?? {},
            triggers: entry.extensions?.triggers || [],
            ignoreBudget: entry.extensions?.ignore_budget ?? false,
        };
    });

    return result;
}

export function setWorldInfoButtonClass(chid, forceValue = undefined) {
    if (forceValue !== undefined) {
        $('#set_character_world, #world_button').toggleClass('world_set', forceValue);
        return;
    }

    if (chid === undefined) {
        return;
    }

    const world = String(characters[chid]?.data?.extensions?.world || '').trim();
    const worldSet = Boolean(world);
    $('#set_character_world, #world_button').toggleClass('world_set', worldSet);
}

export function checkEmbeddedWorld(chid) {
    $('#import_character_info').hide();

    if (chid === undefined) {
        return false;
    }

    // Skip auto-import for pushed characters — their lorebook is already
    // imported by the push system via applyQueuedPushToRecipient().
    // Without this guard, the embedded character_book triggers a duplicate import.
    // Instead, ensure the pushed lorebook link is valid and icon is lit.
    const isPushedCharacter = isPushedCharacterRecord(characters[chid]);
    if (isPushedCharacter) {
        ensurePushedLoreBookLinked(chid);
        return false;
    }

    if (characters[chid]?.data?.character_book) {
        $('#import_character_info').data('chid', chid).show();

        // Only show the alert once per character
        const checkKey = `AlertWI_${characters[chid].avatar}`;
        const worldName = characters[chid]?.data?.extensions?.world;
        if (!accountStorage.getItem(checkKey) && (!worldName || !world_names.includes(worldName))) {
            accountStorage.setItem(checkKey, 'true');

            if (power_user.world_import_dialog) {
                const html = `<h3>This character has an embedded World/Lorebook.</h3>
                <h3>Would you like to import it now?</h3>
                <div class="m-b-1">If you want to import it later, select "Import Card Lore" in the "More..." dropdown menu on the character panel.</div>`;
                const checkResult = (result) => {
                    if (result) {
                        importEmbeddedWorldInfo(true);
                    }
                };
                callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { okButton: 'Yes' }).then(checkResult);
            }
            else {
                toastr.info(
                    'To import and use it, select "Import Card Lore" in the "More..." dropdown menu on the character panel.',
                    `${characters[chid].name} has an embedded World/Lorebook`,
                    { timeOut: 5000, extendedTimeOut: 10000 },
                );
            }
        }
        return true;
    }

    return false;
}

export async function importEmbeddedWorldInfo(skipPopup = false) {
    const chid = $('#import_character_info').data('chid');

    if (chid === undefined || chid === -1) {
        return;
    }

    // Safety guard: don't re-import lorebooks for pushed characters.
    // Instead, auto-link the already-imported pushed lorebook.
    const isPushed = isPushedCharacterRecord(characters[chid]);
    if (isPushed) {
        const linked = autoLinkPushedLorebook(chid);
        if (linked) {
            setWorldInfoButtonClass(chid);
        }
        return;
    }

    const hasEmbed = checkEmbeddedWorld(chid);

    if (!hasEmbed) {
        return;
    }

    const bookName = characters[chid]?.data?.character_book?.name || `${characters[chid]?.name}'s Lorebook`;

    if (!skipPopup) {
        const confirmation = await Popup.show.confirm(t`Are you sure you want to import '${bookName}'?`, world_names.includes(bookName) ? t`It will overwrite the World/Lorebook with the same name.` : '');
        if (!confirmation) {
            return;
        }
    }

    const convertedBook = convertCharacterBook(characters[chid].data.character_book);

    await saveWorldInfo(bookName, convertedBook, true);
    await updateWorldInfoList();
    $('#character_world').val(bookName).trigger('change');

    toastr.success(t`The world '${bookName}' has been imported and linked to the character successfully.`, t`World/Lorebook imported`);

    const newIndex = world_names.indexOf(bookName);
    if (newIndex >= 0) {
        //show&draw the WI panel before..
        $('#WIDrawerIcon').trigger('click');
        //..auto-opening the new imported WI
        $('#world_editor_select').val(newIndex).trigger('change');
    }

    setWorldInfoButtonClass(chid, true);
}

export function onWorldInfoChange(args, text) {
    if (args !== '__notSlashCommand__') { // if it's a slash command
        const silent = isTrueBoolean(args.silent);
        if (text.trim() !== '') { // and args are provided
            const slashInputSplitText = text.trim().toLowerCase().split(',');

            slashInputSplitText.forEach((worldName) => {
                const wiElement = getWIElement(worldName);
                if (wiElement.length > 0) {
                    const name = wiElement.text();
                    switch (args.state) {
                        case 'off': {
                            if (selected_world_info.includes(name)) {
                                selected_world_info.splice(selected_world_info.indexOf(name), 1);
                                wiElement.prop('selected', false);
                                if (!silent) toastr.success(t`Deactivated world: ${name}`);
                            } else {
                                if (!silent) toastr.error(t`World was not active: ${name}`);
                            }
                            break;
                        }
                        case 'toggle': {
                            if (selected_world_info.includes(name)) {
                                selected_world_info.splice(selected_world_info.indexOf(name), 1);
                                wiElement.prop('selected', false);
                                if (!silent) toastr.success(t`Deactivated world: ${name}`);
                            } else {
                                selected_world_info.push(name);
                                wiElement.prop('selected', true);
                                if (!silent) toastr.success(t`Activated world: ${name}`);
                            }
                            break;
                        }
                        case 'on':
                        default: {
                            selected_world_info.push(name);
                            wiElement.prop('selected', true);
                            if (!silent) toastr.success(t`Activated world: ${name}`);
                        }
                    }
                } else {
                    if (!silent) toastr.error(t`No world found named: ${worldName}`);
                }
            });
            $('#world_info').trigger('change');
        } else { // if no args, unset all worlds
            if (!silent) toastr.success(t`Deactivated all worlds`);
            selected_world_info = [];
            $('#world_info').val(null).trigger('change');
        }
    } else { //if it's a pointer selection
        const tempWorldInfo = [];
        const val = $('#world_info').val();
        const selectedWorlds = (Array.isArray(val) ? val : [val]).map((e) => Number(e)).filter((e) => !isNaN(e));
        if (selectedWorlds.length > 0) {
            selectedWorlds.forEach((worldIndex) => {
                const existingWorldName = world_names[worldIndex];
                if (existingWorldName) {
                    tempWorldInfo.push(existingWorldName);
                } else {
                    const wiElement = getWIElement(existingWorldName);
                    wiElement.prop('selected', false);
                    toastr.error(t`The world with ${existingWorldName} is invalid or corrupted.`);
                }
            });
        }
        selected_world_info = tempWorldInfo;
    }

    saveSettingsDebounced();
    eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
    return '';
}

/**
 * Imports world info from a file.
 * @param {File} file File to import
 */
export async function importWorldInfo(file) {
    if (!file) {
        return;
    }

    const formData = new FormData();
    formData.append('avatar', file);

    try {
        let jsonData;

        if (file.name.endsWith('.png')) {
            const buffer = new Uint8Array(await getFileBuffer(file));
            jsonData = extractDataFromPng(buffer, 'naidata');
        } else {
            // File should be a JSON file
            jsonData = await parseJsonFile(file);
        }

        if (jsonData === undefined || jsonData === null) {
            toastr.error(t`File is not valid: ${file.name}`);
            return;
        }

        // Convert Novel Lorebook
        if (jsonData.lorebookVersion !== undefined) {
            console.log('Converting Novel Lorebook');
            formData.append('convertedData', JSON.stringify(convertNovelLorebook(jsonData)));
        }

        // Convert Agnai Memory Book
        if (jsonData.kind === 'memory') {
            console.log('Converting Agnai Memory Book');
            formData.append('convertedData', JSON.stringify(convertAgnaiMemoryBook(jsonData)));
        }

        // Convert Risu Lorebook
        if (jsonData.type === 'risu') {
            console.log('Converting Risu Lorebook');
            formData.append('convertedData', JSON.stringify(convertRisuLorebook(jsonData)));
        }
    } catch (error) {
        toastr.error(`Error parsing file: ${error}`);
        return;
    }

    const worldName = file.name.substr(0, file.name.lastIndexOf('.'));
    const sanitizedWorldName = await getSanitizedFilename(worldName);
    const allowed = await checkOverwriteExistingData('World Info', world_names, sanitizedWorldName, { interactive: true, actionName: 'Import', deleteAction: (existingName) => deleteWorldInfo(existingName) });
    if (!allowed) {
        return false;
    }

    try {
        const result = await fetch('/api/worldinfo/import', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
            cache: 'no-cache',
        });

        if (!result.ok) {
            throw new Error(`Failed to import world info: ${result.statusText}`);
        }

        const data = await result.json();

        if (data.name) {
            await updateWorldInfoList();

            const newIndex = world_names.indexOf(data.name);
            if (newIndex >= 0) {
                $('#world_editor_select').val(newIndex).trigger('change');
            }

            toastr.success(t`World Info "${data.name}" imported successfully!`);
        }
    } catch (error) {
        console.error('Error importing world info:', error);
        toastr.error(t`Failed to import World Info`);
    }
}

/**
 * Forces the world info editor to open on a specific world.
 * @param {string} worldName The name of the world to open
 */
export function openWorldInfoEditor(worldName) {
    console.log(`Opening lorebook for ${worldName}`);
    const selectedCharacterId = Number($('#set_character_world').data('chid'));

    if (!Number.isNaN(selectedCharacterId) && selectedCharacterId >= 0) {
        const selectedCharacter = characters[selectedCharacterId];
        const selectedWorld = String(selectedCharacter?.data?.extensions?.world || '').trim();

        if (selectedWorld === String(worldName || '').trim() && isCharacterDefinitionLocked(selectedCharacter)) {
            applyCharacterDefinitionLockState(true);
            toastr.warning('Lorebook access is locked on this pushed character.');
            return;
        }
    }

    // Block hidden lorebooks from being opened by non-admin/non-creator
    if (!world_names.includes(worldName)) {
        console.log(`[WI] Lorebook "${worldName}" not in world_names list, skipping editor open`);
        return;
    }
    if (!$('#WorldInfo').is(':visible')) {
        $('#WIDrawerIcon').trigger('click');
    }
    const index = world_names.indexOf(worldName);
    $('#world_editor_select').val(index).trigger('change');
}

/**
 * Assigns a lorebook to the current chat.
 * @param {JQuery.ClickEvent<Document, undefined, any, any>} event Pointer event
 * @returns {Promise<void>}
 */
export async function assignLorebookToChat(event) {
    const selectedNames = getVisibleChatLorebooks();

    if (selectedNames.length > 0 && event.altKey) {
        openWorldInfoEditor(getPrimaryVisibleChatLorebook());
        return;
    }

    const template = $(await renderTemplateAsync('chatLorebook'));

    const worldSelect = template.find('select');
    const chatName = template.find('.chat_name');
    chatName.text(getCurrentChatId());

    for (const worldName of world_names) {
        if (isHiddenPushedLorebookForDropdown(worldName)) continue;
        const option = document.createElement('option');
        option.value = worldName;
        option.innerText = getLorebookDropdownDisplayName(worldName);
        option.selected = selectedNames.includes(worldName);
        worldSelect.append(option);
    }

    worldSelect.on('change', function () {
        const worldNames = normalizeArray($(this).val()).slice(0, CHAT_LOREBOOK_LIMIT);
        setChatLorebooks(worldNames);
        saveMetadata();
    });

    // Open popup — callGenericPopup runs synchronously up to its first await (user
    // confirmation), so by the time the next line executes the template content is
    // already attached to the document and Select2 can initialise on it.
    // dropdownParent must point to the <dialog> element so the dropdown renders
    // above the modal backdrop instead of being hidden behind it.
    const popupPromise = callGenericPopup(template, POPUP_TYPE.TEXT);
    const dlg = worldSelect.closest('dialog');
    worldSelect.select2({
        searchInputPlaceholder: t`Search lorebooks...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        matcher: startsWithMatcher,
        dropdownCssClass: 'wi-lorebook-dropdown',
        dropdownParent: dlg.length ? dlg : $(document.body),
        placeholder: t`No chat lorebooks linked. Select up to 4.`,
        allowClear: true,
        closeOnSelect: false,
        maximumSelectionLength: CHAT_LOREBOOK_LIMIT,
    });
    await popupPromise;
    worldSelect.select2('destroy');
}

/**
 * Moves a World Info entry from a source lorebook to a target lorebook.
 *
 * @param {string} sourceName - The name of the source lorebook file.
 * @param {string} targetName - The name of the target lorebook file.
 * @param {string|number} uid - The UID of the entry to move from the source lorebook.
 * @param {Object} options - Additional options for the move operation.
 * @param {boolean} [options.deleteOriginal=true] - Whether to delete the original entry from the source lorebook after moving it.
 * @returns {Promise<boolean>} True if the move was successful, false otherwise.
 */
export async function moveWorldInfoEntry(sourceName, targetName, uid, { deleteOriginal = true } = {}) {
    if (sourceName === targetName) {
        return false;
    }

    if (!world_names.includes(sourceName)) {
        toastr.error(t`Source lorebook '${sourceName}' not found.`);
        console.error(`[WI Move] Source lorebook '${sourceName}' does not exist.`);
        return false;
    }

    if (!world_names.includes(targetName)) {
        toastr.error(t`Target lorebook '${targetName}' not found.`);
        console.error(`[WI Move] Target lorebook '${targetName}' does not exist.`);
        return false;
    }

    const entryUidString = String(uid);

    try {
        const sourceData = await loadWorldInfo(sourceName);
        const targetData = await loadWorldInfo(targetName);

        if (!sourceData || !sourceData.entries) {
            toastr.error(t`Failed to load data for source lorebook '${sourceName}'.`);
            console.error(`[WI Move] Could not load source data for '${sourceName}'.`);
            return false;
        }
        if (!targetData || !targetData.entries) {
            toastr.error(t`Failed to load data for target lorebook '${targetName}'.`);
            console.error(`[WI Move] Could not load target data for '${targetName}'.`);
            return false;
        }

        if (!sourceData.entries[entryUidString]) {
            toastr.error(t`Entry not found in source lorebook '${sourceName}'.`);
            console.error(`[WI Move] Entry UID ${entryUidString} not found in '${sourceName}'.`);
            return false;
        }

        const entryToMove = structuredClone(sourceData.entries[entryUidString]);

        const newUid = getFreeWorldEntryUid(targetData);
        if (newUid === null) {
            console.error(`[WI Move] Failed to get a free UID in '${targetName}'.`);
            return false;
        }

        entryToMove.uid = newUid;
        // Place the entry at the end of the target lorebook
        const maxDisplayIndex = Object.values(targetData.entries).reduce((max, entry) => Math.max(max, entry.displayIndex ?? -1), -1);
        entryToMove.displayIndex = maxDisplayIndex + 1;

        targetData.entries[newUid] = entryToMove;

        if (deleteOriginal) {
            delete sourceData.entries[entryUidString];
            // Remove from originalData if it exists
            deleteWIOriginalDataValue(sourceData, entryUidString);
            // TODO: setWIOriginalDataValue
            console.debug(`[WI Move] Removed entry UID ${entryUidString} from source '${sourceName}'.`);
        }

        await saveWorldInfo(targetName, targetData, true);
        console.debug(`[WI Move] Saved target lorebook '${targetName}'.`);
        await saveWorldInfo(sourceName, sourceData, true);
        console.debug(`[WI Move] Saved source lorebook '${sourceName}'.`);

        console.log(`[WI Move] ${entryToMove.comment} ${deleteOriginal ? 'moved' : 'copied'} successfully to '${targetName}'.`);

        // Check if the currently viewed book in the editor is the source or target and reload it
        const currentEditorBookIndex = Number($('#world_editor_select').val());
        if (!isNaN(currentEditorBookIndex)) {
            const currentEditorBookName = world_names[currentEditorBookIndex];
            if (currentEditorBookName === sourceName || currentEditorBookName === targetName) {
                reloadEditor(currentEditorBookName);
            }
        }

        toastr.success(deleteOriginal
            ? t`Entry moved successfully from '${sourceName}' to '${targetName}'.`
            : t`Entry copied successfully to '${targetName}'.`);

        return true;
    } catch (error) {
        toastr.error(t`An unexpected error occurred while moving the entry: ${error.message}`);
        console.error('[WI Move] Unexpected error:', error);
        return false;
    }
}


/**
 * Updates the primary world info linked to a character.
 * Can also unset it to null.
 * @param {string} name - The name of the world info to link to the character.
 */
export async function charUpdatePrimaryWorld(name) {
    const previousValue = $('#character_world').val();
    $('#character_world').val(name);
    $('#character_world_unlink').val(previousValue && !name ? 'true' : '');

    console.debug('Character world selected:', name);

    if (menu_type == 'create') {
        create_save.world = name;
        return;
    }

    if (previousValue && !name) {
        try {
            // Dirty hack to remove embedded lorebook from character JSON data.
            const data = JSON.parse(String($('#character_json_data').val()));

            if (data?.data?.character_book) {
                data.data.character_book = undefined;
            }

            $('#character_json_data').val(JSON.stringify(data));
            toastr.info(t`Embedded lorebook will be removed from this character.`);
        } catch {
            console.error('Failed to parse character JSON data.');
        }
    }

    await createOrEditCharacter();
    $('#character_world_unlink').val('');

    setWorldInfoButtonClass(undefined, !!name);
}

/**
 * Adds one or more auxiliary world books to a character.
 * @param {string} characterKey - The key of the character to add auxiliary world books to
 * @param {string|string[]} nameOrNames - The name or names of the auxiliary world books to add
 */
export async function charUpdateAddAuxWorld(characterKey, nameOrNames) {
    const fileName = getCharaFilename(null, { manualAvatarKey: characterKey });
    const toAdd = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
    updateAuxBooks(fileName, curr => [...curr, ...toAdd]);
}

/**
 * Replaces the entire list of auxiliary world books for a character.
 * @param {string} fileName - The filename of the character to update
 * @param {string[]} books - The new list of auxiliary world books to replace the existing list with
 */
export function charSetAuxWorlds(fileName, books) {
    updateAuxBooks(fileName, _ => Array.isArray(books) ? books : []);
}

function updateAuxBooks(fileName, computeNext) {
    if (!fileName) return;

    if (menu_type === 'create') {
        const current = create_save.extra_books ?? [];
        create_save.extra_books = normalizeArray(computeNext(current));
        return; // no debounced save in create flow
    }

    const charLore = world_info.charLore ?? [];
    const idx = charLore.findIndex(e => e.name === fileName);
    const current = idx !== -1 ? (charLore[idx].extraBooks ?? []) : [];
    const next = normalizeArray(computeNext(current));

    if (next.length === 0) {
        if (idx !== -1) charLore.splice(idx, 1);
    } else if (idx === -1) {
        charLore.push({ name: fileName, extraBooks: next });
    } else {
        charLore[idx] = { ...charLore[idx], extraBooks: next };
    }

    Object.assign(world_info, { charLore });
    saveSettingsDebounced();
}

export function initWorldInfo() {
    setupPushWorkflowControls();
    initLoreTreasuryInline();

    $('#world_info').on('mousedown change', async function (e) {
        // If there's no world names, don't do anything
        if (world_names.length === 0) {
            e.preventDefault();
            return;
        }

        onWorldInfoChange('__notSlashCommand__');
    });

    //**************************WORLD INFO IMPORT EXPORT*************************//
    $('#world_import_button').on('click', function () {
        $('#world_import_file').trigger('click');
    });

    $('#world_import_file').on('change', async function (e) {
        if (!(e.target instanceof HTMLInputElement)) {
            return;
        }

        const file = e.target.files[0];

        await importWorldInfo(file);

        // Will allow to select the same file twice in a row
        e.target.value = '';
    });

    $('#world_create_button').on('click', async () => {
        const tempName = getFreeWorldName();
        const finalName = await Popup.show.input(t`Create a new World Info`, t`Enter a name for the new file:`, tempName);

        if (finalName) {
            await createNewWorldInfo(finalName, { interactive: true });
        }
    });

    $('#world_editor_select').on('change', async () => {
        $('#world_info_search').val('');
        worldInfoFilter.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH, '', true);
        const selectedIndex = String($('#world_editor_select').find(':selected').val());

        if (selectedIndex === '') {
            await hideWorldEditor();
        } else {
            const worldName = world_names[selectedIndex];
            showWorldEditor(worldName);
        }
    });

    const saveSettings = () => {
        saveSettingsDebounced();
        eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
    };

    $('#world_info_depth').on('input', function () {
        world_info_depth = Number($(this).val());
        $('#world_info_depth_counter').val($(this).val());
        saveSettings();
    });

    $('#world_info_min_activations').on('input', function () {
        world_info_min_activations = Number($(this).val());
        $('#world_info_min_activations_counter').val(world_info_min_activations);

        if (world_info_min_activations !== 0 && world_info_max_recursion_steps !== 0) {
            $('#world_info_max_recursion_steps').val(0).trigger('input');
            flashHighlight($('#world_info_max_recursion_steps').parent()); // flash the other control to show it has changed
            console.info('[WI] Max recursion steps set to 0, as min activations is set to', world_info_min_activations);
        } else {
            saveSettings();
        }
    });

    $('#world_info_min_activations_depth_max').on('input', function () {
        world_info_min_activations_depth_max = Number($(this).val());
        $('#world_info_min_activations_depth_max_counter').val($(this).val());
        saveSettings();
    });

    $('#world_info_budget').on('input', function () {
        world_info_budget = Number($(this).val());
        $('#world_info_budget_counter').val($(this).val());
        saveSettings();
    });

    $('#world_info_include_names').on('input', function () {
        world_info_include_names = !!$(this).prop('checked');
        saveSettings();
    });

    $('#world_info_recursive').on('input', function () {
        world_info_recursive = !!$(this).prop('checked');
        saveSettings();
    });

    $('#world_info_case_sensitive').on('input', function () {
        world_info_case_sensitive = !!$(this).prop('checked');
        saveSettings();
    });

    $('#world_info_match_whole_words').on('input', function () {
        world_info_match_whole_words = !!$(this).prop('checked');
        saveSettings();
    });

    $('#world_info_character_strategy').on('change', function () {
        world_info_character_strategy = Number($(this).val());
        saveSettings();
    });

    $('#world_info_overflow_alert').on('change', function () {
        world_info_overflow_alert = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#world_info_use_group_scoring').on('change', function () {
        world_info_use_group_scoring = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#world_info_budget_cap').on('input', function () {
        world_info_budget_cap = Number($(this).val());
        $('#world_info_budget_cap_counter').val(world_info_budget_cap);
        saveSettings();
    });

    $('#world_info_max_recursion_steps').on('input', function () {
        world_info_max_recursion_steps = Number($(this).val());
        $('#world_info_max_recursion_steps_counter').val(world_info_max_recursion_steps);
        if (world_info_max_recursion_steps !== 0 && world_info_min_activations !== 0) {
            $('#world_info_min_activations').val(0).trigger('input');
            flashHighlight($('#world_info_min_activations').parent()); // flash the other control to show it has changed
            console.info('[WI] Min activations set to 0, as max recursion steps is set to', world_info_max_recursion_steps);
        } else {
            saveSettings();
        }
    });

    $('#world_button').on('click', async function (event) {
        const openSetWorldMenu = () => $('#char-management-dropdown').val($('#set_character_world').val()).trigger('change');
        const chid = $('#set_character_world').data('chid');

        if (chid === -1) {
            openSetWorldMenu();
            return;
        }

        if (chid !== undefined && chid !== null && isCharacterDefinitionLocked(characters[chid])) {
            event.preventDefault();
            event.stopImmediatePropagation();
            applyCharacterDefinitionLockState(true);
            toastr.warning('Lorebook access is locked on this pushed character.');
            return;
        }

        const worldName = characters[chid]?.data?.extensions?.world;
        const hasEmbed = checkEmbeddedWorld(chid);
        if (worldName && world_names.includes(worldName) && !event.shiftKey) {
            openWorldInfoEditor(worldName);
        } else if (hasEmbed && !event.shiftKey) {
            await importEmbeddedWorldInfo();
            saveCharacterDebounced();
        }
        else {
            openSetWorldMenu();
        }
    });

    const debouncedWorldInfoSearch = debounce((searchQuery) => {
        worldInfoFilter.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH, searchQuery);
    });
    $('#world_info_search').on('input', function () {
        const searchQuery = $(this).val();
        debouncedWorldInfoSearch(searchQuery);
    });

    $('#world_refresh').on('click', () => {
        updateEditor(navigation_option.previous);
    });

    $('#world_info_sort_order').on('change', function () {
        const value = String($(this).find(':selected').val());
        // Save sort order, but do not save search sorting, as this is a temporary sorting option
        if (value !== 'search') accountStorage.setItem(SORT_ORDER_KEY, value);
        updateEditor(navigation_option.none);
    });

    $(document).on('click', '.chat_lorebook_button', assignLorebookToChat);

    // Lorebook selects — same Select2 options as the connection-profile model selectors
    // so the UX is identical: search box at the top of the dropdown, works on all devices.
    // dropdownCssClass gives the dropdown a stable hook for the mobile CSS rule that
    // expands it to full panel width (Select2's JS .css() cannot beat CSS !important).
    const lorebookSelect2Options = {
        searchInputPlaceholder: t`Search lorebooks...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        matcher: startsWithMatcher,
        // wi-lorebook-single suppresses the global checkbox pseudo-elements
        // (select2-overrides.css) which are only appropriate for the multi-select.
        dropdownCssClass: 'wi-lorebook-dropdown wi-lorebook-single',
    };

    $('#world_editor_select').select2({
        ...lorebookSelect2Options,
        placeholder: t`--- Pick to Edit ---`,
        searchInputPlaceholder: t`Search...`,
        allowClear: true,
        closeOnSelect: true,
        multiple: false,
    });

    $('#world_info').select2({
        ...lorebookSelect2Options,
        dropdownCssClass: 'wi-lorebook-dropdown', // multi-select keeps checkboxes
        placeholder: t`No Worlds active. Click here to select.`,
        allowClear: true,
        closeOnSelect: false,
    });

    // Clicking a selected tag in the multi-select opens the lorebook for editing.
    // Uses hover/pointer events so limit to non-touch devices.
    if (!isMobile()) {
        select2ChoiceClickSubscribe($('#world_info'), target => {
            const name = $(target).text();
            const selectedIndex = world_names.indexOf(name);
            const alreadySelectedInEditor = $('#world_editor_select option:selected').text() === name;
            if (selectedIndex !== -1 && !alreadySelectedInEditor) {
                $('#world_editor_select').val(selectedIndex).trigger('change');
                console.log('Quick selection of world', name);
            } else {
                console.warn('lets not reload an already loaded list yes?');
            }
        }, { buttonStyle: true, closeDrawer: true });
    }

    $('#WorldInfo').on('scroll', () => {
        $('.world_entry input[name="group"], .world_entry input[name="automationId"]').each((_, el) => {
            const instance = $(el).autocomplete('instance');

            if (instance !== undefined) {
                $(el).autocomplete('close');
            }
        });
    });
}


let pushNotificationPollTimer = null;
const PUSH_UI_PREF_KEY = 'push_workflow_ui_pref';
const PUSH_UI_PREF_MIGRATION_KEY = 'push_workflow_ui_pref_v5';
const PUSH_UI_MIN_TOP = 300;
const PUSH_UI_DEFAULT_TOP = 420;
const PUSH_UI_RIGHT_OFFSET = 260;

function getDefaultPushUiLeft() {
    return Math.max(16, (window.innerWidth || 1280) - PUSH_UI_RIGHT_OFFSET);
}

function getDefaultPushUiTop() {
    const viewportHeight = window.innerHeight || 900;
    return Math.max(PUSH_UI_MIN_TOP, Math.min(PUSH_UI_DEFAULT_TOP, viewportHeight - 140));
}
function getPushUiPref() {
    const fallback = { collapsed: false, floating: true, hidden: false, left: getDefaultPushUiLeft(), top: getDefaultPushUiTop() };
    try {
        const raw = power_user?.push_workflow_ui_pref
            ? JSON.stringify(power_user.push_workflow_ui_pref)
            : accountStorage.getItem(PUSH_UI_PREF_KEY);
        if (!raw) return normalizePushUiPref(fallback);
        const parsed = JSON.parse(raw);
        return normalizePushUiPref({
            collapsed: !!parsed.collapsed,
            floating: typeof parsed.floating === 'boolean' ? parsed.floating : fallback.floating,
            hidden: !!parsed.hidden,
            left: Number.isFinite(Number(parsed.left)) ? Number(parsed.left) : fallback.left,
            top: Number.isFinite(Number(parsed.top)) ? Number(parsed.top) : fallback.top,
        });
    } catch {
        return normalizePushUiPref(fallback);
    }
}

function normalizePushUiPref(pref) {
    const normalized = { ...pref };
    normalized.floating = true;
    normalized.hidden = !!normalized.hidden;
    const maxTop = Math.max(PUSH_UI_MIN_TOP, (window.innerHeight || 900) - 120);
    const topValue = Number.isFinite(Number(normalized.top)) ? Number(normalized.top) : getDefaultPushUiTop();
    normalized.top = Math.min(maxTop, Math.max(PUSH_UI_MIN_TOP, topValue));
    const viewportWidth = window.innerWidth || 1280;
    const maxLeft = Math.max(16, viewportWidth - 80);
    const defaultLeft = getDefaultPushUiLeft();
    const leftValue = Number.isFinite(Number(normalized.left)) ? Number(normalized.left) : defaultLeft;
    normalized.left = Math.min(maxLeft, Math.max(16, leftValue));
    return normalized;
}

function setPushUiPref(pref) {
    const normalized = normalizePushUiPref(pref);
    power_user.push_workflow_ui_pref = normalized;
    accountStorage.setItem(PUSH_UI_PREF_KEY, JSON.stringify(normalized));
    saveSettingsDebounced();
}

function setPushWorkflowControlsHidden(hidden, showToast = true) {
    const pref = getPushUiPref();
    pref.hidden = !!hidden;
    applyPushUiPref(pref);
    bindPushUiDrag(pref);
    setPushUiPref(pref);

    if (showToast) {
        if (pref.hidden) {
            toastr.info('Push controls hidden. Use /showPUSH to restore.', 'Push');
        } else {
            toastr.info('Push controls visible.', 'Push');
        }
    }

    return pref;
}

globalThis.setPushWorkflowControlsHidden = setPushWorkflowControlsHidden;

function applyPushUiPref(pref) {
    pref = normalizePushUiPref(pref);
    const controls = $('#push_workflow_controls');
    controls.toggleClass('push-controls-drawer-primary', !!pref.hidden);
    controls.toggle(!pref.hidden);
    controls.toggleClass('push-controls-collapsed', !!pref.collapsed);
    controls.toggleClass('push-controls-floating', !!pref.floating);

    if (pref.floating) {
        controls.css({ left: `${pref.left}px`, top: `${pref.top}px` });
        $('#topbar_push_drag').addClass('drag-enabled').attr('title', 'Drag to Move');
    } else {
        controls.css({ left: '', top: '' });
        $('#topbar_push_drag').removeClass('drag-enabled').attr('title', 'Drag to Move');
    }

    $('#topbar_push_reset').attr('title', 'Reset Push Controls Position');

    $('#topbar_push_toggle')
        .toggleClass('fa-chevron-left', !pref.collapsed)
        .toggleClass('fa-chevron-right', !!pref.collapsed)
        .attr('title', pref.collapsed ? 'Expand Push Controls' : 'Collapse Push Controls');
}

function formatDetailedPushFailures(bulkResults) {
    const failures = [];

    for (const result of bulkResults || []) {
        const lorebook = escapeHtml(String(result?.lorebook || 'Unknown lorebook'));
        for (const failure of result?.failed || []) {
            failures.push(`<b>${lorebook}</b>: ${escapeHtml(String(failure))}`);
        }
    }

    return failures;
}

function bindPushUiDrag(pref) {
    const controls = $('#push_workflow_controls');
    if (!($.fn && $.fn.draggable)) return;

    try {
        if (controls.hasClass('ui-draggable')) {
            controls.draggable('destroy');
        }
    } catch {
        // no-op
    }

    if (!pref.floating || pref.hidden) return;

    let dragStarted = false;

    controls.draggable({
        handle: '#topbar_push_drag',
        cancel: '.push-workflow-action, .push-badge, #topbar_push_toggle, #topbar_push_reset',
        containment: 'window',
        distance: 8,
        start: function (_event, _ui) {
            dragStarted = true;
            controls.addClass('ui-draggable-dragging');
        },
        stop: function (_event, ui) {
            pref.left = Math.max(16, Math.round(ui.position.left));
            pref.top = Math.max(PUSH_UI_MIN_TOP, Math.round(ui.position.top));
            controls.css({ left: `${pref.left}px`, top: `${pref.top}px` });
            controls.removeClass('ui-draggable-dragging');
            setPushUiPref(pref);

            if (dragStarted) {
                toastr.success('Position saved', 'Push Controls', { timeOut: 1500 });
                dragStarted = false;
            }
        },
    });
}

function bindPushControlAction(selector, showState, handler) {
    const button = $(selector);
    let lastActivationAt = 0;
    let pointerTrackingId = null;
    let pointerStartX = 0;
    let pointerStartY = 0;
    let pointerMoved = false;
    let touchTrackingId = null;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchMoved = false;
    const movementThreshold = 12;

    const activate = async (event) => {
        const now = Date.now();
        if (now - lastActivationAt < 700) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        lastActivationAt = now;
        event.preventDefault();
        event.stopPropagation();
        await handler(event);
    };

    button
        .toggle(showState)
        .toggleClass('displayNone', !showState)
        .off('click pointerdown pointermove pointerup pointercancel touchstart touchmove touchend touchcancel');

    button.on('pointerdown', (event) => {
        if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
        pointerTrackingId = event.pointerId;
        pointerStartX = Number(event.clientX || 0);
        pointerStartY = Number(event.clientY || 0);
        pointerMoved = false;
    });

    button.on('pointermove', (event) => {
        if (event.pointerId !== pointerTrackingId) return;
        const deltaX = Math.abs(Number(event.clientX || 0) - pointerStartX);
        const deltaY = Math.abs(Number(event.clientY || 0) - pointerStartY);
        if (deltaX > movementThreshold || deltaY > movementThreshold) {
            pointerMoved = true;
        }
    });

    button.on('pointerup', async (event) => {
        if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
        if (event.pointerId !== pointerTrackingId) return;
        const moved = pointerMoved;
        pointerTrackingId = null;
        pointerMoved = false;
        if (moved) return;
        await activate(event);
    });

    button.on('pointercancel', () => {
        pointerTrackingId = null;
        pointerMoved = false;
    });

    button.on('touchstart', (event) => {
        const touch = event.originalEvent?.changedTouches?.[0];
        if (!touch) return;
        touchTrackingId = touch.identifier;
        touchStartX = Number(touch.clientX || 0);
        touchStartY = Number(touch.clientY || 0);
        touchMoved = false;
    });

    button.on('touchmove', (event) => {
        const touches = Array.from(event.originalEvent?.changedTouches || []);
        const touch = touches.find((item) => item.identifier === touchTrackingId);
        if (!touch) return;
        const deltaX = Math.abs(Number(touch.clientX || 0) - touchStartX);
        const deltaY = Math.abs(Number(touch.clientY || 0) - touchStartY);
        if (deltaX > movementThreshold || deltaY > movementThreshold) {
            touchMoved = true;
        }
    });

    button.on('touchend', async (event) => {
        const touches = Array.from(event.originalEvent?.changedTouches || []);
        const touch = touches.find((item) => item.identifier === touchTrackingId);
        if (!touch) return;
        touchTrackingId = null;
        if (touchMoved) {
            touchMoved = false;
            return;
        }
        touchMoved = false;
        await activate(event);
    });

    button.on('touchcancel', () => {
        touchTrackingId = null;
        touchMoved = false;
    });

    button.on('click', async (event) => {
        if (Date.now() - lastActivationAt < 700) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        await handler(event);
    });
}

const PUSH_NOTIFICATION_CACHE_TTL = 5000;
const PUSH_USER_CACHE_TTL = 60000;
const pushNotificationStateCache = {
    expiresAt: 0,
    promise: null,
    value: null,
};
const pushUserCache = new Map();

function createEmptyPushNotificationState() {
    return {
        pending_count: 0,
        unread_count: 0,
        pending_unread_count: 0,
        inbox_unread_count: 0,
        admin_pending_submissions: 0,
        admin_unread_notes: 0,
        pending: [],
        submission_updates: [],
        legacy: [],
    };
}

function getUserAvatarImageUrl(handle) {
    const normalizedHandle = String(handle || '').trim();
    return normalizedHandle
        ? `/api/worldinfo/user-avatar-img?handle=${encodeURIComponent(normalizedHandle)}`
        : '/img/default-user.png';
}

function invalidatePushNotificationState() {
    pushNotificationStateCache.expiresAt = 0;
    pushNotificationStateCache.value = null;
}

async function getPushNotificationState(options = {}) {
    const { force = false } = options;
    const now = Date.now();

    if (!force && pushNotificationStateCache.value && pushNotificationStateCache.expiresAt > now) {
        return pushNotificationStateCache.value;
    }

    if (!force && pushNotificationStateCache.promise) {
        return pushNotificationStateCache.promise;
    }

    pushNotificationStateCache.promise = (async () => {
        try {
            const res = await fetch('/api/worldinfo/push-notifications', {
                method: 'POST',
                headers: getRequestHeaders(),
            });
            const state = res.ok ? await res.json() : createEmptyPushNotificationState();
            pushNotificationStateCache.value = state;
            pushNotificationStateCache.expiresAt = Date.now() + PUSH_NOTIFICATION_CACHE_TTL;
            return state;
        } catch {
            const emptyState = createEmptyPushNotificationState();
            pushNotificationStateCache.value = emptyState;
            pushNotificationStateCache.expiresAt = Date.now() + 1000;
            return emptyState;
        } finally {
            pushNotificationStateCache.promise = null;
        }
    })();

    return pushNotificationStateCache.promise;
}

async function refreshPushNotificationState() {
    invalidatePushNotificationState();
    const state = await getPushNotificationState({ force: true });
    updatePushNotificationBadge(state);
    return state;
}

function updatePushBadge(el, count) {
    if (!el) return;
    el.textContent = count > 99 ? '99+' : String(count);
    el.classList.toggle('show', count > 0);
    el.closest('.push-drawer-link-badge')?.classList.toggle('has-push-alert', count > 0);
}

function closeOptionsDrawer() {
    if (typeof globalThis.hideOptionsMenu === 'function') {
        globalThis.hideOptionsMenu();
        return;
    }

    const menu = $('#options');
    if (!menu.length) return;
    menu.stop(true, true).fadeOut(animation_duration);
}

function updatePushNotificationBadge(state) {
    // Keep badge semantics explicit:
    // - Bell: unread pending push items only
    // - User Inbox: unread user inbox items
    // - Admin Inbox: pending admin inbox items
    updatePushBadge(document.getElementById('topbar_push_notif_badge'), Number(state?.pending_unread_count || 0));
    updatePushBadge(document.getElementById('option_push_notif_badge'), Number(state?.pending_unread_count || 0));
    updatePushBadge(document.getElementById('topbar_submit_badge'), Number(state?.inbox_unread_count || 0));
    updatePushBadge(document.getElementById('option_submit_badge'), Number(state?.inbox_unread_count || 0));
    updatePushBadge(document.getElementById('topbar_admin_inbox_badge'), Number(state?.admin_pending_submissions || 0));
    updatePushBadge(document.getElementById('option_admin_inbox_badge'), Number(state?.admin_pending_submissions || 0));

    // Compatibility control: despite the legacy id, this button opens the user inbox modal.
    const submitBtn = document.getElementById('topbar_submit');
    if (submitBtn && Number(state?.inbox_unread_count || 0) > 0) {
        submitBtn.style.cursor = 'pointer';
        submitBtn.title = `Inbox (${state.inbox_unread_count} unread item${state.inbox_unread_count !== 1 ? 's' : ''})`;
        const badge = document.getElementById('topbar_submit_badge');
        if (badge) {
            badge.style.cursor = 'pointer';
        }
    } else if (submitBtn) {
        submitBtn.title = 'Inbox';
    }

    const drawerInboxBtn = document.getElementById('option_user_inbox');
    if (drawerInboxBtn && Number(state?.inbox_unread_count || 0) > 0) {
        drawerInboxBtn.title = `Inbox (${state.inbox_unread_count} unread item${state.inbox_unread_count !== 1 ? 's' : ''})`;
    } else if (drawerInboxBtn) {
        drawerInboxBtn.title = 'Inbox';
    }

    const drawerAdminInboxBtn = document.getElementById('option_push_inbox');
    if (drawerAdminInboxBtn && Number(state?.admin_pending_submissions || 0) > 0) {
        drawerAdminInboxBtn.title = `Push Inbox (${state.admin_pending_submissions} pending item${state.admin_pending_submissions !== 1 ? 's' : ''})`;
    } else if (drawerAdminInboxBtn) {
        drawerAdminInboxBtn.title = 'Push Inbox';
    }

    const drawerSubmitBtn = document.getElementById('option_submit_to_admin');
    if (drawerSubmitBtn) {
        drawerSubmitBtn.title = 'Submit to Admin';
    }

    const drawerNotificationsBtn = document.getElementById('option_push_notifs');
    if (drawerNotificationsBtn && Number(state?.pending_unread_count || 0) > 0) {
        drawerNotificationsBtn.title = `Push Notifications (${state.pending_unread_count} unread item${state.pending_unread_count !== 1 ? 's' : ''})`;
    } else if (drawerNotificationsBtn) {
        drawerNotificationsBtn.title = 'Push Notifications';
    }
}

function formatPushTs(ts) {
    if (!ts) return '';
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return '';
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function inboxTypeTag(type) {
    const normalized = String(type || 'note').toUpperCase();
    if (normalized === 'SUBMISSION_REPLY') return 'SUBMISSION';
    if (normalized === 'ADMIN_NOTE') return 'NOTE';
    return normalized;
}

function inboxPreview(text, max = 110) {
    const str = String(text || '');
    if (str.length <= max) return str;
    return `${str.slice(0, max - 1)}...`;
}

async function getUserInboxState() {
    const res = await fetch('/api/worldinfo/user-inbox', {
        method: 'POST',
        headers: getRequestHeaders(),
    });

    if (!res.ok) {
        throw new Error(await res.text() || 'Failed to load inbox');
    }

    return await res.json();
}

async function openUserInboxDetailModal(inboxId) {
    const detailRes = await fetch('/api/worldinfo/user-inbox-detail', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ inbox_id: inboxId }),
    });

    if (!detailRes.ok) {
        toastr.error(await detailRes.text() || 'Failed to load inbox detail', 'Inbox');
        return;
    }

    const item = await detailRes.json();
    const context = item.context || {};
    const senderHandle = String(item.from_handle || '').trim();
    const canReply = !!senderHandle && senderHandle.toLowerCase() !== 'system';
    const chips = [];
    if (context.content_type) chips.push(`<span class="push-inbox-chip">${escapeHtml(String(context.content_type).toUpperCase())}</span>`);
    if (context.content_name) chips.push(`<span class="push-inbox-chip">${escapeHtml(context.content_name)}</span>`);
    if (context.push_id) chips.push('<span class="push-inbox-chip">PUSH</span>');
    if (context.submission_id) chips.push('<span class="push-inbox-chip">SUBMISSION</span>');

    const senderAvatar = senderHandle && senderHandle.toLowerCase() !== 'system'
        ? getUserAvatarImageUrl(senderHandle)
        : '/img/default-user.png';

    const senderAvatarHtml = `
        <div class="push-sender-header">
            <img class="push-sender-avatar" src="${escapeHtml(senderAvatar)}"
                 alt="${escapeHtml(item.from_name || senderHandle || 'Sender')}"
                 onerror="this.src='/img/default-user.png'" />
            <div>
                <div class="push-sender-name">${escapeHtml(item.from_name || item.from_handle || 'System')}</div>
                <div class="push-flow-meta" style="margin:0;">${formatPushTs(item.created_at)}</div>
            </div>
        </div>
    `;

    const html = `
        <div class="push-inbox-modal push-popup-layout">
            <h3 style="margin-top:0;">${escapeHtml(item.title || 'Inbox Item')}</h3>
            ${senderAvatarHtml}
            <div class="push-inbox-chip-row">${chips.join('')}</div>
            <div class="push-inbox-detail-body">${escapeHtml(item.body || '')}</div>
        </div>
    `;

    const RESULT_TOGGLE_READ = POPUP_RESULT.CUSTOM1;
    const RESULT_DELETE = POPUP_RESULT.CUSTOM2;
    const RESULT_REPLY = POPUP_RESULT.CUSTOM3;
    const customButtons = [
        ...(canReply ? [{ text: 'Reply', result: RESULT_REPLY }] : []),
        { text: item.read_at ? 'Mark Unread' : 'Mark Read', result: RESULT_TOGGLE_READ },
        { text: 'Delete', result: RESULT_DELETE },
    ];

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        rows: 1,
        wider: true,
        customButtons,
    });
    decoratePushPopup(popup, 'user-inbox-detail');

    const result = await popup.show();
    if (result === RESULT_REPLY) {
        await openUserSendAdminNoteModal(inboxId);
        await refreshPushNotificationState();
        return;
    }

    if ([RESULT_TOGGLE_READ, RESULT_DELETE].includes(result)) {
        const action = result === RESULT_TOGGLE_READ
            ? (item.read_at ? 'mark_unread' : 'mark_read')
            : 'delete';

        const actionRes = await fetch('/api/worldinfo/user-inbox-action', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ action, inbox_id: inboxId }),
        });

        if (!actionRes.ok) {
            toastr.error(await actionRes.text() || 'Failed to update inbox item', 'Inbox');
        }

        await refreshPushNotificationState();
        await openUserInboxModal();
        return;
    }

    await refreshPushNotificationState();
}


async function fetchPushBotUsers({ adminsOnly = false, force = false } = {}) {
    const cacheKey = adminsOnly ? 'admins' : 'all';
    const cached = pushUserCache.get(cacheKey);
    const now = Date.now();

    if (!force && cached?.value && cached.expiresAt > now) {
        return cached.value;
    }

    if (!force && cached?.promise) {
        return cached.promise;
    }

    const endpoints = adminsOnly
        ? ['/api/worldinfo/admin-handles', '/api/worldinfo/users/get', '/api/users/get']
        : ['/api/worldinfo/users/get', '/api/users/get'];

    const requestPromise = (async () => {
        let lastError = '';
        for (const url of endpoints) {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ include_avatars: false }),
                });
                if (!res.ok) {
                    lastError = await res.text().catch(() => `${res.status} ${res.statusText}`);
                    continue;
                }
                const data = await res.json();
                if (!Array.isArray(data)) continue;
                const users = data.filter(u => u && typeof u === 'object');
                const filteredUsers = adminsOnly ? users.filter(u => u.admin) : users;
                pushUserCache.set(cacheKey, {
                    value: filteredUsers,
                    expiresAt: Date.now() + PUSH_USER_CACHE_TTL,
                    promise: null,
                });
                return filteredUsers;
            } catch (err) {
                lastError = String(err?.message || err || 'Unknown error');
            }
        }
        throw new Error(lastError || 'Failed to retrieve users');
    })();

    pushUserCache.set(cacheKey, {
        value: cached?.value || null,
        expiresAt: cached?.expiresAt || 0,
        promise: requestPromise,
    });

    try {
        return await requestPromise;
    } finally {
        const latest = pushUserCache.get(cacheKey);
        if (latest?.promise === requestPromise) {
            pushUserCache.set(cacheKey, {
                value: latest.value,
                expiresAt: latest.expiresAt,
                promise: null,
            });
        }
    }
}

async function openUserSendAdminNoteModal(onResponseToInboxId = null) {
    // Fetch admins
    let admins = [];
    try {
        admins = await fetchPushBotUsers({ adminsOnly: true });
    } catch (err) {
        console.warn('[UserAdminNote] Failed to fetch admins:', err);
    }

    const adminOptions = admins.length > 0
        ? admins.map(a => `<option value="${escapeHtml(a.handle)}">${escapeHtml(a.name || a.handle)}</option>`).join('')
        : '<option value="">No admins available</option>';

    // Use the image endpoint (stable URL) instead of embedding base64 — prevents flicker on swap
    const firstHandle = admins[0]?.handle || '';
    const avatarUrl = (handle) => getUserAvatarImageUrl(handle);

    const html = `
        <div class="push-popup-layout">
            <h3 style="margin-top:0;">Send Note to Admin</h3>
            <label class="push-inbox-label">Send To</label>
            <div class="push-note-recipient-row">
                <img id="user_note_admin_avatar" class="push-note-recipient-avatar"
                     src="${avatarUrl(firstHandle)}"
                     alt="Admin avatar"
                     onerror="this.src='/img/default-user.png'" />
                <select id="user_admin_note_target" class="text_pole" style="flex:1;">
                    ${adminOptions}
                </select>
            </div>
            <label class="push-inbox-label" style="margin-top:10px;">Message</label>
            <textarea id="user_admin_note_text" class="text_pole" style="width:100%; height:120px; resize:vertical;" placeholder="Your message to the admin..."></textarea>
        </div>
    `;

    const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Send Note',
        cancelButton: 'Cancel',
        wider: true,
    });
    decoratePushPopup(popup, 'user-admin-note');

    // Update avatar URL on selection change — simple URL swap, no base64 thrashing
    $(popup.dlg).on('change', '#user_admin_note_target', function () {
        const selectedHandle = String($(this).val() || '');
        $(popup.dlg).find('#user_note_admin_avatar').attr('src', avatarUrl(selectedHandle));
    });

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    const noteText = $(popup.dlg).find('#user_admin_note_text').val() || '';
    if (!noteText.trim()) {
        toastr.warning('Please enter a message.', 'Note');
        return;
    }

    const targetAdmin = $(popup.dlg).find('#user_admin_note_target').val() || admins[0]?.handle || null;

    if (!targetAdmin) {
        toastr.error('No admin selected or available.', 'Send Note');
        return;
    }

    const payload = {
        message: noteText,
        target_admin: targetAdmin,
        in_response_to_inbox_id: onResponseToInboxId,
    };

    const sendRes = await fetch('/api/worldinfo/user-admin-note', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });

    if (!sendRes.ok) {
        toastr.error(await sendRes.text() || 'Failed to send note', 'Send Note');
        return;
    }

    toastr.success('Note sent to admin.', 'Send Note');
    await openUserInboxModal();
}

async function openUserInboxModal() {

    let payload;
    try {
        payload = await getUserInboxState();
    } catch (err) {
        toastr.error(String(err?.message || err), 'Inbox');
        return;
    }

    const inboxIcon = (type) => {
        const t = String(type || '').toLowerCase();
        if (t === 'submission_reply') return 'fa-upload';
        if (t === 'admin_note') return 'fa-pen-to-square';
        if (t === 'push') return 'fa-paper-plane';
        return 'fa-envelope';
    };

    const inboxTagClass = (type) => {
        const t = String(type || '').toLowerCase();
        if (t === 'submission_reply') return 'push-tag-char';
        if (t === 'push') return 'push-tag-lore';
        return 'push-tag-char';
    };

    const rows = (payload.items || []).map(item => {
        const unreadClass = item.read_at ? '' : ' unread';
        const tag = inboxTypeTag(item.type);
        const body = inboxPreview(item.body || '');
        const senderHandle = item.from_handle || '';
        const senderAvatar = senderHandle && senderHandle !== 'system'
            ? getUserAvatarImageUrl(senderHandle)
            : null;
        const avHtml = senderAvatar
            ? `<img class="push-ni-av-img"
                    src="${escapeHtml(senderAvatar)}"
                    alt="${escapeHtml(item.from_name || senderHandle)}"
                    onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
               <i class="fa-solid ${inboxIcon(item.type)}" style="display:none;"></i>`
            : `<i class="fa-solid ${inboxIcon(item.type)}"></i>`;

        return `
            <div class="push-ni${unreadClass}" data-inbox-id="${escapeHtml(item.inbox_id)}">
                <div class="push-ni-av">${avHtml}</div>
                <div class="push-ni-body">
                    <div class="push-ni-title">${escapeHtml(item.title || 'Inbox Item')} <span class="push-tag ${inboxTagClass(item.type)}">${escapeHtml(tag)}</span></div>
                    <div class="push-ni-desc">${escapeHtml(body)}</div>
                    <div class="push-ni-desc" style="margin-top:2px"><span style="opacity:.5">From:</span> <strong>${escapeHtml(item.from_name || item.from_handle || 'System')}</strong></div>
                    <div class="push-ni-time">${formatPushTs(item.created_at)}</div>
                </div>
            </div>
        `;
    }).join('');

    const html = `
        <div class="push-inbox-modal push-popup-layout">
            <h3 style="margin-top:0;"><i class="fa-solid fa-inbox" style="color:#a78bfa; font-size:14px;"></i> Notifications &amp; Inbox</h3>
            <div class="push-nl">${rows || '<div class="push-ni-desc" style="padding:12px; text-align:center;">No inbox items.</div>'}</div>
        </div>
    `;

    const RESULT_CLEAR_READ = POPUP_RESULT.CUSTOM1;
    const RESULT_CLEAR_ALL = POPUP_RESULT.CUSTOM2;
    const RESULT_SUBMIT = POPUP_RESULT.CUSTOM3;
    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        rows: 1,
        wider: true,
        customButtons: [
            { text: 'Clear Read', result: RESULT_CLEAR_READ },
            { text: 'Clear All', result: RESULT_CLEAR_ALL },
            { text: 'Submit to Admin', result: RESULT_SUBMIT },
        ],
    });
    decoratePushPopup(popup, 'user-inbox');
    const resultPromise = popup.show();

    $(popup.dlg).on('click', '.push-ni[data-inbox-id]', async function () {
        const inboxId = $(this).data('inbox-id');
        if (!inboxId) return;
        popup.complete(POPUP_RESULT.AFFIRMATIVE);
        setTimeout(() => {
            openUserInboxDetailModal(inboxId);
        }, 220);
    });

    const result = await resultPromise;
    if (result === RESULT_CLEAR_READ || result === RESULT_CLEAR_ALL) {
        const clearRes = await fetch('/api/worldinfo/user-inbox-action', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ action: result === RESULT_CLEAR_ALL ? 'clear_all' : 'clear_read' }),
        });
        if (!clearRes.ok) {
            toastr.error(await clearRes.text() || 'Failed to clear read items', 'Inbox');
        }
    }

    await refreshPushNotificationState();

    if (result === RESULT_SUBMIT) {
        await openSubmitToAdminModal();
    }
}

async function openAdminNoteModal() {
    console.log('[AdminNote] Modal opened');

    if (!isAdmin()) {
        console.warn('[AdminNote] User is not admin');
        toastr.warning('Only admins can send direct notes.', 'Admin Note');
        return;
    }

    let users = [];
    try {
        console.log('[AdminNote] Fetching users...');
        const allUsers = await fetchPushBotUsers();
        users = allUsers.filter(u => u.handle !== getCurrentUserHandle())
            .sort((a, b) => (a.handle || '').localeCompare(b.handle || ''));
        console.log('[AdminNote] Fetched users:', users.length);
    } catch (err) {
        console.error('[AdminNote] Error fetching users:', err);
    }

    const userRows = users.map(u => {
        // Use image endpoint URL — avoids embedding large base64 strings in HTML
        const avatarSrc = getUserAvatarImageUrl(u.handle);
        const avatarHtml = `<img class="push-note-target-avatar" src="${avatarSrc}" alt="${escapeHtml(u.name || u.handle)}" onerror="this.src='/img/default-user.png'" />`;
        return `
        <label class="push-note-target">
            <input type="checkbox" class="admin_note_target" value="${escapeHtml(u.handle)}" />
            ${avatarHtml}
            <span>${escapeHtml(u.name || u.handle)} <span style="opacity:0.6;">(${escapeHtml(u.handle)})</span></span>
        </label>
    `;
    }).join('');

    const html = `
        <div class="push-inbox-modal push-popup-layout">
            <h3 style="margin-top:0;">Send Note</h3>
            <label class="push-inbox-label">Targets</label>
            <label class="push-note-target" style="margin-bottom:6px;">
                <input type="checkbox" id="admin_note_all" />
                <span>All users</span>
            </label>
            <div class="push-flow-list" style="max-height:150px; margin-bottom:10px;">${userRows || '<div class="push-flow-meta">No users found.</div>'}</div>
            <label class="push-inbox-label">Subject</label>
            <input id="admin_note_subject" class="text_pole" style="width:100%; margin-bottom:10px;" />
            <label class="push-inbox-label">Note</label>
            <textarea id="admin_note_body" class="text_pole" style="width:100%; min-height:100px; margin-bottom:10px;"></textarea>
            <label class="push-inbox-label">Priority</label>
            <select id="admin_note_priority" class="text_pole" style="width:100%;">
                <option value="normal">Normal</option>
                <option value="low">Low</option>
                <option value="high">High</option>
            </select>
        </div>
    `;

    const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', { okButton: 'Send Note', cancelButton: 'Cancel', wider: true });
    decoratePushPopup(popup, 'admin-note');
    const dlg = popup.dlg;

    const syncAdminNoteSelectionUi = () => {
        $(dlg).find('.push-note-target').removeClass('push-note-target-selected');
        $(dlg).find('.admin_note_target:checked').each(function () {
            $(this).closest('.push-note-target').addClass('push-note-target-selected');
        });
    };

    $(dlg).on('click', '.push-note-target', function (event) {
        if ($(event.target).is('input')) return;
        event.preventDefault();
        event.stopPropagation();
        const cb = $(this).find('input[type="checkbox"]').first();
        if (cb.length) {
            cb.prop('checked', !cb.prop('checked')).trigger('change');
        }
    });

    $(dlg).on('change', '#admin_note_all', function () {
        const checked = !!$(this).prop('checked');
        $(dlg).find('.admin_note_target').prop('checked', false).prop('disabled', checked);
        syncAdminNoteSelectionUi();
    });

    $(dlg).on('change', '.admin_note_target', function () {
        if ($(this).prop('checked')) {
            $(dlg).find('#admin_note_all').prop('checked', false);
        }
        syncAdminNoteSelectionUi();
    });

    syncAdminNoteSelectionUi();

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    const useAll = !!$(dlg).find('#admin_note_all').prop('checked');
    const targets = [];
    if (!useAll) {
        $(dlg).find('.admin_note_target:checked').each(function () {
            targets.push($(this).val());
        });
        if (targets.length === 0) {
            toastr.warning('Select at least one user, or choose All users.', 'Admin Note');
            return;
        }
    }

    const payload = {
        targets: useAll ? 'all' : targets,
        subject: String($(dlg).find('#admin_note_subject').val() || '').trim(),
        body: String($(dlg).find('#admin_note_body').val() || '').trim(),
        priority: String($(dlg).find('#admin_note_priority').val() || 'normal'),
    };

    const res = await fetch('/api/worldinfo/admin-note', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        toastr.error(await res.text() || 'Failed to send note', 'Admin Note');
        return;
    }

    const data = await res.json();
    toastr.success(`Sent to ${data.delivered?.length || 0} user(s).`, 'Admin Note');
}

function decoratePushPopup(popup, mode = 'default') {
    if (!popup?.dlg) return;

    const mobileScrollModes = new Set(['queue', 'submit']);
    const bodyEl = popup.dlg.querySelector('.popup-body');
    const contentEl = popup.dlg.querySelector('.popup-content');
    const setImportantStyle = (element, property, value) => element.style.setProperty(property, value, 'important');

    const applyMobilePushLayout = () => {
        if (!(bodyEl instanceof HTMLElement) || !(contentEl instanceof HTMLElement)) return;

        const isCompactViewport = window.matchMedia('(max-width: 640px), (max-height: 760px)').matches;
        const shouldUseBodyScroll = isCompactViewport && mobileScrollModes.has(mode);

        if (!shouldUseBodyScroll) {
            popup.dlg.style.removeProperty('top');
            popup.dlg.style.removeProperty('left');
            popup.dlg.style.removeProperty('right');
            popup.dlg.style.removeProperty('bottom');
            popup.dlg.style.removeProperty('transform');
            popup.dlg.style.removeProperty('width');
            popup.dlg.style.removeProperty('max-width');
            popup.dlg.style.removeProperty('height');
            popup.dlg.style.removeProperty('max-height');
            popup.dlg.style.removeProperty('overflow');
            popup.dlg.style.removeProperty('overflow-y');
            popup.dlg.style.removeProperty('overflow-x');

            bodyEl.style.removeProperty('display');
            bodyEl.style.removeProperty('height');
            bodyEl.style.removeProperty('max-height');
            bodyEl.style.removeProperty('min-height');
            bodyEl.style.removeProperty('overflow');
            bodyEl.style.removeProperty('overflow-y');
            bodyEl.style.removeProperty('overflow-x');
            bodyEl.style.removeProperty('-webkit-overflow-scrolling');
            bodyEl.style.removeProperty('touch-action');

            contentEl.style.removeProperty('flex');
            contentEl.style.removeProperty('min-height');
            contentEl.style.removeProperty('overflow');
            contentEl.style.removeProperty('overflow-y');
            contentEl.style.removeProperty('overflow-x');
            return;
        }

        const viewportHeight = Math.max(320, Math.floor((window.visualViewport?.height || window.innerHeight) - 16));

        setImportantStyle(popup.dlg, 'top', '8px');
        setImportantStyle(popup.dlg, 'left', '50%');
        setImportantStyle(popup.dlg, 'right', 'auto');
        setImportantStyle(popup.dlg, 'bottom', 'auto');
        setImportantStyle(popup.dlg, 'transform', 'translateX(-50%)');
        setImportantStyle(popup.dlg, 'width', '92vw');
        setImportantStyle(popup.dlg, 'max-width', '92vw');
        setImportantStyle(popup.dlg, 'height', 'auto');
        setImportantStyle(popup.dlg, 'max-height', `${viewportHeight}px`);
        setImportantStyle(popup.dlg, 'overflow', 'hidden');

        setImportantStyle(bodyEl, 'display', 'block');
        setImportantStyle(bodyEl, 'height', 'auto');
        setImportantStyle(bodyEl, 'max-height', `${Math.max(280, viewportHeight - 12)}px`);
        setImportantStyle(bodyEl, 'min-height', '0');
        setImportantStyle(bodyEl, 'overflow-y', 'auto');
        setImportantStyle(bodyEl, 'overflow-x', 'hidden');
        setImportantStyle(bodyEl, '-webkit-overflow-scrolling', 'touch');
        setImportantStyle(bodyEl, 'touch-action', 'pan-y');

        setImportantStyle(contentEl, 'flex', '0 0 auto');
        setImportantStyle(contentEl, 'min-height', 'auto');
        setImportantStyle(contentEl, 'overflow', 'visible');
    };

    const handleViewportChange = () => window.requestAnimationFrame(applyMobilePushLayout);

    const decorate = () => {
        const dlg = $(popup.dlg);
        if (!dlg.length) return;

        dlg.addClass('push-aurora-popup');
        dlg.attr('data-push-popup-mode', mode);

        const root = dlg.closest('.popup, .dialogue_popup, .popup_holder');
        if (root.length) {
            root.addClass('push-aurora-popup-shell');
        }

        const buttonMap = [
            ['Overwrite', 'push-aurora-btn-overwrite'],
            ['Decline', 'push-aurora-btn-decline'],
            ['Reject', 'push-aurora-btn-decline'],
            ['Deny', 'push-aurora-btn-decline'],
            ['Approve', 'push-aurora-btn-approve'],
            ['Mark Reviewed', 'push-aurora-btn-reviewed'],
            ['Accept', 'push-aurora-btn-accept'],
            ['Yes — Import', 'push-aurora-btn-accept'],
            ['Yes-Import', 'push-aurora-btn-accept'],
            ['No', 'push-aurora-btn-decline'],
            ['Close', 'push-aurora-btn-ghost'],
            ['Submit', 'push-aurora-btn-accept'],
            ['Send Note', 'push-aurora-btn-accept'],
            ['Send Admin Note', 'push-aurora-btn-accept'],
            ['Mark Read', 'push-aurora-btn-reviewed'],
            ['Mark Unread', 'push-aurora-btn-reviewed'],
            ['Clear Read', 'push-aurora-btn-ghost'],
            ['Clear Processed', 'push-aurora-btn-ghost'],
            ['Clear All', 'push-aurora-btn-ghost'],
            ['Delete', 'push-aurora-btn-decline'],
        ];

        dlg.find('.popup-button-ok').addClass('push-aurora-btn push-aurora-btn-primary');
        dlg.find('.popup-button-cancel').addClass('push-aurora-btn push-aurora-btn-ghost');
        dlg.find('.menu_button, .popup-button-custom').each(function () {
            const button = $(this);
            const text = String(button.text() || '').trim();
            button.addClass('push-aurora-btn');
            for (const [label, cls] of buttonMap) {
                if (text === label) {
                    button.addClass(cls);
                    break;
                }
            }
        });

        applyMobilePushLayout();
    };

    decorate();
    setTimeout(decorate, 0);
    setTimeout(decorate, 80);

    window.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('resize', handleViewportChange);

    const previousOnClose = popup.onClose;
    popup.onClose = async (...args) => {
        window.removeEventListener('resize', handleViewportChange);
        window.visualViewport?.removeEventListener('resize', handleViewportChange);

        if (typeof previousOnClose === 'function') {
            await previousOnClose(...args);
        }
    };
}

function renderPushTargetRail(users) {
    if (!Array.isArray(users) || users.length === 0) {
        return '<div class="push-ni-desc" style="padding:8px 0;">No users found.</div>';
    }

    const userCards = users.map(u => `
        <button type="button" class="push-rail-card" data-handle="${escapeHtml(u.handle)}">
            <img class="push-rail-card-avatar"
                src="${escapeHtml(getUserAvatarImageUrl(u.handle))}"
                alt="${escapeHtml(u.name || u.handle)}"
                onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
            <i class="fa-solid fa-user" style="display:none;"></i>
            <span>${escapeHtml(u.name || u.handle)}</span>
        </button>
    `).join('');

    return `
        <div class="push-rail-shell">
            <div class="push-rail-fade push-rail-fade-left"></div>
            <div class="push-rail-track" data-push-rail-track="true">
                <button type="button" class="push-rail-card push-rail-card-all on" data-push-all="true">
                    <i class="fa-solid fa-users"></i>
                    <span>All Users</span>
                </button>
                ${userCards}
            </div>
            <div class="push-rail-fade push-rail-fade-right"></div>
        </div>
    `;
}

function initPushTargetRail(dlg) {
    const shell = $(dlg).find('.push-rail-shell');
    const track = shell.find('.push-rail-track').get(0);
    if (!track) return;

    const view = track.ownerDocument?.defaultView || window;
    const fadeLeft = shell.find('.push-rail-fade-left');
    const fadeRight = shell.find('.push-rail-fade-right');
    let isPointerDown = false;
    let dragMoved = false;
    let startX = 0;
    let startScrollLeft = 0;

    const updateFades = () => {
        const maxScrollLeft = track.scrollWidth - track.clientWidth;
        const canScroll = maxScrollLeft > 8;
        fadeLeft.toggleClass('visible', canScroll && track.scrollLeft > 8);
        fadeRight.toggleClass('visible', canScroll && track.scrollLeft < (maxScrollLeft - 8));
    };

    const endDrag = () => {
        if (!isPointerDown) return;
        isPointerDown = false;
        track.classList.remove('push-rail-dragging');
        view.setTimeout(() => {
            dragMoved = false;
        }, 0);
    };

    track.addEventListener('scroll', updateFades);
    track.addEventListener('wheel', (event) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        event.preventDefault();
        track.scrollLeft += event.deltaY;
    }, { passive: false });

    track.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        isPointerDown = true;
        dragMoved = false;
        startX = event.pageX;
        startScrollLeft = track.scrollLeft;
        track.classList.add('push-rail-dragging');
        view.addEventListener('mouseup', endDrag, { once: true });
    });

    track.addEventListener('mousemove', (event) => {
        if (!isPointerDown) return;
        const delta = event.pageX - startX;
        if (Math.abs(delta) > 4) {
            dragMoved = true;
        }
        event.preventDefault();
        track.scrollLeft = startScrollLeft - delta;
    });

    track.addEventListener('mouseleave', endDrag);

    track.addEventListener('click', (event) => {
        if (!dragMoved) return;
        const button = event.target instanceof Element ? event.target.closest('.push-rail-card') : null;
        if (button) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);

    updateFades();
    view.setTimeout(updateFades, 60);
}

async function openPushDetailModal(pushId) {
    const detailRes = await fetch('/api/worldinfo/push-detail', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ push_id: pushId }),
    });

    if (!detailRes.ok) {
        toastr.error(await detailRes.text() || 'Failed to load push detail', 'Push');
        return;
    }

    const item = await detailRes.json();
    const isChar = (item.character_files || []).length > 0;
    const charIcon = isChar ? 'fa-user-astronaut' : 'fa-book-atlas';
    const tagText = isChar ? 'Character' : 'Lorebook';
    const tagClass = isChar ? 'push-tag-char' : 'push-tag-lore';
    const titleLabel = isChar ? 'Character Update' : 'Lorebook Update';
    const isAnnouncement = !!item.is_public_announcement;
    const lorebookBundle = Array.isArray(item.lorebook_bundle)
        ? item.lorebook_bundle.filter(entry => entry?.pushed_lorebook_name)
        : [];
    const bundleLorebookNames = lorebookBundle.map(entry => String(entry.pushed_lorebook_name || '').trim()).filter(Boolean);
    const primaryBundleLorebook = lorebookBundle.find(entry => String(entry.role || '').toLowerCase() === 'primary')?.pushed_lorebook_name || item.pushed_lorebook_name;
    const characterLabel = item.announcement_character_name || item.source_names?.character_label || item.char_label || item.pushed_lorebook_name || 'Character';
    const cardTitle = isAnnouncement ? (item.announcement_title || '🎉 NEW CHARACTER!! 🎉') : primaryBundleLorebook;
    const cardDescription = isAnnouncement
        ? characterLabel
        : (bundleLorebookNames.length > 1
            ? `${item.char_label || 'Updated character bundle'} (${bundleLorebookNames.length} lorebooks)`
            : (item.char_label || (isChar ? 'Updated character and lorebook content.' : 'Updated world lore.')));
    const floralCharacterLabel = `🌸 ${characterLabel} 🌸`;
    const notesText = isAnnouncement
        ? `<span style="font-size:14px; font-weight:bold;">🎉 NEW CHARACTER!! 🎉</span>\n<span style="font-size:14px; font-weight:bold;">${floralCharacterLabel}</span>`
        : (item.notes || 'No notes provided.');
    const pushedByLabel = item.pushed_by_label || item.pushed_by_name || item.creator_handle || 'User';
    const originalCreator = item.original_creator_name || item.original_creator_handle || item.effective_creator || item.creator_handle || 'Unknown';
    const dialogTitle = isAnnouncement ? 'Import Lorebook' : titleLabel;
    const okLabel = 'Yes — Import';
    const declineLabel = 'No';

    // Character thumbnail — served via the push-char-thumb endpoint which
    // validates the item belongs to this user before serving from the creator's dir.
    const charThumbFile = (item.character_files || item.source_avatar_files || [])[0] || '';
    const charAvHtml = `
        <div class="push-cp-av-frame">
            ${isChar && charThumbFile
                ? `<img class="push-cp-av-img"
                    src="/api/worldinfo/push-char-thumb?push_id=${encodeURIComponent(pushId)}&file=${encodeURIComponent(charThumbFile)}"
                    alt="${escapeHtml(cardTitle)}"
                    onerror="this.classList.add('push-cp-av-img-err'); this.nextElementSibling.classList.add('is-visible');" />`
                : ''
            }
            <div class="push-cp-av-fallback${isChar && charThumbFile ? '' : ' is-visible'}"><i class="fa-solid ${charIcon}"></i></div>
        </div>
    `;

    const html = `
        <div class="push-popup-layout">
            <h3 style="margin-top:0;"><i class="fa-solid ${charIcon}" style="color:#a78bfa; font-size:14px;"></i> ${dialogTitle}</h3>
            <div class="push-cp">
                <div class="push-cp-av">${charAvHtml}</div>
                <div class="push-cp-info">
                    <div class="push-cp-name" ${isAnnouncement ? 'style="font-size:14px;"' : ''}>${escapeHtml(cardTitle)} <span class="push-tag ${tagClass}">${tagText}</span></div>
                    <div class="push-cp-by">Pushed by: ${escapeHtml(pushedByLabel)}</div>
                    <div class="push-cp-by">Submitted by original creator: ${escapeHtml(originalCreator)}</div>
                    <div class="push-cp-desc">${escapeHtml(cardDescription)}</div>
                </div>
            </div>
            <div class="push-cl-box">
                <div class="push-cl-title"><i class="fa-solid fa-scroll"></i> Update Notes</div>
                <div class="push-cl-body">${isAnnouncement ? notesText.replace(/\n/g, '<br>') : escapeHtml(notesText).replace(/\n/g, '<br>')}</div>
                ${bundleLorebookNames.length > 0 ? `<div class="push-cl-ver">Lorebooks: ${escapeHtml(bundleLorebookNames.join(', '))}</div>` : ''}
                ${item.version ? `<div class="push-cl-ver">Version: ${escapeHtml(item.version)}</div>` : ''}
            </div>
            <div class="push-warn">
                <i class="fa-solid fa-info-circle"></i>
                <p><strong>Yes-Import</strong> will import the character and linked lorebook. Lorebook contents will be hidden unless you are the creator or admin.</p>
            </div>
        </div>
    `;

    const RESULT_DECLINE = POPUP_RESULT.CUSTOM1;
    const RESULT_CLOSE = POPUP_RESULT.CUSTOM2;
    const customButtons = [
        { text: declineLabel, result: RESULT_DECLINE },
        { text: 'Close', result: RESULT_CLOSE }
    ];

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        okButton: okLabel,
        rows: 1,
        wider: true,
        customButtons,
    });
    decoratePushPopup(popup, 'detail');

    const result = await popup.show();
    let action = null;
    if (result === POPUP_RESULT.AFFIRMATIVE) action = 'accept';
    if (result === RESULT_DECLINE) action = 'decline';
        if (result === RESULT_CLOSE) return; // Close without action
    if (!action) return;

    let actionRes = await fetch('/api/worldinfo/push-action', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ push_id: pushId, action }),
    });

    // Backend returns 409 when files already exist and overwrite was not requested.
    // Prompt the user to confirm overwrite before retrying.
    if (actionRes.status === 409 && action === 'accept') {
        const confirmOverwrite = await callPopup(
            'This character/lorebook already exists locally. Overwrite with the updated version?',
            'confirm',
        );
        if (!confirmOverwrite) {
            await refreshPushNotificationState();
            return;
        }
        actionRes = await fetch('/api/worldinfo/push-action', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ push_id: pushId, action: 'overwrite' }),
        });
    }

    if (actionRes.ok) {
        let actionData = null;
        try {
            actionData = await actionRes.json();
        } catch {
            // no-op
        }
        const resolvedAction = actionData?.action || action;
        if (resolvedAction === 'accept' || resolvedAction === 'overwrite') {
            const charCount = actionData?.applied?.characters?.length || 0;
            const lorebookName = actionData?.applied?.lorebook || '';
            const bundledLorebooks = Array.isArray(actionData?.applied?.lorebooks) ? actionData.applied.lorebooks : (lorebookName ? [lorebookName] : []);
            const secondaryLorebooks = Array.isArray(actionData?.applied?.secondary_lorebooks) ? actionData.applied.secondary_lorebooks : [];

            // Success message showing what was imported
            let successMessage = `Imported ${charCount} character(s)`;
            if (bundledLorebooks.length > 1) {
                successMessage += ` with ${bundledLorebooks.length} lorebooks`;
            } else if (lorebookName) {
                successMessage += ` with lorebook: ${lorebookName}`;
            }
            toastr.success(successMessage, 'Import Successful', { timeOut: 5000 });

            // Reload character list and world info from backend
            await updateWorldInfoList();
            await getCharacters();

            // Show the character list panel so the user can see the newly imported character.
            if (actionData?.applied?.characters?.[0]) {
                const importedFileName = actionData.applied.characters[0];
                const charIndex = characters.findIndex(c => c.avatar === importedFileName);
                if (charIndex >= 0) {
                    // Navigate to the character list (not chat) so the recipient sees the new character.
                    select_rm_characters();

                    const character = characters[charIndex] || characters[Number(this_chid)] || null;
                    if (!character) {
                        return;
                    }

                    // Verify lorebook is linked
                    const characterWorld = character?.data?.extensions?.world;
                    const isPushedCharacter = isPushedCharacterRecord(character);

                    if (isPushedCharacter && lorebookName) {
                        // If backend didn't auto-link, link it now
                        if (characterWorld !== lorebookName) {
                            console.log(`[Push Import] Auto-linking "${character.name}" to lorebook "${lorebookName}"`);
                            const characterExtensions = /** @type {any} */ (character?.data?.extensions);
                            if (characterExtensions) {
                                characterExtensions.world = lorebookName;
                            }
                        }
                    }

                    if (secondaryLorebooks.length > 0) {
                        charSetAuxWorlds(importedFileName, secondaryLorebooks);
                    }

                    // Show world button lit up
                    setWorldInfoButtonClass(charIndex);

                    // Show toast confirming lorebook is linked
                    if (lorebookName) {
                        const creatorHandle = getCharacterPushExtensionBySuffix(character, 'creator');
                        const currentHandle = getCurrentUserHandle();
                        const creatorInfo = creatorHandle === currentHandle
                            ? ' (visible to you)'
                            : ' (hidden from dropdown)';
                        const lorebookInfo = bundledLorebooks.length > 1
                            ? `Lorebooks "${bundledLorebooks.join(', ')}"${creatorInfo}`
                            : `Lorebook "${lorebookName}"${creatorInfo}`;
                        toastr.info(
                            `${lorebookInfo} linked to "${character.name || character.data?.name || 'Character'}"`,
                            'Lorebook Linked',
                            { timeOut: 6000 },
                        );
                    }

                    // Apply definition lock state for pushed characters
                    const locked = isCharacterDefinitionLocked(character);
                    applyCharacterDefinitionLockState(locked);
                    ensurePushedLoreBookLinked(charIndex);
                    checkEmbeddedWorld(charIndex);

                    // Log what was imported for debugging
                    console.log(`[Push Import] Completed:`);
                    console.log(`  Character: "${character.name || character.data?.name}"`);
                    console.log(`  Lorebook: "${lorebookName}"`);
                    console.log(`  Locked: ${locked}`);
                }
            } else if (this_chid !== undefined && this_chid >= 0) {
                // Fallback: re-apply to current character
                setWorldInfoButtonClass(this_chid);
                ensurePushedLoreBookLinked(Number(this_chid));
            }
        } else {
            toastr.success(`Push ${resolvedAction} completed.`, 'Push');
        }
    } else {
        let err = 'Push action failed';
        try {
            const errJson = await actionRes.json();
            err = errJson?.reason || errJson?.error || err;
        } catch {
            err = await actionRes.text() || err;
        }
        toastr.error(err, 'Push');
    }

    await refreshPushNotificationState();
}

function statusTagClass(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'approved' || s === 'accepted') return 'push-tag-approved';
    if (s === 'reviewed') return 'push-tag-reviewed';
    if (s === 'rejected' || s === 'declined') return 'push-tag-rejected';
    return 'push-tag-pending';
}

async function openPushNotificationsModal() {
    const state = await refreshPushNotificationState();

    // Build a flat unified list of all notification items
    const rows = (state.pending || []).map(item => {
        const isChar = item.character_files?.length > 0;
        const icon = isChar ? 'fa-user-astronaut' : 'fa-book-atlas';
        const tag = isChar ? 'Char' : 'Lore';
        const tagClass = isChar ? 'push-tag-char' : 'push-tag-lore';
        const unreadClass = item.unread ? ' unread' : '';
        const isAnnouncement = !!item.is_public_announcement;
        const rowTitle = isAnnouncement
            ? (item.announcement_title || '🎉 NEW CHARACTER!! 🎉')
            : (item.pushed_lorebook_name || 'Notification');
        const announcementCharacter = item.announcement_character_name || item.source_names?.character_label || 'Character';
        const rowDesc = isAnnouncement
            ? `🌸 ${announcementCharacter} 🌸`
            : (item.notes || 'No notes');

        // Show character PNG thumbnail when available; fallback to FA icon
        const charThumbFile = (item.character_files || item.source_avatar_files || [])[0] || '';
        const avHtml = `
            <div class="push-ni-av-frame">
                ${isChar && charThumbFile && item.push_id
                    ? `<img class="push-ni-av-img"
                        src="/api/worldinfo/push-char-thumb?push_id=${encodeURIComponent(item.push_id)}&file=${encodeURIComponent(charThumbFile)}"
                        alt="${escapeHtml(rowTitle)}"
                        onerror="this.classList.add('push-ni-av-img-err'); this.nextElementSibling.classList.add('is-visible');" />`
                    : ''
                }
                <div class="push-ni-av-fallback${isChar && charThumbFile && item.push_id ? '' : ' is-visible'}"><i class="fa-solid ${icon}"></i></div>
            </div>
        `;

        return `
        <div class="push-ni${unreadClass}" data-push-id="${item.push_id}">
            <div class="push-ni-av">${avHtml}</div>
            <div class="push-ni-body">
                <div class="push-ni-title" ${isAnnouncement ? 'style="font-size:14px; font-weight:bold;"' : ''}>${escapeHtml(rowTitle)} <span class="push-tag ${tagClass}">${tag}</span></div>
                <div class="push-ni-desc ${isAnnouncement ? 'push-ni-desc-announce' : ''}" ${isAnnouncement ? 'style="font-size:14px; font-weight:bold;"' : ''}>${escapeHtml(rowDesc)}</div>
                <div class="push-ni-time">${formatPushTs(item.created_at)}</div>
            </div>
        </div>`;
    }).join('');

    const html = `
        <div class="push-inbox-modal push-popup-layout">
            <h3 style="margin-top:0;"><i class="fa-solid fa-bell" style="color:#a78bfa; font-size:14px;"></i> Notifications</h3>
            <div class="push-nl">${rows || '<div class="push-ni-desc" style="padding:12px; text-align:center;">No notifications.</div>'}</div>
        </div>
    `;

    const RESULT_MARK_ALL_READ = POPUP_RESULT.CUSTOM1;
    const RESULT_CLEAR_READ = POPUP_RESULT.CUSTOM2;
    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        rows: 1,
        wider: true,
        customButtons: [
            { text: 'Mark All Read', result: RESULT_MARK_ALL_READ },
            { text: 'Clear Read', result: RESULT_CLEAR_READ },
        ],
    });
    decoratePushPopup(popup, 'notifications');
    const resultPromise = popup.show();

    $(popup.dlg).on('click', '.push-ni[data-push-id]', async function (evt) {
        evt.preventDefault();
        evt.stopPropagation();
        const pushId = $(this).data('push-id');
        if (!pushId) return;
        popup.complete(POPUP_RESULT.AFFIRMATIVE);
        setTimeout(() => {
            openPushDetailModal(pushId);
        }, 220);
    });

    const result = await resultPromise;
    let clearAction = null;
    if (result === RESULT_MARK_ALL_READ) clearAction = 'mark_all_read';
    if (result === RESULT_CLEAR_READ) clearAction = 'clear_read';
    if (clearAction) {
        const clearRes = await fetch('/api/worldinfo/push-notifications-clear', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ action: clearAction }),
        });
        if (!clearRes.ok) {
            toastr.error(await clearRes.text() || 'Failed to clear notifications', 'Push');
        }
        await refreshPushNotificationState();
    }
}

async function openDeletionRequestModal() {
    const old = document.getElementById('del_req_overlay');
    if (old) old.remove();

    // Fetch push records to cross-reference which characters were pushed
    const pushRes = await fetch('/api/worldinfo/accepted-pushes', { method: 'POST', headers: getRequestHeaders() });
    const pushData = pushRes.ok ? await pushRes.json() : { accepted: [] };
    const pushByFile = new Map();
    for (const item of pushData.accepted || []) {
        for (const f of (item.character_files || [])) pushByFile.set(f, item);
    }

    const allChars = (characters || [])
        .filter(c => c.avatar && c.name)
        .map(c => ({ name: c.name, avatar: c.avatar, pushItem: pushByFile.get(c.avatar) || null }));

    const selectedAvatars = new Set();
    const requestedAvatars = new Set();

    const thumbUrl = av => `/thumbnail?type=avatar&file=${encodeURIComponent(av)}`;

    function updateFooterBtn() {
        const btn = document.getElementById('del_req_submit');
        if (!btn) return;
        const pending = [...selectedAvatars].filter(av => !requestedAvatars.has(av));
        btn.disabled = pending.length === 0;
        btn.textContent = pending.length > 0
            ? `Request Deletion (${pending.length})`
            : 'Request Deletion';
    }

    function renderCards() {
        const cardsEl = document.getElementById('del_req_cards');
        const countEl = document.getElementById('del_req_count');
        if (!cardsEl || !countEl) return;
        const sel = [...selectedAvatars];
        countEl.textContent = sel.length === 0
            ? 'No characters selected'
            : `${sel.length} character${sel.length !== 1 ? 's' : ''} selected`;
        if (sel.length === 0) {
            cardsEl.innerHTML = `<div style="width:100%; text-align:center; color:#5a5a7a; font-size:13px; padding-top:36px; font-style:italic;">Search and select characters above</div>`;
        } else {
            cardsEl.innerHTML = sel.map(av => {
                const ch = allChars.find(c => c.avatar === av);
                const name = ch ? ch.name : av.replace(/\.png$/i, '');
                const done = requestedAvatars.has(av);
                return `
                <div class="del-req-card" data-avatar="${escapeHtml(av)}" style="
                    flex-shrink:0; width:120px; display:flex; flex-direction:column; align-items:center;
                    background:#1a1a2e; border:1px solid ${done ? '#2a4a2a' : '#2e2e4e'}; border-radius:10px;
                    padding:10px 8px 8px; position:relative; opacity:${done ? '.55' : '1'};">
                    ${!done ? `<button type="button" class="del-req-remove-btn" data-avatar="${escapeHtml(av)}" style="
                        position:absolute; top:-8px; right:-8px; width:20px; height:20px; border-radius:50%;
                        background:#3a3a5a; border:1px solid #5a5a7a; color:#c0c0e0; font-size:12px;
                        cursor:pointer; display:flex; align-items:center; justify-content:center; padding:0;">×</button>` : ''}
                    <img src="${thumbUrl(av)}" alt="${escapeHtml(name)}"
                         style="width:72px; height:72px; border-radius:8px; object-fit:cover; margin-bottom:6px; border:1px solid #2e2e4e;"
                         onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
                    <div style="display:none; width:72px; height:72px; border-radius:8px; background:#2a2a4a; align-items:center; justify-content:center; margin-bottom:6px; font-size:24px; color:#5a5a8a;"><i class="fa-solid fa-user-astronaut"></i></div>
                    <div style="font-size:15px; color:#c0c0e0; text-align:center; word-break:break-word; line-height:1.3;">${escapeHtml(name)}</div>
                    ${done ? `<div style="font-size:14px; color:#4a9a4a; margin-top:4px;"><i class="fa-solid fa-check"></i> Requested</div>` : ''}
                </div>`;
            }).join('');
        }
        updateFooterBtn();
    }

    function renderDropdown(query) {
        const ddEl = document.getElementById('del_req_dropdown');
        if (!ddEl) return;
        const q = query.toLowerCase().trim();
        const filtered = allChars.filter(c =>
            !selectedAvatars.has(c.avatar)
            && (!q || c.name.toLowerCase().includes(q) || c.avatar.toLowerCase().includes(q))
        );
        if (!filtered.length) {
            ddEl.innerHTML = `<div style="padding:10px 12px; color:#5a5a7a; font-size:13px; font-style:italic;">${q ? 'No matches found.' : 'All characters selected.'}</div>`;
        } else {
            ddEl.innerHTML = filtered.slice(0, 40).map(c => `
                <div class="del-req-dd-item" data-avatar="${escapeHtml(c.avatar)}" style="
                    display:flex; align-items:center; gap:10px; padding:7px 12px; cursor:pointer;
                    font-size:13px; color:#c0c0e0; transition:background .12s;"
                    onmouseover="this.style.background='rgba(104,104,170,.18)'"
                    onmouseout="this.style.background=''">
                    <img src="${thumbUrl(c.avatar)}" style="width:28px; height:28px; border-radius:4px; object-fit:cover; flex-shrink:0;" onerror="this.style.display='none';" />
                    <span>${escapeHtml(c.name)}</span>
                </div>`).join('');
        }
        ddEl.style.display = 'block';
    }

    $('body').append(`
        <div id="del_req_overlay" class="push-inbox-overlay">
            <div class="push-inbox-window" role="dialog" aria-modal="true" style="max-width:560px;">
                <div class="push-inbox-window-header">
                    <h3 style="font-size:16px;"><i class="fa-solid fa-box-archive" style="color:#a78bfa;"></i> Request Character Deletion</h3>
                    <button type="button" id="del_req_close_x" class="menu_button push-aurora-btn push-aurora-btn-ghost"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="push-inbox-window-body" style="display:flex; flex-direction:column; gap:10px; padding:16px; flex:1 1 auto; min-height:0;">
                    <div style="font-size:16px; color:#8888aa; flex-shrink:0;">Select an imported character to request its removal from your account.</div>
                    <div style="position:relative; flex-shrink:0;">
                        <i class="fa-solid fa-magnifying-glass" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:#6868aa; font-size:16px; pointer-events:none; z-index:1;"></i>
                        <input id="del_req_search" type="text" class="text_pole" autocomplete="off"
                            placeholder="Search characters..."
                            style="padding-left:36px !important; font-size:17px !important; width:100%; box-sizing:border-box; margin:0;" />
                        <div id="del_req_dropdown" style="
                            display:none; position:absolute; top:calc(100% + 4px); left:0; right:0; z-index:200;
                            background:#181828; border:1px solid #3a3a5a; border-radius:8px;
                            max-height:200px; overflow-y:auto; box-shadow:0 6px 20px rgba(0,0,0,.5);"></div>
                    </div>
                    <div id="del_req_count" style="font-size:15px; color:#6060a0; padding:0 2px; flex-shrink:0;">No characters selected</div>
                    <div id="del_req_cards" style="display:flex; flex-direction:row; flex-wrap:nowrap; overflow-x:auto; gap:10px; padding:4px 2px 10px; flex:1 1 auto; min-height:100px; align-items:flex-start;">
                        <div style="width:100%; text-align:center; color:#5a5a7a; font-size:16px; padding-top:36px; font-style:italic;">Search and select characters above</div>
                    </div>
                </div>
                <div class="push-inbox-window-footer" style="flex-shrink:0;">
                    <button type="button" id="del_req_submit" class="menu_button push-aurora-btn push-aurora-btn-decline" disabled style="font-size:16px; padding:8px 16px;">Request Deletion</button>
                    <button type="button" id="del_req_close" class="menu_button push-aurora-btn push-aurora-btn-ghost" style="font-size:16px; padding:8px 16px;">Close</button>
                </div>
            </div>
        </div>
    `);

    function closeModal() {
        $('#del_req_overlay').remove();
        $(document).off('.delReq');
    }

    $(document).on('click.delReq', '#del_req_close, #del_req_close_x', closeModal);
    $(document).on('click.delReq', '#del_req_overlay', function (e) {
        if (e.target.id === 'del_req_overlay') closeModal();
    });
    $(document).on('input.delReq', '#del_req_search', function () { renderDropdown(this.value); });
    $(document).on('focus.delReq', '#del_req_search', function () { renderDropdown(this.value); });
    $(document).on('click.delReq', function (e) {
        if (!$(e.target).closest('#del_req_search, #del_req_dropdown').length) {
            const dd = document.getElementById('del_req_dropdown');
            if (dd) dd.style.display = 'none';
        }
    });
    $(document).on('click.delReq', '.del-req-dd-item', function () {
        const av = $(this).data('avatar');
        if (!av || selectedAvatars.has(av)) return;
        selectedAvatars.add(av);
        renderCards();
        const dd = document.getElementById('del_req_dropdown');
        if (dd) dd.style.display = 'none';
        const inp = document.getElementById('del_req_search');
        if (inp) inp.value = '';
    });
    $(document).on('click.delReq', '.del-req-remove-btn', function () {
        const av = $(this).data('avatar');
        if (!requestedAvatars.has(av)) {
            selectedAvatars.delete(av);
            renderCards();
        }
    });

    // Shared helper: show a custom dialog above the overlay (avoids callPopup z-index conflict)
    function showDelReqDialog(htmlContent) {
        $('#del_req_dialog').remove();
        $('body').append(`
            <div id="del_req_dialog" style="
                position:fixed; inset:0; z-index:100000;
                background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center;">
                <div style="background:#1a1a2e; border:1px solid #3a3a5a; border-radius:12px;
                            padding:24px; min-width:300px; max-width:420px; width:90%;
                            box-shadow:0 8px 32px rgba(0,0,0,.6);">
                    ${htmlContent}
                </div>
            </div>
        `);
    }

    function customConfirm(message) {
        return new Promise(resolve => {
            showDelReqDialog(`
                <p style="margin:0 0 18px; font-size:14px; color:#c0c0e0; line-height:1.6;">${message}</p>
                <div style="display:flex; gap:10px; justify-content:flex-end;">
                    <button id="drq_no" class="menu_button push-aurora-btn push-aurora-btn-ghost" style="font-size:13px; padding:7px 16px;">Cancel</button>
                    <button id="drq_yes" class="menu_button push-aurora-btn push-aurora-btn-decline" style="font-size:13px; padding:7px 16px;">Yes, Request</button>
                </div>
            `);
            function cleanup() { $(document).off('.drqConfirm'); $('#del_req_dialog').remove(); }
            $(document).on('click.drqConfirm', '#drq_yes', () => { cleanup(); resolve(true); });
            $(document).on('click.drqConfirm', '#drq_no',  () => { cleanup(); resolve(false); });
        });
    }

    function customInput(label) {
        return new Promise(resolve => {
            showDelReqDialog(`
                <p style="margin:0 0 10px; font-size:14px; color:#c0c0e0;">${label}</p>
                <input id="drq_reason_input" type="text" class="text_pole" autocomplete="off"
                    placeholder="Optional…"
                    style="width:100%; box-sizing:border-box; font-size:14px !important; margin-bottom:14px;" />
                <div style="display:flex; gap:10px; justify-content:flex-end;">
                    <button id="drq_input_skip" class="menu_button push-aurora-btn push-aurora-btn-ghost" style="font-size:13px; padding:7px 16px;">Skip</button>
                    <button id="drq_input_ok" class="menu_button push-aurora-btn" style="font-size:13px; padding:7px 16px;">OK</button>
                </div>
            `);
            function cleanup() { $(document).off('.drqInput'); $('#del_req_dialog').remove(); }
            $(document).on('click.drqInput', '#drq_input_ok', () => {
                const val = String($('#drq_reason_input').val() || '').trim();
                cleanup(); resolve(val);
            });
            $(document).on('click.drqInput', '#drq_input_skip', () => { cleanup(); resolve(''); });
            // Submit on Enter
            $(document).on('keydown.drqInput', '#drq_reason_input', function (e) {
                if (e.key === 'Enter') { $('#drq_input_ok').trigger('click'); }
            });
        });
    }

    // Footer "Request Deletion (N)" — batch all pending selected characters
    $(document).on('click.delReq', '#del_req_submit', async function () {
        const pending = [...selectedAvatars].filter(av => !requestedAvatars.has(av));
        if (!pending.length) return;

        const nameList = pending.map(av => {
            const ch = allChars.find(c => c.avatar === av);
            return `<strong>${escapeHtml(ch ? ch.name : av.replace(/\.png$/i, ''))}</strong>`;
        }).join(', ');

        const confirmed = await customConfirm(`Request admin to delete ${nameList} from your account?`);
        if (!confirmed) return;

        const reason = await customInput('Reason for deletion request (optional, applies to all):');

        let successCount = 0;
        const errors = [];
        for (const av of pending) {
            const ch = allChars.find(c => c.avatar === av);
            const name = ch ? ch.name : av.replace(/\.png$/i, '');
            const body = ch?.pushItem
                ? { push_id: ch.pushItem.push_id, reason }
                : { character_file: av, character_name: name, reason };
            const r = await fetch('/api/worldinfo/user-deletion-request', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });
            if (r.ok) {
                requestedAvatars.add(av);
                successCount++;
            } else {
                const txt = await r.text();
                errors.push(`${name}: ${txt || 'failed'}`);
            }
        }

        if (successCount > 0) {
            toastr.success(
                `Deletion request sent for ${successCount} character${successCount !== 1 ? 's' : ''}.`,
                'Request Sent',
            );
        }
        if (errors.length) {
            toastr.warning(errors.join('\n'), 'Some Requests Failed');
        }
        if (successCount > 0) {
            closeModal();
            return;
        }
        renderCards();
    });
}

function getSubmitRenameTargetName(boundLorebook, characterName) {
    const sourceName = String(boundLorebook || characterName || '').trim();
    const currentHandle = String(getCurrentUserHandle() || '').trim().toLowerCase();
    const currentUserIsAdmin = Boolean(isAdmin());

    if (!sourceName) return '';
    if (sourceName.startsWith('dd-')) return sourceName;
    if (isAdminPrefixedLorebookName(sourceName)) {
        if (!currentUserIsAdmin) {
            const baseName = stripAdminLorebookPrefix(sourceName);
            return currentHandle ? `dd-${currentHandle}-${baseName}` : baseName;
        }
        return sourceName;
    }
    if (!currentHandle) return sourceName;
    if (currentUserIsAdmin) {
        return currentHandle === 'default-user'
            ? `ADMIN-${sourceName}`
            : `ADMIN${currentHandle}-${sourceName}`;
    }
    return `dd-${currentHandle}-${sourceName}`;
}

function renderPushBindingCard({
    characterName,
    boundLorebook,
    avatarFile = '',
    renameValue = '',
    renameInputId = '',
    showRenameInput = false,
}) {
    const safeCharacterName = escapeHtml(characterName || 'Unknown');
    const safeBoundLorebook = escapeHtml(boundLorebook || '');
    const safeRenameValue = escapeHtml(renameValue || '');
    const hiddenNote = boundLorebook ? '<span class="push-lb-hidden-note">~(hidden entries)~</span>' : '';
    const bindingHtml = boundLorebook
        ? `<div class="push-lb bound"><i class="fa-solid fa-book-atlas"></i> <span>Lorebook bound: <strong>${safeBoundLorebook}</strong> ${hiddenNote}</span></div>`
        : '<div class="push-lb unbound"><i class="fa-solid fa-book-skull"></i> <span>No lorebook bound to this character. Submission will use the character name.</span></div>';

    const thumbHtml = `
        <div class="push-binding-card-thumb-frame">
            ${avatarFile
                ? `<img class="push-binding-card-thumb" src="/thumbnail?type=avatar&file=${encodeURIComponent(avatarFile)}" alt="${safeCharacterName}" onerror="this.classList.add('push-binding-card-thumb-err'); this.nextElementSibling.classList.add('is-visible')" />`
                : ''
            }
            <div class="push-binding-card-thumb-fallback${avatarFile ? '' : ' is-visible'}"><i class="fa-solid fa-user-astronaut"></i></div>
        </div>
    `;

    const renameHtml = showRenameInput
        ? `
            <div class="push-f push-rename-field">
                <div class="push-fl"><i class="fa-solid fa-i-cursor"></i> Rename Lorebook Before Submission</div>
                <input id="${renameInputId}" class="text_pole push-submit-rename" style="width:100%;" value="${safeRenameValue}" />
            </div>
        `
        : '';

    return `
        <div class="push-binding-card" data-char-name="${safeCharacterName}">
            <div class="push-binding-card-header">
                ${thumbHtml}
                <div class="push-binding-card-name">${safeCharacterName}</div>
            </div>
            ${bindingHtml}
            ${renameHtml}
        </div>
    `;
}

async function openSubmitToAdminModal() {
    // Build character options — show all characters, sorted alphabetically
    const charList = (characters || []).map(c => ({
        name: c.name || c.avatar?.replace('.png', '') || 'Unknown',
        world: c?.data?.extensions?.world || '',
        avatar: c.avatar || '',
    }));
    charList.sort((a, b) => a.name.localeCompare(b.name));

    const charOptions = charList.map(c =>
        `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`,
    ).join('');

    const html = `
        <div class="push-popup-layout">
            <h3 style="margin-top:0;">Submit to Admin</h3>
            <div class="push-f">
                <div class="push-fl"><i class="fa-solid fa-user-astronaut"></i> Character Card <span style="opacity:0.5; font-size:0.85em;">(select up to 10)</span></div>
                <select id="push_submit_name" class="text_pole" style="width:100%;" multiple="multiple">
                    ${charOptions}
                </select>
                <div id="push_submit_lb" class="push-binding-list" style="display:none;"></div>
                <div style="margin-top:4px;">
                    <span id="push_submit_count" style="font-size:0.85em; opacity:0.6;">0 / 10 selected</span>
                </div>
            </div>
            <div class="push-f">
                <div class="push-fl"><i class="fa-solid fa-comment-dots"></i> Notes to Admin</div>
                <textarea id="push_submit_notes" class="text_pole" style="width:100%; min-height:90px;" placeholder="What you changed, bugs, suggestions..."></textarea>
            </div>
            <div class="push-f">
                <div class="push-fl">Priority</div>
                <select id="push_submit_priority" class="text_pole" style="width:100%;">
                    <option value="normal">Normal</option>
                    <option value="low">Low \u2014 Suggestion</option>
                    <option value="high">High \u2014 Bug fix</option>
                </select>
            </div>
        </div>
    `;
    const RESULT_INBOX = POPUP_RESULT.CUSTOM1;
    const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Submit',
        cancelButton: 'Cancel',
        wider: true,
        allowVerticalScrolling: true,
        customButtons: [{ text: 'Inbox', result: RESULT_INBOX }],
    });
    decoratePushPopup(popup, 'submit');
    const dlg = popup.dlg;
    const resultPromise = popup.show();

    // Initialize Select2 searchable multi-select for character selection.
    // dropdownParent must point to the open popup dialog so the dropdown
    // renders INSIDE the popup instead of behind it (z-index issue).
    const $charSelect = $(dlg).find('#push_submit_name');
    $charSelect.select2({
        width: '100%',
        placeholder: '\u2014 Search and select characters \u2014',
        searchInputPlaceholder: 'Type to filter...',
        allowClear: true,
        closeOnSelect: false,
        maximumSelectionLength: 10,
        dropdownParent: $(dlg),
    });

    const renameDrafts = new Map();
    const primaryLorebookDrafts = new Map();
    const secondaryLorebookDrafts = new Map();

    // Build lorebook options from world_names
    const lorebookOptions = (world_names || []).map(name =>
        `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`,
    ).join('');

    // Lorebook binding indicator — updates as selections change
    function refreshSubmitBindings() {
        const lbDiv = $(dlg).find('#push_submit_lb');
        const selected = $charSelect.val() || [];
        const count = selected.length;
        $(dlg).find('#push_submit_count').text(`${count} / 10 selected`);

        if (count === 0) {
            lbDiv.hide().empty();
            return;
        }

        const entries = selected.map((name, index) => {
            const c = charList.find(x => x.name === name);
            const avatarFile = c?.avatar || '';
            const primaryLorebook = primaryLorebookDrafts.get(name) || c?.world || '';
            const secondaryLorebook = secondaryLorebookDrafts.get(name) || '';
            const renameValue = renameDrafts.get(name) || getSubmitRenameTargetName(primaryLorebook, name);

            // Create lorebook selector HTML for this character
            const primarySelectHtml = `
                <div class="push-lorebook-selector" style="margin-top:8px;">
                    <label style="font-size:0.9em; opacity:0.8; display:block; margin-bottom:4px;">
                        <i class="fa-solid fa-book"></i> Primary Lorebook (required)
                    </label>
                    <select id="push_submit_primary_lb_${index}" class="text_pole push-submit-primary-lb" style="width:100%;" data-char-name="${escapeHtml(name)}">
                        <option value="">— Select primary lorebook —</option>
                        ${lorebookOptions}
                    </select>
                </div>
            `;

            const secondarySelectHtml = `
                <div class="push-lorebook-selector" style="margin-top:6px;">
                    <label style="font-size:0.9em; opacity:0.7; display:block; margin-bottom:4px;">
                        <i class="fa-solid fa-book-open"></i> Secondary Lorebook (optional)
                    </label>
                    <select id="push_submit_secondary_lb_${index}" class="text_pole push-submit-secondary-lb" style="width:100%;" data-char-name="${escapeHtml(name)}">
                        <option value="">— Select secondary lorebook (optional) —</option>
                        ${lorebookOptions}
                    </select>
                </div>
            `;

            const cardHtml = renderPushBindingCard({
                characterName: name,
                boundLorebook: primaryLorebook,
                avatarFile,
                renameValue,
                renameInputId: `push_submit_rename_${index}`,
                showRenameInput: true,
            });
            return `<div class="push-binding-group">${cardHtml}${primarySelectHtml}${secondarySelectHtml}</div>`;
        });

        // Single card: plain vertical layout. Multiple: horizontal scroll rail.
        if (entries.length === 1) {
            lbDiv.show().html(entries[0]);
        } else {
            lbDiv.show().html(`
                <div class="push-binding-rail push-rail-shell">
                    <div class="push-rail-fade push-rail-fade-left"></div>
                    <div class="push-binding-rail-track push-rail-track">
                        ${entries.join('')}
                    </div>
                    <div class="push-rail-fade push-rail-fade-right"></div>
                </div>
            `);
            // Reuse the existing drag+fade scroll initializer on the new rail
            initPushTargetRail(lbDiv[0]);
        }

        // Initialize Select2 on newly created lorebook selectors
        $(dlg).find('.push-submit-primary-lb').each(function () {
            if (!$(this).data('select2')) {
                const charName = $(this).data('char-name');
                $(this).val(primaryLorebookDrafts.get(charName) || '').select2({
                    width: '100%',
                    placeholder: '— Select primary lorebook —',
                    searchInputPlaceholder: 'Type to filter...',
                    allowClear: true,
                    closeOnSelect: true,
                    dropdownParent: $(dlg),
                });
            }
        });

        $(dlg).find('.push-submit-secondary-lb').each(function () {
            if (!$(this).data('select2')) {
                const charName = $(this).data('char-name');
                $(this).val(secondaryLorebookDrafts.get(charName) || '').select2({
                    width: '100%',
                    placeholder: '— Select secondary lorebook (optional) —',
                    searchInputPlaceholder: 'Type to filter...',
                    allowClear: true,
                    closeOnSelect: true,
                    dropdownParent: $(dlg),
                });
            }
        });
    }

    $charSelect.on('change', refreshSubmitBindings);

    // Track primary lorebook selection
    $(dlg).on('change', '.push-submit-primary-lb', function () {
        const charName = $(this).data('char-name');
        const value = String($(this).val() || '').trim();
        if (value) {
            primaryLorebookDrafts.set(charName, value);
        } else {
            primaryLorebookDrafts.delete(charName);
        }
    });

    // Track secondary lorebook selection
    $(dlg).on('change', '.push-submit-secondary-lb', function () {
        const charName = $(this).data('char-name');
        const value = String($(this).val() || '').trim();
        if (value) {
            secondaryLorebookDrafts.set(charName, value);
        } else {
            secondaryLorebookDrafts.delete(charName);
        }
    });

    $(dlg).on('input', '.push-submit-rename', function () {
        const characterName = $(this).closest('.push-binding-card').data('char-name');
        if (!characterName) return;
        renameDrafts.set(characterName, String($(this).val() || '').trim());
    });

    const result = await resultPromise;

    // Clean up Select2 before popup removal
    if ($charSelect.data('select2')) {
        try { $charSelect.select2('destroy'); } catch { /* no-op */ }
    }

    if (result === RESULT_INBOX) {
        await openUserInboxModal();
        return;
    }
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    const selectedNames = $charSelect.val() || [];
    if (selectedNames.length === 0) {
        toastr.warning('Choose at least one character before submitting.', 'Submit');
        return;
    }

    // Validate that all characters have at least a primary lorebook selected
    let missingLorebooks = [];
    for (const charName of selectedNames) {
        if (!primaryLorebookDrafts.get(charName)) {
            missingLorebooks.push(charName);
        }
    }
    if (missingLorebooks.length > 0) {
        toastr.warning(`Please select a primary lorebook for: ${missingLorebooks.join(', ')}`, 'Submit');
        return;
    }

    const priority = String($(dlg).find('#push_submit_priority').val() || 'normal');
    const notes = String($(dlg).find('#push_submit_notes').val() || '');

    // Submit each selected character individually
    let successCount = 0;
    let failCount = 0;
    let needsRefresh = false;
    for (const charName of selectedNames) {
        const charInfo = charList.find(c => c.name === charName);
        const primaryLorebook = primaryLorebookDrafts.get(charName) || '';
        const secondaryLorebook = secondaryLorebookDrafts.get(charName) || '';
        const submittedLorebookName = renameDrafts.get(charName) || getSubmitRenameTargetName(primaryLorebook, charName);
        const submittedLorebookNameError = getSubmissionLorebookNamingValidationError(submittedLorebookName);
        if (submittedLorebookNameError) {
            toastr.error(submittedLorebookNameError, 'Invalid Lorebook Name');
            return;
        }
        const primaryLorebookNameError = getSubmissionLorebookNamingValidationError(primaryLorebook);
        if (primaryLorebookNameError) {
            toastr.error(primaryLorebookNameError, 'Invalid Lorebook Name');
            return;
        }
        if (secondaryLorebook) {
            const secondaryLorebookNameError = getSubmissionLorebookNamingValidationError(secondaryLorebook);
            if (secondaryLorebookNameError) {
                toastr.error(secondaryLorebookNameError, 'Invalid Lorebook Name');
                return;
            }
        }

        const payload = {
            content_type: 'character_lorebook_bundle',
            primary_lorebook_name: primaryLorebook,
            secondary_lorebook_name: secondaryLorebook || undefined,
            secondary_lorebooks: secondaryLorebook ? [secondaryLorebook] : [],
            content_name: submittedLorebookName,
            source_lorebook_name: primaryLorebook,
            character_name: charName,
            character_avatar: charInfo?.avatar || '',
            priority,
            notes,
        };

        try {
            const res = await fetch('/api/worldinfo/submit', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(payload),
            });

            if (res.ok) {
                const data = await res.json();
                if (data?.renamed_source_lorebook) needsRefresh = true;
                successCount++;
            } else {
                console.warn(`[Submit] Failed for ${charName}:`, await res.text());
                failCount++;
            }
        } catch (err) {
            console.error(`[Submit] Error for ${charName}:`, err);
            failCount++;
        }
    }

    if (needsRefresh) {
        await updateWorldInfoList();
        await getCharacters();
    }

    if (successCount > 0) {
        toastr.success(`Submitted ${successCount} character(s) to admin inbox.${failCount > 0 ? ` (${failCount} failed)` : ''}`, 'Submit');
    } else {
        toastr.error('All submissions failed.', 'Submit');
    }

    await refreshPushNotificationState();
}

async function openAdminInboxDetailModal(itemId, itemType = 'submission') {
    const detailRes = await fetch('/api/worldinfo/admin-inbox-detail', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(itemType === 'admin_note' ? { note_id: itemId } : { submission_id: itemId }),
    });

    if (!detailRes.ok) {
        toastr.error(await detailRes.text() || 'Failed to load inbox item', 'Admin Inbox');
        return;
    }

    const item = await detailRes.json();

    const old = document.getElementById('push_admin_submission_overlay');
    if (old) old.remove();

    const isAdminNote = item.inbox_item_type === 'admin_note';
    const isDeletionRequest = item.inbox_item_type === 'deletion_request';
    const priorityLabel = { high: '\u{1F534} High \u2014 Bug fix', low: '\u{1F535} Low \u2014 Suggestion', normal: '\u{1F7E2} Normal' };
    const isChar = item.content_type === 'character_lorebook_bundle';
    const charIcon = isAdminNote ? 'fa-note-sticky' : isDeletionRequest ? 'fa-trash-can' : (isChar ? 'fa-user-astronaut' : 'fa-book-atlas');
    const tagText = isAdminNote ? 'User Note' : isDeletionRequest ? 'Del Request' : (isChar ? 'Character' : 'Lorebook');
    const tagClass = isAdminNote ? 'push-tag-note' : isDeletionRequest ? 'push-tag-rejected' : (isChar ? 'push-tag-char' : 'push-tag-lore');
    const cardName = isAdminNote ? `Note for ${item.target_admin || 'admin'}` : (item.content_name || 'Submission');
    const byLine = isAdminNote
        ? `Sent by: ${escapeHtml(item.from_name || item.from_handle || 'user')}`
        : `Submitted by: ${escapeHtml(item.submitter_name || item.submitter_handle || 'user')}`;
    const descText = isAdminNote
        ? 'A user note sent directly to an admin.'
        : isDeletionRequest
            ? `User requests deletion of this pushed character from their account.`
            : (item.character_description || 'User-submitted content for review.');

    // Use stable avatar URLs so the detail modal can render immediately without
    // waiting on a separate profile-avatar fetch.
    const senderHandleForAvatar = isAdminNote ? (item.from_handle || '') : (item.submitter_handle || '');
    const senderProfileAvatar = getUserAvatarImageUrl(senderHandleForAvatar);
    const notesTitle = isAdminNote ? 'Message' : 'User Notes';
    const notesBody = isAdminNote ? (item.message || 'No message provided.') : (item.notes || 'No notes provided.');
    const replyValue = isAdminNote ? (item.admin_reply || '') : (item.reply || '');
    const replyPlaceholder = isAdminNote ? 'Optional reply back to the user...' : 'Feedback for user...';
    const submissionBundle = !isAdminNote && Array.isArray(item.lorebook_bundle)
        ? item.lorebook_bundle.filter(entry => entry?.source_lorebook_name || entry?.pushed_lorebook_name)
        : [];
    const primarySubmissionLorebook = submissionBundle.find(entry => String(entry.role || '').toLowerCase() === 'primary')?.pushed_lorebook_name
        || item.primary_lorebook_name
        || item.source_lorebook_name
        || '';
    const secondarySubmissionLorebooks = submissionBundle
        .filter(entry => String(entry.role || '').toLowerCase() === 'secondary')
        .map(entry => String(entry.pushed_lorebook_name || entry.source_lorebook_name || '').trim())
        .filter(Boolean);
    const bundleInfoHtml = !isAdminNote && (primarySubmissionLorebook || secondarySubmissionLorebooks.length > 0)
        ? `
                    <div class="push-cl-box notes" style="margin-top:12px;">
                        <div class="push-cl-title"><i class="fa-solid fa-scroll"></i> Bundle Lorebooks</div>
                        ${primarySubmissionLorebook ? `<div class="push-cl-body"><strong>Primary:</strong> ${escapeHtml(primarySubmissionLorebook)}</div>` : ''}
                        ${secondarySubmissionLorebooks.length > 0 ? `<div class="push-cl-ver">Secondary: ${escapeHtml(secondarySubmissionLorebooks.join(', '))}</div>` : ''}
                    </div>
                `
        : '';
    const footerButtons = isAdminNote
        ? `
                    <button type="button" id="push_admin_submission_reply" class="menu_button push-aurora-btn push-aurora-btn-reviewed"><i class="fa-solid fa-reply"></i> Reply</button>
                    <button type="button" id="push_admin_submission_delete" class="menu_button push-aurora-btn push-aurora-btn-decline"><i class="fa-solid fa-trash"></i> Delete</button>
                    <button type="button" id="push_admin_submission_reviewed" class="menu_button push-aurora-btn push-aurora-btn-reviewed"><i class="fa-solid fa-eye"></i> Reviewed</button>
                `
        : isDeletionRequest
            ? `
                    <button type="button" id="push_admin_del_for_user" class="menu_button push-aurora-btn push-aurora-btn-reviewed"><i class="fa-solid fa-user-minus"></i> Delete for User</button>
                    <button type="button" id="push_admin_del_for_all" class="menu_button push-aurora-btn push-aurora-btn-decline"><i class="fa-solid fa-users-slash"></i> Delete for All Users</button>
                    <button type="button" id="push_admin_submission_delete" class="menu_button push-aurora-btn push-aurora-btn-ghost"><i class="fa-solid fa-xmark"></i> Dismiss</button>
                `
            : `
                    <button type="button" id="push_admin_submission_deny" class="menu_button push-aurora-btn push-aurora-btn-decline"><i class="fa-solid fa-xmark"></i> Reject</button>
                    <button type="button" id="push_admin_submission_reviewed" class="menu_button push-aurora-btn push-aurora-btn-reviewed"><i class="fa-solid fa-eye"></i> Reviewed</button>
                    <button type="button" id="push_admin_submission_approve" class="menu_button push-aurora-btn push-aurora-btn-approve"><i class="fa-solid fa-check"></i> Approve</button>
                    <button type="button" id="push_admin_submission_delete" class="menu_button push-aurora-btn push-aurora-btn-ghost"><i class="fa-solid fa-trash"></i> Delete</button>
                `;

    // For admin_note: show the sender's profile avatar.
    // For submissions: show the submitter's character PNG (more useful for content review).
    const submitterHandle = isAdminNote ? null : (item.submitter_handle || null);
    const submitterCharFile = !isAdminNote && (item.bound_characters?.[0] || item.character_files?.[0]) || null;
    const charAvatarHtml = isAdminNote
        // User note → profile avatar for identification
        ? `<img class="push-cp-av-img"
               src="${escapeHtml(senderProfileAvatar)}"
               alt="${escapeHtml(item.from_name || item.from_handle || 'User')}"
               onerror="this.src='/img/default-user.png';" />`
        // Submission → character PNG with profile avatar fallback
        : submitterHandle && submitterCharFile
            ? `<img class="push-cp-av-img"
                   src="/api/worldinfo/admin-char-thumb?handle=${encodeURIComponent(submitterHandle)}&file=${encodeURIComponent(submitterCharFile)}"
                   alt="${escapeHtml(cardName)}"
                   onerror="this.src='${escapeHtml(senderProfileAvatar)}';" />`
            : `<i class="fa-solid ${charIcon}"></i>`;

    // If multiple bound characters, show a mini horizontal scroll strip of thumbnails.
    const allBoundFiles = !isAdminNote ? (item.bound_characters || item.character_files || []) : [];
    const charThumbsHtml = submitterHandle && allBoundFiles.length > 1
        ? `<div class="push-cp-thumbs">
            ${allBoundFiles.map(f => `
                <img class="push-cp-thumb-mini"
                     src="/api/worldinfo/admin-char-thumb?handle=${encodeURIComponent(submitterHandle)}&file=${encodeURIComponent(f)}"
                     alt="${escapeHtml(f.replace('.png', ''))}"
                     title="${escapeHtml(f.replace('.png', ''))}"
                     onerror="this.style.display='none';" />
            `).join('')}
           </div>`
        : '';

    const html = `
        <div id="push_admin_submission_overlay" class="push-inbox-overlay">
            <div class="push-inbox-window" role="dialog" aria-modal="true" aria-label="Submission Detail">
                <div class="push-inbox-window-header">
                    <h3><i class="fa-solid fa-envelope-open-text"></i> From ${escapeHtml(isAdminNote ? (item.from_handle || 'user') : (item.submitter_handle || 'user'))}</h3>
                    <button type="button" id="push_admin_submission_close" class="menu_button push-aurora-btn push-aurora-btn-ghost"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="push-inbox-window-body">
                    <div class="push-cp">
                        <div class="push-cp-av">${charAvatarHtml}</div>
                        <div class="push-cp-info">
                            <div class="push-cp-name">${escapeHtml(cardName)} <span class="push-tag ${tagClass}">${tagText}</span></div>
                            <div class="push-cp-by">${byLine}</div>
                            <div class="push-cp-desc">${escapeHtml(descText)}</div>
                        </div>
                    </div>
                    ${charThumbsHtml}
                    <div class="push-cl-box notes">
                        <div class="push-cl-title"><i class="fa-solid fa-comment-dots"></i> ${notesTitle}</div>
                        <div class="push-cl-body">${escapeHtml(notesBody)}</div>
                        <div class="push-cl-ver">Priority: ${priorityLabel[item.priority] || escapeHtml(item.priority || 'normal')}</div>
                    </div>
                    ${bundleInfoHtml}
                    <div class="push-f" style="margin-top:14px;">
                        <div class="push-fl"><i class="fa-solid fa-reply"></i> Reply</div>
                        <textarea id="admin_submission_reply" class="text_pole" style="width:100%; min-height:90px;" placeholder="${replyPlaceholder}">${escapeHtml(replyValue)}</textarea>
                    </div>
                </div>
                <div class="push-inbox-window-footer">
                    ${footerButtons}
                </div>
            </div>
        </div>
    `;

    $('body').append(html);
    const detailOverlay = document.getElementById('push_admin_submission_overlay');
    const detailWindow = detailOverlay?.querySelector('.push-inbox-window');
    const detailBody = detailOverlay?.querySelector('.push-inbox-window-body');
    if (detailOverlay) detailOverlay.scrollTop = 0;
    if (detailWindow) detailWindow.scrollTop = 0;
    if (detailBody) detailBody.scrollTop = 0;

    const closeOverlay = () => {
        $(document).off('click.admInboxDel');
        $('#push_admin_submission_overlay').remove();
    };

    $('#push_admin_submission_overlay').on('click', function (evt) {
        if (evt.target && evt.target.id === 'push_admin_submission_overlay') {
            closeOverlay();
        }
    });
    $('#push_admin_submission_close').on('click', closeOverlay);

    async function submitAction(action) {
        const replyText = String($('#admin_submission_reply').val() || '');
        if (itemType === 'admin_note' && action === 'reply' && !replyText.trim()) {
            toastr.warning('Enter a reply before sending it.', 'Admin Inbox');
            return;
        }

        const apiAction = itemType === 'admin_note' && action === 'reply' ? 'reviewed' : action;
        const actionRes = await fetch('/api/worldinfo/admin-inbox-action', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(itemType === 'admin_note' ? { note_id: itemId, action: apiAction, reply: replyText } : { submission_id: itemId, action: apiAction, reply: replyText }),
        });

        if (actionRes.ok) {
            if (action === 'approve') {
                toastr.success('Submission Approved', 'Admin Inbox');
                await updateWorldInfoList();
                await getCharacters();
            } else if (itemType === 'admin_note' && action === 'reply') {
                toastr.success('Reply sent to user', 'Admin Inbox');
            } else if (action === 'reject') {
                toastr.info('Submission Rejected', 'Admin Inbox');
            } else if (action === 'reviewed') {
                toastr.info('Submission Marked Reviewed', 'Admin Inbox');
            } else if (action === 'delete') {
                toastr.success('Submission Deleted', 'Admin Inbox');
            } else {
                toastr.success(`Submission ${action}.`, 'Admin Inbox');
            }
            closeOverlay();
            await refreshPushNotificationState();
            return;
        }

        let err = 'Failed to update submission';
        try {
            const errJson = await actionRes.json();
            err = errJson?.error || errJson?.reason || err;
        } catch {
            err = await actionRes.text() || err;
        }
        toastr.error(err, 'Admin Inbox');
    }

    $('#push_admin_submission_reply').on('click', () => { submitAction('reply'); });
    $('#push_admin_submission_approve').on('click', () => { submitAction('approve'); });
    $('#push_admin_submission_reviewed').on('click', () => { submitAction('reviewed'); });
    $('#push_admin_submission_deny').on('click', () => { submitAction('reject'); });
    $('#push_admin_submission_delete').on('click', () => { submitAction('delete'); });

    // Inline confirm helper — renders above push-inbox-overlay (z-index conflict with callPopup)
    function inboxConfirm(message) {
        return new Promise(resolve => {
            $('#adm_inbox_inline_confirm').remove();

            const footer = $('#push_admin_submission_overlay .push-inbox-window-footer');
            const confirmHtml = `
                <div id="adm_inbox_inline_confirm" class="push-cl-box notes" style="margin:0 14px 12px; border-color:rgba(251, 113, 133, 0.28);">
                    <div class="push-cl-title"><i class="fa-solid fa-triangle-exclamation"></i> Confirm Action</div>
                    <div class="push-cl-body">${message}</div>
                    <div style="display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap; margin-top:12px;">
                        <button id="aic_no" class="menu_button push-aurora-btn push-aurora-btn-ghost">Cancel</button>
                        <button id="aic_yes" class="menu_button push-aurora-btn push-aurora-btn-decline">Confirm</button>
                    </div>
                </div>
            `;

            if (footer.length) {
                footer.before(confirmHtml);
            } else {
                $('#push_admin_submission_overlay .push-inbox-window-body').append(confirmHtml);
            }

            const confirmBox = document.getElementById('adm_inbox_inline_confirm');
            confirmBox?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

            function cleanup() {
                $(document).off('.aicDlg');
                $('#adm_inbox_inline_confirm').remove();
            }

            $(document).on('click.aicDlg', '#aic_yes', () => { cleanup(); resolve(true); });
            $(document).on('click.aicDlg', '#aic_no', () => { cleanup(); resolve(false); });
        });
    }

    // Deletion request actions (only rendered for deletion_request items)
    $(document).on('click.admInboxDel', '#push_admin_del_for_user', async () => {
        const confirmed = await inboxConfirm(
            `Delete <strong>${escapeHtml(item.content_name || 'this character')}</strong> from <strong>${escapeHtml(item.submitter_handle || 'this user')}</strong>'s account only?`,
        );
        if (!confirmed) return;
        const res = await fetch('/api/worldinfo/admin-delete-pushed-char', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ submission_id: itemId, scope: 'user' }),
        });
        if (res.ok) {
            const data = await res.json();
            toastr.error(`Deleted "${item.content_name || 'character'}" from ${data.deleted_handles?.[0] || item.submitter_handle}`, 'Character Deleted');
            $(document).off('click.admInboxDel');
            closeOverlay();
            await refreshPushNotificationState();
        } else {
            toastr.error(await res.text() || 'Deletion failed', 'Error');
        }
    });

    $(document).on('click.admInboxDel', '#push_admin_del_for_all', async () => {
        const confirmed = await inboxConfirm(
            `Delete <strong>${escapeHtml(item.content_name || 'this character')}</strong> from <em>all users</em> who received this push? This cannot be undone.`,
        );
        if (!confirmed) return;
        const res = await fetch('/api/worldinfo/admin-delete-pushed-char', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ submission_id: itemId, scope: 'all' }),
        });
        if (res.ok) {
            const data = await res.json();
            toastr.error(`Deleted "${item.content_name || 'character'}" from ${data.deleted_count} user(s)`, 'Character Deleted');
            $(document).off('click.admInboxDel');
            closeOverlay();
            await refreshPushNotificationState();
        } else {
            toastr.error(await res.text() || 'Deletion failed', 'Error');
        }
    });

    $(document).on('click.admInboxDel', '#push_admin_submission_delete', () => {
        $(document).off('click.admInboxDel');
    });
}

async function openAdminPushDeletionModal() {
    const old = document.getElementById('push_admin_del_mgr_overlay');
    if (old) old.remove();

    const loadingHtml = `
        <div id="push_admin_del_mgr_overlay" class="push-inbox-overlay">
            <div class="push-inbox-window" role="dialog" aria-modal="true" aria-label="Character Deletion Manager"
                 style="max-width:min(95vw,1000px); width:min(95vw,1000px);">
                <div class="push-inbox-window-header">
                    <h3 style="font-size:16px;"><i class="fa-solid fa-trash-can" style="color:#fb7185;"></i> Character Deletion Manager</h3>
                    <button type="button" id="push_admin_del_mgr_close" class="menu_button push-aurora-btn push-aurora-btn-ghost"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="push-inbox-window-body" style="display:flex; flex-direction:column; gap:12px; padding:16px; flex:1 1 auto; min-height:0;">
                    <div id="push_admin_del_loading" style="padding:40px; text-align:center; color:#8888aa; font-size:14px;">
                        <i class="fa-solid fa-spinner fa-spin" style="font-size:24px; margin-bottom:12px; display:block; color:#6868aa;"></i>
                        Scanning character files across all users&hellip;
                    </div>
                </div>
            </div>
        </div>
    `;
    $('body').append(loadingHtml);

    const closeOverlay = () => { $('#push_admin_del_mgr_overlay').remove(); };
    $('#push_admin_del_mgr_overlay').on('click', function (evt) {
        if (evt.target && evt.target.id === 'push_admin_del_mgr_overlay') closeOverlay();
    });
    $('#push_admin_del_mgr_close').on('click', closeOverlay);

    let items = [];
    try {
        const res = await fetch('/api/worldinfo/admin-all-accepted-pushes', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!res.ok) {
            let errMsg = `HTTP ${res.status} ${res.statusText}`;
            try {
                const txt = await res.text();
                const body = txt?.trim();
                if (body && !body.startsWith('<')) errMsg = body;
                else if (body) errMsg = `HTTP ${res.status} — ${body.slice(0, 120)}`;
            } catch { /* ignore */ }
            $('#push_admin_del_loading').html(`<i class="fa-solid fa-circle-exclamation" style="color:#fb7185; font-size:20px; margin-bottom:8px; display:block;"></i>${escapeHtml(errMsg)}`);
            return;
        }
        const data = await res.json();
        items = data.items || [];
    } catch (err) {
        $('#push_admin_del_loading').html(`<i class="fa-solid fa-circle-exclamation" style="color:#fb7185; font-size:20px; margin-bottom:8px; display:block;"></i>${escapeHtml(String(err?.message || err))}`);
        return;
    }

    if (!document.getElementById('push_admin_del_mgr_overlay')) return;

    const selectedKeys = new Set();
    const itemKey = it => `${it.file}::${it.recipient_handle}`;

    function updateSelectionUI() {
        const count = selectedKeys.size;
        $('#push_admin_del_sel_count').text(count ? `${count} selected` : '');
        $('#push_admin_del_sel_actions').css('display', count > 0 ? 'flex' : 'none');
        if (count > 0) {
            $('#push_admin_del_sel_btn').html(`<i class="fa-solid fa-trash-can"></i> Delete ${count} Selected`);
        }
        $('.push-del-card').each(function () {
            const key = `${$(this).data('file')}::${$(this).data('recipient')}`;
            const sel = selectedKeys.has(key);
            $(this).toggleClass('push-del-card-selected', sel);
            const ind = $(this).find('.push-del-cb-indicator');
            ind.css({ 'border-color': sel ? '#fb7185' : 'rgba(168,140,250,0.5)', 'background': sel ? '#fb7185' : 'rgba(20,16,34,0.7)' });
            ind.html(sel ? '<i class="fa-solid fa-check" style="color:#fff; font-size:10px;"></i>' : '');
        });
    }

    function buildCards(filter) {
        const q = String(filter || '').toLowerCase().trim();
        const filtered = q
            ? items.filter(it =>
                it.name.toLowerCase().includes(q)
                || it.bound_lorebook.toLowerCase().includes(q)
                || it.recipient_handle.toLowerCase().includes(q)
                || it.creator_handle.toLowerCase().includes(q)
                || (it.secondary_lorebooks || []).some(lb => lb.toLowerCase().includes(q))
            )
            : items;

        if (!filtered.length) {
            return `<div style="padding:20px; text-align:center; color:#8888aa; font-size:14px;">No characters match your search.</div>`;
        }

        const cards = filtered.map(it => {
            const key = itemKey(it);
            const sel = selectedKeys.has(key);
            const thumbUrl = `/api/worldinfo/admin-char-thumb?handle=${encodeURIComponent(it.recipient_handle)}&file=${encodeURIComponent(it.file)}`;
            const pushedBadge = it.is_pushed
                ? `<span class="push-tag push-tag-char" style="font-size:10px; padding:1px 5px; align-self:flex-start; margin-bottom:2px;">Pushed</span>`
                : '';
            const lorebookLine = it.bound_lorebook
                ? `<div><i class="fa-solid fa-book-atlas" style="opacity:.5; margin-right:3px;"></i>${escapeHtml(it.bound_lorebook)}</div>`
                : `<div style="font-style:italic; color:#5a5a7a;">No lorebook</div>`;
            const secondaryLine = (it.secondary_lorebooks || []).length > 0
                ? `<div style="color:#6868aa; margin-top:2px;"><i class="fa-solid fa-layer-group" style="opacity:.45; margin-right:3px;"></i>${escapeHtml(it.secondary_lorebooks.join(', '))}</div>`
                : '';
            return `
                <div class="push-binding-card push-del-card${sel ? ' push-del-card-selected' : ''}"
                     data-file="${escapeHtml(it.file)}"
                     data-recipient="${escapeHtml(it.recipient_handle)}"
                     data-name="${escapeHtml(it.name)}"
                     data-lorebook="${escapeHtml(it.bound_lorebook)}"
                     style="cursor:pointer; position:relative; user-select:none; flex-shrink:0;">
                    <div class="push-del-cb-indicator" style="position:absolute; top:6px; right:6px; z-index:2; width:18px; height:18px; border-radius:4px;
                         border:2px solid ${sel ? '#fb7185' : 'rgba(168,140,250,0.5)'};
                         background:${sel ? '#fb7185' : 'rgba(20,16,34,0.7)'};
                         display:flex; align-items:center; justify-content:center; transition:all .15s; pointer-events:none;">
                        ${sel ? '<i class="fa-solid fa-check" style="color:#fff; font-size:10px;"></i>' : ''}
                    </div>
                    <div class="push-binding-card-header">
                        <div class="push-binding-card-thumb-frame">
                            <img class="push-binding-card-thumb"
                                 src="${thumbUrl}"
                                 alt="${escapeHtml(it.name)}"
                                 onerror="this.classList.add('push-binding-card-thumb-err'); this.nextElementSibling.classList.add('is-visible');" />
                            <div class="push-binding-card-thumb-fallback"><i class="fa-solid fa-user-astronaut"></i></div>
                        </div>
                        <div class="push-binding-card-name">${escapeHtml(it.name)}</div>
                    </div>
                    <div style="font-size:11px; color:#8888aa; display:flex; flex-direction:column; gap:2px;">
                        ${pushedBadge}
                        <div style="color:#b0b0e0;"><i class="fa-solid fa-user" style="opacity:.5; margin-right:3px;"></i>${escapeHtml(it.recipient_handle)}</div>
                        ${lorebookLine}
                        ${secondaryLine}
                    </div>
                </div>`;
        }).join('');

        return `
            <div class="push-binding-rail push-rail-shell" id="push_admin_del_rail">
                <div class="push-rail-fade push-rail-fade-left"></div>
                <div class="push-binding-rail-track push-rail-track" id="push_admin_del_card_track">
                    ${cards}
                </div>
                <div class="push-rail-fade push-rail-fade-right"></div>
            </div>`;
    }

    const emptyHtml = `<div style="padding:24px; text-align:center; color:#8888aa; font-size:14px; line-height:1.7;">No characters found across any user accounts.</div>`;

    $('.push-inbox-window-body').html(`
        <div style="position:relative; flex-shrink:0;">
            <i class="fa-solid fa-magnifying-glass" style="position:absolute; left:13px; top:50%; transform:translateY(-50%); color:#6868aa; font-size:14px; pointer-events:none; z-index:1;"></i>
            <input id="push_admin_del_search" type="text" class="text_pole"
                placeholder="Filter by character, lorebook, or user..."
                style="padding-left:38px !important; padding-top:10px !important; padding-bottom:10px !important; font-size:14px !important; width:100%; box-sizing:border-box; margin:0;" autocomplete="off" />
        </div>
        <div style="display:flex; align-items:center; gap:12px; flex-shrink:0; flex-wrap:wrap;">
            <span id="push_admin_del_total" style="font-size:12px; color:#6060a0;">
                ${items.length} character${items.length !== 1 ? 's' : ''} across all users
            </span>
            <span id="push_admin_del_sel_count" style="font-size:12px; color:#fb7185; font-weight:600;"></span>
            <div id="push_admin_del_sel_actions" style="display:none; gap:8px; margin-left:auto; align-items:center;">
                <button type="button" id="push_admin_del_deselect_btn" class="menu_button push-aurora-btn push-aurora-btn-ghost" style="font-size:12px; padding:5px 10px;">Deselect All</button>
                <button type="button" id="push_admin_del_sel_btn" class="menu_button push-aurora-btn push-aurora-btn-decline" style="font-size:13px; padding:5px 14px;">
                    <i class="fa-solid fa-trash-can"></i> Delete Selected
                </button>
            </div>
        </div>
        <div id="push_admin_del_cards_wrap" style="flex:1 1 auto; min-height:0; overflow:hidden;">
            ${items.length ? buildCards('') : emptyHtml}
        </div>
    `);

    if (items.length) {
        initPushTargetRail(document.getElementById('push_admin_del_mgr_overlay'));
    }

    $('#push_admin_del_search').on('input', function () {
        if (!items.length) return;
        $('#push_admin_del_cards_wrap').html(buildCards($(this).val()));
        initPushTargetRail(document.getElementById('push_admin_del_mgr_overlay'));
    });

    $('#push_admin_del_mgr_overlay').on('click', '.push-del-card', function () {
        const key = `${$(this).data('file')}::${$(this).data('recipient')}`;
        if (selectedKeys.has(key)) selectedKeys.delete(key);
        else selectedKeys.add(key);
        updateSelectionUI();
    });

    $('#push_admin_del_mgr_overlay').on('click', '#push_admin_del_deselect_btn', () => {
        selectedKeys.clear();
        updateSelectionUI();
    });

    $('#push_admin_del_mgr_overlay').on('click', '#push_admin_del_sel_btn', async function () {
        const count = selectedKeys.size;
        if (!count) return;

        const selectedItems = items.filter(it => selectedKeys.has(itemKey(it)));
        const byFile = new Map();
        for (const it of selectedItems) {
            if (!byFile.has(it.file)) byFile.set(it.file, { name: it.name, lorebook: it.bound_lorebook, handles: [] });
            byFile.get(it.file).handles.push(it.recipient_handle);
        }

        const summaryRows = [...byFile.entries()].map(([, info]) => {
            const handleList = info.handles.map(h => `<strong style="color:#e0e0ff;">${escapeHtml(h)}</strong>`).join(', ');
            const lbPart = info.lorebook ? ` <span style="color:#9090b8; font-size:12px;">(+ lorebook <em>${escapeHtml(info.lorebook)}</em>)</span>` : '';
            return `<div style="padding:5px 0; font-size:13px; border-bottom:1px solid rgba(104,104,170,.12);">
                <strong style="color:#fb7185;">${escapeHtml(info.name)}</strong>${lbPart}
                <div style="font-size:12px; color:#8888aa; margin-top:2px;"><i class="fa-solid fa-user" style="opacity:.5; margin-right:3px;"></i>${handleList}</div>
            </div>`;
        }).join('');

        function showInlineDeletionPanel(contentHtml) {
            $('#push_admin_del_inline_panel').remove();
            const panelHtml = `<div id="push_admin_del_inline_panel" class="push-cl-box notes" style="margin:0 0 14px; border-color:rgba(251,113,133,0.28);">${contentHtml}</div>`;
            const searchBlock = $('#push_admin_del_mgr_overlay #push_admin_del_search').closest('div');
            if (searchBlock.length) searchBlock.before(panelHtml);
            else $('#push_admin_del_mgr_overlay .push-inbox-window-body').prepend(panelHtml);
            const bodyEl = document.querySelector('#push_admin_del_mgr_overlay .push-inbox-window-body');
            if (bodyEl) bodyEl.scrollTop = 0;
        }

        function clearInlineDeletionPanel() { $('#push_admin_del_inline_panel').remove(); }

        const confirmed = await new Promise((resolve) => {
            showInlineDeletionPanel(`
                <div class="push-cl-title"><i class="fa-solid fa-triangle-exclamation"></i> Confirm Deletion</div>
                <div class="push-cl-body">
                    <div style="max-height:200px; overflow-y:auto; margin-bottom:12px;">${summaryRows}</div>
                    <div style="font-size:12px; color:#6a6a8a; line-height:1.5; margin-bottom:14px;">
                        <i class="fa-solid fa-shield-halved" style="margin-right:4px; color:#6868aa;"></i>
                        Chats and memory lorebooks will not be affected.
                    </div>
                    <div style="display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap;">
                        <button type="button" id="adm_del_confirm_cancel" class="menu_button push-aurora-btn push-aurora-btn-ghost" style="font-size:13px; padding:8px 18px;">Cancel</button>
                        <button type="button" id="adm_del_confirm_yes" class="menu_button push-aurora-btn push-aurora-btn-decline" style="font-size:13px; padding:8px 18px;">
                            <i class="fa-solid fa-trash-can"></i> Yes, Delete ${count}
                        </button>
                    </div>
                </div>
            `);
            function cleanup() { $(document).off('.admDelConfirm'); clearInlineDeletionPanel(); }
            $(document).on('click.admDelConfirm', '#adm_del_confirm_cancel', () => { cleanup(); resolve(false); });
            $(document).on('click.admDelConfirm', '#adm_del_confirm_yes', () => { cleanup(); resolve(true); });
        });

        if (!confirmed) return;

        const adminHandle = getCurrentUserHandle();
        const exemptHandles = new Set([adminHandle, 'default-user']);
        let totalSuccess = 0;
        let totalFail = 0;

        for (const [file, info] of byFile.entries()) {
            const validHandles = info.handles.filter(h => !exemptHandles.has(h));
            if (!validHandles.length) continue;
            try {
                const delRes = await fetch('/api/worldinfo/admin-delete-chars-bulk', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ file, lorebook: info.lorebook || '', handles: validHandles }),
                });
                if (delRes.ok) {
                    const result = await delRes.json();
                    const succeeded = result.succeeded || [];
                    totalSuccess += succeeded.length;
                    totalFail += (result.failed || []).filter(r => r.error && r.error !== 'Character file not found').length;
                    for (const h of succeeded) {
                        selectedKeys.delete(`${file}::${h}`);
                        items.splice(0, items.length, ...items.filter(it => !(it.file === file && it.recipient_handle === h)));
                    }
                } else {
                    totalFail += validHandles.length;
                }
            } catch {
                totalFail += validHandles.length;
            }
        }

        if (totalSuccess > 0) {
            toastr.error(`Deleted ${totalSuccess} character${totalSuccess !== 1 ? 's' : ''} successfully`, 'Characters Deleted');
        }
        if (totalFail > 0) {
            toastr.warning(`${totalFail} deletion(s) failed`, 'Partial Success');
        }

        const searchVal = $('#push_admin_del_search').val() || '';
        $('#push_admin_del_cards_wrap').html(items.length ? buildCards(searchVal) : emptyHtml);
        if (items.length) initPushTargetRail(document.getElementById('push_admin_del_mgr_overlay'));
        $('#push_admin_del_total').text(`${items.length} character${items.length !== 1 ? 's' : ''} across all users`);
        updateSelectionUI();
    });
}

async function openAdminInboxModal() {
    const res = await fetch('/api/worldinfo/admin-inbox', {
        method: 'POST',
        headers: getRequestHeaders(),
    });

    if (!res.ok) {
        toastr.error(await res.text() || 'Failed to load admin inbox', 'Admin Inbox');
        return;
    }

    const payload = await res.json();
    const priorityDot = { high: '\u{1F534}', low: '\u{1F535}', normal: '\u{1F7E2}' };
    const rows = (payload.items || []).map(item => {
        const isAdminNote = item.inbox_item_type === 'admin_note';
        const isDeletionRequest = item.inbox_item_type === 'deletion_request';
        const isChar = item.content_type === 'character_lorebook_bundle';
        const icon = isAdminNote ? 'fa-note-sticky' : isDeletionRequest ? 'fa-trash-can' : (isChar ? 'fa-user-astronaut' : 'fa-book-atlas');
        const tag = isAdminNote ? 'Note' : isDeletionRequest ? 'Del Request' : (isChar ? 'Char' : 'Lore');
        const tagClass = isAdminNote ? 'push-tag-note' : isDeletionRequest ? 'push-tag-rejected' : (isChar ? 'push-tag-char' : 'push-tag-lore');
        const title = isAdminNote ? `Note from ${item.from_handle || 'user'}` : (item.content_name || 'Submission');
        const desc = isAdminNote ? (item.message || 'No message provided.') : (item.notes || 'No notes provided.');
        const fromHandle = isAdminNote ? (item.from_handle || 'unknown') : (item.submitter_handle || 'unknown');
        const unreadClass = (isAdminNote ? !item.read_at : item.status === 'pending') ? 'unread' : '';
        return `
        <div class="push-ni ${unreadClass}" data-item-id="${escapeHtml(item.item_id || '')}" data-item-type="${escapeHtml(item.inbox_item_type || 'submission')}">
            <div class="push-ni-av"><i class="fa-solid ${icon}"></i></div>
            <div class="push-ni-body">
                <div class="push-ni-title">${escapeHtml(title)} <span class="push-tag ${tagClass}">${tag}</span></div>
                <div class="push-ni-desc">${priorityDot[item.priority] || ''} ${escapeHtml(inboxPreview(desc))}</div>
                <div class="push-ni-desc" style="margin-top:2px"><span style="opacity:.5">From:</span> <strong>${escapeHtml(fromHandle)}</strong></div>
                <div class="push-ni-time">${formatPushTs(item.created_at)}</div>
            </div>
        </div>`;
    }).join('');

    const html = `
        <div class="push-inbox-modal push-popup-layout">
            <h3 style="margin-top:0;"><i class="fa-solid fa-inbox" style="color:#a78bfa; font-size:14px;"></i> User Submissions</h3>
            <div class="push-nl">${rows || '<div class="push-ni-desc" style="padding:12px; text-align:center;">No submissions.</div>'}</div>
        </div>
    `;

    const RESULT_CLEAR_PROCESSED = POPUP_RESULT.CUSTOM1;
    const RESULT_CLEAR_ALL = POPUP_RESULT.CUSTOM2;
    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        rows: 1,
        wider: true,
        customButtons: [
            { text: 'Clear Processed', result: RESULT_CLEAR_PROCESSED },
            { text: 'Clear All', result: RESULT_CLEAR_ALL },
        ],
    });
    decoratePushPopup(popup, 'inbox');
    const resultPromise = popup.show();

    $(popup.dlg).on('click', '.push-ni[data-item-id]', function (evt) {
        evt.preventDefault();
        evt.stopPropagation();
        const itemId = $(this).data('item-id');
        const itemType = $(this).data('item-type') || 'submission';
        if (!itemId) return;
        popup.complete(POPUP_RESULT.AFFIRMATIVE);
        setTimeout(() => {
            openAdminInboxDetailModal(itemId, itemType);
        }, 220);
    });

    const result = await resultPromise;
    if (result === RESULT_CLEAR_PROCESSED || result === RESULT_CLEAR_ALL) {
        const clearRes = await fetch('/api/worldinfo/admin-inbox-clear', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ action: result === RESULT_CLEAR_ALL ? 'clear_all' : 'clear_processed' }),
        });
        if (!clearRes.ok) {
            toastr.error(await clearRes.text() || 'Failed to clear admin inbox', 'Admin Inbox');
        }
    }

    await refreshPushNotificationState();
}

async function openTopbarPushModal() {
    if (!isAdmin()) {
        toastr.warning('Only admins can queue pushes.', 'Push');
        return;
    }

    let users = [];
    try {
        const allUsers = await fetchPushBotUsers();
        users = allUsers.filter(u => u.handle !== getCurrentUserHandle())
            .sort((a, b) => (a.handle || '').localeCompare(b.handle || ''));
    } catch {
        // no-op
    }

    // Build character options — show all characters, sorted alphabetically
    const charList = (characters || []).map(c => ({
        name: c.name || c.avatar?.replace('.png', '') || 'Unknown',
        world: c?.data?.extensions?.world || '',
        avatar: c.avatar || '',
    }));
    charList.sort((a, b) => a.name.localeCompare(b.name));

    const charOptions = charList.map(c =>
        `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`,
    ).join('');

    const userRail = renderPushTargetRail(users);

    // Build lorebook options from world_names
    const lorebookOptions = (world_names || []).map(name =>
        `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`,
    ).join('');

    const html = `
        <div class="push-popup-layout">
            <div class="push-f">
                <div class="push-fl"><i class="fa-solid fa-user-astronaut"></i> Character Card <span style="opacity:0.5; font-size:0.85em;">(select up to 10)</span></div>
                <select id="topbar_push_book" class="text_pole" style="width:100%;" multiple="multiple">
                    ${charOptions}
                </select>
                <div id="topbar_push_lb" class="push-binding-list" style="display:none;"></div>
                <div style="margin-top:4px;">
                    <span id="topbar_push_count" style="font-size:0.85em; opacity:0.6;">0 / 10 selected</span>
                </div>
            </div>
            <div class="push-f">
                <div class="push-fl">Push To</div>
                ${userRail}
            </div>
            <div class="push-f">
                <div class="push-fl">Update Notes</div>
                <textarea id="topbar_push_notes" class="text_pole" style="width:100%; min-height:90px;" placeholder="What changed..."></textarea>
            </div>
            <div class="push-f">
                <div class="push-fl">Version</div>
                <input id="topbar_push_version" class="text_pole" style="width:100%;" placeholder="e.g. v2.1" />
            </div>
        </div>
    `;

    const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Push Now',
        cancelButton: 'Cancel',
        wider: true,
        allowVerticalScrolling: true,
    });
    decoratePushPopup(popup, 'queue');
    const dlg = popup.dlg;
    const resultPromise = popup.show();

    // Initialize Select2 searchable multi-select for character selection.
    // dropdownParent must point to the open popup dialog so the dropdown
    // renders INSIDE the popup instead of behind it (z-index issue).
    const $charSelect = $(dlg).find('#topbar_push_book');
    $charSelect.select2({
        width: '100%',
        placeholder: '\u2014 Search and select characters \u2014',
        searchInputPlaceholder: 'Type to filter...',
        allowClear: true,
        closeOnSelect: false,
        maximumSelectionLength: 10,
        dropdownParent: $(dlg),
    });

    initPushTargetRail(dlg);

    const primaryLorebookDrafts = new Map();
    const secondaryLorebookDrafts = new Map();

    // Lorebook binding indicator — updates as selections change
    function refreshPushBindings() {
        const lbDiv = $(dlg).find('#topbar_push_lb');
        const selected = $charSelect.val() || [];
        const count = selected.length;
        $(dlg).find('#topbar_push_count').text(`${count} / 10 selected`);

        if (count === 0) {
            lbDiv.hide().empty();
            return;
        }

        const boundEntries = selected.map((name, index) => {
            const char = charList.find(c => c.name === name);
            if (!char) return null;
            const primaryLorebook = primaryLorebookDrafts.get(name) || char.world || '';
            const secondaryLorebook = secondaryLorebookDrafts.get(name) || '';

            // Create lorebook selector HTML for this character
            const primarySelectHtml = `
                <div class="push-lorebook-selector" style="margin-top:8px;">
                    <label style="font-size:0.9em; opacity:0.8; display:block; margin-bottom:4px;">
                        <i class="fa-solid fa-book"></i> Primary Lorebook (required)
                    </label>
                    <select id="topbar_push_primary_lb_${index}" class="text_pole topbar-push-primary-lb" style="width:100%;" data-char-name="${escapeHtml(name)}">
                        <option value="">— Select primary lorebook —</option>
                        ${lorebookOptions}
                    </select>
                </div>
            `;

            const secondarySelectHtml = `
                <div class="push-lorebook-selector" style="margin-top:6px;">
                    <label style="font-size:0.9em; opacity:0.7; display:block; margin-bottom:4px;">
                        <i class="fa-solid fa-book-open"></i> Secondary Lorebook (optional)
                    </label>
                    <select id="topbar_push_secondary_lb_${index}" class="text_pole topbar-push-secondary-lb" style="width:100%;" data-char-name="${escapeHtml(name)}">
                        <option value="">— Select secondary lorebook (optional) —</option>
                        ${lorebookOptions}
                    </select>
                </div>
            `;

            const cardHtml = renderPushBindingCard({
                characterName: char.name,
                boundLorebook: primaryLorebook,
                avatarFile: char.avatar || '',
                showRenameInput: false,
            });
            return `<div class="push-binding-group">${cardHtml}${primarySelectHtml}${secondarySelectHtml}</div>`;
        }).filter(Boolean);

        if (boundEntries.length === 1) {
            lbDiv.show().html(boundEntries[0]);
        } else {
            lbDiv.show().html(`
                <div class="push-binding-rail push-rail-shell">
                    <div class="push-rail-fade push-rail-fade-left"></div>
                    <div class="push-binding-rail-track push-rail-track">
                        ${boundEntries.join('')}
                    </div>
                    <div class="push-rail-fade push-rail-fade-right"></div>
                </div>
            `);
            initPushTargetRail(lbDiv[0]);
        }

        // Initialize Select2 on newly created lorebook selectors
        $(dlg).find('.topbar-push-primary-lb').each(function () {
            if (!$(this).data('select2')) {
                const charName = $(this).data('char-name');
                $(this).val(primaryLorebookDrafts.get(charName) || '').select2({
                    width: '100%',
                    placeholder: '— Select primary lorebook —',
                    searchInputPlaceholder: 'Type to filter...',
                    allowClear: true,
                    closeOnSelect: true,
                    dropdownParent: $(dlg),
                });
            }
        });

        $(dlg).find('.topbar-push-secondary-lb').each(function () {
            if (!$(this).data('select2')) {
                const charName = $(this).data('char-name');
                $(this).val(secondaryLorebookDrafts.get(charName) || '').select2({
                    width: '100%',
                    placeholder: '— Select secondary lorebook (optional) —',
                    searchInputPlaceholder: 'Type to filter...',
                    allowClear: true,
                    closeOnSelect: true,
                    dropdownParent: $(dlg),
                });
            }
        });
    }

    $charSelect.on('change', refreshPushBindings);

    // Track primary lorebook selection
    $(dlg).on('change', '.topbar-push-primary-lb', function () {
        const charName = $(this).data('char-name');
        const value = String($(this).val() || '').trim();
        if (value) {
            primaryLorebookDrafts.set(charName, value);
        } else {
            primaryLorebookDrafts.delete(charName);
        }
    });

    // Track secondary lorebook selection
    $(dlg).on('change', '.topbar-push-secondary-lb', function () {
        const charName = $(this).data('char-name');
        const value = String($(this).val() || '').trim();
        if (value) {
            secondaryLorebookDrafts.set(charName, value);
        } else {
            secondaryLorebookDrafts.delete(charName);
        }
    });

    $(popup.dlg).on('click', '.push-rail-card-all', function () {
        $(popup.dlg).find('.push-rail-card').removeClass('on');
        $(this).addClass('on');
    });
    $(popup.dlg).on('click', '.push-rail-card[data-handle]', function () {
        $(popup.dlg).find('.push-rail-card-all').removeClass('on');
        $(this).toggleClass('on');
        const selectedCount = $(popup.dlg).find('.push-rail-card[data-handle].on').length;
        if (selectedCount === 0) {
            $(popup.dlg).find('.push-rail-card-all').addClass('on');
        }
    });

    const result = await resultPromise;

    // Clean up Select2 before popup removal
    if ($charSelect.data('select2')) {
        try { $charSelect.select2('destroy'); } catch { /* no-op */ }
    }

    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    const targets = $(dlg).find('.push-rail-card-all').hasClass('on')
        ? users.map(u => u.handle)
        : $(dlg).find('.push-rail-card[data-handle].on').map(function () {
            return $(this).data('handle');
        }).get();

    const selectedNames = $charSelect.val() || [];
    if (selectedNames.length === 0 || targets.length === 0) {
        toastr.warning('Choose at least one character and one target user.', 'Push');
        return;
    }

    // Validate that all characters have at least a primary lorebook selected
    let missingLorebooks = [];
    for (const charName of selectedNames) {
        if (!primaryLorebookDrafts.get(charName)) {
            missingLorebooks.push(charName);
        }
    }
    if (missingLorebooks.length > 0) {
        toastr.warning(`Please select a primary lorebook for: ${missingLorebooks.join(', ')}`, 'Push');
        return;
    }

    // Build one bundle per selected character.
    const lorebookEntries = selectedNames.reduce((acc, name) => {
        const c = charList.find(x => x.name === name);
        const primaryLorebook = primaryLorebookDrafts.get(name) || '';
        const secondaryLorebook = secondaryLorebookDrafts.get(name) || '';
        if (!primaryLorebook) return acc;

        acc.push({
            primary_lorebook: primaryLorebook,
            secondary_lorebook: secondaryLorebook || undefined,
            character_name: name,
            avatarFile: c?.avatar || '',
        });
        return acc;
    }, []);

    if (lorebookEntries.length === 0) {
        toastr.warning('Selected characters have no lorebook selections.', 'Push');
        return;
    }

    const notes = String($(dlg).find('#topbar_push_notes').val() || '').trim();
    const version = String($(dlg).find('#topbar_push_version').val() || '').trim();

    // Use bulk-push endpoint for multi-character support
    toastr.info(`Pushing ${lorebookEntries.length} character bundle(s) to ${targets.length} user(s)\u2026`, 'Push');
    try {
        const pushRes = await fetch('/api/worldinfo/bulk-push', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ lorebooks: lorebookEntries, targets, notes, version }),
        });
        if (pushRes.ok) {
            const { results: bulkResults } = await pushRes.json();
            const msgs = [];
            for (const r of bulkResults) {
                const parts = [];
                if (r.queued?.length) {
                    const queuedHandles = r.queued
                        .map(item => String(item?.handle || '').trim())
                        .filter(Boolean);
                    const queuedLabel = queuedHandles.length
                        ? `to ${queuedHandles.map(handle => escapeHtml(handle)).join(', ')}`
                        : `${r.queued.length} queued`;
                    parts.push(`queued ${queuedLabel}`);
                }
                if (r.failed?.length) parts.push(`${r.failed.length} failed`);
                const label = r.character_name || r.primary_lorebook || r.lorebook || 'Bundle';
                msgs.push(`<b>${escapeHtml(label)}</b>: ${parts.join(', ') || 'done'}`);
            }
            const detailedFailures = formatDetailedPushFailures(bulkResults);
            if (msgs.length > 0) {
                toastr.success(msgs.join('<br>'), 'Push Complete', { timeOut: 8000, escapeHtml: false });
            }
            if (detailedFailures.length > 0) {
                toastr.error(detailedFailures.join('<br>'), 'Push Failed', { timeOut: 12000, escapeHtml: false, closeButton: true });
            }
        } else {
            toastr.error(await pushRes.text() || 'Push failed', 'Push Failed', { timeOut: 12000, closeButton: true });
        }
    } catch (err) {
        toastr.error(String(err), 'Push Error', { timeOut: 12000, closeButton: true });
    }
}


async function collectPushWorkflowDiagnostics() {
    const perfStart = performance.now();
    let payload = { checks: [], run: {} };
    const admin = isAdmin();

    if (admin) {
        const response = await fetch('/api/worldinfo/admin-push-diagnostics', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ initiated_at: Date.now() }),
        });

        if (!response.ok) {
            throw new Error(await response.text() || `Diagnostics request failed with status ${response.status}`);
        }

        payload = await response.json();
    } else {
        const endpointChecks = [];
        const endpointProbes = [
            { name: 'Push Notifications API', url: '/api/worldinfo/push-notifications', detail: 'Loads the shared notification state used by regular users' },
            { name: 'User Inbox API', url: '/api/worldinfo/user-inbox', detail: 'Loads the regular-user inbox list' },
            { name: 'Accepted Pushes API', url: '/api/worldinfo/accepted-pushes', detail: 'Loads accepted push records used by deletion requests' },
            { name: 'Admin Handles API', url: '/api/worldinfo/admin-handles', detail: 'Loads admin recipients for user-to-admin notes' },
        ];

        for (const probe of endpointProbes) {
            try {
                const response = await fetch(probe.url, {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ include_avatars: false }),
                });
                endpointChecks.push({
                    name: probe.name,
                    ok: response.ok,
                    detail: response.ok
                        ? probe.detail
                        : `${probe.detail} (failed with ${response.status} ${response.statusText})`,
                });
            } catch (err) {
                endpointChecks.push({
                    name: probe.name,
                    ok: false,
                    detail: `${probe.detail} (${String(err?.message || err)})`,
                });
            }
        }

        payload = {
            run: {
                started_at: Date.now(),
                finished_at: Date.now(),
                duration_ms: 0,
                mode: 'user',
            },
            checks: endpointChecks,
        };
    }

    const frontendChecks = admin
        ? [
            { name: 'Topbar Push Button', ok: $('#option_push_queue').length === 1, detail: 'Admin push control is mounted in the DOM' },
            { name: 'Topbar Inbox Button', ok: $('#option_push_inbox').length === 1, detail: 'Admin inbox control is mounted in the DOM' },
            { name: 'Topbar Admin Note Button', ok: $('#option_admin_note').length === 1, detail: 'Admin note control is mounted in the DOM' },
            { name: 'Topbar Notifications Button', ok: $('#option_push_notifs').length === 1, detail: 'Notifications control is mounted in the DOM' },
            { name: 'Topbar Diagnostics Button', ok: $('#option_push_diag').length === 1, detail: 'Diagnostics control is mounted in the DOM' },
        ]
        : [
            { name: 'Topbar Submit Button', ok: $('#option_submit_to_admin').length === 1, detail: 'Regular-user submit control is mounted in the DOM' },
            { name: 'Topbar User Note Button', ok: $('#option_user_admin_note').length === 1, detail: 'Regular-user note-to-admin control is mounted in the DOM' },
            { name: 'Topbar Deletion Request Button', ok: $('#option_del_request').length === 1, detail: 'Regular-user deletion request control is mounted in the DOM' },
            { name: 'Topbar Notifications Button', ok: $('#option_push_notifs').length === 1, detail: 'Notifications control is mounted in the DOM' },
            { name: 'Topbar Diagnostics Button', ok: $('#option_push_diag').length === 1, detail: 'Diagnostics control is mounted in the DOM' },
        ];

    const checks = [...(Array.isArray(payload.checks) ? payload.checks : []), ...frontendChecks];
    const passed = checks.filter(check => check.ok).length;
    const failed = checks.length - passed;

    return {
        run: {
            ...(payload.run && typeof payload.run === 'object' ? payload.run : {}),
            frontend_duration_ms: Math.max(0, Math.round(performance.now() - perfStart)),
        },
        summary: {
            total: checks.length,
            passed,
            failed,
        },
        checks,
    };
}

async function runPushWorkflowDiagnostics() {
    const admin = isAdmin();

    const html = `
        <div class="push-popup-layout">
            <h3 style="margin-top:0;">Push Workflow Diagnostics</h3>
            <div id="push_diag_status" class="push-flow-meta" style="margin-bottom:12px;">
                Press <b>Run Diagnostics</b> to probe the push workflow and inspect the results.
            </div>
            <div class="btn-row" style="justify-content:flex-start; margin-bottom:12px;">
                <button id="push_diag_run" type="button" class="menu_button push-aurora-btn push-aurora-btn-primary">Run Diagnostics</button>
            </div>
            <div id="push_diag_results" class="push-flow-list">
                <div class="push-flow-row" style="cursor:default;">
                    <div>No diagnostics have been run yet.</div>
                    <div class="push-flow-meta">Click the button above to start.</div>
                </div>
            </div>
        </div>
    `;

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { okButton: 'Close', rows: 1, wider: true });
    decoratePushPopup(popup, 'diagnostics');
    const resultPromise = popup.show();
    const dlg = popup.dlg;

    let isRunning = false;
    $(dlg).on('click', '#push_diag_run', async function () {
        if (isRunning) return;
        isRunning = true;

        const runButton = $(this);
        const statusEl = $(dlg).find('#push_diag_status');
        const resultsEl = $(dlg).find('#push_diag_results');

        runButton.prop('disabled', true).text('Running...');
        statusEl.text('Running push diagnostics...');
        resultsEl.html(`
            <div class="push-flow-row" style="cursor:default;">
                <div>Diagnostics in progress...</div>
                <div class="push-flow-meta">Checking APIs, access control, and ${admin ? 'admin' : 'regular-user'} push controls.</div>
            </div>
        `);

        try {
            const diagnostics = await collectPushWorkflowDiagnostics();
            const checks = Array.isArray(diagnostics.checks) ? diagnostics.checks : [];
            const passCount = diagnostics.summary?.passed ?? checks.filter(x => x.ok).length;
            const failCount = diagnostics.summary?.failed ?? (checks.length - passCount);
            const startedAt = diagnostics.run?.started_at ? new Date(diagnostics.run.started_at) : null;
            const finishedAt = diagnostics.run?.finished_at ? new Date(diagnostics.run.finished_at) : null;
            const durationMs = Number(diagnostics.run?.duration_ms || 0);
            const frontendDurationMs = Number(diagnostics.run?.frontend_duration_ms || 0);

            const rows = checks.map(c => `
                <div class="push-flow-row" style="cursor:default;">
                    <div><b>${c.ok ? 'PASS' : 'FAIL'}</b> - ${c.name}</div>
                    <div class="push-flow-meta">${c.detail}</div>
                </div>
            `).join('');

            statusEl.html(`
                Ran live diagnostics at <b>${startedAt ? escapeHtml(startedAt.toLocaleString()) : 'just now'}</b>
                ${finishedAt ? `| Finished <b>${escapeHtml(finishedAt.toLocaleTimeString())}</b>` : ''}
                | Server <b>${escapeHtml(String(durationMs))} ms</b>
                | UI <b>${escapeHtml(String(frontendDurationMs))} ms</b>
                | Passed: <b>${passCount}</b>
                | Failed: <b>${failCount}</b>
            `);
            resultsEl.html(rows || `
                <div class="push-flow-row" style="cursor:default;">
                    <div>No diagnostics returned.</div>
                    <div class="push-flow-meta">No checks were recorded.</div>
                </div>
            `);
        } catch (err) {
            statusEl.text('Diagnostics failed to complete.');
            resultsEl.html(`
                <div class="push-flow-row" style="cursor:default;">
                    <div><b>FAIL</b> - Diagnostics Runner</div>
                    <div class="push-flow-meta">${escapeHtml(String(err?.message || err))}</div>
                </div>
            `);
        } finally {
            isRunning = false;
            runButton.prop('disabled', false).text('Run Diagnostics');
        }
    });

    await resultPromise;
    $(dlg).off('click', '#push_diag_run');
}
async function setupPushWorkflowControls() {
    const admin = isAdmin();
    // Push workflow now lives exclusively in the Options menu.

    const drawerActions = [
        ['#option_push_queue', admin, async () => {
            await openTopbarPushModal();
        }],
        ['#option_push_inbox', admin, async () => {
            await openAdminInboxModal();
        }],
        ['#option_admin_del_mgr', admin, async () => {
            await openAdminPushDeletionModal();
        }],
        ['#option_admin_note', admin, async () => {
            await openAdminNoteModal();
        }],
        ['#option_submit_to_admin', !admin, async () => {
            await openSubmitToAdminModal();
        }],
        ['#option_user_inbox', !admin, async () => {
            await openUserInboxModal();
        }],
        ['#option_user_admin_note', !admin, async () => {
            await openUserSendAdminNoteModal();
        }],
        ['#option_del_request', !admin, async () => {
            await openDeletionRequestModal();
        }],
        ['#option_coauthor', true, async () => {
            const dest = admin ? '/coauthor-admin.html' : '/coauthor.html';
            window.open(dest, '_blank', 'noopener,noreferrer');
        }],
        ['#option_push_notifs', true, async () => {
            await openPushNotificationsModal();
        }],
        ['#option_push_diag', true, async () => {
            await runPushWorkflowDiagnostics();
        }],
    ];

    for (const [selector, showState, handler] of drawerActions) {
        bindPushControlAction(selector, showState, async () => {
            try {
                closeOptionsDrawer();
                await handler();
            } catch (err) {
                console.error(`[PushDrawer] Failed action for ${selector}:`, err);
                toastr.error(String(err?.message || err), 'Push Workflow');
            }
        });
    }

    $('#option_push_separator, #option_push_heading')
        .show()
        .removeClass('displayNone');

    const state = await getPushNotificationState();
    updatePushNotificationBadge(state);

    if (pushNotificationPollTimer) {
        clearInterval(pushNotificationPollTimer);
    }
    pushNotificationPollTimer = setInterval(async () => {
        await refreshPushNotificationState();
    }, 30000);
}

// ============================================================================
// LORE TREASURY — Bulk WI Entry Mover
// ============================================================================
// Modal UI to copy, transfer, or delete multiple WI entries between lorebooks.
// ============================================================================
function initLoreTreasuryInline() {
    if (document.getElementById('lt_overlay')) {
        return;
    }

    let allowedLorebookNames = null;
    let hiddenLorebookNames = new Set();
    let staleLorebookNames = new Set();

    function isPrefixedHiddenLorebook(name) {
        return String(name || '').trim().startsWith('9z');
    }

    function isCurrentUserOwnerOfScopedLorebook(name) {
        const worldName = String(name || '').trim().toLowerCase();
        const currentHandle = normalizeHandleForPushLock(getCurrentUserHandle());
        if (!currentHandle) {
            return false;
        }

        return worldName.startsWith(`bb-${currentHandle}-`) || worldName.startsWith(`dd-${currentHandle}-`);
    }

    function isOwnerScopedLorebookName(name) {
        const worldName = String(name || '').trim().toLowerCase();
        return worldName.startsWith('bb-') || worldName.startsWith('dd-');
    }

    function canAccessLorebook(name) {
        const worldName = String(name || '').trim();
        if (!worldName) {
            return false;
        }

        if (isPrefixedHiddenLorebook(worldName) || staleLorebookNames.has(worldName)) {
            return false;
        }

        if (allowedLorebookNames) {
            return allowedLorebookNames.has(worldName);
        }

        if (isOwnerScopedLorebookName(worldName)) {
            return !isAdmin() && isCurrentUserOwnerOfScopedLorebook(worldName);
        }

        if (isAdmin()) {
            return true;
        }

        return !hiddenLorebookNames.has(worldName) && !isHiddenPushedLorebookForDropdown(worldName);
    }

    function visibleLorebooks() {
        return (world_names || []).filter(canAccessLorebook);
    }

    async function refreshLoreTreasuryAccessMap() {
        const response = await fetch('/api/plugins/lore-treasury/access', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error(`Lore Treasury access scan failed: ${response.status}`);
        }

        const data = await response.json();
        allowedLorebookNames = new Set(
            Array.isArray(data?.allowed_world_names)
                ? data.allowed_world_names.map(name => String(name || '').trim()).filter(Boolean)
                : [],
        );
        hiddenLorebookNames = new Set(
            Array.isArray(data?.hidden_world_names)
                ? data.hidden_world_names.map(name => String(name || '').trim()).filter(Boolean)
                : [],
        );
        staleLorebookNames = new Set(
            Array.isArray(data?.stale_world_names)
                ? data.stale_world_names.map(name => String(name || '').trim()).filter(Boolean)
                : [],
        );

        const leakedNames = (world_names || []).filter(name => !canAccessLorebook(name));
        if (leakedNames.length) {
            console.info('[Lore Treasury] Filtered hidden/stale lorebooks from selector:', leakedNames);
        }
    }

    if (!document.getElementById('lore_treasury_button')) {
        const button = document.createElement('div');
        button.id = 'lore_treasury_button';
        button.className = 'menu_button';
        button.title = 'Lore Treasury - Bulk copy, transfer, or delete WI entries between lorebooks';
        button.dataset.i18n = '[title]Lore Treasury';
        button.innerHTML = `
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/>
                <circle cx="17" cy="6" r="1.5" stroke="none" fill="currentColor"/>
                <circle cx="20" cy="10" r="1" stroke="none" fill="currentColor"/>
                <polyline points="14,17 17,20 14,23"/>
                <line x1="10" y1="20" x2="17" y2="20"/>
            </svg>
        `;

        const anchor = document.getElementById('world_bulk_push')
            || document.getElementById('world_popup_delete')
            || document.getElementById('world_duplicate');

        if (anchor?.parentElement) {
            anchor.insertAdjacentElement('afterend', button);
        }
    }

    // ── Inject scrollbar polish ───────────────────────────────────────────────
    const ltStyle = document.createElement('style');
    ltStyle.textContent = `
        #lt_overlay[open] {
            position: fixed;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            overflow: auto;
            padding: 20px 16px;
            box-sizing: border-box;
            margin: 0;
            inset: 0;
        }
        #lt_overlay::backdrop {
            background: rgba(0,0,0,0.62);
            -webkit-backdrop-filter: blur(8px);
            backdrop-filter: blur(8px);
        }
        #lt_entries::-webkit-scrollbar,
        .lt-combo-list::-webkit-scrollbar { width: 5px; }
        #lt_entries::-webkit-scrollbar-track,
        .lt-combo-list::-webkit-scrollbar-track { background: transparent; }
        #lt_entries::-webkit-scrollbar-thumb,
        .lt-combo-list::-webkit-scrollbar-thumb { background: #3a3a5c; border-radius: 3px; }
        #lt_entries::-webkit-scrollbar-thumb:hover,
        .lt-combo-list::-webkit-scrollbar-thumb:hover { background: #5a5a8c; }
        #lore_treasury_button:hover svg { stroke: var(--SmartThemeBodyColor, #c8d0f0); }
        @media (max-width: 700px) {
            #lt_overlay[open] {
                align-items: center !important;
                justify-content: center !important;
                overflow-y: auto !important;
                overscroll-behavior: contain;
                -webkit-overflow-scrolling: touch;
                padding: 12px !important;
            }
            #lt_panel {
                width: calc(100vw - 24px) !important;
                max-width: calc(100vw - 24px) !important;
                max-height: calc(100dvh - 24px) !important;
                margin: 0 auto !important;
                overflow-y: auto !important;
                overscroll-behavior: contain;
                -webkit-overflow-scrolling: touch;
            }
            #lt_pickers_row {
                grid-template-columns: 1fr !important;
            }
            #lt_step2 {
                display: flex !important;
                flex-direction: column !important;
                flex: 1 1 auto !important;
                min-height: 0 !important;
                overflow-y: auto !important;
            }
            #lt_entries {
                flex: 1 1 auto !important;
                min-height: 160px !important;
                max-height: none !important;
                overflow-y: auto !important;
                -webkit-overflow-scrolling: touch;
            }
            #lt_actions {
                display: flex !important;
                flex-direction: column !important;
                flex-shrink: 0 !important;
            }
        }
    `;
    document.head.appendChild(ltStyle);

    // ── Shared style fragments ────────────────────────────────────────────────
    const S_INPUT = 'width:100%;background:#0a0a1a;border:1px solid #3a3a5c;border-radius:6px;color:#c8d0f0;padding:10px 13px;font-size:17px;outline:none;box-sizing:border-box;font-family:inherit;';
    const S_LIST  = 'display:none;position:absolute;left:0;right:0;top:100%;margin-top:3px;z-index:200;background:#111122;border:1px solid #4a4a7c;border-radius:6px;max-height:220px;overflow-y:auto;box-shadow:0 8px 28px rgba(0,0,0,0.65);';
    const S_LABEL = 'font-size:13px;color:#666688;display:block;margin-bottom:7px;text-transform:uppercase;letter-spacing:0.07em;';
    const S_BTN   = 'background:none;border:1px solid #3a3a5c;border-radius:6px;color:#c0c8e8;cursor:pointer;padding:11px 16px;font-size:16px;display:flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;transition:background 0.15s,border-color 0.15s;';

    // ── Inject modal HTML ─────────────────────────────────────────────────────
    $('body').append(`
<dialog id="lt_overlay" style="padding:0;border:none;background:transparent;max-width:none;max-height:none;width:100vw;height:100dvh;overflow:visible;">

  <!-- Main panel -->
  <div id="lt_panel" style="background:#13132a;border:1px solid #3a3a5c;border-radius:12px;width:min(600px,93vw);max-height:calc(100vh - 40px);display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.75);margin:auto;flex-shrink:0;">

    <!-- Header -->
    <div id="lt_header_bar" style="padding:15px 20px 14px;border-bottom:1px solid #252542;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:12px;">
      <div id="lt_header_hit" style="display:flex;align-items:center;gap:10px;min-width:0;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8aabee" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" fill="rgba(122,154,238,0.08)"/>
          <circle cx="17" cy="6" r="1.5" fill="rgba(122,154,238,0.5)" stroke="none"/>
          <circle cx="20" cy="10" r="1" fill="rgba(122,154,238,0.35)" stroke="none"/>
          <polyline points="14,17 17,20 14,23"/>
          <line x1="10" y1="20" x2="17" y2="20"/>
        </svg>
        <span style="font-size:22px;font-weight:600;color:#c8d0f0;letter-spacing:0.01em;min-width:0;">Lore Treasury</span>
      </div>
      <button id="lt_close" style="background:none;border:none;color:#444466;cursor:pointer;font-size:20px;line-height:1;padding:4px 8px;border-radius:4px;" title="Close">✕</button>
    </div>

    <!-- ── Step 1: Source / Destination / Load ── -->
    <div id="lt_step1" style="padding:20px;display:flex;flex-direction:column;gap:18px;flex-shrink:0;">
      <div id="lt_pickers_row" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">

        <div>
          <label style="${S_LABEL}">Source Lorebook</label>
          <div class="lt-combo" id="lt_src_combo" data-value="" style="position:relative;">
            <input class="lt-combo-input" id="lt_src_input" type="text" placeholder="Type to search…" autocomplete="off" spellcheck="false" style="${S_INPUT}">
            <div class="lt-combo-list" id="lt_src_list" style="${S_LIST}"></div>
          </div>
        </div>

        <div>
          <label style="${S_LABEL}">Destination Lorebook</label>
          <div class="lt-combo" id="lt_dst_combo" data-value="" style="position:relative;">
            <input class="lt-combo-input" id="lt_dst_input" type="text" placeholder="Type to search…" autocomplete="off" spellcheck="false" style="${S_INPUT}">
            <div class="lt-combo-list" id="lt_dst_list" style="${S_LIST}"></div>
          </div>
        </div>

      </div>

      <div style="display:flex;align-items:center;gap:12px;">
        <button id="lt_load_btn" style="${S_BTN}flex:1;border-color:#4a6aaa;color:#9ab2e8;font-weight:500;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          Load Entries
        </button>
        <span id="lt_load_status" style="font-size:13px;color:#555577;"></span>
      </div>

      <p style="font-size:15px;color:#a0a0c0;margin:0;text-align:center;">
        Select a source (required) and destination (for Copy / Transfer), then load.
      </p>
    </div>

    <!-- ── Step 2: Entry list ── (hidden until load) -->
    <div id="lt_step2" style="display:none;flex-direction:column;flex:1;min-height:0;">

      <!-- Breadcrumb -->
      <div id="lt_breadcrumb" style="padding:8px 20px;border-bottom:1px solid #252542;font-size:15px;color:#8888aa;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#0e0e20;"></div>

      <!-- Select-all bar -->
      <div style="padding:8px 20px;border-bottom:1px solid #252542;display:flex;align-items:center;gap:10px;flex-shrink:0;background:#0e0e20;">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;margin:0;">
          <input type="checkbox" id="lt_select_all" style="width:15px;height:15px;accent-color:#7a9aee;cursor:pointer;flex-shrink:0;">
          <span id="lt_select_label" style="font-size:16px;color:#9ba0c0;user-select:none;">Select All</span>
        </label>
        <span id="lt_entry_count" style="font-size:15px;color:#555577;flex-shrink:0;"></span>
      </div>

      <!-- Entry rows (scrollable) -->
      <div id="lt_entries" style="overflow-y:auto;flex:1;"></div>

      <!-- Action buttons -->
      <div id="lt_actions" style="padding:11px 16px;border-top:1px solid #252542;display:flex;gap:8px;flex-shrink:0;background:#0e0e20;">
        <button id="lt_copy_btn" style="${S_BTN}flex:1;" title="Copy selected entries into destination lorebook (source untouched)">
          📋 Copy
        </button>
        <button id="lt_transfer_btn" style="${S_BTN}flex:1;" title="Move selected entries to destination and remove them from source">
          🔀 Transfer
        </button>
        <button id="lt_delete_btn" style="${S_BTN}flex:1;border-color:#6a2a2a;color:#e87a7a;" title="Permanently delete selected entries from source lorebook">
          🗑 Delete
        </button>
      </div>
    </div>

  </div><!-- /#lt_panel -->

  <!-- ── Delete confirmation overlay (full-screen, above panel) ── -->
  <div id="lt_delete_confirm" style="display:none;position:fixed;inset:0;z-index:10001;background:rgba(6,3,12,0.95);flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:32px;text-align:center;">
    <div style="font-size:44px;line-height:1;">⚠️</div>
    <div style="max-width:420px;">
      <div style="font-size:21px;font-weight:600;color:#ff7070;margin-bottom:10px;">Confirm Deletion</div>
      <div id="lt_delete_msg" style="font-size:16px;color:#9ba0c0;line-height:1.65;"></div>
    </div>
    <div style="display:flex;gap:12px;width:100%;max-width:340px;">
      <button id="lt_delete_cancel" style="${S_BTN}flex:1;">Cancel</button>
      <button id="lt_delete_confirm_btn" style="${S_BTN}flex:1;border-color:#7a3a3a;background:rgba(122,58,58,0.18);color:#ff7070;font-weight:500;"></button>
    </div>
  </div>

</dialog><!-- /#lt_overlay -->
`);

    // ── HTML escaping / highlight helper ─────────────────────────────────────
    function escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function hlMatch(text, query) {
        if (!query) return escHtml(text);
        const idx = text.toLowerCase().indexOf(query.toLowerCase());
        if (idx === -1) return escHtml(text);
        return escHtml(text.slice(0, idx))
            + `<span style="color:#7a9aee;font-weight:600;">${escHtml(text.slice(idx, idx + query.length))}</span>`
            + escHtml(text.slice(idx + query.length));
    }

    // ── Searchable combo factory ──────────────────────────────────────────────
    // Returns { getValue(), reset() }.
    // Uses mousedown+preventDefault on list items so the input never blurs
    // before the selection is committed.
    function makeCombo(wrapperId, inputId, listId) {
        const wrapper = document.getElementById(wrapperId);
        const input   = document.getElementById(inputId);
        const listEl  = document.getElementById(listId);
        let lastValid = '';
        let hiIdx     = -1;

        function setHi(idx) {
            const opts = listEl.querySelectorAll('.lt-opt');
            opts.forEach(o => o.style.background = '');
            hiIdx = idx;
            if (hiIdx >= 0 && opts[hiIdx]) {
                opts[hiIdx].style.background = '#22224a';
                opts[hiIdx].scrollIntoView({ block: 'nearest' });
            }
        }

        function renderList(q) {
            const names    = visibleLorebooks();
            const filtered = q ? names.filter(n => n.toLowerCase().includes(q.toLowerCase())) : names;
            if (!filtered.length) {
                listEl.innerHTML = '<div style="padding:10px 12px;color:#444466;font-size:12px;">No lorebooks found</div>';
            } else {
                listEl.innerHTML = filtered.map((n, i) =>
                    `<div class="lt-opt" data-name="${escHtml(n)}" data-i="${i}" ` +
                    `style="padding:7px 12px;cursor:pointer;font-size:13px;color:#c8d0f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">`
                    + hlMatch(n, q) + '</div>'
                ).join('');
                listEl.querySelectorAll('.lt-opt').forEach((opt, i) => {
                    // mousedown+preventDefault keeps focus on the input
                    opt.addEventListener('mousedown', e => { e.preventDefault(); choose(opt.dataset.name); });
                    opt.addEventListener('mouseenter', () => setHi(i));
                });
            }
            listEl.style.display = 'block';
            hiIdx = -1;
        }

        function closeList() {
            listEl.style.display = 'none';
            hiIdx = -1;
        }

        function choose(name) {
            lastValid           = name;
            wrapper.dataset.value = name;
            input.value         = name;
            closeList();
        }

        input.addEventListener('focus', () => renderList(input.value));

        input.addEventListener('input', () => {
            wrapper.dataset.value = '';
            renderList(input.value);
        });

        input.addEventListener('keydown', e => {
            const opts = listEl.querySelectorAll('.lt-opt');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHi(Math.min(hiIdx + 1, opts.length - 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHi(Math.max(hiIdx - 1, -1));
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (hiIdx >= 0 && opts[hiIdx]) choose(opts[hiIdx].dataset.name);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                input.value           = lastValid;
                wrapper.dataset.value = lastValid;
                closeList();
            }
        });

        input.addEventListener('blur', () => {
            // Small delay so mousedown on a list item fires first
            setTimeout(() => {
                closeList();
                const typed = input.value;
                const names = visibleLorebooks();
                if (typed && !names.includes(typed)) {
                    // Typed value doesn't match any lorebook — snap back
                    input.value           = lastValid;
                    wrapper.dataset.value = lastValid;
                } else if (!typed) {
                    wrapper.dataset.value = '';
                }
            }, 180);
        });

        return {
            getValue: () => wrapper.dataset.value || '',
            reset: () => {
                lastValid = '';
                wrapper.dataset.value = '';
                input.value = '';
                listEl.style.display = 'none';
                hiIdx = -1;
            },
        };
    }

    const srcCombo = makeCombo('lt_src_combo', 'lt_src_input', 'lt_src_list');
    const dstCombo = makeCombo('lt_dst_combo', 'lt_dst_input', 'lt_dst_list');

    // ── Module-level state ────────────────────────────────────────────────────
    let loadedSource = '';
    let loadedData   = null;

    // ── Open / close / reset ──────────────────────────────────────────────────
    function resetModal() {
        srcCombo.reset();
        dstCombo.reset();
        document.getElementById('lt_step1').style.display = 'flex';
        document.getElementById('lt_step2').style.display = 'none';
        document.getElementById('lt_delete_confirm').style.display = 'none';
        document.getElementById('lt_entries').innerHTML = '';
        document.getElementById('lt_load_status').textContent = '';
        document.getElementById('lt_breadcrumb').textContent = '';
        document.getElementById('lt_header_bar').style.cursor = '';
        document.getElementById('lt_header_bar').title = '';
        document.getElementById('lt_header_hit').style.cursor = '';
        document.getElementById('lt_header_hit').title = '';
        document.getElementById('lt_breadcrumb').style.cursor = '';
        document.getElementById('lt_breadcrumb').title = '';
        loadedSource = '';
        loadedData   = null;
    }

    const ltOverlay = /** @type {HTMLDialogElement|null} */ (document.getElementById('lt_overlay'));
    if (ltOverlay) {
        ltOverlay.style.margin = '0';
        ltOverlay.style.inset = '0';
        ltOverlay.style.position = 'fixed';
        ltOverlay.style.boxSizing = 'border-box';
    }

    function showModalNow() {
        if (ltOverlay?.showModal) {
            if (!ltOverlay.open) ltOverlay.showModal();
        } else {
            $('#lt_overlay').css('display', 'flex');
        }
    }

    async function openModal() {
        resetModal();
        document.getElementById('lt_load_status').textContent = 'Loading lorebooks...';
        showModalNow();

        try {
            await refreshLoreTreasuryAccessMap();
        } catch (error) {
            console.warn('[Lore Treasury] Could not refresh access map; using local hidden-lore filters.', error);
            toastr.warning('Server ownership scan is unavailable. Hidden lore protection is using local filters.', 'Lore Treasury');
            allowedLorebookNames = null;
        }

        if (ltOverlay?.open || document.getElementById('lt_overlay').style.display === 'flex') {
            document.getElementById('lt_load_status').textContent = '';
        }
    }

    $('#lore_treasury_button').off('click.loreTreasury').on('click.loreTreasury', () => {
        void openModal();
    });

    $('#lt_close').off('click.loreTreasury').on('click.loreTreasury', (e) => {
        e.stopPropagation();
        if (ltOverlay?.close) {
            ltOverlay.close();
        } else {
            $('#lt_overlay').css('display', 'none');
        }
        resetModal();
    });

    $('#lt_breadcrumb, #lt_header_hit, #lt_header_bar').off('click.loreTreasury').on('click.loreTreasury', (e) => {
        if ($(e.target).closest('#lt_close').length) return;
        if (document.getElementById('lt_step2').style.display !== 'none') {
            resetModal();
        }
    });

    // Click on backdrop dismisses
    $('#lt_overlay').off('click.loreTreasury').on('click.loreTreasury', function (e) {
        if (e.target === this) {
            if (ltOverlay?.close) {
                ltOverlay.close();
            } else {
                $(this).css('display', 'none');
            }
            resetModal();
        }
    });

    // ── Load entries ──────────────────────────────────────────────────────────
    $('#lt_load_btn').off('click.loreTreasury').on('click.loreTreasury', async () => {
        const src = srcCombo.getValue();
        if (!src) {
            toastr.warning('Please select a Source lorebook.', 'Lore Treasury');
            return;
        }
        if (!canAccessLorebook(src)) {
            toastr.error('This lorebook is not available in Lore Treasury.', 'Lore Treasury');
            return;
        }

        const dst = dstCombo.getValue();
        if (dst && !canAccessLorebook(dst)) {
            toastr.error('This destination lorebook is not available in Lore Treasury.', 'Lore Treasury');
            return;
        }

        $('#lt_load_status').text('Loading…');
        $('#lt_load_btn').prop('disabled', true);
        let data;
        try {
            data = await loadWorldInfo(src);
        } finally {
            $('#lt_load_status').text('');
            $('#lt_load_btn').prop('disabled', false);
        }

        if (!data || typeof data.entries !== 'object') {
            toastr.error(`Could not load lorebook: "${src}"`, 'Lore Treasury');
            return;
        }

        loadedSource = src;
        loadedData   = data;

        $('#lt_breadcrumb').text(dst
            ? `${src}  →  ${dst}`
            : `Source: ${src}   (no destination — Copy/Transfer will require one)`
        );
        document.getElementById('lt_header_bar').style.cursor = 'pointer';
        document.getElementById('lt_header_bar').title = 'Tap to choose different lorebooks';
        document.getElementById('lt_header_hit').style.cursor = 'pointer';
        document.getElementById('lt_header_hit').title = 'Tap to choose different lorebooks';
        document.getElementById('lt_breadcrumb').style.cursor = 'pointer';
        document.getElementById('lt_breadcrumb').title = 'Tap to choose different lorebooks';

        renderEntries(data);
        $('#lt_step1').css('display', 'none');
        $('#lt_step2').css('display', 'flex');
    });

    // ── Entry list ────────────────────────────────────────────────────────────
    function renderEntries(data) {
        const list    = document.getElementById('lt_entries');
        list.innerHTML = '';
        const entries = Object.values(data.entries || {});

        if (!entries.length) {
            list.innerHTML = '<div style="padding:28px;text-align:center;color:#333355;font-size:13px;">This lorebook has no entries.</div>';
            document.getElementById('lt_entry_count').textContent = '0 entries';
            updateSelectAll();
            return;
        }

        const fragment = document.createDocumentFragment();
        entries.forEach(entry => {
            const uid   = entry.uid;
            const title = entry.comment || '(untitled)';
            const keys  = Array.isArray(entry.key) ? entry.key.join(', ') : '';

            const row = document.createElement('div');
            row.className    = 'lt-entry-row';
            row.dataset.uid  = uid;
            row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 18px;cursor:pointer;border-bottom:1px solid #191930;'
                + (entry.disable ? 'opacity:0.45;' : '');
            row.innerHTML =
                `<input type="checkbox" class="lt-entry-check" data-uid="${uid}" ` +
                `style="width:14px;height:14px;flex-shrink:0;accent-color:#7a9aee;cursor:pointer;">` +
                `<div style="flex:1;min-width:0;">` +
                  `<div style="font-size:16px;color:#c8d0f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(title)}</div>` +
                  (keys ? `<div style="font-size:14px;color:#444466;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;">${escHtml(keys)}</div>` : '') +
                `</div>` +
                (entry.constant
                    ? '<span style="font-size:10px;color:#7ae8d8;border:1px solid rgba(122,232,216,0.35);border-radius:3px;padding:1px 5px;flex-shrink:0;">const</span>'
                    : '');

            // Click anywhere on the row toggles the checkbox
            row.addEventListener('click', e => {
                if (e.target.type === 'checkbox') return;
                const cb = row.querySelector('.lt-entry-check');
                cb.checked = !cb.checked;
                updateSelectAll();
            });
            row.querySelector('.lt-entry-check').addEventListener('change', updateSelectAll);
            row.addEventListener('mouseenter', () => { row.style.background = '#1c1c3a'; });
            row.addEventListener('mouseleave', () => { row.style.background = ''; });

            fragment.appendChild(row);
        });
        list.appendChild(fragment);

        document.getElementById('lt_entry_count').textContent =
            `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
        updateSelectAll();
    }

    function updateSelectAll() {
        const all     = document.querySelectorAll('#lt_entries .lt-entry-check');
        const checked = document.querySelectorAll('#lt_entries .lt-entry-check:checked');
        const cb      = document.getElementById('lt_select_all');
        const lbl     = document.getElementById('lt_select_label');

        if (checked.length === 0) {
            cb.checked = false; cb.indeterminate = false;
        } else if (checked.length === all.length) {
            cb.checked = true;  cb.indeterminate = false;
        } else {
            cb.checked = false; cb.indeterminate = true;
        }
        lbl.textContent = checked.length > 0 ? `Selected (${checked.length})` : 'Select All';
    }

    document.getElementById('lt_select_all').addEventListener('change', function () {
        document.querySelectorAll('#lt_entries .lt-entry-check')
            .forEach(cb => { cb.checked = this.checked; });
        updateSelectAll();
    });

    function getSelectedUIDs() {
        return Array.from(document.querySelectorAll('#lt_entries .lt-entry-check:checked'))
            .map(cb => parseInt(cb.dataset.uid));
    }

    // Validates selection and optionally checks destination.
    // Returns uid array or null on failure.
    function validateSelection(needDest) {
        const uids = getSelectedUIDs();
        if (!uids.length) {
            toastr.warning('Select at least one entry first.', 'Lore Treasury');
            return null;
        }
        if (!canAccessLorebook(loadedSource)) {
            toastr.error('This lorebook is not available in Lore Treasury.', 'Lore Treasury');
            return null;
        }
        if (needDest) {
            const dst = dstCombo.getValue();
            if (!dst) {
                toastr.warning('Please select a Destination lorebook.', 'Lore Treasury');
                return null;
            }
            if (!canAccessLorebook(dst)) {
                toastr.error('This destination lorebook is not available in Lore Treasury.', 'Lore Treasury');
                return null;
            }
            if (dst === loadedSource) {
                toastr.warning('Source and Destination must be different lorebooks.', 'Lore Treasury');
                return null;
            }
        }
        return uids;
    }

    // ── Copy ──────────────────────────────────────────────────────────────────
    $('#lt_copy_btn').on('click', async () => {
        const uids = validateSelection(true);
        if (!uids) return;

        const dst     = dstCombo.getValue();
        const dstData = await loadWorldInfo(dst);
        if (!dstData || typeof dstData.entries !== 'object') {
            toastr.error(`Could not load destination lorebook: "${dst}"`, 'Lore Treasury');
            return;
        }
        dstData.entries = dstData.entries || {};

        let maxUid = Object.keys(dstData.entries).reduce((m, k) => Math.max(m, parseInt(k)), -1);
        for (const uid of uids) {
            const entry = loadedData.entries[uid];
            if (!entry) continue;
            maxUid++;
            dstData.entries[maxUid] = Object.assign({}, entry, { uid: maxUid });
        }

        await saveWorldInfo(dst, dstData, true);
        toastr.success(
            `Copied ${uids.length} entr${uids.length === 1 ? 'y' : 'ies'} into "${dst}"`,
            'Lore Treasury'
        );
        setTimeout(resetModal, 400);
    });

    // ── Transfer ──────────────────────────────────────────────────────────────
    $('#lt_transfer_btn').on('click', async () => {
        const uids = validateSelection(true);
        if (!uids) return;

        const dst     = dstCombo.getValue();
        const dstData = await loadWorldInfo(dst);
        if (!dstData || typeof dstData.entries !== 'object') {
            toastr.error(`Could not load destination lorebook: "${dst}"`, 'Lore Treasury');
            return;
        }
        dstData.entries = dstData.entries || {};

        // Add to destination
        let maxUid = Object.keys(dstData.entries).reduce((m, k) => Math.max(m, parseInt(k)), -1);
        for (const uid of uids) {
            const entry = loadedData.entries[uid];
            if (!entry) continue;
            maxUid++;
            dstData.entries[maxUid] = Object.assign({}, entry, { uid: maxUid });
        }
        await saveWorldInfo(dst, dstData, true);

        // Remove from source
        for (const uid of uids) delete loadedData.entries[uid];
        await saveWorldInfo(loadedSource, loadedData, true);

        toastr.success(
            `Transferred ${uids.length} entr${uids.length === 1 ? 'y' : 'ies'} → "${dst}"`,
            'Lore Treasury'
        );
        setTimeout(resetModal, 400);
    });

    // ── Delete (with confirmation screen) ────────────────────────────────────
    $('#lt_delete_btn').on('click', () => {
        const uids = validateSelection(false);
        if (!uids) return;
        const n = uids.length;
        document.getElementById('lt_delete_msg').textContent =
            `You are about to permanently delete ${n} entr${n === 1 ? 'y' : 'ies'} ` +
            `from "${loadedSource}". This cannot be undone.`;
        document.getElementById('lt_delete_confirm_btn').textContent =
            `Delete ${n} Entr${n === 1 ? 'y' : 'ies'}`;
        $('#lt_delete_confirm').css('display', 'flex');
    });

    $('#lt_delete_cancel').on('click', () => {
        $('#lt_delete_confirm').css('display', 'none');
    });

    $('#lt_delete_confirm_btn').on('click', async () => {
        $('#lt_delete_confirm').css('display', 'none');
        const uids = getSelectedUIDs();
        if (!uids.length) return;

        for (const uid of uids) delete loadedData.entries[uid];
        await saveWorldInfo(loadedSource, loadedData, true);

        uids.forEach(uid => {
            document.querySelector(`#lt_entries .lt-entry-row[data-uid="${uid}"]`)?.remove();
        });

        const rem = Object.keys(loadedData.entries).length;
        document.getElementById('lt_entry_count').textContent =
            `${rem} entr${rem === 1 ? 'y' : 'ies'}`;
        updateSelectAll();

        toastr.success(
            `Deleted ${uids.length} entr${uids.length === 1 ? 'y' : 'ies'} from "${loadedSource}"`,
            'Lore Treasury'
        );
        setTimeout(resetModal, 400);
    });
}
