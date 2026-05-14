import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
    requireAdminMiddleware,
    getAllUserHandles,
    getUserDirectories,
} from '../users.js';

export const router = express.Router();

// Source of truth is always default-user — not configurable
const ADMIN_HANDLE = 'default-user';

// Maps config preset type key → getUserDirectories() property name
const PRESET_DIRS = {
    openAI:  'openAI_Settings',
    textGen: 'textGen_Settings',
    novelAI: 'novelAI_Settings',
};

// Computed lazily so DATA_ROOT is guaranteed to be set by the time it's used
function getSyncConfigPath() {
    return path.join(globalThis.DATA_ROOT ?? 'data', 'sync-config.json');
}

const DEFAULT_CONFIG = {
    lorebooks: {},
    presets: {
        openAI:  {},
        textGen: {},
        novelAI: {},
    },
    optedOut: {},
    lastSyncedAt: null,
};

function readConfig() {
    try {
        const configPath = getSyncConfigPath();
        if (fs.existsSync(configPath)) {
            const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            // Migrate old flat presets (pre-TextGen/NovelAI) to nested structure
            if (saved.presets && !saved.presets.openAI && !saved.presets.textGen) {
                saved.presets = { openAI: saved.presets, textGen: {}, novelAI: {} };
            }
            return {
                ...DEFAULT_CONFIG,
                ...saved,
                presets: { ...DEFAULT_CONFIG.presets, ...(saved.presets || {}) },
            };
        }
    } catch (err) {
        console.error('[SyncManager] Failed to read config:', err.message);
    }
    return structuredClone(DEFAULT_CONFIG);
}

function writeConfig(config) {
    fs.writeFileSync(getSyncConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

function listJsonFiles(dir) {
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    } catch {
        return [];
    }
}

/**
 * Merge an admin lorebook onto a user's existing lorebook file.
 * Preserves each entry's `disable` state the user has set (toggle in the WI editor)
 * while updating all content from the admin version. Matching is done by entry `uid`.
 */
function mergeLorebook(adminBook, destPath) {
    if (!fs.existsSync(destPath)) return adminBook;
    let userBook;
    try {
        userBook = JSON.parse(fs.readFileSync(destPath, 'utf-8'));
    } catch {
        return adminBook;
    }
    const merged = structuredClone(adminBook);
    if (userBook.entries && merged.entries) {
        const userDisabled = new Map(
            Object.values(userBook.entries)
                .filter(e => e.disable === true)
                .map(e => [e.uid, true]),
        );
        for (const entry of Object.values(merged.entries)) {
            if (userDisabled.has(entry.uid)) entry.disable = true;
        }
    }
    return merged;
}

function syncLorebookFile(src, dest, destDir) {
    if (!fs.existsSync(src)) return false;
    const adminBook = JSON.parse(fs.readFileSync(src, 'utf-8'));
    const merged = mergeLorebook(adminBook, dest);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(merged, null, 4), 'utf-8');
    return true;
}

/**
 * Merge an admin preset onto a user's existing preset file.
 * Preserves the user's per-prompt enabled/disabled states (chain icon toggles)
 * while updating all content from the admin version.
 */
function mergePreset(adminPreset, destPath) {
    if (!fs.existsSync(destPath)) return adminPreset;
    let userPreset;
    try {
        userPreset = JSON.parse(fs.readFileSync(destPath, 'utf-8'));
    } catch {
        return adminPreset;
    }
    const merged = structuredClone(adminPreset);
    if (Array.isArray(userPreset.prompt_order) && Array.isArray(merged.prompt_order)) {
        for (const adminOrderEntry of merged.prompt_order) {
            const userOrderEntry = userPreset.prompt_order.find(
                e => e.character_id === adminOrderEntry.character_id,
            );
            if (!userOrderEntry?.order) continue;
            const userDisabled = new Map(
                userOrderEntry.order
                    .filter(p => p.enabled === false)
                    .map(p => [p.identifier, false]),
            );
            for (const prompt of adminOrderEntry.order) {
                if (userDisabled.has(prompt.identifier)) prompt.enabled = false;
            }
        }
    }
    return merged;
}

