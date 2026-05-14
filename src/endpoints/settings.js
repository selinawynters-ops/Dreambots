/*
 * ============================================================================
 * DREAMTAVERN CUSTOMIZATION - Settings Endpoint
 * ============================================================================
 * 
 * MODIFICATIONS FROM DEFAULT SILLYTAVERN:
 * 
 * Minor modifications to support multi-user environment and admin controls.
 * Exact changes depend on integration with user-specific settings storage.
 * 
 * POTENTIAL MODIFICATIONS:
 * - User-specific settings paths
 * - Admin-only settings access controls
 * - Integration with user.js authentication system
 * 
 * RELATED FILES:
 *    - src/users.js (user authentication and directory management)
 *    - src/endpoints/characters.js (character-specific settings protection)
 * 
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import _ from 'lodash';
import writeFileAtomic from 'write-file-atomic';

import { SETTINGS_FILE } from '../constants.js';
import { getConfigValue, generateTimestamp, removeOldBackups } from '../util.js';
import { getAllUserHandles, getUserDirectories } from '../users.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';

const ENABLE_EXTENSIONS = !!getConfigValue('extensions.enabled', true, 'boolean');
const ENABLE_EXTENSIONS_AUTO_UPDATE = !!getConfigValue('extensions.autoUpdate', true, 'boolean');
const ENABLE_ACCOUNTS = !!getConfigValue('enableUserAccounts', false, 'boolean');

// 10 minutes
const AUTOSAVE_INTERVAL = 10 * 60 * 1000;

/**
 * Map of functions to trigger settings autosave for a user.
 * @type {Map<string, function>}
 */
const AUTOSAVE_FUNCTIONS = new Map();

/**
 * Triggers autosave for a user every 10 minutes.
 * @param {string} handle User handle
 * @returns {void}
 */
function triggerAutoSave(handle) {
    if (!AUTOSAVE_FUNCTIONS.has(handle)) {
        const throttledAutoSave = _.throttle(() => backupUserSettings(handle, true), AUTOSAVE_INTERVAL);
        AUTOSAVE_FUNCTIONS.set(handle, throttledAutoSave);
    }

    const functionToCall = AUTOSAVE_FUNCTIONS.get(handle);
    if (functionToCall && typeof functionToCall === 'function') {
        functionToCall();
    }
}

/**
 * Reads and parses files from a directory.
 * @param {string} directoryPath Path to the directory
 * @param {string} fileExtension File extension
 * @returns {Array} Parsed files
 */
function readAndParseFromDirectory(directoryPath, fileExtension = '.json') {
    const files = fs
        .readdirSync(directoryPath)
        .filter(x => path.parse(x).ext == fileExtension)
        .sort();

    const parsedFiles = [];

    files.forEach(item => {
        try {
            const file = fs.readFileSync(path.join(directoryPath, item), 'utf-8');
            parsedFiles.push(fileExtension == '.json' ? JSON.parse(file) : file);
        }
        catch {
            // skip
        }
    });

    return parsedFiles;
}

/**
 * Gets a sort function for sorting strings.
 * @param {*} _
 * @returns {(a: string, b: string) => number} Sort function
 */
function sortByName(_) {
    return (a, b) => a.localeCompare(b);
}

function normalizeHandle(value) {
    return String(value || '').trim().toLowerCase();
}