function syncPresetFile(src, dest, destDir) {
    if (!fs.existsSync(src)) return false;
    const adminPreset = JSON.parse(fs.readFileSync(src, 'utf-8'));
    const merged = mergePreset(adminPreset, dest);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(merged, null, 4), 'utf-8');
    return true;
}

async function syncFiles(config) {
    const adminDirs = getUserDirectories(ADMIN_HANDLE);
    const allHandles = await getAllUserHandles();
    const regularUsers = allHandles.filter(h => h !== ADMIN_HANDLE);
    const results = { synced: 0, skipped: 0, errors: [] };

    for (const handle of regularUsers) {
        if (config.optedOut[handle]) { results.skipped++; continue; }
        const userDirs = getUserDirectories(handle);

        // Lorebooks: smart merge preserves user's per-entry disable states
        for (const [filename, enabled] of Object.entries(config.lorebooks)) {
            if (!enabled) continue;
            const src = path.join(adminDirs.worlds, filename);
            const dest = path.join(userDirs.worlds, filename);
            try {
                if (syncLorebookFile(src, dest, userDirs.worlds)) results.synced++;
            } catch (err) {
                results.errors.push(`${handle}/${filename}: ${err.message}`);
            }
        }

        // Presets — all three types, smart merge preserves chain-icon disabled states
        for (const [presetType, files] of Object.entries(config.presets || {})) {
            const dirKey = PRESET_DIRS[presetType];
            if (!dirKey) continue;
            for (const [filename, enabled] of Object.entries(files || {})) {
                if (!enabled) continue;
                const src = path.join(adminDirs[dirKey], filename);
                const dest = path.join(userDirs[dirKey], filename);
                try {
                    if (syncPresetFile(src, dest, userDirs[dirKey])) results.synced++;
                } catch (err) {
                    results.errors.push(`${handle}/${presetType}/${filename}: ${err.message}`);
                }
            }
        }
    }
    return results;
}