function isTrueishFlag(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function getPushExtensionBySuffix(extensions, suffix) {
    if (!extensions || typeof extensions !== 'object') return undefined;
    for (const [key, value] of Object.entries(extensions)) {
        if (key.endsWith(`_${suffix}`)) {
            return value;
        }
    }
    return undefined;
}

function findCreatorFromDdName(lorebookName, allHandles) {
    const name = String(lorebookName || '').trim().toLowerCase();
    if (!name.startsWith('dd-')) return '';
    const handles = [...new Set((allHandles || []).map(h => String(h || '').trim()).filter(Boolean))]
        .sort((a, b) => b.length - a.length);
    for (const handle of handles) {
        const normalizedHandle = handle.toLowerCase();
        if (name.startsWith(`dd-${normalizedHandle}-`)) {
            return handle;
        }
    }
    return '';
}

function canUserSeeHiddenLorebook(worldName, extensions, userProfile, allHandles) {
    if (userProfile?.admin) return true;
    const userHandle = normalizeHandle(userProfile?.handle);
    if (!userHandle) return false;

    const creator = normalizeHandle(getPushExtensionBySuffix(extensions, 'creator'));
    const originalCreator = normalizeHandle(getPushExtensionBySuffix(extensions, 'original_creator') || creator);
    if (creator && creator === userHandle) return true;
    if (originalCreator && originalCreator === userHandle) return true;

    const ddCreator = normalizeHandle(findCreatorFromDdName(worldName, allHandles));
    if (ddCreator && ddCreator === userHandle) return true;

    return false;
}

function isHiddenLorebookForList(worldName, extensions) {
    if (String(worldName || '').startsWith('ADMIN-')) return true;
    if (String(worldName || '').startsWith('dd-')) return true;
    return isTrueishFlag(getPushExtensionBySuffix(extensions, 'hidden'));
}

function getPushedWorldOwnershipMap(directories, userProfile) {
    /** @type {Map<string, { hasPushed: boolean, owner: boolean }>} */
    const ownership = new Map();
    const userHandle = normalizeHandle(userProfile?.handle);
    const isAdminUser = Boolean(userProfile?.admin);

    let files = [];
    try {
        files = fs.readdirSync(directories.characters).filter(x => x.toLowerCase().endsWith('.png'));
    } catch {
        return ownership;
    }

    for (const file of files) {
        const filePath = path.join(directories.characters, file);
        try {
            const png = fs.readFileSync(filePath);
            const raw = readCharacterCard(png);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            const ext = parsed?.data?.extensions || {};
            const worldName = String(ext.world || '').trim();
            if (!worldName) continue;

            const pushed = isTrueishFlag(getPushExtensionBySuffix(ext, 'pushed'));
            if (!pushed) continue;

            const creator = normalizeHandle(getPushExtensionBySuffix(ext, 'creator'));
            const originalCreator = normalizeHandle(getPushExtensionBySuffix(ext, 'original_creator') || creator);
            const owner = isAdminUser || (userHandle && (userHandle === creator || userHandle === originalCreator));

            const current = ownership.get(worldName) || { hasPushed: false, owner: false };
            current.hasPushed = true;
            current.owner = current.owner || owner;
            ownership.set(worldName, current);

            // Also register secondary/bundle lorebooks so they appear in
            // hidden_world_names and get the 9z prefix in WorldInfoInfo.
            const auxRaw = getPushExtensionBySuffix(ext, 'aux_lorebooks')
                || getPushExtensionBySuffix(ext, 'bundle_lorebooks');
            const auxNames = Array.isArray(auxRaw)
                ? auxRaw.map(n => String(n || '').trim()).filter(Boolean)
                : [];
            for (const auxName of auxNames) {
                if (auxName === worldName) continue;
                const auxCurrent = ownership.get(auxName) || { hasPushed: false, owner: false };
                auxCurrent.hasPushed = true;
                auxCurrent.owner = auxCurrent.owner || owner;
                ownership.set(auxName, auxCurrent);
            }
        } catch {
            // Ignore malformed cards for visibility inference.
        }
    }

    return ownership;
}

/**
 * Gets backup file prefix for user settings.
 * @param {string} handle User handle
 * @returns {string} File prefix
 */
export function getSettingsBackupFilePrefix(handle) {
    return `settings_${handle}_`;
}

function readPresetsFromDirectory(directoryPath, options = {}) {
    const {
        sortFunction,
        removeFileExtension = false,
        fileExtension = '.json',
    } = options;

    const files = fs.readdirSync(directoryPath).sort(sortFunction).filter(x => path.parse(x).ext == fileExtension);
    const fileContents = [];
    const fileNames = [];

    files.forEach(item => {
        try {
            const file = fs.readFileSync(path.join(directoryPath, item), 'utf8');
            JSON.parse(file);
            fileContents.push(file);
            fileNames.push(removeFileExtension ? item.replace(/\.[^/.]+$/, '') : item);
        } catch {
            // skip
            console.warn(`${item} is not a valid JSON`);
        }
    });

    return { fileContents, fileNames };
}

async function backupSettings() {
    try {
        const userHandles = await getAllUserHandles();

        for (const handle of userHandles) {
            backupUserSettings(handle, true);
        }
    } catch (err) {
        console.error('Could not backup settings file', err);
    }
}

/**
 * Makes a backup of the user's settings file.
 * @param {string} handle User handle
 * @param {boolean} preventDuplicates Prevent duplicate backups
 * @returns {void}
 */
function backupUserSettings(handle, preventDuplicates) {
    const userDirectories = getUserDirectories(handle);

    if (!fs.existsSync(userDirectories.root)) {
        return;
    }

    const backupFile = path.join(userDirectories.backups, `${getSettingsBackupFilePrefix(handle)}${generateTimestamp()}.json`);
    const sourceFile = path.join(userDirectories.root, SETTINGS_FILE);

    if (preventDuplicates && isDuplicateBackup(handle, sourceFile)) {
        return;
    }

    if (!fs.existsSync(sourceFile)) {
        return;
    }

    fs.copyFileSync(sourceFile, backupFile);
    removeOldBackups(userDirectories.backups, `settings_${handle}`);
}

/**
 * Checks if the backup would be a duplicate.
 * @param {string} handle User handle
 * @param {string} sourceFile Source file path
 * @returns {boolean} True if the backup is a duplicate
 */
function isDuplicateBackup(handle, sourceFile) {
    const latestBackup = getLatestBackup(handle);
    if (!latestBackup) {
        return false;
    }
    return areFilesEqual(latestBackup, sourceFile);
}

/**
 * Returns true if the two files are equal.
 * @param {string} file1 File path
 * @param {string} file2 File path
 */
function areFilesEqual(file1, file2) {
    if (!fs.existsSync(file1) || !fs.existsSync(file2)) {
        return false;
    }

    const content1 = fs.readFileSync(file1);
    const content2 = fs.readFileSync(file2);
    return content1.toString() === content2.toString();
}

/**
 * Gets the latest backup file for a user.
 * @param {string} handle User handle
 * @returns {string|null} Latest backup file. Null if no backup exists.
 */
function getLatestBackup(handle) {
    const userDirectories = getUserDirectories(handle);
    const backupFiles = fs.readdirSync(userDirectories.backups)
        .filter(x => x.startsWith(getSettingsBackupFilePrefix(handle)))
        .map(x => ({ name: x, ctime: fs.statSync(path.join(userDirectories.backups, x)).ctimeMs }));
    const latestBackup = backupFiles.sort((a, b) => b.ctime - a.ctime)[0]?.name;
    if (!latestBackup) {
        return null;
    }
    return path.join(userDirectories.backups, latestBackup);
}

export const router = express.Router();

router.post('/save', async function (request, response) {
    try {
        if (!request.user || !request.user.directories) {
            console.error('[settings/save] No request.user.directories — auth/middleware likely failed');
            return response.status(401).json({ error: 'Not authenticated' });
        }
        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
        await writeFileAtomic(pathToSettings, JSON.stringify(request.body, null, 4), 'utf8');
        triggerAutoSave(request.user.profile.handle);
        response.send({ result: 'ok' });
    } catch (err) {
        console.error('[settings/save] Failed:', err);
        response.status(500).json({ error: err.message || String(err) });
    }
});

// Wintermute's code
router.post('/get', async (request, response) => {
    let settings;
    try {
        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
        settings = await fs.promises.readFile(pathToSettings, 'utf8');
    } catch (e) {
        console.error('[settings/get] Failed to read settings file:', e?.code || '', e?.message || e);
        return response.status(500).json({ error: e?.code || 'read_failed', message: e?.message || String(e) });
    }

    // NovelAI Settings
    const { fileContents: novelai_settings, fileNames: novelai_setting_names }
        = readPresetsFromDirectory(request.user.directories.novelAI_Settings, {
            sortFunction: sortByName(request.user.directories.novelAI_Settings),
            removeFileExtension: true,
        });

    // OpenAI Settings
    const { fileContents: openai_settings, fileNames: openai_setting_names }
        = readPresetsFromDirectory(request.user.directories.openAI_Settings, {
            sortFunction: sortByName(request.user.directories.openAI_Settings), removeFileExtension: true,
        });

    // TextGenerationWebUI Settings
    const { fileContents: textgenerationwebui_presets, fileNames: textgenerationwebui_preset_names }
        = readPresetsFromDirectory(request.user.directories.textGen_Settings, {
            sortFunction: sortByName(request.user.directories.textGen_Settings), removeFileExtension: true,
        });

    //Kobold
    const { fileContents: koboldai_settings, fileNames: koboldai_setting_names }
        = readPresetsFromDirectory(request.user.directories.koboldAI_Settings, {
            sortFunction: sortByName(request.user.directories.koboldAI_Settings), removeFileExtension: true,
        });

    const worldFiles = fs
        .readdirSync(request.user.directories.worlds)
        .filter(file => path.extname(file).toLowerCase() === '.json')
        .sort((a, b) => a.localeCompare(b));
    const allHandles = await getAllUserHandles();
    const pushedWorldOwnership = getPushedWorldOwnershipMap(request.user.directories, request.user.profile);
    const world_names = [];
    const hidden_world_names = [];
    for (const file of worldFiles) {
        const worldName = path.parse(file).name;
        if (request.user.profile?.admin) {
            world_names.push(worldName);
            continue;
        }

        const pushedOwnership = pushedWorldOwnership.get(worldName);

        const filePath = path.join(request.user.directories.worlds, file);
        let extensions = {};
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            extensions = _.isObjectLike(parsed?.extensions) ? parsed.extensions : {};
        } catch {
            extensions = {};
        }

        if (!isHiddenLorebookForList(worldName, extensions)) {
            world_names.push(worldName);
            continue;
        }

        if (canUserSeeHiddenLorebook(worldName, extensions, request.user.profile, allHandles)) {
            world_names.push(worldName);
            continue;
        }

        // Include hidden pushed lorebooks that are bound to this user's pushed characters.
        // The lorebook itself is hidden from the editor dropdown (filtered on the frontend),
        // but it must be in world_names so the character's world icon lights up and the
        // lorebook entries can be loaded for prompt building.
        if (pushedOwnership?.hasPushed) {
            world_names.push(worldName);
            hidden_world_names.push(worldName);
        }
    }

    const themes = readAndParseFromDirectory(request.user.directories.themes);
    const movingUIPresets = readAndParseFromDirectory(request.user.directories.movingUI);
    const quickReplyPresets = readAndParseFromDirectory(request.user.directories.quickreplies);

    const instruct = readAndParseFromDirectory(request.user.directories.instruct);
    const context = readAndParseFromDirectory(request.user.directories.context);
    const sysprompt = readAndParseFromDirectory(request.user.directories.sysprompt);
    const reasoning = readAndParseFromDirectory(request.user.directories.reasoning);

    response.send({
        settings,
        koboldai_settings,
        koboldai_setting_names,
        hidden_world_names,
        world_names,
        novelai_settings,
        novelai_setting_names,
        openai_settings,
        openai_setting_names,
        textgenerationwebui_presets,
        textgenerationwebui_preset_names,
        themes,
        movingUIPresets,
        quickReplyPresets,
        instruct,
        context,
        sysprompt,
        reasoning,
        enable_extensions: ENABLE_EXTENSIONS,
        enable_extensions_auto_update: ENABLE_EXTENSIONS_AUTO_UPDATE,
        enable_accounts: ENABLE_ACCOUNTS,
    });
});