// GET /api/sync-manager/status
// Returns config, available files per type, user list, and live sync counts
router.get('/status', requireAdminMiddleware, async (_req, res) => {
    try {
        const config = readConfig();
        const adminDirs = getUserDirectories(ADMIN_HANDLE);
        const allHandles = await getAllUserHandles();
        const regularUsers = allHandles.filter(h => h !== ADMIN_HANDLE).sort((a, b) => a.localeCompare(b));

        const availableLorebooks = listJsonFiles(adminDirs.worlds);
        const availablePresets = {
            openAI:  listJsonFiles(adminDirs.openAI_Settings),
            textGen: listJsonFiles(adminDirs.textGen_Settings),
            novelAI: listJsonFiles(adminDirs.novelAI_Settings),
        };

        // Count how many regular users currently have each file on disk
        const lbCounts = {};
        const presetCounts = { openAI: {}, textGen: {}, novelAI: {} };
        for (const handle of regularUsers) {
            const userDirs = getUserDirectories(handle);
            for (const f of availableLorebooks) {
                if (fs.existsSync(path.join(userDirs.worlds, f))) {
                    lbCounts[f] = (lbCounts[f] || 0) + 1;
                }
            }
            for (const [key, dirKey] of Object.entries(PRESET_DIRS)) {
                for (const f of (availablePresets[key] || [])) {
                    if (fs.existsSync(path.join(userDirs[dirKey], f))) {
                        presetCounts[key][f] = (presetCounts[key][f] || 0) + 1;
                    }
                }
            }
        }

        res.json({
            config,
            availableLorebooks,
            availablePresets,
            regularUsers,
            userCount: regularUsers.length,
            lbCounts,
            presetCounts,
        });
    } catch (err) {
        console.error('[SyncManager] status error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sync-manager/config
// Save updated config (lorebooks, presets, optedOut)
router.post('/config', requireAdminMiddleware, (req, res) => {
    try {
        const current = readConfig();
        const updated = {
            ...current,
            lorebooks: req.body.lorebooks ?? current.lorebooks,
            presets:   req.body.presets   ?? current.presets,
            optedOut:  req.body.optedOut  ?? current.optedOut,
        };
        writeConfig(updated);
        res.json({ success: true });
    } catch (err) {
        console.error('[SyncManager] config save error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sync-manager/sync-all
// Immediately re-push all enabled files to all non-opted-out users
router.post('/sync-all', requireAdminMiddleware, async (_req, res) => {
    try {
        const config = readConfig();
        const results = await syncFiles(config);
        config.lastSyncedAt = new Date().toISOString();
        writeConfig(config);
        console.log(`[SyncManager] Sync complete: ${results.synced} files synced, ${results.skipped} users skipped`);
        res.json({ success: true, ...results });
    } catch (err) {
        console.error('[SyncManager] sync-all error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sync-manager/unsync
// Disables a file in config and deletes it from all users' directories
router.post('/unsync', requireAdminMiddleware, async (req, res) => {
    try {
        const { type, filename, presetType } = req.body;
        if (!filename) return res.status(400).json({ error: 'filename required' });

        const config = readConfig();
        const allHandles = await getAllUserHandles();
        const regularUsers = allHandles.filter(h => h !== ADMIN_HANDLE);
        let removed = 0;

        if (type === 'lorebook') {
            config.lorebooks[filename] = false;
            for (const handle of regularUsers) {
                const dest = path.join(getUserDirectories(handle).worlds, filename);
                try { if (fs.existsSync(dest)) { fs.unlinkSync(dest); removed++; } } catch {}
            }
        } else if (type === 'preset') {
            const dirKey = PRESET_DIRS[presetType];
            if (!dirKey) return res.status(400).json({ error: 'invalid presetType' });
            config.presets[presetType] = config.presets[presetType] || {};
            config.presets[presetType][filename] = false;
            for (const handle of regularUsers) {
                const dest = path.join(getUserDirectories(handle)[dirKey], filename);
                try { if (fs.existsSync(dest)) { fs.unlinkSync(dest); removed++; } } catch {}
            }
        } else {
            return res.status(400).json({ error: 'invalid type' });
        }

        writeConfig(config);
        console.log(`[SyncManager] Unsynced ${filename} (${type}) — removed from ${removed} user(s)`);
        res.json({ success: true, removed });
    } catch (err) {
        console.error('[SyncManager] unsync error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Sync enabled files to a single user on login.
 * Skips if the user is the admin or has opted out.
 * Safe to call fire-and-forget — errors are caught internally.
 * @param {string} handle - The handle of the user who just logged in
 */
export async function syncOnLogin(handle) {
    try {
        const config = readConfig();

        // Don't sync to the admin account itself
        if (handle === ADMIN_HANDLE) return;

        // Respect master opt-out
        if (config.optedOut[handle]) {
            console.info(`[SyncManager] Skipping login sync for ${handle} (opted out)`);
            return;
        }

        const adminDirs = getUserDirectories(ADMIN_HANDLE);
        const userDirs = getUserDirectories(handle);
        let count = 0;

        for (const [filename, enabled] of Object.entries(config.lorebooks)) {
            if (!enabled) continue;
            const src = path.join(adminDirs.worlds, filename);
            const dest = path.join(userDirs.worlds, filename);
            try {
                if (syncLorebookFile(src, dest, userDirs.worlds)) count++;
            } catch (err) {
                console.error(`[SyncManager] Failed to sync lorebook ${filename} to ${handle}:`, err.message);
            }
        }

        for (const [presetType, files] of Object.entries(config.presets || {})) {
            const dirKey = PRESET_DIRS[presetType];
            if (!dirKey) continue;
            for (const [filename, enabled] of Object.entries(files || {})) {
                if (!enabled) continue;
                const src = path.join(adminDirs[dirKey], filename);
                const dest = path.join(userDirs[dirKey], filename);
                try {
                    if (syncPresetFile(src, dest, userDirs[dirKey])) count++;
                } catch (err) {
                    console.error(`[SyncManager] Failed to sync ${presetType} preset ${filename} to ${handle}:`, err.message);
                }
            }
        }

        if (count > 0) {
            console.info(`[SyncManager] Synced ${count} file(s) to ${handle} on login`);
        }
    } catch (err) {
        console.error(`[SyncManager] Login sync failed for ${handle}:`, err.message);
    }
}