router.post('/get-snapshots', async (request, response) => {
    try {
        const snapshots = fs.readdirSync(request.user.directories.backups);
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);
        const userSnapshots = snapshots.filter(x => x.startsWith(userFilesPattern));

        const result = userSnapshots.map(x => {
            const stat = fs.statSync(path.join(request.user.directories.backups, x));
            return { date: stat.ctimeMs, name: x, size: stat.size };
        });

        response.json(result);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/load-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!fs.existsSync(snapshotPath)) {
            return response.sendStatus(404);
        }

        const content = fs.readFileSync(snapshotPath, 'utf8');

        response.send(content);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/make-snapshot', async (request, response) => {
    try {
        backupUserSettings(request.user.profile.handle, false);
        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/restore-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!fs.existsSync(snapshotPath)) {
            return response.sendStatus(404);
        }

        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
        fs.rmSync(pathToSettings, { force: true });
        fs.copyFileSync(snapshotPath, pathToSettings);

        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

// Fonts endpoint moved to publicFontsRouter for public access

/**
 * Public fonts router - doesn't require authentication
 */
export const publicFontsRouter = express.Router();

publicFontsRouter.get('/fonts', (request, response) => {
    try {
        const fontsDir = path.join(process.cwd(), 'public', 'fonts');
        const supported = ['.woff', '.woff2', '.ttf', '.otf'];

        if (!fs.existsSync(fontsDir)) {
            return response.json([]);
        }

        const fonts = fs.readdirSync(fontsDir)
            .filter(file => supported.includes(path.extname(file).toLowerCase()))
            .sort((a, b) => a.localeCompare(b))
            .map(file => {
                const ext = path.extname(file).toLowerCase();
                const value = path.basename(file, path.extname(file)).trim();
                const name = value.replace(/[_-]+/g, ' ').trim();
                const format = ext === '.ttf'
                    ? 'truetype'
                    : ext === '.otf'
                        ? 'opentype'
                        : ext === '.woff2'
                            ? 'woff2'
                            : 'woff';

                return {
                    name,
                    value,
                    file,
                    files: [{ url: `/fonts/${file}`, format }],
                };
            });

        return response.json(fonts);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * Initializes the settings endpoint
 */
export async function init() {
    await backupSettings();
}
