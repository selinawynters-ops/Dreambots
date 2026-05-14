/*
 * ============================================================================
 * DREAMTAVERN CUSTOMIZATION - World Info Push System
 * ============================================================================
 * 
 * MODIFICATIONS FROM DEFAULT SILLYTAVERN:
 * 
 * 1. LOREBOOK PUSH/SHARE SYSTEM:
 *    - Allows admin users to push (share) lorebooks to specific users or all users
 *    - Tracks pushed lorebooks via push-manifest.json in each user's data folder
 *    - Pushed lorebooks are automatically synced when the creator makes edits
 *    - Recipients see pushed lorebooks as character-seeded (locked from editing)
 * 
 * 2. PUSH MANIFEST TRACKING:
 *    - readPushManifest() - Read which lorebooks were pushed to whom
 *    - writePushManifest() - Save push tracking data
 *    - mergePushRecord() - Update manifest when new pushes occur
 * 
 * 3. NEW ENDPOINTS:
 *    - POST /api/worldinfo/push - Push a lorebook to selected users
 *    - GET /api/worldinfo/find-characters - Find characters using a specific lorebook
 *    - Auto-embed pushed lorebooks in character cards for recipients
 * 
 * 4. AUTOMATIC SYNC:
 *    - When creator edits a pushed lorebook, changes propagate to all recipients
 *    - Recipients cannot edit pushed lorebooks (displayed as character-embedded)
 * 
 * RELATED FILES:
 *    - src/endpoints/characters.js (character protection system)
 *    - public/scripts/world-info.js (frontend push UI, admin checks)
 *    - public/index.html (push/share buttons in world info panel)
 * 
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { tryParse, getConfigValue, humanizedDateTime } from '../util.js';
import { getAllUserHandles, getUserDirectories, getAllUsers, getUserAvatar } from '../users.js';
import { DEFAULT_USER } from '../constants.js';
import { findCharactersByWorld } from './characters.js';
import { read as readCharacterCard, write as writeCharacterCard } from '../character-card-parser.js';

// ────────────────────────────────────────────────────────
// Push manifest – tracks which files were pushed to whom
// so edits can be synced back automatically.
// Stored at  data/{handle}/push-manifest.json
// ────────────────────────────────────────────────────────

/**
 * Returns the path to a user's push manifest file.
 * @param {string} handle User handle
 * @returns {string}
 */
function getPushManifestPath(handle) {
    const dirs = getUserDirectories(handle);
    // dirs.root is  data/{handle}  — go one level up from any sub-dir
    return path.join(path.dirname(dirs.worlds), 'push-manifest.json');
}

/**
 * Read the push manifest for a creator. Returns [] if missing/corrupt.
 * @param {string} handle Creator handle
 * @returns {Array<{source_lorebook:string, pushed_lorebook_name:string, character_files:string[], recipients:string[], lorebook_bundle?:Array}>}
 */
export function readPushManifest(handle) {
    try {
        const p = getPushManifestPath(handle);
        if (!fs.existsSync(p)) return [];
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return [];
    }
}

/**
 * Write the push manifest for a creator.
 * @param {string} handle Creator handle
 * @param {Array} records Manifest records
 */
function writePushManifest(handle, records) {
    const p = getPushManifestPath(handle);
    writeFileAtomicSync(p, JSON.stringify(records, null, 2));
}

/**
 * Merge a new push into the manifest.
 * If a record with the same pushed_lorebook_name already exists, its
 * recipients list is extended (de-duped).  Otherwise a new entry is added.
 * @param {string} creatorHandle
 * @param {{source_lorebook:string, pushed_lorebook_name:string, character_files:string[], recipients:string[], lorebook_bundle?:Array}} record
 */
function recordPush(creatorHandle, record) {
    if (!record.recipients || record.recipients.length === 0) return;
    const manifest = readPushManifest(creatorHandle);
    const normalizedBundle = getStoredLorebookBundle(record);
    const primaryBundleEntry = normalizedBundle.find(entry => entry.role === 'primary') || normalizedBundle[0];
    if (!primaryBundleEntry) return;

    const normalizedRecord = {
        ...record,
        source_lorebook: primaryBundleEntry.source_lorebook_name,
        pushed_lorebook_name: primaryBundleEntry.pushed_lorebook_name,
        lorebook_bundle: normalizedBundle,
    };
    const targetKey = getManifestRecordKey(normalizedRecord);
    const existing = manifest.find(r => getManifestRecordKey(r) === targetKey);
    if (existing) {
        const set = new Set(existing.recipients);
        for (const h of normalizedRecord.recipients) set.add(h);
        existing.recipients = [...set];
        // Also merge any new character files
        const charSet = new Set(existing.character_files);
        for (const f of (normalizedRecord.character_files || [])) charSet.add(f);
        existing.character_files = [...charSet];
        existing.source_lorebook = normalizedRecord.source_lorebook;
        existing.pushed_lorebook_name = normalizedRecord.pushed_lorebook_name;
        existing.lorebook_bundle = normalizedRecord.lorebook_bundle;
    } else {
        manifest.push(normalizedRecord);
    }
    writePushManifest(creatorHandle, manifest);
}

/**
 * Rename a lorebook file to match the pushed naming convention.
 * This is CRITICAL for the hidden lorebook system to work correctly.
 * Naming convention:
 *   ADMIN-{name}       = Admin direct push (hidden from users)
 *   dd-{handle}-{name} = User submission (only creator sees)
 *   No prefix          = Regular book (visible to all)
 * @param {string} dirPath - Directory containing the lorebook file
 * @param {string} currentName - Current filename (without .json)
 * @param {string} newName - New pushed name (without .json)
 * @returns {boolean} True if renamed (or no rename needed), false if failed
 */
function renameLoreBookIfNeeded(dirPath, currentName, newName) {
    if (currentName === newName) {
        console.log(`[Push] Lorebook name unchanged: "${currentName}"`);
        return true;
    }

    const sourcePath = path.join(dirPath, sanitize(`${currentName}.json`));
    if (!fs.existsSync(sourcePath)) {
        console.warn(`[Push] Source lorebook not found for rename: ${sourcePath}`);
        return false;
    }

    try {
        const newPath = path.join(dirPath, sanitize(`${newName}.json`));
        fs.renameSync(sourcePath, newPath);
        console.log(`[Push] Renamed lorebook: "${currentName}" → "${newName}"`);
        return true;
    } catch (err) {
        console.error(`[Push] Failed to rename lorebook:`, err.message);
        return false;
    }
}

/**
 * Write a push notification file for a recipient user.
 * The client polls /api/worldinfo/push-notifications to pick these up.
 * @param {string} handle Recipient user handle
 * @param {string} message Notification message
 */
function writePushNotification(handle, message) {
    try {
        const userDirs = getUserDirectories(handle);
        const notifDir = path.join(path.dirname(userDirs.worlds), 'push-notifications');
        if (!fs.existsSync(notifDir)) fs.mkdirSync(notifDir, { recursive: true });
        const notifFile = path.join(notifDir, `${Date.now()}.json`);
        writeFileAtomicSync(notifFile, JSON.stringify({ message, ts: Date.now() }));
    } catch (err) {
        console.warn(`[Push] Failed to write notification for ${handle}:`, err.message);
    }
}

function getPendingPushesPath(handle) {
    const dirs = getUserDirectories(handle);
    return path.join(path.dirname(dirs.worlds), 'pending-pushes.json');
}

function readPendingPushes(handle) {
    try {
        const p = getPendingPushesPath(handle);
        if (!fs.existsSync(p)) return [];
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writePendingPushes(handle, items) {
    const p = getPendingPushesPath(handle);
    writeFileAtomicSync(p, JSON.stringify(items, null, 2));
}

function getUserInboxPath(handle) {
    const dirs = getUserDirectories(handle);
    return path.join(path.dirname(dirs.worlds), 'user-inbox.json');
}

function readUserInbox(handle) {
    try {
        const p = getUserInboxPath(handle);
        if (!fs.existsSync(p)) return [];
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeUserInbox(handle, items) {
    const p = getUserInboxPath(handle);
    writeFileAtomicSync(p, JSON.stringify(items, null, 2));
}

function normalizeInboxPriority(priority) {
    return ['low', 'normal', 'high'].includes(priority) ? priority : 'normal';
}

function appendUserInbox(handle, item) {
    const current = readUserInbox(handle);
    const record = {
        inbox_id: makeId('inbox'),
        type: item.type || 'system',
        title: String(item.title || ''),
        body: String(item.body || ''),
        priority: normalizeInboxPriority(item.priority || 'normal'),
        from_handle: item.from_handle || null,
        from_name: item.from_name || item.from_handle || 'System',
        created_at: Date.now(),
        read_at: null,
        status: item.status || null,
        context: item.context && typeof item.context === 'object' ? item.context : null,
    };
    current.push(record);
    writeUserInbox(handle, current);
    return record;
}

function summarizeUserInbox(items) {
    const total = items.length;
    const unread_count = items.filter(x => !x.read_at).length;
    return { total, unread_count };
}


const ADMIN_SUBMISSIONS_PATH = path.join(process.cwd(), 'data', 'admin-submissions.json');
const ADMIN_NOTES_PATH = path.join(process.cwd(), 'data', 'admin-notes.json');
// Stable directory where character PNG snapshots are stored at submission time.
// Keyed by submitter handle so the file can be found from handle+filename alone.
const SUBMISSION_THUMBS_DIR = path.join(process.cwd(), 'data', '_submissions', 'thumbs');
const TRUE_ADMIN_HANDLE = DEFAULT_USER.handle;

function isTrueAdminHandle(handle) {
    return normalizeHandle(handle) === normalizeHandle(TRUE_ADMIN_HANDLE);
}

function isAdminLorebookName(name) {
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

function isAllowedReservedLorebookName(name) {
    const value = String(name || '').trim();
    if (!value) return false;
    if (value.startsWith('dd-')) return /^dd-[a-z0-9._-]+-.+/u.test(value);
    if (/^admin/iu.test(value)) return isAdminLorebookName(value);
    return !/^dd-/iu.test(value) && !/^admin/iu.test(value);
}

function getLorebookNameValidationError(name) {
    const value = String(name || '').trim();
    if (!value) {
        return 'Lorebook name cannot be empty.';
    }
    if (isAllowedReservedLorebookName(value)) {
        return '';
    }

    if (/^dd-/iu.test(value) || /^admin/iu.test(value)) {
        return 'Invalid lorebook name. Allowed prefixes are plain names, dd-{user-handle}-{BookName}, ADMIN-{BookName}, or ADMIN{user-handle}-{BookName}. Rename it before submitting or pushing.';
    }

    return '';
}

function getSubmissionLorebookNameValidationError(name, submitterHandle, isAdminSubmitter) {
    const value = String(name || '').trim();
    const genericError = getLorebookNameValidationError(value);
    if (genericError) return genericError;
    if (!value) return '';

    const normalizedSubmitterHandle = normalizeHandle(submitterHandle);
    if (value.startsWith('dd-') && !isAdminSubmitter) {
        if (!normalizedSubmitterHandle || !value.startsWith(`dd-${normalizedSubmitterHandle}-`)) {
            return `Your lorebook name must use your own dd-${normalizedSubmitterHandle || '{user-handle}'}- prefix or stay plain before submission.`;
        }
    }

    if (isAdminLorebookName(value)) {
        if (!isAdminSubmitter) {
            return 'Only admins can submit lorebooks with ADMIN prefixes.';
        }
        if (!isTrueAdminHandle(normalizedSubmitterHandle)) {
            const expectedPrefix = `ADMIN${normalizedSubmitterHandle}-`;
            if (!value.startsWith(expectedPrefix)) {
                return `Admin submissions to the true admin must use the ${expectedPrefix}{BookName} naming convention.`;
            }
        }
    }

    return '';
}

function buildAdminLorebookName(baseName, submitterHandle = '') {
    const cleanBaseName = stripAdminLorebookPrefix(baseName);
    const cleanSubmitterHandle = normalizeHandle(submitterHandle);
    if (!cleanBaseName) return '';
    if (!cleanSubmitterHandle || isTrueAdminHandle(cleanSubmitterHandle)) {
        return `ADMIN-${cleanBaseName}`;
    }
    return `ADMIN${cleanSubmitterHandle}-${cleanBaseName}`;
}

function getSubmissionDistributionLorebookName(displayName, submitterHandle, isAdminSubmitter) {
    const sourceName = String(displayName || '').trim();
    const handle = normalizeHandle(submitterHandle);
    if (!sourceName) return '';
    if (sourceName.startsWith('dd-')) return sourceName;
    if (isAdminLorebookName(sourceName)) {
        return isAdminSubmitter && !isTrueAdminHandle(handle)
            ? buildAdminLorebookName(stripAdminLorebookPrefix(sourceName), handle)
            : sourceName;
    }
    if (isAdminSubmitter) {
        return buildAdminLorebookName(sourceName, handle);
    }
    return handle ? `dd-${handle}-${sourceName}` : sourceName;
}

function getSubmissionTargetAdminHandle(submitterHandle, isAdminSubmitter) {
    if (isAdminSubmitter && isTrueAdminHandle(submitterHandle)) {
        return normalizeHandle(submitterHandle);
    }
    return TRUE_ADMIN_HANDLE;
}

function canAdminAccessSubmission(submission, adminHandle) {
    const targetAdminHandle = normalizeHandle(submission?.target_admin_handle);
    if (!targetAdminHandle) return true;
    return targetAdminHandle === normalizeHandle(adminHandle);
}

function getVisibleAdminSubmissions(adminHandle) {
    return readAdminSubmissions().filter(item => canAdminAccessSubmission(item, adminHandle));
}

function readAdminSubmissions() {
    try {
        if (!fs.existsSync(ADMIN_SUBMISSIONS_PATH)) return [];
        const parsed = JSON.parse(fs.readFileSync(ADMIN_SUBMISSIONS_PATH, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeAdminSubmissions(items) {
    writeFileAtomicSync(ADMIN_SUBMISSIONS_PATH, JSON.stringify(items, null, 2));
}

function readAdminNotes() {
    try {
        if (!fs.existsSync(ADMIN_NOTES_PATH)) return [];
        const parsed = JSON.parse(fs.readFileSync(ADMIN_NOTES_PATH, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeAdminNotes(items) {
    writeFileAtomicSync(ADMIN_NOTES_PATH, JSON.stringify(items, null, 2));
}

function appendAdminNote(noteData) {
    const notes = readAdminNotes();
    const noteId = makeId('admin_note');
    const note = {
        note_id: noteId,
        created_at: Date.now(),
        read_at: null,
        status: 'pending',
        ...noteData,
    };
    notes.push(note);
    writeAdminNotes(notes);
    return note;
}

function summarizeAdminNotes(items) {
    const total = items.length;
    const unread_count = items.filter(x => !x.read_at).length;
    const pending_count = items.filter(x => String(x.status || 'pending') === 'pending').length;
    return { total, unread_count, pending_count };
}

function normalizeAdminInboxItem(item) {
    if (item?.inbox_item_type === 'admin_note') {
        return {
            ...item,
            priority: item.priority || 'normal',
            item_id: item.note_id,
            preview_text: item.message || '',
        };
    }
    return {
        ...item,
        inbox_item_type: item.inbox_item_type || 'submission',
        item_id: item.submission_id,
        preview_text: item.notes || '',
    };
}

function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeTargets(targets, selfHandle, allHandles) {
    if (targets === 'all') {
        return allHandles.filter(h => h !== selfHandle);
    }
    if (Array.isArray(targets)) {
        return [...new Set(targets.filter(h => h && h !== selfHandle))];
    }
    return null;
}

function isPendingStatus(status) {
    return String(status || '').toLowerCase() === 'pending';
}

function isUnreadFlag(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeHandle(value) {
    return String(value || '').trim().toLowerCase();
}

function isTrueishFlag(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function getPushExtensionBySuffix(extensions, suffix) {
    if (!extensions || typeof extensions !== 'object') return undefined;
    const exact = extensions[NS(suffix)];
    if (exact !== undefined) return exact;
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

export function isLorebookHidden(fileName, extensions) {
    const normalizedName = String(fileName || '').trim();
    const hiddenFlag = isTrueishFlag(getPushExtensionBySuffix(extensions, 'hidden'));
    if (hiddenFlag) return true;
    if (isAdminLorebookName(normalizedName)) return true;
    if (normalizedName.startsWith('dd-')) return true;
    return false;
}

export function canUserAccessHiddenLorebook(fileName, extensions, userProfile, allHandles = []) {
    if (userProfile?.admin) return true;
    const userHandle = normalizeHandle(userProfile?.handle);
    if (!userHandle) return false;

    const creator = normalizeHandle(getPushExtensionBySuffix(extensions, 'creator'));
    const originalCreator = normalizeHandle(getPushExtensionBySuffix(extensions, 'original_creator') || creator);
    if (creator && creator === userHandle) return true;
    if (originalCreator && originalCreator === userHandle) return true;

    const ddCreator = normalizeHandle(findCreatorFromDdName(fileName, allHandles));
    if (ddCreator && ddCreator === userHandle) return true;

    return false;
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
        const charPath = path.join(directories.characters, file);
        try {
            const png = fs.readFileSync(charPath);
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
        } catch {
            // Ignore malformed cards for visibility inference.
        }
    }

    return ownership;
}

function normalizeCreatorHandle(primary, fallback = '') {
    return String(primary || fallback || '').trim();
}

function getLorebookBaseNameForDistribution(lorebookName, creatorHandle = '') {
    const normalizedName = String(lorebookName || '').trim();
    const normalizedCreator = normalizeCreatorHandle(creatorHandle);
    if (!normalizedName) return '';
    if (isAdminLorebookName(normalizedName)) return stripAdminLorebookPrefix(normalizedName);
    if (normalizedCreator && normalizedName.startsWith(`dd-${normalizedCreator}-`)) {
        return normalizedName.substring(`dd-${normalizedCreator}-`.length).trim();
    }
    return normalizedName;
}

function getQueuedLorebookNameForRecipient({
    sourceLorebookName,
    fallbackLabel = '',
    isAdminPush = false,
    recipientHandle = '',
    originalCreatorHandle = '',
    pusherHandle = '',
    preserveOriginalName = false,
}) {
    const sourceName = String(sourceLorebookName || '').trim();
    const label = String(fallbackLabel || '').trim();
    if (!isAdminPush) return sourceName || label;
    if (preserveOriginalName) return sourceName || label;

    // User-submitted lorebooks keep their dd-{creator}-* identity even when
    // an admin redistributes them to other users.
    if (sourceName.startsWith('dd-')) {
        return sourceName || label;
    }
    if (isAdminLorebookName(sourceName)) {
        return sourceName;
    }

    const recipient = normalizeCreatorHandle(recipientHandle);
    const originalCreator = normalizeCreatorHandle(originalCreatorHandle);
    const pusher = normalizeCreatorHandle(pusherHandle);
    if (recipient && pusher && recipient === pusher) {
        return sourceName || label;
    }
    if (recipient && originalCreator && recipient === originalCreator) {
        return sourceName || label;
    }

    const baseName = label || getLorebookBaseNameForDistribution(sourceName, originalCreator);
    return buildAdminLorebookName(baseName, pusher);
}

function getUserDistributedLorebookName(sourceLorebookName, fallbackLabel = '', creatorHandle = '') {
    const sourceName = String(sourceLorebookName || '').trim();
    const label = String(fallbackLabel || '').trim();
    const creator = normalizeCreatorHandle(creatorHandle);
    if (!sourceName && !label) return '';
    if (sourceName.startsWith('dd-')) return sourceName;

    const baseName = label || sourceName;
    return creator ? `dd-${creator}-${baseName}` : baseName;
}

function normalizeLorebookNameList(values = []) {
    const names = [];
    const seen = new Set();

    for (const value of values) {
        const name = String(value || '').trim();
        if (!name) continue;

        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }

    return names;
}

function normalizeLorebookBundleEntries(entries = []) {
    const normalized = [];
    const seen = new Set();

    for (const entry of entries) {
        const sourceLorebookName = String(entry?.source_lorebook_name || '').trim();
        const pushedLorebookName = String(entry?.pushed_lorebook_name || '').trim();
        const fallbackLabel = String(entry?.fallback_label || '').trim();
        if (!sourceLorebookName && !pushedLorebookName) continue;

        const effectiveSourceLorebookName = sourceLorebookName || pushedLorebookName;
        const effectivePushedLorebookName = pushedLorebookName || sourceLorebookName;
        const dedupeKey = String(effectivePushedLorebookName || effectiveSourceLorebookName).trim().toLowerCase();
        if (!dedupeKey || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const rawRole = String(entry?.role || '').trim().toLowerCase();
        normalized.push({
            role: rawRole === 'secondary' ? 'secondary' : 'primary',
            source_lorebook_name: effectiveSourceLorebookName,
            pushed_lorebook_name: effectivePushedLorebookName,
            fallback_label: fallbackLabel,
        });
    }

    let primaryFound = false;
    for (const entry of normalized) {
        if (entry.role === 'primary' && !primaryFound) {
            primaryFound = true;
            continue;
        }
        entry.role = 'secondary';
    }

    if (!primaryFound && normalized.length > 0) {
        normalized[0].role = 'primary';
    }

    return normalized;
}

function getLegacySecondaryLorebookNames(item) {
    return normalizeLorebookNameList([
        item?.secondary_lorebook_name,
        item?.secondary_lorebook,
        ...(Array.isArray(item?.secondary_lorebooks) ? item.secondary_lorebooks : []),
    ]);
}

function getStoredLorebookBundle(record) {
    const explicitBundle = normalizeLorebookBundleEntries(Array.isArray(record?.lorebook_bundle) ? record.lorebook_bundle : []);
    if (explicitBundle.length > 0) {
        return explicitBundle;
    }

    const sourceLorebookName = String(record?.source_lorebook || record?.source_lorebook_name || '').trim();
    const pushedLorebookName = String(record?.pushed_lorebook_name || '').trim() || sourceLorebookName;
    if (!sourceLorebookName && !pushedLorebookName) return [];

    return normalizeLorebookBundleEntries([{
        role: 'primary',
        source_lorebook_name: sourceLorebookName || pushedLorebookName,
        pushed_lorebook_name: pushedLorebookName || sourceLorebookName,
    }]);
}

function getManifestRecordKey(record) {
    const bundleKey = getStoredLorebookBundle(record)
        .map(entry => `${entry.role}:${entry.source_lorebook_name}->${entry.pushed_lorebook_name}`)
        .join('|');
    const characterKey = normalizeLorebookNameList(Array.isArray(record?.character_files) ? record.character_files : [])
        .sort((a, b) => a.localeCompare(b))
        .join('|');

    return `${bundleKey}::${characterKey}`;
}

function buildSubmissionLorebookBundle({
    primarySourceLorebookName,
    primaryPushedLorebookName,
    secondarySourceLorebooks = [],
    creatorHandle = '',
    isAdminSubmission = false,
}) {
    const primarySource = String(primarySourceLorebookName || '').trim();
    const primaryPushed = String(primaryPushedLorebookName || '').trim() || primarySource;
    const bundle = [];

    if (primarySource || primaryPushed) {
        bundle.push({
            role: 'primary',
            source_lorebook_name: primarySource || primaryPushed,
            pushed_lorebook_name: primaryPushed || primarySource,
            fallback_label: primaryPushed || primarySource,
        });
    }

    const secondaryLorebooks = normalizeLorebookNameList(secondarySourceLorebooks)
        .filter(name => name.toLowerCase() !== primarySource.toLowerCase())
        .filter(name => name.toLowerCase() !== primaryPushed.toLowerCase());

    for (const secondarySourceLorebookName of secondaryLorebooks) {
        bundle.push({
            role: 'secondary',
            source_lorebook_name: secondarySourceLorebookName,
            pushed_lorebook_name: isAdminSubmission
                ? secondarySourceLorebookName
                : getUserDistributedLorebookName(secondarySourceLorebookName, secondarySourceLorebookName, creatorHandle),
            fallback_label: secondarySourceLorebookName,
        });
    }

    return normalizeLorebookBundleEntries(bundle);
}

function getRecipientChatName(existingData = null, sourceData = null) {
    const existingChat = String(existingData?.chat || '').trim();
    if (existingChat) return existingChat;

    const sourceName = String(sourceData?.name || existingData?.name || 'Character').trim() || 'Character';
    return `${sourceName} - ${humanizedDateTime()}`;
}

/**
 * Fallback resolver: find a character PNG file by display name.
 * Used when world-binding lookup returns no character files.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} characterLabel
 * @returns {string[]} matching PNG filenames
 */
function findCharacterFilesByName(directories, characterLabel) {
    const wanted = String(characterLabel || '').trim().toLowerCase();
    if (!wanted) return [];
    const charDir = directories.characters;
    if (!fs.existsSync(charDir)) return [];

    const matches = [];
    const pngFiles = fs.readdirSync(charDir).filter(f => f.toLowerCase().endsWith('.png'));
    for (const file of pngFiles) {
        const charPath = path.join(charDir, file);
        try {
            const pngBuffer = fs.readFileSync(charPath);
            const raw = readCharacterCard(pngBuffer);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            const name = String(parsed?.name || parsed?.data?.name || '').trim().toLowerCase();
            if (name && name === wanted) {
                matches.push(file);
            }
        } catch {
            // skip unreadable character cards
        }
    }
    return matches;
}

function findCreatorFromCharacterFiles(directories, characterFiles) {
    for (const charFile of characterFiles || []) {
        const charPath = path.join(directories.characters, charFile);
        if (!fs.existsSync(charPath)) continue;
        try {
            const pngBuffer = fs.readFileSync(charPath);
            const raw = readCharacterCard(pngBuffer);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            const creator = String(
                parsed?.data?.extensions?.[NS('original_creator')]
                || parsed?.data?.extensions?.[NS('creator')]
                || '',
            ).trim();
            if (creator) return creator;
        } catch {
            // skip unreadable cards
        }
    }
    return '';
}

function findCharacterNameFromFiles(directories, characterFiles, fallback = '') {
    for (const charFile of characterFiles || []) {
        const charPath = path.join(directories.characters, charFile);
        if (!fs.existsSync(charPath)) continue;
        try {
            const pngBuffer = fs.readFileSync(charPath);
            const raw = readCharacterCard(pngBuffer);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            const name = String(parsed?.name || parsed?.data?.name || '').trim();
            if (name) return name;
        } catch {
            // skip unreadable cards
        }
    }
    return String(fallback || '').trim();
}

/**
 * Renames a source lorebook file and updates linked character card world bindings.
 * Used by user submission flow when submitter renames before sending to admin.
 * @param {import('express').Request} request
 * @param {string} fromLorebookName
 * @param {string} toLorebookName
 * @param {string} characterLabel
 * @returns {Promise<{ok:boolean,status?:number,reason?:string,renamed:boolean,source_lorebook_name:string,updated_characters:string[]}>}
 */
async function renameLorebookForSubmission(request, fromLorebookName, toLorebookName, characterLabel = '') {
    const fromName = String(fromLorebookName || '').trim();
    const toName = String(toLorebookName || '').trim();

    if (!fromName || !toName || fromName === toName) {
        return {
            ok: true,
            renamed: false,
            source_lorebook_name: fromName || toName,
            updated_characters: [],
        };
    }

    const sourcePath = path.join(request.user.directories.worlds, sanitize(`${fromName}.json`));
    const destPath = path.join(request.user.directories.worlds, sanitize(`${toName}.json`));

    if (!sourcePath || !destPath || sourcePath === destPath) {
        return {
            ok: false,
            status: 400,
            reason: `Lorebook rename "${fromName}" -> "${toName}" is invalid for this filesystem.`,
            renamed: false,
            source_lorebook_name: fromName,
            updated_characters: [],
        };
    }

    if (!fs.existsSync(sourcePath)) {
        if (fs.existsSync(destPath)) {
            return {
                ok: true,
                renamed: false,
                source_lorebook_name: toName,
                updated_characters: [],
            };
        }
        return {
            ok: false,
            status: 404,
            reason: `Source lorebook "${fromName}" not found.`,
            renamed: false,
            source_lorebook_name: fromName,
            updated_characters: [],
        };
    }

    if (fs.existsSync(destPath)) {
        return {
            ok: false,
            status: 409,
            reason: `Lorebook "${toName}" already exists.`,
            renamed: false,
            source_lorebook_name: fromName,
            updated_characters: [],
        };
    }

    const lock = checkLock(sourcePath, request.user.profile);
    if (lock.locked) {
        return {
            ok: false,
            status: 403,
            reason: lock.reason || 'Source lorebook is locked.',
            renamed: false,
            source_lorebook_name: fromName,
            updated_characters: [],
        };
    }

    fs.renameSync(sourcePath, destPath);

    let linkedCharacterFiles = await findCharactersByWorld(request.user.directories, fromName);
    if (linkedCharacterFiles.length === 0 && characterLabel) {
        const byName = findCharacterFilesByName(request.user.directories, characterLabel);
        for (const f of byName) {
            if (!linkedCharacterFiles.includes(f)) linkedCharacterFiles.push(f);
        }
    }

    const updatedCharacters = [];
    for (const charFile of linkedCharacterFiles) {
        const charPath = path.join(request.user.directories.characters, charFile);
        if (!fs.existsSync(charPath)) continue;
        try {
            const pngBuffer = fs.readFileSync(charPath);
            const raw = readCharacterCard(pngBuffer);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            if (!parsed.data) parsed.data = {};
            if (!parsed.data.extensions) parsed.data.extensions = {};
            parsed.data.extensions.world = toName;
            const rewritten = writeCharacterCard(pngBuffer, JSON.stringify(parsed));
            fs.writeFileSync(charPath, rewritten);
            updatedCharacters.push(charFile);
        } catch (err) {
            console.warn(`[SubmitRename] Failed to rebind character ${charFile}:`, err.message);
        }
    }

    return {
        ok: true,
        renamed: true,
        source_lorebook_name: toName,
        updated_characters: updatedCharacters,
    };
}

function buildLorebookBundleFromItem(item, recipientHandle = '') {
    const explicitBundle = Array.isArray(item?.lorebook_bundle)
        ? item.lorebook_bundle
            .map((entry, index) => {
                const sourceLorebookName = String(entry?.source_lorebook_name || '').trim();
                const pushedLorebookName = String(entry?.pushed_lorebook_name || '').trim();
                if (!sourceLorebookName && !pushedLorebookName) return null;

                const fallbackLabel = String(
                    entry?.fallback_label
                    || item?.source_names?.character_label
                    || item?.source_names?.lorebook
                    || sourceLorebookName
                    || pushedLorebookName,
                ).trim();
                const role = String(entry?.role || (index === 0 ? 'primary' : 'secondary')).trim().toLowerCase() || (index === 0 ? 'primary' : 'secondary');
                const effectiveSourceLorebookName = sourceLorebookName || pushedLorebookName;
                const effectivePushedLorebookName = (
                    item?.pushed_by_role === 'admin'
                        ? getQueuedLorebookNameForRecipient({
                            sourceLorebookName: effectiveSourceLorebookName,
                            fallbackLabel,
                            isAdminPush: true,
                            recipientHandle,
                            originalCreatorHandle: item?.original_creator_handle || item?.effective_creator || item?.creator_handle,
                            pusherHandle: item?.pushed_by_handle || item?.creator_handle,
                            preserveOriginalName: false,
                        })
                        : pushedLorebookName
                ) || effectiveSourceLorebookName;

                return {
                    role: role === 'secondary' ? 'secondary' : 'primary',
                    source_lorebook_name: effectiveSourceLorebookName,
                    pushed_lorebook_name: effectivePushedLorebookName,
                    fallback_label: fallbackLabel,
                };
            })
            .filter(Boolean)
        : [];

    if (explicitBundle.length > 0) {
        return normalizeLorebookBundleEntries(explicitBundle);
    }

    const legacyPrimarySource = String(
        item?.primary_lorebook_name
        || item?.primary_lorebook
        || item?.source_lorebook_name
        || item?.lorebook
        || '',
    ).trim();
    const legacyPrimaryPushed = String(item?.pushed_lorebook_name || '').trim();
    if (!legacyPrimarySource && !legacyPrimaryPushed) return [];

    const fallbackLabel = String(item?.source_names?.character_label || item?.source_names?.lorebook || legacyPrimarySource || legacyPrimaryPushed).trim();
    const effectiveSourceLorebookName = legacyPrimarySource || legacyPrimaryPushed;
    const effectivePushedLorebookName = (
        item?.pushed_by_role === 'admin'
            ? getQueuedLorebookNameForRecipient({
                sourceLorebookName: effectiveSourceLorebookName,
                fallbackLabel,
                isAdminPush: true,
                recipientHandle,
                originalCreatorHandle: item?.original_creator_handle || item?.effective_creator || item?.creator_handle,
                pusherHandle: item?.pushed_by_handle || item?.creator_handle,
                preserveOriginalName: false,
            })
            : legacyPrimaryPushed
    ) || effectiveSourceLorebookName;

    const derivedBundle = [{
        role: 'primary',
        source_lorebook_name: effectiveSourceLorebookName,
        pushed_lorebook_name: effectivePushedLorebookName,
        fallback_label: fallbackLabel,
    }];

    const creatorHandle = item?.original_creator_handle || item?.effective_creator || item?.creator_handle || '';
    for (const secondarySourceLorebookName of getLegacySecondaryLorebookNames(item)) {
        if (secondarySourceLorebookName.toLowerCase() === effectiveSourceLorebookName.toLowerCase()) continue;

        const secondaryPushedLorebookName = item?.pushed_by_role === 'admin'
            ? getQueuedLorebookNameForRecipient({
                sourceLorebookName: secondarySourceLorebookName,
                fallbackLabel: secondarySourceLorebookName,
                isAdminPush: true,
                recipientHandle,
                originalCreatorHandle: creatorHandle,
                pusherHandle: item?.pushed_by_handle || item?.creator_handle,
                preserveOriginalName: false,
            })
            : getUserDistributedLorebookName(secondarySourceLorebookName, secondarySourceLorebookName, creatorHandle);

        derivedBundle.push({
            role: 'secondary',
            source_lorebook_name: secondarySourceLorebookName,
            pushed_lorebook_name: secondaryPushedLorebookName || secondarySourceLorebookName,
            fallback_label: secondarySourceLorebookName,
        });
    }

    return normalizeLorebookBundleEntries(derivedBundle);
}

function getPushConflictPaths(recipientDirs, item, lorebookBundle = []) {
    const conflicts = [];
    const bundleToCheck = Array.isArray(lorebookBundle) && lorebookBundle.length > 0
        ? lorebookBundle
        : buildLorebookBundleFromItem(item);
    for (const entry of bundleToCheck) {
        const lorebookPath = path.join(recipientDirs.worlds, sanitize(`${entry.pushed_lorebook_name}.json`));
        if (fs.existsSync(lorebookPath)) {
            conflicts.push({
                type: 'lorebook',
                path: lorebookPath,
                lorebook: entry.pushed_lorebook_name,
                role: entry.role,
            });
        }
    }

    for (const charFile of item.character_files || []) {
        const charPath = path.join(recipientDirs.characters, charFile);
        if (fs.existsSync(charPath)) conflicts.push({ type: 'character', path: charPath });
    }

    return conflicts;
}

function applyQueuedPushToRecipient(recipientHandle, item, forceOverwrite = false) {
    const sourceDirs = getUserDirectories(item.creator_handle);
    const recipientDirs = getUserDirectories(recipientHandle);
    const effectiveBundle = buildLorebookBundleFromItem(item, recipientHandle);
    const primaryBundleEntry = effectiveBundle.find(entry => entry.role === 'primary') || effectiveBundle[0];
    if (!primaryBundleEntry) {
        return { ok: false, status: 400, error: 'Push item is missing lorebook data.' };
    }

    const effectiveRecipientLorebookName = primaryBundleEntry.pushed_lorebook_name || primaryBundleEntry.source_lorebook_name;
    const effectiveItem = {
        ...item,
        source_lorebook_name: primaryBundleEntry.source_lorebook_name,
        pushed_lorebook_name: effectiveRecipientLorebookName,
        lorebook_bundle: effectiveBundle,
    };
    const primaryPushedLorebookName = effectiveItem.pushed_lorebook_name;
    const primarySourceLorebookName = primaryBundleEntry.source_lorebook_name;
    const bundledPushedLorebooks = normalizeLorebookNameList(
        effectiveBundle.map(entry => entry.pushed_lorebook_name).filter(Boolean),
    );
    const secondaryPushedLorebooks = normalizeLorebookNameList(
        effectiveBundle
            .filter(entry => entry.role === 'secondary')
            .map(entry => entry.pushed_lorebook_name)
            .filter(Boolean),
    );

    if (!fs.existsSync(recipientDirs.worlds)) fs.mkdirSync(recipientDirs.worlds, { recursive: true });
    if (!fs.existsSync(recipientDirs.characters)) fs.mkdirSync(recipientDirs.characters, { recursive: true });

    const resolvedCharacterFiles = Array.isArray(item.source_avatar_files) && item.source_avatar_files.length > 0
        ? [...item.source_avatar_files]
        : (Array.isArray(item.character_files) ? [...item.character_files] : []);
    if (resolvedCharacterFiles.length === 0) {
        const fallbackLabel = item?.source_names?.character_label || '';
        const byName = findCharacterFilesByName(sourceDirs, fallbackLabel);
        for (const f of byName) {
            if (!resolvedCharacterFiles.includes(f)) resolvedCharacterFiles.push(f);
        }
    }

    effectiveItem.character_files = resolvedCharacterFiles;
    const conflicts = getPushConflictPaths(recipientDirs, effectiveItem, effectiveBundle);
    const allowNonDestructiveAccept = !!item.is_public_announcement && !forceOverwrite;
    if (!forceOverwrite && conflicts.length > 0 && !allowNonDestructiveAccept) {
        return {
            ok: false,
            status: 409,
            conflict: true,
            reason: 'Local files already exist. Use overwrite to apply this push.',
            conflicts,
        };
    }
    const creatorStamp = normalizeCreatorHandle(item.effective_creator, item.creator_handle);
    const originalCreatorStamp = normalizeCreatorHandle(
        item.original_creator_handle || item.original_creator || item.effective_creator,
        creatorStamp,
    );
    // The true content creator — used for symlink targets and source_handle so that
    // recipients always resolve live from the original author, not from whoever pushed.
    const trueCreatorHandle = item.original_creator_handle || item.effective_creator || item.creator_handle;
    // Guard: if creatorStamp resolved to the admin/pusher (default-user) but we have a
    // separately identified original creator, tag the character with the real author.
    // Only keep default-user when default-user genuinely originated the content.
    const resolvedCreatorStamp = (
        creatorStamp === DEFAULT_USER.handle
        && originalCreatorStamp
        && originalCreatorStamp !== DEFAULT_USER.handle
    ) ? originalCreatorStamp : creatorStamp;
    const resolvedBundle = [];
    for (const bundleEntry of effectiveBundle) {
        // Try pushed name first (renamed on queue), then source name fallback.
        const attempts = [
            bundleEntry.pushed_lorebook_name,
            bundleEntry.source_lorebook_name,
        ]
            .map(value => String(value || '').trim())
            .filter(Boolean);
        let sourceLorebookPath = null;
        let resolvedSourceName = '';
        for (const attemptName of attempts) {
            const attemptPath = path.join(sourceDirs.worlds, sanitize(`${attemptName}.json`));
            if (fs.existsSync(attemptPath)) {
                sourceLorebookPath = attemptPath;
                resolvedSourceName = attemptName;
                break;
            }
        }
        if (!sourceLorebookPath) {
            console.error(`[Push] Source lorebook not found for bundle entry. Tried: ${attempts.join(', ')} (creator: ${item.creator_handle})`);
            return {
                ok: false,
                status: 404,
                error: `Source lorebook "${bundleEntry.pushed_lorebook_name}" or "${bundleEntry.source_lorebook_name}" no longer exists.`,
            };
        }

        const destLorebookPath = path.join(recipientDirs.worlds, sanitize(`${bundleEntry.pushed_lorebook_name}.json`));
        const destLorebookExists = fs.existsSync(destLorebookPath);
        if (forceOverwrite || !destLorebookExists) {
            const lorebookData = JSON.parse(fs.readFileSync(sourceLorebookPath, 'utf8'));
            lorebookData.name = bundleEntry.pushed_lorebook_name || lorebookData.name || bundleEntry.source_lorebook_name || '';
            if (!lorebookData.extensions) lorebookData.extensions = {};
            lorebookData.extensions[NS('locked')] = true;
            lorebookData.extensions[NS('hidden')] = true;
            lorebookData.extensions[NS('creator')] = resolvedCreatorStamp;
            lorebookData.extensions[NS('original_creator')] = originalCreatorStamp;
            lorebookData.extensions[NS('source_lorebook')] = bundleEntry.source_lorebook_name || '';
            lorebookData.extensions[NS('source_handle')] = trueCreatorHandle || '';
            writeFileAtomicSync(destLorebookPath, JSON.stringify(lorebookData, null, 4));
            console.log(`[Push] Lorebook written: ${destLorebookPath}`);
        } else if (allowNonDestructiveAccept) {
            try {
                const destData = JSON.parse(fs.readFileSync(destLorebookPath, 'utf8'));
                destData.name = bundleEntry.pushed_lorebook_name || destData.name || bundleEntry.source_lorebook_name || '';
                if (!destData.extensions) destData.extensions = {};
                destData.extensions[NS('locked')] = true;
                destData.extensions[NS('hidden')] = true;
                destData.extensions[NS('creator')] = resolvedCreatorStamp;
                destData.extensions[NS('original_creator')] = originalCreatorStamp;
                destData.extensions[NS('source_lorebook')] = bundleEntry.source_lorebook_name || '';
                destData.extensions[NS('source_handle')] = trueCreatorHandle || '';
                writeFileAtomicSync(destLorebookPath, JSON.stringify(destData, null, 4));
                console.log(`[Push] Lorebook relinked (non-destructive): ${destLorebookPath}`);
            } catch (err) {
                console.warn(`[Push] Failed non-destructive lorebook relink for ${destLorebookPath}:`, err.message);
            }
        }

        resolvedBundle.push({
            ...bundleEntry,
            resolved_source_lorebook_name: resolvedSourceName,
            source_path: sourceLorebookPath,
            dest_path: destLorebookPath,
        });
    }

    const appliedCharacters = [];
    for (const charFile of effectiveItem.character_files || []) {
        let srcChar = path.join(sourceDirs.characters, charFile);
        const destChar = path.join(recipientDirs.characters, charFile);
        if (!fs.existsSync(srcChar)) {
            // Fall back to the submission-time snapshot. Try the original creator's snapshot
            // first (covers bulk-push where creator_handle is default-user but the file was
            // submitted by someone else), then the direct pusher's snapshot as a secondary.
            const lookupHandles = [...new Set([trueCreatorHandle, item.creator_handle])];
            let snapshotFound = false;
            for (const h of lookupHandles) {
                const snap = path.join(SUBMISSION_THUMBS_DIR, h, charFile);
                if (fs.existsSync(snap)) {
                    console.log(`[Push] Source character missing; using submission snapshot (${h}) for ${charFile}`);
                    srcChar = snap;
                    snapshotFound = true;
                    break;
                }
            }
            if (!snapshotFound) {
                console.warn(`[Push] Source character not found, skipping: ${srcChar}`);
                continue;
            }
        }

        // Always create symlink pointer for pushed characters, regardless of announcement mode
        // For existing files in non-destructive mode, we'll update metadata below
        const charAlreadyExists = fs.existsSync(destChar);
        
        if (!charAlreadyExists || !allowNonDestructiveAccept) {
            // Write full character data with symlink metadata overlay.
            // Deep-clone the source so all fields (system_prompt, alternate_greetings,
            // character_book, depth_prompt, etc.) are preserved in the recipient's PNG.
            // Symlink resolution on read will auto-sync from master for future updates.
            try {
                // Use original snapshot if available (preserves creator's original avatar, not admin modifications)
                let sourcePngBuffer = null;
                if (item.original_avatar_snapshots && item.original_avatar_snapshots[charFile]) {
                    const snapshotBase64 = item.original_avatar_snapshots[charFile];
                    if (snapshotBase64) {
                        sourcePngBuffer = Buffer.from(snapshotBase64, 'base64');
                        console.log(`[Push] Using original snapshot for ${charFile}`);
                    }
                }
                // Fallback to current creator file if snapshot unavailable
                if (!sourcePngBuffer) {
                    sourcePngBuffer = fs.readFileSync(srcChar);
                    console.log(`[Push] Using current creator file for ${charFile} (no snapshot available)`);
                }

                const sourceDataStr = readCharacterCard(sourcePngBuffer);
                const sourceData = JSON.parse(sourceDataStr);
                const sourceExt = sourceData?.data?.extensions || {};

                // Deep clone ALL source data — no fields lost
                const pushedData = JSON.parse(JSON.stringify(sourceData));
                if (!pushedData.data) pushedData.data = {};
                if (!pushedData.data.extensions) pushedData.data.extensions = {};

                const existingData = charAlreadyExists
                    ? tryParse(readCharacterCard(fs.readFileSync(destChar)))
                    : null;

                // Override lorebook binding with the bundle primary + optional auxiliaries.
                pushedData.data.extensions.world = primaryPushedLorebookName;
                pushedData.data.extensions[NS('source_lorebook')] = primarySourceLorebookName || primaryPushedLorebookName;
                pushedData.data.extensions[NS('pushed_lorebook_name')] = primaryPushedLorebookName;
                pushedData.data.extensions[NS('bundle_lorebooks')] = bundledPushedLorebooks;
                pushedData.data.extensions[NS('aux_lorebooks')] = secondaryPushedLorebooks;
                pushedData.data.extensions[NS('source_handle')] = trueCreatorHandle || '';
                pushedData.chat = getRecipientChatName(existingData, pushedData);

                // Stamp push + symlink metadata
                // Point symlink_to at the true content creator's master file.
                // If the original creator doesn't have the file (edge case), fall back to the pusher.
                const trueCreatorDirs = getUserDirectories(trueCreatorHandle);
                const trueCharPath = path.join(trueCreatorDirs.characters, charFile);
                const pusherCharPath = path.join(sourceDirs.characters, charFile);
                // Prefer the true creator's path; fall back to the pusher's path if the creator
                // no longer has the file; last resort is the recipient (the file is being written
                // there now) so the symlink always points to a real, live location.
                const symlinkHost = fs.existsSync(trueCharPath)
                    ? trueCreatorHandle
                    : (fs.existsSync(pusherCharPath) ? item.creator_handle : recipientHandle);
                pushedData.data.extensions[NS('pushed')] = true;
                pushedData.data.extensions[NS('creator')] = resolvedCreatorStamp;
                pushedData.data.extensions[NS('original_creator')] = originalCreatorStamp;
                pushedData.data.extensions[NS('symlink_mode')] = true;
                pushedData.data.extensions[NS('symlink_to')] = `${symlinkHost}/${charFile}`;
                pushedData.data.extensions[NS('symlink_avatar')] = charFile;
                pushedData.data.extensions[NS('symlink_linked_at')] = Date.now();
                pushedData.data.extensions[NS('master_id')] = sourceExt[NS('master_id')] || null;

                const basePng = charAlreadyExists ? fs.readFileSync(destChar) : sourcePngBuffer;
                const pushedPng = writeCharacterCard(basePng, JSON.stringify(pushedData));
                fs.writeFileSync(destChar, pushedPng);
                appliedCharacters.push(charFile);
                console.log(`[Push] Character written with full data + symlink: ${destChar}`);
            } catch (err) {
                console.warn(`[Push] Character push failed for ${charFile}:`, err.message);
                if (!allowNonDestructiveAccept) {
                    throw err;
                }
            }
            continue;
        }

        if (allowNonDestructiveAccept && charAlreadyExists) {
            // Non-destructive accept (public announcement on existing file): update metadata only
            try {
                const destPngBuffer = fs.readFileSync(destChar);
                const destDataStr = readCharacterCard(destPngBuffer);
                const destData = JSON.parse(destDataStr);
                if (!destData.data) destData.data = {};
                if (!destData.data.extensions) destData.data.extensions = {};
                destData.data.extensions.world = primaryPushedLorebookName;
                destData.data.extensions[NS('source_lorebook')] = primarySourceLorebookName || primaryPushedLorebookName;
                destData.data.extensions[NS('pushed_lorebook_name')] = primaryPushedLorebookName;
                destData.data.extensions[NS('bundle_lorebooks')] = bundledPushedLorebooks;
                destData.data.extensions[NS('aux_lorebooks')] = secondaryPushedLorebooks;
                destData.data.extensions[NS('source_handle')] = trueCreatorHandle || '';
                destData.data.extensions[NS('pushed')] = true;
                destData.data.extensions[NS('creator')] = resolvedCreatorStamp;
                destData.data.extensions[NS('original_creator')] = originalCreatorStamp;
                const relinkedPng = writeCharacterCard(destPngBuffer, JSON.stringify(destData));
                fs.writeFileSync(destChar, relinkedPng);
                appliedCharacters.push(charFile);
                console.log(`[Push] Character relinked (non-destructive): ${destChar}`);
            } catch (err) {
                console.warn(`[Push] Failed non-destructive character relink for ${charFile}:`, err.message);
            }
            continue;
        }
    }

    return {
        ok: true,
        lorebook: primaryPushedLorebookName,
        lorebooks: bundledPushedLorebooks,
        secondary_lorebooks: secondaryPushedLorebooks,
        characters: appliedCharacters,
    };
}

function approveSubmissionForAdmin(submission, adminHandle) {
    const submissionDisplayName = String(submission.content_name || '').trim();
    const submissionSourceName = String(submission.source_lorebook_name || submission.content_name || '').trim();
    const submissionCharacterName = String(submission.character_name || '').trim();
    const submissionSecondaryLorebooks = getLegacySecondaryLorebookNames(submission);
    const submissionBundle = Array.isArray(submission.lorebook_bundle) && submission.lorebook_bundle.length > 0
        ? normalizeLorebookBundleEntries(submission.lorebook_bundle)
        : buildSubmissionLorebookBundle({
            primarySourceLorebookName: submissionSourceName,
            primaryPushedLorebookName: submissionDisplayName || submissionSourceName,
            secondarySourceLorebooks: submissionSecondaryLorebooks,
            creatorHandle: submission.submitter_handle,
            isAdminSubmission: false,
        });
    const submissionNames = normalizeLorebookNameList([
        submissionDisplayName,
        submissionSourceName,
        submissionCharacterName,
        ...submissionBundle.flatMap(entry => [entry.source_lorebook_name, entry.pushed_lorebook_name]),
    ]);
    const submissionNameSet = new Set(submissionNames.map(name => name.toLowerCase()));

    const pending = readPendingPushes(adminHandle);
    const candidates = pending
        .filter(item => item.status === 'pending')
        .filter(item => item.creator_handle === submission.submitter_handle)
        .filter(item => {
            const itemBundleNames = getStoredLorebookBundle(item)
                .flatMap(entry => [entry.source_lorebook_name, entry.pushed_lorebook_name])
                .filter(Boolean);

            return submissionNames.some(name =>
                item.source_lorebook_name === name
                || item.pushed_lorebook_name === name
                || item.source_names?.lorebook === name
                || item.source_names?.character_label === name
                || item.pushed_lorebook_name?.includes(name),
            ) || itemBundleNames.some(name => submissionNameSet.has(String(name || '').trim().toLowerCase()));
        })
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    let item = candidates[0];

    // Fallback path: if no queue item exists, import directly from submitter source files by content name.
    if (!item) {
        console.log(`[SubmissionApproval] No pending push match for submission display="${submissionDisplayName}" source="${submissionSourceName}" from ${submission.submitter_handle}. Using fallback import.`);
        const sourceDirs = getUserDirectories(submission.submitter_handle);
        const fallbackSourceName = submissionSourceName;
        const fallbackPushedName = submissionDisplayName || fallbackSourceName;
        const fallbackCharacterName = submissionCharacterName || fallbackSourceName;
        if (!fallbackSourceName) {
            return { ok: false, status: 400, reason: 'Submission is missing source_lorebook_name.' };
        }
        const sourceLorebookPath = path.join(sourceDirs.worlds, sanitize(`${fallbackSourceName}.json`));
        if (!fs.existsSync(sourceLorebookPath)) {
            console.warn(`[SubmissionApproval] Source lorebook not found: ${sourceLorebookPath}`);
            return { ok: false, status: 404, reason: 'No matching pending push item or source lorebook was found for this submission.' };
        }

        const allPng = fs.readdirSync(sourceDirs.characters).filter(f => f.endsWith('.png'));
        const characterFiles = allPng.filter(f => {
            try {
                const buf = fs.readFileSync(path.join(sourceDirs.characters, f));
                const raw = readCharacterCard(buf);
                const parsed = JSON.parse(raw);
                const charWorld = parsed?.data?.extensions?.world;
                if (charWorld === fallbackSourceName) {
                    console.log(`[SubmissionApproval] Found character bound to "${fallbackSourceName}": ${f}`);
                    return true;
                }
                return false;
            } catch (err) {
                console.warn(`[SubmissionApproval] Failed to read character card ${f}:`, err.message);
                return false;
            }
        });

        console.log(`[SubmissionApproval] Fallback import: lorebook="${fallbackSourceName}", characters=[${characterFiles.join(', ')}]`);

        item = {
            creator_handle: submission.submitter_handle,
            effective_creator: submission.submitter_handle,
            pushed_by_handle: submission.submitter_handle,
            pushed_by_name: submission.submitter_name || submission.submitter_handle,
            pushed_by_role: 'user',
            original_creator_handle: submission.submitter_handle,
            original_creator_name: submission.submitter_name || submission.submitter_handle,
            source_lorebook_name: fallbackSourceName,
            pushed_lorebook_name: fallbackPushedName,
            lorebook_bundle: submissionBundle,
            source_type: 'character_lorebook_bundle',
            source_names: {
                lorebook: fallbackSourceName,
                lorebooks: normalizeLorebookNameList(submissionBundle.map(entry => entry.source_lorebook_name)),
                character_label: fallbackCharacterName,
            },
            character_files: characterFiles,
        };
    } else {
        console.log(`[SubmissionApproval] Found pending push match: push_id=${item.push_id}, lorebook="${item.pushed_lorebook_name}", characters=[${(item.character_files || []).join(', ')}]`);
    }

    const applyResult = applyQueuedPushToRecipient(adminHandle, item, true);
    if (!applyResult.ok) {
        console.warn(`[SubmissionApproval] applyQueuedPushToRecipient failed:`, applyResult);
        return { ok: false, status: applyResult.status || 500, reason: applyResult.reason || applyResult.error || 'Failed to apply submitted content.' };
    }

    console.log(`[SubmissionApproval] Successfully applied to ${adminHandle}: lorebook="${applyResult.lorebook}", characters=[${(applyResult.characters || []).join(', ')}]`);

    if (item.push_id) {
        const idx = pending.findIndex(x => x.push_id === item.push_id);
        if (idx !== -1) {
            pending[idx].status = 'accepted';
            pending[idx].unread = false;
            pending[idx].processed_at = Date.now();
            pending[idx].processed_by = adminHandle;
            writePendingPushes(adminHandle, pending);
        }
    }

    return { ok: true, applied: applyResult, push_id: item.push_id || null };
}

/**
 * Reads a World Info file and returns its contents
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Name of the World Info file
 * @param {boolean} allowDummy If true, returns an empty object if the file doesn't exist
 * @returns {object} World Info file contents
 */
export function readWorldInfoFile(directories, worldInfoName, allowDummy) {
    const dummyObject = allowDummy ? { entries: {} } : null;

    if (!worldInfoName) {
        return dummyObject;
    }

    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(directories.worlds, filename);

    if (!fs.existsSync(pathToWorldInfo)) {
        console.error(`World info file ${filename} doesn't exist.`);
        return dummyObject;
    }

    const worldInfoText = fs.readFileSync(pathToWorldInfo, 'utf8');
    const worldInfo = JSON.parse(worldInfoText);
    return worldInfo;
}

export function readResolvedWorldInfoFile(directories, worldInfoName, allowDummy = true) {
    let file = readWorldInfoFile(directories, worldInfoName, allowDummy);

    const sourceLorebookName = file?.extensions?.[NS('source_lorebook')];
    const sourceHandle = file?.extensions?.[NS('source_handle')];
    if (!sourceLorebookName || !sourceHandle) {
        return file;
    }

    try {
        const creatorDirs = getUserDirectories(sourceHandle);
        const masterFile = readWorldInfoFile(creatorDirs, sourceLorebookName, false);
        if (masterFile && masterFile.entries) {
            const localExtensions = file?.extensions || {};
            masterFile.extensions = masterFile.extensions || {};
            masterFile.extensions[NS('locked')] = localExtensions[NS('locked')];
            masterFile.extensions[NS('hidden')] = localExtensions[NS('hidden')];
            masterFile.extensions[NS('creator')] = localExtensions[NS('creator')];
            masterFile.extensions[NS('original_creator')] = localExtensions[NS('original_creator')];
            masterFile.extensions[NS('source_lorebook')] = sourceLorebookName;
            masterFile.extensions[NS('source_handle')] = sourceHandle;
            file = masterFile;
        }
    } catch (symlinkErr) {
        console.warn(`[Symlink] Lorebook resolution failed for ${worldInfoName}:`, symlinkErr.message);
    }

    return file;
}

// Determine the metadata namespace used for push/lock flags.  By default
// we fall back to the package name (non‑alphanumeric chars stripped) or
// "dreamtavern" if that cannot be determined.  Administrators may override
// via config `push.namespace`.
function getPushNamespace() {
    const cfg = getConfigValue('push.namespace', null);
    if (cfg) return cfg;
    try {
        const pkgPath = path.join(process.cwd(), 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg && pkg.name) {
                return pkg.name.replace(/\W+/g, '').toLowerCase();
            }
        }
    } catch {
        // silent
    }
    return 'dreamtavern';
}
const PUSH_NS = getPushNamespace();
const NS = suffix => `${PUSH_NS}_${suffix}`;
/**
 * @param {object} userProfile User profile object
 * @returns {{ locked: boolean, reason?: string }}
 */
function checkLock(filePath, userProfile) {
    if (!fs.existsSync(filePath)) return { locked: false };

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const ext = data?.extensions || {};

        if (!isTrueishFlag(getPushExtensionBySuffix(ext, 'locked'))) return { locked: false };

        // Admin can always edit
        if (userProfile?.admin) return { locked: false };

        // Creator can edit their own
        const creator = normalizeHandle(getPushExtensionBySuffix(ext, 'creator'));
        const originalCreator = normalizeHandle(getPushExtensionBySuffix(ext, 'original_creator') || creator);
        const userHandle = normalizeHandle(userProfile?.handle);
        if (creator === userHandle || originalCreator === userHandle) return { locked: false };

        return { locked: true, reason: 'This lorebook is locked. Only the creator or an admin can modify it.' };
    } catch {
        return { locked: false };
    }
}


function cleanupDeclinedAdminPush(recipientProfile, item) {
    try {
        // Only cleanup for user -> admin decline cases.
        if (!recipientProfile?.admin) return;
        if (!item?.creator_handle || item.creator_handle === recipientProfile.handle) return;
        const lorebookBundle = buildLorebookBundleFromItem(item);
        if (lorebookBundle.length === 0) return;
        const pushedLorebookNames = lorebookBundle
            .map(entry => String(entry?.pushed_lorebook_name || '').trim())
            .filter(Boolean);
        if (!pushedLorebookNames.some(name => name.startsWith('dd-'))) return;
        const primaryPushedLorebook = lorebookBundle.find(entry => entry.role === 'primary')?.pushed_lorebook_name || pushedLorebookNames[0];

        const adminDirs = getUserDirectories(recipientProfile.handle);
        for (const pushedLorebookName of pushedLorebookNames) {
            const lorebookPath = path.join(adminDirs.worlds, sanitize(`${pushedLorebookName}.json`));
            if (fs.existsSync(lorebookPath)) {
                fs.unlinkSync(lorebookPath);
            }
        }

        for (const charFile of item.character_files || []) {
            const charPath = path.join(adminDirs.characters, charFile);
            if (!fs.existsSync(charPath)) continue;

            // Delete only if this character card is bound to the declined pushed lorebook.
            try {
                const charBuf = fs.readFileSync(charPath);
                const charDataStr = readCharacterCard(charBuf);
                const charData = JSON.parse(charDataStr);
                const ext = charData?.data?.extensions || {};
                if (
                    ext.world === primaryPushedLorebook
                    && ext[NS('pushed')]
                    && ext[NS('creator')] === (item.effective_creator || item.creator_handle)
                ) {
                    fs.unlinkSync(charPath);
                }
            } catch {
                // Keep files we cannot confidently identify as declined-push artifacts.
            }
        }
    } catch (err) {
        console.warn('[PushAction] Decline cleanup failed:', err.message);
    }
}

/**
 * Delete pushed character files and lorebooks from a specific user's directory.
 * Used when an admin processes a user's deletion request.
 * @param {string} handle - The user whose files to delete
 * @param {object} item   - The push item describing what to delete
 * @returns {{ ok: boolean, error?: string }}
 */
function deleteUserPushedCharFiles(handle, item) {
    try {
        const lorebookBundle = buildLorebookBundleFromItem(item, handle);
        const pushedLorebookNames = lorebookBundle
            .map(entry => String(entry?.pushed_lorebook_name || '').trim())
            .filter(Boolean);

        if (item.pushed_lorebook_name && !pushedLorebookNames.includes(String(item.pushed_lorebook_name).trim())) {
            pushedLorebookNames.push(String(item.pushed_lorebook_name).trim());
        }

        const primaryPushedLorebook = lorebookBundle.find(e => String(e.role || '').toLowerCase() === 'primary')?.pushed_lorebook_name
            || pushedLorebookNames[0]
            || '';

        const userDirs = getUserDirectories(handle);

        for (const lorebookName of pushedLorebookNames) {
            const lorebookPath = path.join(userDirs.worlds, sanitize(`${lorebookName}.json`));
            if (fs.existsSync(lorebookPath)) {
                fs.unlinkSync(lorebookPath);
            }
        }

        for (const charFile of item.character_files || []) {
            const charPath = path.join(userDirs.characters, charFile);
            if (!fs.existsSync(charPath)) continue;
            try {
                const charBuf = fs.readFileSync(charPath);
                const charDataStr = readCharacterCard(charBuf);
                const charData = JSON.parse(charDataStr);
                const ext = charData?.data?.extensions || {};
                const creatorMatch = ext[NS('creator')] === (item.effective_creator || item.creator_handle);
                const lorebookMatch = !primaryPushedLorebook || ext.world === primaryPushedLorebook;
                if (ext[NS('pushed')] && creatorMatch && lorebookMatch) {
                    fs.unlinkSync(charPath);
                }
            } catch {
                // Keep files we cannot confidently identify as push artifacts.
            }
        }

        const pushes = readPendingPushes(handle);
        const pushIdx = pushes.findIndex(p => p.push_id === item.push_id);
        if (pushIdx !== -1) {
            pushes[pushIdx].status = 'admin_deleted';
            pushes[pushIdx].admin_deleted_at = Date.now();
            writePendingPushes(handle, pushes);
        }

        return { ok: true };
    } catch (err) {
        console.warn('[PushDelete] deleteUserPushedCharFiles failed:', err.message);
        return { ok: false, error: err.message };
    }
}

export const router = express.Router();

// GET /api/worldinfo/push-char-thumb?push_id=xxx&file=CharName.png
// Any authenticated user: serve a character PNG from a push item's creator directory.
// Validates the push item belongs to the requesting user before serving.
router.get('/push-char-thumb', (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.status(401).send('Unauthorized');

    const pushId = String(request.query.push_id || '').trim();
    const file   = String(request.query.file   || '').trim();
    if (!pushId || !file) return response.status(400).send('push_id and file required');

    const pending = readPendingPushes(handle);
    const item = pending.find(p => p.push_id === pushId);
    if (!item) return response.status(404).send('Push item not found');

    // Security: ensure the requested filename is one that was part of this push
    const allowed = new Set([
        ...(item.character_files       || []),
        ...(item.source_avatar_files   || []),
    ]);
    if (!allowed.has(file)) return response.status(403).send('File not part of this push');

    const creatorHandle = item.creator_handle || item.pushed_by_handle;
    if (!creatorHandle) return response.status(404).send('Creator unknown');

    const creatorDirs = getUserDirectories(creatorHandle);
    const filePath = path.resolve(creatorDirs.characters, sanitize(file));
    if (!fs.existsSync(filePath)) return response.status(404).send('Not found');

    return response.sendFile(filePath, err => {
        if (err && !response.headersSent) response.status(500).send('Failed to send file');
    });
});

// GET /api/worldinfo/user-avatar-img?handle=xxx
// Returns a user's profile avatar as an image (for direct <img src> use).
// Available to all authenticated users — only exposes the same avatar
// that is already shown on the login/user-picker screen.
router.get('/user-avatar-img', async (request, response) => {
    if (!request.user?.profile) return response.status(401).send('Unauthorized');

    const handle = String(request.query.handle || '').trim();
    if (!handle) return response.status(400).send('handle required');

    try {
        const avatar = await getUserAvatar(handle);

        // If it's a data URI, decode and serve as binary
        if (avatar && avatar.startsWith('data:')) {
            const [meta, base64] = avatar.split(',');
            const mimeType = meta.replace('data:', '').replace(';base64', '');
            const buffer = Buffer.from(base64, 'base64');
            response.set('Content-Type', mimeType);
            response.set('Cache-Control', 'private, max-age=60');
            return response.send(buffer);
        }

        // Fallback: redirect to the default avatar
        return response.redirect('/img/default-user.png');
    } catch {
        return response.redirect('/img/default-user.png');
    }
});

// GET /api/worldinfo/admin-char-thumb?handle=xxx&file=CharName.png
// Admin-only: serve a character PNG from any user's characters directory.
// Used in the admin inbox detail to show the submitter's character avatar.
router.get('/admin-char-thumb', async (request, response) => {
    if (!request.user?.profile?.admin) {
        return response.status(403).send('Admin only');
    }
    const handle = String(request.query.handle || '').trim();
    const file = String(request.query.file || '').trim();
    if (!handle || !file) return response.status(400).send('handle and file required');

    const dirs = getUserDirectories(handle);
    const filePath = path.resolve(dirs.characters, sanitize(file));

    if (fs.existsSync(filePath)) {
        return response.sendFile(filePath, err => {
            if (err && !response.headersSent) response.status(500).send('Failed to send file');
        });
    }

    // Fallback 1: snapshot captured at submission time — survives renames/deletes.
    const snapshotPath = path.resolve(path.join(SUBMISSION_THUMBS_DIR, handle), sanitize(file));
    if (fs.existsSync(snapshotPath)) {
        return response.sendFile(snapshotPath, err => {
            if (err && !response.headersSent) response.status(500).send('Failed to send file');
        });
    }

    // Fallback 2: pushed characters migrate to the shared (default-user) directory after
    // submission approval, so check there before returning 404.
    const sharedDirs = getUserDirectories(DEFAULT_USER.handle);
    const sharedPath = path.resolve(sharedDirs.characters, sanitize(file));
    if (!fs.existsSync(sharedPath)) return response.status(404).send('Not found');
    return response.sendFile(sharedPath, err => {
        if (err && !response.headersSent) response.status(500).send('Failed to send file');
    });
});

router.post('/list', async (request, response) => {
    try {
        const data = [];
        const jsonFiles = (await fs.promises.readdir(request.user.directories.worlds, { withFileTypes: true }))
            .filter((file) => file.isFile() && path.extname(file.name).toLowerCase() === '.json')
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const file of jsonFiles) {
            try {
                const filePath = path.join(request.user.directories.worlds, file.name);
                const fileContents = await fs.promises.readFile(filePath, 'utf8');
                const fileContentsParsed = tryParse(fileContents) || {};
                const fileExtensions = fileContentsParsed?.extensions || {};
                const fileNameWithoutExt = path.parse(file.name).name;
                const fileData = {
                    file_id: fileNameWithoutExt,
                    name: fileContentsParsed?.name || fileNameWithoutExt,
                    extensions: _.isObjectLike(fileExtensions) ? fileExtensions : {},
                };
                data.push(fileData);
            } catch (err) {
                console.warn(`Error reading or parsing World Info file ${file.name}:`, err);
            }
        }

        // Hide pushed lorebooks from non-admin/non-creator users
        // ADMIN-* → hidden from all non-admins
        // dd-{handle}-* → visible only to that handle + admins
        // hidden flag (namespace dynamic) → visible only to creator + admins
        const allHandles = (await getAllUsers())
            .filter(u => u.enabled)
            .map(u => u.handle);
        const pushedWorldOwnership = getPushedWorldOwnershipMap(request.user.directories, request.user.profile);
        const filtered = data.filter(entry => {
            const fileId = entry.file_id || '';
            const ext = entry.extensions || {};
            const pushedOwnership = pushedWorldOwnership.get(fileId);
            if (pushedOwnership?.hasPushed && !pushedOwnership.owner) return false;
            if (!isLorebookHidden(fileId, ext)) return true;
            return canUserAccessHiddenLorebook(fileId, ext, request.user.profile, allHandles);
        });

        return response.send(filtered);
    } catch (err) {
        console.error('Error reading World Info directory:', err);
        return response.sendStatus(500);
    }
});

router.post('/get', async (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    let file = readResolvedWorldInfoFile(request.user.directories, request.body.name, true);

    // Hidden pushed lorebooks are UI-hidden for non-owners but still returned for prompt building.
    // Only fetch the full user list when the lorebook is actually hidden — getAllUsers() is an
    // async storage read and would otherwise run on every lorebook fetch (every chat open).
    if (isLorebookHidden(request.body.name, file?.extensions || {})) {
        const allHandles = (await getAllUsers())
            .map(u => u.handle);
        const canAccess = canUserAccessHiddenLorebook(
            request.body.name,
            file?.extensions || {},
            request.user.profile,
            allHandles,
        );
        if (!canAccess) {
            file._stw_hidden_restricted = true;
            file._dreamtavern_restricted = true;
            file.entries = {};
        }
    }

    return response.send(file);
});

router.post('/delete', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const worldInfoName = request.body.name;
    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(request.user.directories.worlds, filename);

    if (!fs.existsSync(pathToWorldInfo)) {
        throw new Error(`World info file ${filename} doesn't exist.`);
    }

    // Lock check
    const lock = checkLock(pathToWorldInfo, request.user.profile);
    if (lock.locked) {
        return response.status(403).send(lock.reason);
    }

    fs.unlinkSync(pathToWorldInfo);

    return response.sendStatus(200);
});

router.post('/import', (request, response) => {
    if (!request.file) return response.sendStatus(400);

    const filename = `${path.parse(sanitize(request.file.originalname)).name}.json`;

    let fileContents = null;

    if (request.body.convertedData) {
        fileContents = request.body.convertedData;
    } else {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        fileContents = fs.readFileSync(pathToUpload, 'utf8');
        fs.unlinkSync(pathToUpload);
    }

    try {
        const worldContent = JSON.parse(fileContents);
        if (!('entries' in worldContent)) {
            throw new Error('File must contain a world info entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const pathToNewFile = path.join(request.user.directories.worlds, filename);
    const worldName = path.parse(pathToNewFile).name;

    if (!worldName) {
        return response.status(400).send('World file must have a name');
    }

    writeFileAtomicSync(pathToNewFile, fileContents);
    return response.send({ name: worldName });
});

router.post('/edit', (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    if (!request.body.name) {
        return response.status(400).send('World file must have a name');
    }

    try {
        if (!('entries' in request.body.data)) {
            throw new Error('World info must contain an entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const filename = sanitize(`${request.body.name}.json`);
    const pathToFile = path.join(request.user.directories.worlds, filename);

    // Lock check
    const lock = checkLock(pathToFile, request.user.profile);
    if (lock.locked) {
        return response.status(403).send(lock.reason);
    }

    writeFileAtomicSync(pathToFile, JSON.stringify(request.body.data, null, 4));

    // ── One-way lorebook sync (fire-and-forget) ──
    // If this user has pushed this lorebook before, propagate the edit
    // to every recipient who still has the file.
    const lorebookName = request.body.name;
    const creatorHandle = request.user.profile.handle;
    setImmediate(() => {
        try {
            const manifest = readPushManifest(creatorHandle);
            const records = manifest
                .map(record => ({ record, bundle: getStoredLorebookBundle(record) }))
                .filter(({ record, bundle }) =>
                    record.source_lorebook === lorebookName
                    || bundle.some(entry => entry.source_lorebook_name === lorebookName),
                );
            if (records.length === 0) return;

            for (const { record, bundle } of records) {
                const matchingBundleEntries = bundle.filter(entry => entry.source_lorebook_name === lorebookName);
                for (const recipient of record.recipients) {
                    for (const bundleEntry of matchingBundleEntries) {
                        try {
                            const recipDirs = getUserDirectories(recipient);
                            const destPath = path.join(recipDirs.worlds, sanitize(`${bundleEntry.pushed_lorebook_name}.json`));
                            if (!fs.existsSync(destPath)) continue; // user deleted it

                            // Build updated copy: creator's data + preserved lock metadata
                            const synced = JSON.parse(JSON.stringify(request.body.data));
                            const existingDest = JSON.parse(fs.readFileSync(destPath, 'utf8'));
                            const existingExt = existingDest?.extensions || {};
                            if (!synced.extensions) synced.extensions = {};
                            synced.extensions[NS('locked')] = getPushExtensionBySuffix(existingExt, 'locked') ?? true;
                            synced.extensions[NS('hidden')] = getPushExtensionBySuffix(existingExt, 'hidden') ?? true;
                            synced.extensions[NS('creator')] = getPushExtensionBySuffix(existingExt, 'creator') || creatorHandle;
                            synced.extensions[NS('original_creator')] = getPushExtensionBySuffix(existingExt, 'original_creator')
                                || getPushExtensionBySuffix(existingExt, 'creator')
                                || creatorHandle;
                            synced.extensions[NS('source_lorebook')] = getPushExtensionBySuffix(existingExt, 'source_lorebook')
                                || bundleEntry.source_lorebook_name
                                || record.source_lorebook;
                            synced.extensions[NS('source_handle')] = getPushExtensionBySuffix(existingExt, 'source_handle') || creatorHandle;

                            writeFileAtomicSync(destPath, JSON.stringify(synced, null, 4));
                        } catch (e) {
                            console.warn(`[Sync] Lorebook sync to ${recipient} failed:`, e.message);
                        }
                    }
                }
            }
            console.log(`[Sync] Lorebook "${lorebookName}" synced to recipients`);
        } catch (err) {
            console.warn('[Sync] Lorebook sync error:', err.message);
        }
    });

    return response.send({ ok: true });
});

// Push lorebook + associated character(s) to target users as pending queue items.
router.post('/push', async (request, response) => {
    const { name, targets, charLabel, notes = '', version = '' } = request.body;
    const userIsAdmin = request.user.profile?.admin;
    const creatorHandle = request.user.profile?.handle;
    const pusherName = request.user.profile?.name || creatorHandle;

    if (!name) return response.status(400).send('Lorebook name is required');
    const nameValidationError = getLorebookNameValidationError(name);
    if (nameValidationError) return response.status(400).send(nameValidationError);

    const sourcePath = path.join(request.user.directories.worlds, sanitize(`${name}.json`));
    if (!fs.existsSync(sourcePath)) {
        return response.status(404).send('Lorebook not found in your collection');
    }

    const sourceLorebook = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    if (!sourceLorebook.extensions) sourceLorebook.extensions = {};
    const isUserPushedBook = name.startsWith('dd-');

    const enabledUsers = await getAllUsers();
    const enabledHandles = enabledUsers.map(u => u.handle);
    const userByHandle = new Map(enabledUsers.map(u => [u.handle, u]));

    let targetHandles = normalizeTargets(targets, creatorHandle, enabledHandles);
    if (!targetHandles) return response.status(400).send('targets must be "all" or an array of handles');

    if (!userIsAdmin) {
        const adminHandles = enabledUsers
            .filter(u => u.admin && normalizeHandle(u.handle) === normalizeHandle(TRUE_ADMIN_HANDLE))
            .map(u => u.handle);
        const invalidTargets = targetHandles.filter(h => !adminHandles.includes(h));
        if (invalidTargets.length > 0) {
            return response.status(403).send('Non-admin users can only push to the true admin account');
        }
    }

    const characterFiles = await findCharactersByWorld(request.user.directories, name);
    if (characterFiles.length === 0 && charLabel) {
        const byName = findCharacterFilesByName(request.user.directories, charLabel);
        for (const f of byName) {
            if (!characterFiles.includes(f)) characterFiles.push(f);
        }
    }
    const existingCreator = String(sourceLorebook.extensions[NS('creator')] || '').trim();
    const existingOriginalCreator = String(sourceLorebook.extensions[NS('original_creator')] || '').trim();
    const inferredFromName = findCreatorFromDdName(name, enabledHandles);
    const inferredFromChars = findCreatorFromCharacterFiles(request.user.directories, characterFiles);
    const effectiveCreatorHandle = normalizeCreatorHandle(
        existingOriginalCreator || inferredFromName || inferredFromChars || existingCreator,
        creatorHandle,
    );
    const effectiveCreatorName = userByHandle.get(effectiveCreatorHandle)?.name || effectiveCreatorHandle || creatorHandle;
    sourceLorebook.extensions[NS('creator')] = effectiveCreatorHandle;
    sourceLorebook.extensions[NS('original_creator')] = effectiveCreatorHandle;
    writeFileAtomicSync(sourcePath, JSON.stringify(sourceLorebook, null, 4));

    // When an admin pushes to All Users, exclude the original creator — the
    // symlink is one-way (creator → admin → other users). The creator already
    // has the authoritative copy; sending it back would create a loop.
    if (userIsAdmin && effectiveCreatorHandle && effectiveCreatorHandle !== creatorHandle) {
        targetHandles = targetHandles.filter(h => h !== effectiveCreatorHandle);
    }

    const labelToUse = charLabel || name;
    const metadataCharacterName = findCharacterNameFromFiles(request.user.directories, characterFiles, labelToUse);
    const preserveOriginalName = false;
    const sourceLorebookName = name;
    const distributedLorebookName = userIsAdmin
        ? sourceLorebookName
        : getUserDistributedLorebookName(sourceLorebookName, labelToUse, creatorHandle);

    const pushedLorebookName = userIsAdmin
        ? getQueuedLorebookNameForRecipient({
            sourceLorebookName,
            fallbackLabel: sourceLorebookName,
            isAdminPush: true,
            recipientHandle: '',
            originalCreatorHandle: effectiveCreatorHandle,
            pusherHandle: creatorHandle,
            preserveOriginalName,
        })
        : distributedLorebookName;

    const shouldRenameSourceLorebook = false;
    const renameSuccess = shouldRenameSourceLorebook
        ? renameLoreBookIfNeeded(request.user.directories.worlds, name, sourceLorebookName)
        : true;
    if (!renameSuccess && shouldRenameSourceLorebook) {
        return response.status(500).send('Failed to prepare lorebook for push: could not rename file');
    }

    const results = { queued: [], failed: [], items: [] };

    for (const handle of targetHandles) {
        try {
            const isOriginalCreatorRecipient = handle === effectiveCreatorHandle;
            const announcementMode = userIsAdmin && !isOriginalCreatorRecipient;
            const deliveredNotes = announcementMode ? '' : (notes || '');
            const recipientPushedLorebookName = userIsAdmin
                ? getQueuedLorebookNameForRecipient({
                    sourceLorebookName,
                    fallbackLabel: sourceLorebookName,
                    isAdminPush: true,
                    recipientHandle: handle,
                    originalCreatorHandle: effectiveCreatorHandle,
                    pusherHandle: creatorHandle,
                    preserveOriginalName,
                })
                : distributedLorebookName;
            const pending = readPendingPushes(handle);
            const item = {
                push_id: makeId('push'),
                status: 'pending',
                unread: true,
                created_at: Date.now(),
                processed_at: null,
                processed_by: null,
                creator_handle: creatorHandle,
                effective_creator: effectiveCreatorHandle,
                pushed_by_handle: creatorHandle,
                pushed_by_name: pusherName,
                pushed_by_role: userIsAdmin ? 'admin' : 'user',
                original_creator_handle: effectiveCreatorHandle,
                original_creator_name: effectiveCreatorName,
                source_lorebook_name: sourceLorebookName,
                pushed_lorebook_name: recipientPushedLorebookName,
                source_type: 'character_lorebook_bundle',
                source_names: {
                    lorebook: name,
                    character_label: labelToUse,
                },
                character_files: characterFiles,
                source_avatar_files: characterFiles,
                // Store original avatar snapshots to preserve creator's original choice,
                // preventing admin modifications from affecting recipients
                original_avatar_snapshots: Object.fromEntries(
                    characterFiles.map(charFile => {
                        const charPath = path.join(request.user.directories.characters, charFile);
                        try {
                            if (fs.existsSync(charPath)) {
                                const buffer = fs.readFileSync(charPath);
                                return [charFile, buffer.toString('base64')];
                            }
                        } catch (err) {
                            console.warn(`[Push] Failed to snapshot ${charFile}:`, err.message);
                        }
                        return [charFile, null];
                    })
                ),
                preview: {
                    character_count: characterFiles.length,
                    note: deliveredNotes,
                    version: version || '',
                },
                notes: deliveredNotes,
                is_public_announcement: announcementMode,
                announcement_title: announcementMode ? '🎉 NEW CHARACTER!! 🎉' : '',
                announcement_character_name: metadataCharacterName,
                version: version || '',
                recipient_handle: handle,
            };
            pending.push(item);
            writePendingPushes(handle, pending);
            // Enhanced notification with hidden lorebook details
            let notifyText;
            if (announcementMode) {
                notifyText = `🎉 NEW CHARACTER!! 🎉 - ${metadataCharacterName || labelToUse} (includes "${recipientPushedLorebookName}")`;
            } else {
                if (userIsAdmin) {
                    notifyText = `New push: "${recipientPushedLorebookName}" (admin-managed, hidden from dropdown)`;
                } else if (recipientPushedLorebookName.startsWith('dd-')) {
                    notifyText = `New push: "${recipientPushedLorebookName}" (your submission, visible to you)`;
                } else {
                    notifyText = `New push queued: ${recipientPushedLorebookName}`;
                }
            }
            writePushNotification(handle, notifyText);
            results.queued.push(handle);
            results.items.push({ handle, push_id: item.push_id });
        } catch (err) {
            console.error(`[PushQueue] Failed to queue "${name}" for ${handle}:`, err);
            results.failed.push(handle);
        }
    }

    return response.json(results);
});

// Bulk-push 1-10 lorebook-linked items to selected users as pending queue items (admin only).
router.post('/bulk-push', async (request, response) => {
    if (!request.user.profile?.admin) {
        return response.status(403).send('Bulk push is admin-only');
    }

    const { lorebooks: lorebooksRaw, targets, version = '' } = request.body;
    if (!Array.isArray(lorebooksRaw) || lorebooksRaw.length < 1 || lorebooksRaw.length > 10) {
        return response.status(400).send('Provide an array of 1-10 lorebook bundle entries');
    }

    const bundleEntries = lorebooksRaw.map(item => {
        if (typeof item === 'string') {
            return { characterName: '', hintedAvatar: '', primaryLorebook: String(item || '').trim(), secondaryLorebooks: [] };
        }

        const primaryLb = String(item.primary_lorebook || item.lorebook || '').trim();
        const secondaryRaw = [
            item.secondary_lorebook,
            ...(Array.isArray(item.secondary_lorebooks) ? item.secondary_lorebooks : []),
        ];
        const secondaryLorebooks = [...new Set(secondaryRaw
            .map(value => String(value || '').trim())
            .filter(Boolean)
            .filter(value => value !== primaryLb))];
        return {
            characterName: String(item.character_name || '').trim(),
            hintedAvatar: sanitize(String(item.avatarFile || '')),
            primaryLorebook: primaryLb,
            secondaryLorebooks,
        };
    });

    const creatorHandle = request.user.profile.handle;
    const pusherName = request.user.profile?.name || creatorHandle;
    const enabledUsers = await getAllUsers();
    const enabledHandles = enabledUsers.map(u => u.handle);
    const userByHandle = new Map(enabledUsers.map(u => [u.handle, u]));
    const targetHandles = normalizeTargets(targets, creatorHandle, enabledHandles);
    if (!targetHandles || targetHandles.length === 0) {
        return response.status(400).send('No target users selected');
    }

    const allResults = [];

    for (const entry of bundleEntries) {
        const primaryLorebook = String(entry.primaryLorebook || '').trim();
        const secondaryLorebooks = Array.isArray(entry.secondaryLorebooks) ? entry.secondaryLorebooks : [];
        const sourceLorebooks = [primaryLorebook, ...secondaryLorebooks].filter(Boolean);
        const result = {
            character_name: entry.characterName || '',
            primary_lorebook: primaryLorebook || '',
            secondary_lorebooks: secondaryLorebooks,
            lorebook: primaryLorebook || '',
            queued: [],
            failed: [],
        };

        try {
            if (!primaryLorebook) {
                result.failed.push('Primary lorebook is required for each selected character.');
                allResults.push(result);
                continue;
            }
            const primaryLorebookValidationError = getLorebookNameValidationError(primaryLorebook);
            if (primaryLorebookValidationError) {
                result.failed.push(primaryLorebookValidationError);
                allResults.push(result);
                continue;
            }
            const invalidSecondaryLorebook = secondaryLorebooks.find(name => getLorebookNameValidationError(name));
            if (invalidSecondaryLorebook) {
                result.failed.push(getLorebookNameValidationError(invalidSecondaryLorebook));
                allResults.push(result);
                continue;
            }

            let characterFiles = [];
            if (entry.characterName) {
                characterFiles = findCharacterFilesByName(request.user.directories, entry.characterName);
            }
            if (characterFiles.length === 0) {
                characterFiles = await findCharactersByWorld(request.user.directories, primaryLorebook);
            }
            if (characterFiles.length === 0 && entry.hintedAvatar) {
                const hintedAvatarPath = path.join(request.user.directories.characters, entry.hintedAvatar);
                if (fs.existsSync(hintedAvatarPath)) {
                    characterFiles = [entry.hintedAvatar];
                }
            }

            const sourceLorebooksData = [];
            for (const lorebookName of sourceLorebooks) {
                const sourcePath = path.join(request.user.directories.worlds, sanitize(`${lorebookName}.json`));
                if (!fs.existsSync(sourcePath)) {
                    result.failed.push(`Source lorebook "${lorebookName}" not found`);
                    continue;
                }

                const sourceLorebook = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
                if (!sourceLorebook.extensions) sourceLorebook.extensions = {};
                sourceLorebooksData.push({ lorebookName, sourcePath, sourceLorebook });
            }

            if (result.failed.length > 0) {
                allResults.push(result);
                continue;
            }

            const primarySource = sourceLorebooksData.find(x => x.lorebookName === primaryLorebook) || sourceLorebooksData[0];
            const existingCreator = String(primarySource?.sourceLorebook?.extensions?.[NS('creator')] || '').trim();
            const existingOriginalCreator = String(primarySource?.sourceLorebook?.extensions?.[NS('original_creator')] || '').trim();
            const inferredFromName = findCreatorFromDdName(primaryLorebook, enabledHandles);
            const inferredFromChars = findCreatorFromCharacterFiles(request.user.directories, characterFiles);
            const effectiveCreatorHandle = normalizeCreatorHandle(
                existingOriginalCreator || inferredFromName || inferredFromChars || existingCreator,
                creatorHandle,
            );
            const effectiveCreatorName = userByHandle.get(effectiveCreatorHandle)?.name || effectiveCreatorHandle || creatorHandle;

            for (const sourceItem of sourceLorebooksData) {
                sourceItem.sourceLorebook.extensions[NS('creator')] = effectiveCreatorHandle;
                sourceItem.sourceLorebook.extensions[NS('original_creator')] = effectiveCreatorHandle;
                writeFileAtomicSync(sourceItem.sourcePath, JSON.stringify(sourceItem.sourceLorebook, null, 4));
            }

            const bundleTargetHandles = (effectiveCreatorHandle && effectiveCreatorHandle !== creatorHandle)
                ? targetHandles.filter(h => h !== effectiveCreatorHandle)
                : targetHandles;

            const metadataCharacterName = findCharacterNameFromFiles(
                request.user.directories,
                characterFiles,
                entry.characterName || primaryLorebook,
            ) || entry.characterName || primaryLorebook;

            for (const handle of bundleTargetHandles) {
                try {
                    const lorebookBundle = sourceLorebooks.map((sourceLorebookName, index) => {
                        const isPrimary = index === 0;
                        // Preserve the source lorebook identity for every bundled book.
                        // Secondary books already need this to avoid collapsing into the
                        // primary, and the primary should also retain its lorebook name
                        // with the ADMIN-/dd- treatment instead of using the character label.
                        const label = sourceLorebookName;
                        return {
                            role: isPrimary ? 'primary' : 'secondary',
                            source_lorebook_name: sourceLorebookName,
                            pushed_lorebook_name: getQueuedLorebookNameForRecipient({
                                sourceLorebookName,
                                fallbackLabel: label,
                                isAdminPush: true,
                                recipientHandle: handle,
                                originalCreatorHandle: effectiveCreatorHandle,
                                pusherHandle: creatorHandle,
                                preserveOriginalName: false,
                            }),
                            fallback_label: label,
                        };
                    });

                    const primaryBundleEntry = lorebookBundle.find(x => x.role === 'primary') || lorebookBundle[0];
                    const pending = readPendingPushes(handle);
                    const item = {
                        push_id: makeId('push'),
                        status: 'pending',
                        unread: true,
                        created_at: Date.now(),
                        processed_at: null,
                        processed_by: null,
                        creator_handle: creatorHandle,
                        effective_creator: effectiveCreatorHandle,
                        pushed_by_handle: creatorHandle,
                        pushed_by_name: pusherName,
                        pushed_by_role: 'admin',
                        original_creator_handle: effectiveCreatorHandle,
                        original_creator_name: effectiveCreatorName,
                        source_lorebook_name: primaryBundleEntry?.source_lorebook_name || primaryLorebook,
                        pushed_lorebook_name: primaryBundleEntry?.pushed_lorebook_name || primaryLorebook,
                        lorebook_bundle: lorebookBundle,
                        source_type: 'character_lorebook_bundle',
                        source_names: {
                            lorebook: primaryLorebook,
                            lorebooks: sourceLorebooks,
                            character_label: metadataCharacterName || primaryLorebook,
                        },
                        character_files: characterFiles,
                        source_avatar_files: characterFiles,
                        // Prefer the creator's submission-time snapshot so first-install
                        // recipients always get the original avatar the creator chose,
                        // even if the admin modified the PNG before distributing.
                        original_avatar_snapshots: Object.fromEntries(
                            characterFiles.map(charFile => {
                                const snapshotPath = path.join(SUBMISSION_THUMBS_DIR, effectiveCreatorHandle, charFile);
                                const adminPath    = path.join(request.user.directories.characters, charFile);
                                const filePath     = fs.existsSync(snapshotPath) ? snapshotPath : adminPath;
                                try {
                                    if (fs.existsSync(filePath)) {
                                        return [charFile, fs.readFileSync(filePath).toString('base64')];
                                    }
                                } catch (err) {
                                    console.warn(`[BulkPush] Failed to read avatar snapshot for ${charFile}:`, err.message);
                                }
                                return [charFile, null];
                            }),
                        ),
                        preview: {
                            character_count: characterFiles.length,
                            lorebook_count: lorebookBundle.length,
                            note: '',
                            version: version || '',
                        },
                        notes: '',
                        is_public_announcement: true,
                        announcement_title: '🎉 NEW CHARACTER!! 🎉',
                        announcement_character_name: metadataCharacterName || primaryLorebook,
                        version: version || '',
                        recipient_handle: handle,
                    };

                    pending.push(item);
                    writePendingPushes(handle, pending);

                    const hiddenNote = lorebookBundle.length > 1
                        ? ` (${lorebookBundle.length} bundled lorebooks hidden from your dropdown)`
                        : ' (lorebook hidden from your dropdown)';
                    writePushNotification(handle, `🎉 NEW CHARACTER!! 🎉 - ${metadataCharacterName || primaryLorebook}${hiddenNote}`);
                    result.queued.push({ handle, push_id: item.push_id });
                } catch (err) {
                    console.error(`[BulkPushQueue] Failed for bundle ${primaryLorebook} -> ${handle}:`, err);
                    result.failed.push(`${handle}: ${err?.message || 'unknown error'}`);
                }
            }
        } catch (err) {
            console.error(`[BulkPushQueue] Error processing bundle "${primaryLorebook}":`, err);
            result.failed.push(`internal error: ${err?.message || 'unknown error'}`);
        }

        allResults.push(result);
    }

    return response.json({ results: allResults });
});
// Find characters linked to a lorebook (any authenticated user)
router.post('/find-characters', async (request, response) => {
    const { name } = request.body;
    if (!name) {
        return response.status(400).send('Lorebook name is required');
    }

    // Apply the same visibility rule as /get for hidden pushed lorebooks.
    const file = readWorldInfoFile(request.user.directories, name, true);
    const pushedWorldOwnership = getPushedWorldOwnershipMap(request.user.directories, request.user.profile);
    const pushedOwnership = pushedWorldOwnership.get(name);
    if (pushedOwnership?.hasPushed && !pushedOwnership.owner) {
        return response.status(403).send('This lorebook is hidden. Only the creator or an admin can access it.');
    }
    const allHandles = (await getAllUsers())
        .filter(u => u.enabled)
        .map(u => u.handle);
    if (isLorebookHidden(name, file?.extensions || {})) {
        if (!canUserAccessHiddenLorebook(name, file?.extensions || {}, request.user.profile, allHandles)) {
            return response.status(403).send('This lorebook is hidden. Only the creator or an admin can access it.');
        }
    }

    const characters = await findCharactersByWorld(request.user.directories, name);
    return response.send({ characters });
});

// Get admin user handles (for non-admin users to know who they can push to)
router.post('/admin-handles', async (request, response) => {
    try {
        const allUsers = await getAllUsers();
        const trueAdmin = allUsers.find(u => normalizeHandle(u.handle) === normalizeHandle(TRUE_ADMIN_HANDLE) && u.admin);
        const admins = trueAdmin
            ? [{ handle: trueAdmin.handle, name: trueAdmin.name, admin: true, enabled: true }]
            : allUsers
                .filter(u => u.admin)
                .map(u => ({ handle: u.handle, name: u.name, admin: true, enabled: true }));
        return response.json(admins);
    } catch (err) {
        console.error('Failed to get admin handles:', err);
        return response.sendStatus(500);
    }
});

router.post('/push-detail', async (request, response) => {
    const { push_id: pushId } = request.body || {};
    if (!pushId) return response.status(400).send('push_id is required');

    const handle = request.user.profile?.handle;
    const pending = readPendingPushes(handle);
    const item = pending.find(x => x.push_id === pushId);
    if (!item) return response.status(404).send('Pending push not found');

    if (item.unread) {
        item.unread = false;
        writePendingPushes(handle, pending);
    }

    const enabledUsers = await getAllUsers();
    const userByHandle = new Map(enabledUsers.map(u => [u.handle, u]));

    const originalCreatorHandle = String(item.original_creator_handle || item.effective_creator || item.creator_handle || '').trim();
    const originalCreatorName = String(item.original_creator_name || userByHandle.get(originalCreatorHandle)?.name || '').trim();
    const isAdminPush = String(item.pushed_by_role || '').toLowerCase() === 'admin'
        || (!!item.creator_handle && item.creator_handle !== originalCreatorHandle);
    const pushedByLabel = isAdminPush
        ? 'Admin'
        : String(item.pushed_by_name || item.creator_handle || 'User');

    return response.json({
        ...item,
        pushed_by_label: pushedByLabel,
        original_creator_handle: originalCreatorHandle || null,
        original_creator_name: originalCreatorName || null,
    });
});

router.post('/push-action', (request, response) => {
    const { push_id: pushId, action } = request.body || {};
    if (!pushId || !action) return response.status(400).send('push_id and action are required');
    if (!['accept', 'overwrite', 'decline'].includes(action)) return response.status(400).send('Invalid action');

    const handle = request.user.profile?.handle;
    const pending = readPendingPushes(handle);
    const idx = pending.findIndex(x => x.push_id === pushId);
    if (idx === -1) return response.status(404).send('Pending push not found');

    const item = pending[idx];
    if (item.status !== 'pending') {
        return response.status(409).json({ ok: false, reason: 'Push item already processed', item });
    }

    // Public announcement imports are accept/decline only.
    // Coerce accidental overwrite requests to accept semantics.
    const effectiveAction = (item.is_public_announcement && action === 'overwrite') ? 'accept' : action;

    if (effectiveAction === 'decline') {
        // On decline, clean up user-pushed lorebook/character artifacts from the admin side.
        cleanupDeclinedAdminPush(request.user.profile, item);

        item.status = 'declined';
        item.unread = false;
        item.processed_at = Date.now();
        item.processed_by = handle;
        pending[idx] = item;
        writePendingPushes(handle, pending);
        return response.json({ ok: true, item, action: effectiveAction });
    }

    const applyResult = applyQueuedPushToRecipient(handle, item, effectiveAction === 'overwrite');
    if (!applyResult.ok) {
        return response.status(applyResult.status || 500).json(applyResult);
    }

    if (applyResult.lorebook) {
        item.pushed_lorebook_name = applyResult.lorebook;
    }
    if (Array.isArray(applyResult.lorebooks) && applyResult.lorebooks.length > 0) {
        item.lorebook_bundle = (item.lorebook_bundle || []).map((entry, index) => ({
            ...entry,
            pushed_lorebook_name: applyResult.lorebooks[index] || entry.pushed_lorebook_name,
        }));
    }

    item.status = effectiveAction === 'overwrite' ? 'overwritten' : 'accepted';
    item.unread = false;
    item.processed_at = Date.now();
    item.processed_by = handle;
    pending[idx] = item;
    writePendingPushes(handle, pending);

    try {
        recordPush(item.creator_handle, {
            source_lorebook: item.source_lorebook_name,
            pushed_lorebook_name: applyResult.lorebook || item.pushed_lorebook_name,
            lorebook_bundle: item.lorebook_bundle,
            character_files: item.character_files || [],
            recipients: [handle],
        });
    } catch (err) {
        console.warn('[PushAction] Failed to record push manifest:', err.message);
    }

    return response.json({ ok: true, item, applied: applyResult, action: effectiveAction });
});

// Returns accepted/overwritten push items for the current user (for deletion-request UI).
router.post('/accepted-pushes', (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.status(401).send('Unauthorized');

    const accepted = readPendingPushes(handle)
        .filter(item => ['accepted', 'overwritten'].includes(String(item.status || '').toLowerCase()))
        .sort((a, b) => (b.processed_at || b.created_at || 0) - (a.processed_at || a.created_at || 0));

    return response.json({ accepted });
});

// User requests the admin delete a character (pushed or any character by file).
// Accepts either push_id (for pushed chars) or character_file + character_name (for any char).
router.post('/user-deletion-request', (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.status(401).send('Unauthorized');

    const { push_id: pushId, character_file: charFile, character_name: charName, reason } = request.body || {};
    if (!pushId && !charFile) return response.status(400).send('push_id or character_file is required');

    const profile = request.user.profile;
    const existing = readAdminSubmissions();

    if (pushId) {
        // Existing flow: pushed character with a push record
        const pending = readPendingPushes(handle);
        const item = pending.find(p => p.push_id === pushId);
        if (!item) return response.status(404).send('Push item not found');

        const itemStatus = String(item.status || '').toLowerCase();
        if (!['accepted', 'overwritten'].includes(itemStatus)) {
            return response.status(400).send('Can only request deletion for accepted push items');
        }

        const alreadyRequested = existing.some(s =>
            s.inbox_item_type === 'deletion_request'
            && s.push_id === pushId
            && s.submitter_handle === handle
            && s.status === 'pending'
        );
        if (alreadyRequested) {
            return response.status(409).send('A deletion request for this item is already pending');
        }

        const characterLabel = item.char_label || item.pushed_lorebook_name || 'Character';
        const submission = {
            submission_id: makeId('del-req'),
            inbox_item_type: 'deletion_request',
            submitter_handle: handle,
            submitter_name: profile?.name || handle,
            content_name: characterLabel,
            content_type: (item.character_files || []).length > 0 ? 'character_lorebook_bundle' : 'lorebook',
            push_id: pushId,
            character_files: item.character_files || [],
            pushed_lorebook_name: item.pushed_lorebook_name || '',
            lorebook_bundle: item.lorebook_bundle || [],
            creator_handle: item.creator_handle || item.pushed_by_handle || '',
            effective_creator: item.effective_creator || item.creator_handle || '',
            notes: reason || 'User requested deletion of this pushed character.',
            priority: 'normal',
            status: 'pending',
            created_at: Date.now(),
        };
        existing.push(submission);
        writeAdminSubmissions(existing);
        return response.json({ ok: true, submission_id: submission.submission_id });
    }

    // New flow: any character by filename (non-pushed or unknown origin)
    const safeFile = path.basename(charFile);
    const alreadyRequested = existing.some(s =>
        s.inbox_item_type === 'deletion_request'
        && s.submitter_handle === handle
        && s.status === 'pending'
        && (s.character_files || []).includes(safeFile)
    );
    if (alreadyRequested) {
        return response.status(409).send('A deletion request for this character is already pending');
    }

    const submission = {
        submission_id: makeId('del-req'),
        inbox_item_type: 'deletion_request',
        submitter_handle: handle,
        submitter_name: profile?.name || handle,
        content_name: charName || safeFile.replace(/\.png$/i, ''),
        content_type: 'character',
        push_id: null,
        character_files: [safeFile],
        pushed_lorebook_name: '',
        lorebook_bundle: [],
        creator_handle: '',
        effective_creator: '',
        notes: reason || 'User requested deletion of this character.',
        priority: 'normal',
        status: 'pending',
        created_at: Date.now(),
    };
    existing.push(submission);
    writeAdminSubmissions(existing);
    return response.json({ ok: true, submission_id: submission.submission_id });
});

// Admin deletes a pushed character for one user or all users who received it.
router.post('/admin-delete-pushed-char', async (request, response) => {
    if (!request.user.profile?.admin) {
        return response.status(403).send('Admin only');
    }

    const { submission_id: submissionId, scope } = request.body || {};
    if (!submissionId || !scope) return response.status(400).send('submission_id and scope are required');
    if (!['user', 'all'].includes(scope)) return response.status(400).send('scope must be "user" or "all"');

    const all = readAdminSubmissions();
    const idx = all.findIndex(s => s.submission_id === submissionId);
    if (idx === -1) return response.status(404).send('Submission not found');

    const submission = all[idx];
    if (submission.inbox_item_type !== 'deletion_request') {
        return response.status(400).send('Not a deletion request');
    }

    const requesterHandle = submission.submitter_handle;
    const pushItem = {
        push_id: submission.push_id,
        character_files: submission.character_files || [],
        pushed_lorebook_name: submission.pushed_lorebook_name || '',
        lorebook_bundle: submission.lorebook_bundle || [],
        creator_handle: submission.creator_handle || '',
        effective_creator: submission.effective_creator || submission.creator_handle || '',
    };

    const deleted = [];
    const errors = [];

    if (scope === 'user') {
        const result = deleteUserPushedCharFiles(requesterHandle, pushItem);
        if (result.ok) deleted.push(requesterHandle);
        else errors.push({ handle: requesterHandle, error: result.error });
    } else {
        try {
            const allHandles = await getAllUserHandles();
            for (const userHandle of allHandles) {
                const userPushes = readPendingPushes(userHandle);
                const match = userPushes.find(p =>
                    p.push_id === submission.push_id
                    || (p.creator_handle === submission.creator_handle
                        && p.pushed_lorebook_name === submission.pushed_lorebook_name
                        && ['accepted', 'overwritten'].includes(String(p.status || '').toLowerCase()))
                );
                if (!match) continue;
                const result = deleteUserPushedCharFiles(userHandle, { ...pushItem, push_id: match.push_id });
                if (result.ok) deleted.push(userHandle);
                else errors.push({ handle: userHandle, error: result.error });
            }
        } catch (err) {
            return response.status(500).json({ ok: false, error: `Failed to enumerate users: ${err.message}` });
        }
    }

    all[idx].status = scope === 'all' ? 'deleted_all' : 'deleted_for_user';
    all[idx].reviewed_at = Date.now();
    all[idx].reviewed_by = request.user.profile?.handle;
    all[idx].deleted_handles = deleted;
    writeAdminSubmissions(all);

    try {
        const actorHandle = request.user.profile?.handle;
        const actorName = request.user.profile?.name || actorHandle;
        appendUserInbox(requesterHandle, {
            type: 'deletion_completed',
            title: 'Character Deletion Completed',
            body: `Your request to delete "${submission.content_name}" has been processed by an admin.`,
            priority: 'normal',
            from_handle: actorHandle,
            from_name: actorName,
            status: 'reviewed',
            context: { push_id: submission.push_id },
        });
        writePushNotification(requesterHandle, 'Your character deletion request has been completed');
    } catch (err) {
        console.warn('[AdminDelete] Failed to notify requesting user:', err.message);
    }

    return response.json({ ok: true, scope, deleted_count: deleted.length, deleted_handles: deleted, errors });
});

// Admin: scan ALL characters from ALL user directories for the deletion manager.
router.post('/admin-all-accepted-pushes', async (request, response) => {
    if (!request.user.profile?.admin) {
        return response.status(403).send('Admin only');
    }
    try {
        const allHandles = await getAllUserHandles();
        const results = [];

        for (const handle of allHandles) {
            const dirs = getUserDirectories(handle);
            if (!fs.existsSync(dirs.characters)) continue;
            const charFiles = fs.readdirSync(dirs.characters).filter(f => /\.png$/i.test(f));
            if (!charFiles.length) continue;

            // Build a map of filename → best push record using only the small JSON files.
            // This avoids reading any PNG binaries and makes the scan near-instant.
            const pushes = readPendingPushes(handle);
            const charPushMap = new Map();
            for (const push of pushes) {
                for (const cf of (push.character_files || [])) {
                    const existing = charPushMap.get(cf);
                    // Prefer accepted/overwritten records; among those, take the most recent
                    const pushTime = push.processed_at || push.created_at || 0;
                    const existingTime = existing ? (existing.processed_at || existing.created_at || 0) : -1;
                    if (!existing || pushTime > existingTime) {
                        charPushMap.set(cf, push);
                    }
                }
            }

            for (const file of charFiles) {
                const name = file.replace(/\.png$/i, '');
                const push = charPushMap.get(file);
                let boundLorebook = '';
                let isPushed = false;
                let creatorHandle = '';
                const secondaryLorebooks = [];

                if (push) {
                    const status = String(push.status || '').toLowerCase();
                    isPushed = ['accepted', 'overwritten', 'pending'].includes(status);
                    boundLorebook = String(push.pushed_lorebook_name || '').trim();
                    creatorHandle = String(push.effective_creator || push.original_creator_handle || push.creator_handle || '').trim();
                    if (Array.isArray(push.lorebook_bundle)) {
                        push.lorebook_bundle
                            .filter(e => String(e.role || '').toLowerCase() === 'secondary' && e.pushed_lorebook_name)
                            .forEach(e => secondaryLorebooks.push(String(e.pushed_lorebook_name).trim()));
                    }
                }

                results.push({ file, name, bound_lorebook: boundLorebook, secondary_lorebooks: secondaryLorebooks, recipient_handle: handle, creator_handle: creatorHandle, is_pushed: isPushed });
            }
        }

        results.sort((a, b) => a.name.localeCompare(b.name));
        return response.json({ items: results });
    } catch (err) {
        return response.status(500).json({ ok: false, error: err.message });
    }
});

// Admin: delete a specific character file + its bound lorebook from a user's directory.
router.post('/admin-delete-char-file', async (request, response) => {
    if (!request.user.profile?.admin) {
        return response.status(403).send('Admin only');
    }
    const { recipient_handle: handle, file, lorebook } = request.body || {};
    if (!handle || !file) return response.status(400).send('recipient_handle and file are required');

    // Sanitize: only allow simple filenames, no path traversal
    const safeFile = path.basename(file);
    const dirs = getUserDirectories(handle);
    const charPath = path.join(dirs.characters, safeFile);
    if (!fs.existsSync(charPath)) return response.status(404).send('Character file not found');

    try { fs.unlinkSync(charPath); } catch (err) {
        return response.status(500).send(`Failed to delete character: ${err.message}`);
    }

    let lorebookDeleted = false;
    if (lorebook) {
        const safeBook = sanitize(`${lorebook}.json`);
        const bookPath = path.join(dirs.worlds, safeBook);
        if (fs.existsSync(bookPath)) {
            try { fs.unlinkSync(bookPath); lorebookDeleted = true; } catch { /* best-effort */ }
        }
    }

    // Mark any matching push record as admin_deleted
    try {
        const pushes = readPendingPushes(handle);
        let changed = false;
        for (const p of pushes) {
            if ((p.character_files || []).includes(safeFile) && p.status !== 'admin_deleted') {
                p.status = 'admin_deleted';
                p.admin_deleted_at = Date.now();
                changed = true;
            }
        }
        if (changed) writePendingPushes(handle, pushes);
    } catch { /* best-effort */ }

    return response.json({ ok: true, file: safeFile, lorebook_deleted: lorebookDeleted });
});

// Admin: delete a character + bound lorebook from multiple users in one call.
// Body: { file, lorebook, handles: string[] }
// Only deletes character PNG + lorebook JSON — chats and memory lorebooks are untouched.
router.post('/admin-delete-chars-bulk', async (request, response) => {
    if (!request.user.profile?.admin) {
        return response.status(403).send('Admin only');
    }
    const { file, lorebook, handles } = request.body || {};
    if (!file || !Array.isArray(handles) || handles.length === 0) {
        return response.status(400).send('file and handles[] are required');
    }

    const safeFile = path.basename(file);
    const adminHandle = request.user.profile?.handle;
    // default-user and the requesting admin's own account are exempt — they manage their own characters
    const exemptHandles = new Set([DEFAULT_USER.handle, adminHandle].filter(Boolean));
    const results = [];

    for (const handle of handles) {
        if (exemptHandles.has(handle)) {
            results.push({ handle, char_deleted: false, lorebook_deleted: false, error: 'Exempt: manual deletion required' });
            continue;
        }
        const dirs = getUserDirectories(handle);
        const charPath = path.join(dirs.characters, safeFile);
        const entry = { handle, char_deleted: false, lorebook_deleted: false, error: null };

        if (!fs.existsSync(charPath)) {
            entry.error = 'Character file not found';
            results.push(entry);
            continue;
        }

        try {
            fs.unlinkSync(charPath);
            entry.char_deleted = true;
        } catch (err) {
            entry.error = `Failed to delete character: ${err.message}`;
            results.push(entry);
            continue;
        }

        if (lorebook) {
            const safeBook = sanitize(`${lorebook}.json`);
            const bookPath = path.join(dirs.worlds, safeBook);
            if (fs.existsSync(bookPath)) {
                try { fs.unlinkSync(bookPath); entry.lorebook_deleted = true; } catch { /* best-effort */ }
            }
        }

        // Mark any matching push record as admin_deleted
        try {
            const pushes = readPendingPushes(handle);
            let changed = false;
            for (const p of pushes) {
                if ((p.character_files || []).includes(safeFile) && p.status !== 'admin_deleted') {
                    p.status = 'admin_deleted';
                    p.admin_deleted_at = Date.now();
                    changed = true;
                }
            }
            if (changed) writePendingPushes(handle, pushes);
        } catch { /* best-effort */ }

        results.push(entry);
    }

    const succeeded = results.filter(r => r.char_deleted).map(r => r.handle);
    const failed = results.filter(r => !r.char_deleted);
    return response.json({ ok: succeeded.length > 0, succeeded, failed });
});

// Admin: directly delete a pushed character by push_id + recipient_handle (no submission required).
router.post('/admin-direct-delete-char', async (request, response) => {
    if (!request.user.profile?.admin) {
        return response.status(403).send('Admin only');
    }

    const { push_id: pushId, recipient_handle: recipientHandle, scope } = request.body || {};
    if (!pushId || !recipientHandle || !scope) {
        return response.status(400).send('push_id, recipient_handle, and scope are required');
    }
    if (!['user', 'all'].includes(scope)) {
        return response.status(400).send('scope must be "user" or "all"');
    }

    const recipientPushes = readPendingPushes(recipientHandle);
    const sourceItem = recipientPushes.find(p => p.push_id === pushId);
    if (!sourceItem) return response.status(404).send('Push item not found for that user');

    const pushItem = {
        push_id: pushId,
        character_files: sourceItem.character_files || [],
        pushed_lorebook_name: sourceItem.pushed_lorebook_name || '',
        lorebook_bundle: sourceItem.lorebook_bundle || [],
        creator_handle: sourceItem.creator_handle || sourceItem.pushed_by_handle || '',
        effective_creator: sourceItem.effective_creator || sourceItem.creator_handle || '',
    };

    const deleted = [];
    const errors = [];

    if (scope === 'user') {
        const result = deleteUserPushedCharFiles(recipientHandle, pushItem);
        if (result.ok) deleted.push(recipientHandle);
        else errors.push({ handle: recipientHandle, error: result.error });
    } else {
        try {
            const allHandles = await getAllUserHandles();
            for (const userHandle of allHandles) {
                const userPushes = readPendingPushes(userHandle);
                const match = userPushes.find(p =>
                    p.push_id === pushId
                    || (p.creator_handle === pushItem.creator_handle
                        && p.pushed_lorebook_name === pushItem.pushed_lorebook_name
                        && ['accepted', 'overwritten'].includes(String(p.status || '').toLowerCase()))
                );
                if (!match) continue;
                const result = deleteUserPushedCharFiles(userHandle, { ...pushItem, push_id: match.push_id });
                if (result.ok) deleted.push(userHandle);
                else errors.push({ handle: userHandle, error: result.error });
            }
        } catch (err) {
            return response.status(500).json({ ok: false, error: `Failed to enumerate users: ${err.message}` });
        }
    }

    return response.json({ ok: true, scope, deleted_count: deleted.length, deleted_handles: deleted, errors });
});

// Poll for push notifications and pending queue summary.



router.post('/push-notifications', (request, response) => {
    try {
        const handle = request.user.profile?.handle;
        const pending = readPendingPushes(handle)
            .filter(item => isPendingStatus(item.status))
            .map(item => ({ ...item, unread: isUnreadFlag(item.unread) }))
            .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

        const notifDir = path.join(path.dirname(request.user.directories.worlds), 'push-notifications');
        const legacy = [];
        if (fs.existsSync(notifDir)) {
            const files = fs.readdirSync(notifDir).filter(f => f.endsWith('.json')).sort();
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(notifDir, file), 'utf8'));
                    legacy.push(data);
                    fs.unlinkSync(path.join(notifDir, file));
                } catch {
                    // skip bad file
                }
            }
        }

        const submissionUpdates = readAdminSubmissions()
            .filter(x => x.submitter_handle === handle && x.status !== 'pending')
            .map(x => ({
                submission_id: x.submission_id,
                status: x.status,
                reply: x.reply || '',
                updated_at: x.reviewed_at || x.created_at,
            }))
            .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

        const inboxSummary = summarizeUserInbox(readUserInbox(handle));
        const pendingUnread = pending.filter(item => isUnreadFlag(item.unread)).length;

        // For admin users, include pending submission count plus unread admin notes for the admin inbox badge.
        let adminPendingSubmissions = 0;
        let adminUnreadNotes = 0;
        if (request.user.profile?.admin) {
            adminPendingSubmissions = getVisibleAdminSubmissions(handle).filter(x => x.status === 'pending').length;
            adminUnreadNotes = summarizeAdminNotes(readAdminNotes().filter(x => !x.target_admin || x.target_admin === handle)).unread_count;
        }

        return response.json({
            pending_count: pending.length,
            pending_unread_count: pendingUnread,
            inbox_unread_count: inboxSummary.unread_count,
            unread_count: pendingUnread + inboxSummary.unread_count,
            admin_pending_submissions: adminPendingSubmissions + adminUnreadNotes,
            admin_unread_notes: adminUnreadNotes,
            pending,
            submission_updates: submissionUpdates,
            legacy,
        });
    } catch (err) {
        console.error('Failed to read push notifications:', err);
        return response.json({
            pending_count: 0,
            pending_unread_count: 0,
            inbox_unread_count: 0,
            unread_count: 0,
            pending: [],
            submission_updates: [],
            legacy: [],
        });
    }
});

router.post('/push-notifications-clear', (request, response) => {
    const handle = request.user.profile?.handle;
    const action = String(request.body?.action || 'mark_all_read');
    if (!['mark_all_read', 'clear_resolved', 'clear_read'].includes(action)) {
        return response.status(400).send('Invalid action');
    }

    let pending = readPendingPushes(handle);
    if (action === 'mark_all_read') {
        pending = pending.map(item => ({ ...item, unread: false }));
    } else if (action === 'clear_read') {
        pending = pending.filter(item => isUnreadFlag(item.unread));
    } else if (action === 'clear_resolved') {
        pending = pending.filter(item => isPendingStatus(item.status));
    }
    writePendingPushes(handle, pending);

    const pendingActive = pending
        .filter(item => isPendingStatus(item.status))
        .map(item => ({ ...item, unread: isUnreadFlag(item.unread) }));
    const pendingUnread = pendingActive.filter(item => isUnreadFlag(item.unread)).length;
    const inboxSummary = summarizeUserInbox(readUserInbox(handle));
    const adminPendingSubmissions = request.user.profile?.admin
        ? getVisibleAdminSubmissions(handle).filter(x => x.status === 'pending').length
        : 0;
    const adminUnreadNotes = request.user.profile?.admin
        ? summarizeAdminNotes(readAdminNotes().filter(x => !x.target_admin || x.target_admin === handle)).unread_count
        : 0;

    return response.json({
        ok: true,
        pending_count: pendingActive.length,
        pending_unread_count: pendingUnread,
        inbox_unread_count: inboxSummary.unread_count,
        unread_count: pendingUnread + inboxSummary.unread_count,
        admin_pending_submissions: adminPendingSubmissions + adminUnreadNotes,
        admin_unread_notes: adminUnreadNotes,
    });
});

router.post('/user-inbox', (request, response) => {
    const handle = request.user.profile?.handle;
    const items = readUserInbox(handle).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const summary = summarizeUserInbox(items);
    return response.json({
        ...summary,
        items,
    });
});

router.post('/user-inbox-detail', (request, response) => {
    const handle = request.user.profile?.handle;
    const inboxId = request.body?.inbox_id;
    if (!inboxId) return response.status(400).send('inbox_id is required');

    const items = readUserInbox(handle);
    const idx = items.findIndex(x => x.inbox_id === inboxId);
    if (idx === -1) return response.status(404).send('Inbox item not found');

    if (!items[idx].read_at) {
        items[idx].read_at = Date.now();
        writeUserInbox(handle, items);
    }

    return response.json(items[idx]);
});

router.post('/user-inbox-action', (request, response) => {
    const handle = request.user.profile?.handle;
    const action = request.body?.action;
    const inboxId = request.body?.inbox_id;

    const validActions = ['mark_read', 'mark_unread', 'delete', 'clear_read', 'clear_all'];
    if (!validActions.includes(action)) {
        return response.status(400).send('Invalid action');
    }

    let items = readUserInbox(handle);

    if (['mark_read', 'mark_unread', 'delete'].includes(action) && !inboxId) {
        return response.status(400).send('inbox_id is required');
    }

    if (action === 'mark_read') {
        const idx = items.findIndex(x => x.inbox_id === inboxId);
        if (idx === -1) return response.status(404).send('Inbox item not found');
        items[idx].read_at = items[idx].read_at || Date.now();
    }

    if (action === 'mark_unread') {
        const idx = items.findIndex(x => x.inbox_id === inboxId);
        if (idx === -1) return response.status(404).send('Inbox item not found');
        items[idx].read_at = null;
    }

    if (action === 'delete') {
        const next = items.filter(x => x.inbox_id !== inboxId);
        if (next.length === items.length) return response.status(404).send('Inbox item not found');
        items = next;
    }

    if (action === 'clear_read') {
        items = items.filter(x => !x.read_at);
    }

    if (action === 'clear_all') {
        items = [];
    }

    writeUserInbox(handle, items);
    const summary = summarizeUserInbox(items);
    return response.json({ ok: true, ...summary });
});

router.post('/admin-note', async (request, response) => {
    if (!request.user.profile?.admin) {
        return response.status(403).send('Admin note is admin-only');
    }

    const actorHandle = request.user.profile?.handle;
    const actorName = request.user.profile?.name || actorHandle;
    const targets = request.body?.targets;
    const subject = String(request.body?.subject || '').trim();
    const body = String(request.body?.body || '').trim();
    const priority = normalizeInboxPriority(String(request.body?.priority || 'normal'));
    const context = request.body?.context && typeof request.body.context === 'object' ? request.body.context : null;

    if (!subject || !body) {
        return response.status(400).send('subject and body are required');
    }

    const enabledUsers = await getAllUsers();
    const enabledHandles = new Set(enabledUsers.filter(u => u.enabled).map(u => u.handle));
    const normalizedTargets = normalizeTargets(targets, actorHandle, [...enabledHandles]);
    if (!normalizedTargets || normalizedTargets.length === 0) {
        return response.status(400).send('No valid targets selected');
    }

    const delivered = [];
    const failed = [];

    for (const handle of normalizedTargets) {
        try {
            if (!enabledHandles.has(handle)) {
                failed.push(handle);
                continue;
            }
            const created = appendUserInbox(handle, {
                type: 'admin_note',
                title: subject,
                body,
                priority,
                from_handle: actorHandle,
                from_name: actorName,
                context,
            });
            writePushNotification(handle, `Admin note: ${subject}`);
            delivered.push({ handle, inbox_id: created.inbox_id });
        } catch (err) {
            console.warn(`[AdminNote] Failed for ${handle}:`, err.message);
            failed.push(handle);
        }
    }

    return response.json({ ok: true, delivered, failed });
});

router.post('/user-admin-note', async (request, response) => {
    const userHandle = request.user.profile?.handle;
    const userName = request.user.profile?.name || userHandle;
    const message = String(request.body?.message || '').trim();
    const targetAdmin = String(request.body?.target_admin || '').trim();
    const inResponseTo = request.body?.in_response_to_inbox_id;

    if (!message) {
        return response.status(400).send('message is required');
    }

    if (!targetAdmin) {
        return response.status(400).send('target_admin is required');
    }

    try {
        const note = appendAdminNote({
            type: 'user_note',
            from_handle: userHandle,
            from_name: userName,
            target_admin: targetAdmin,
            message,
            priority: 'normal',
            in_response_to_inbox_id: inResponseTo || null,
        });

        writePushNotification(targetAdmin, `User note from ${userName || userHandle}`);
        return response.json({ ok: true, note_id: note.note_id });
    } catch (err) {
        console.error('[UserAdminNote] Failed:', err);
        return response.status(500).send('Failed to send note to admins');
    }
});

router.post('/users/get', async (request, response) => {
    try {
        const includeAvatars = request.body?.include_avatars !== false;
        const users = await getAllUsers();
        let safeUsers = users.map(u => ({
            handle: u.handle,
            name: u.name || u.handle,
            enabled: u.enabled,
            admin: u.admin || false,
        }));

        if (safeUsers.length === 0) {
            const dataRoot = path.join(process.cwd(), 'data');
            /** @type {Set<string>} */
            const discoveredHandles = new Set();

            try {
                const entries = fs.readdirSync(dataRoot, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    const handle = String(entry.name || '').trim();
                    if (!handle || handle.startsWith('_')) continue;
                    discoveredHandles.add(handle);
                }
            } catch {
                // no-op
            }

            const currentHandle = String(request.user.profile?.handle || '').trim();
            if (currentHandle) discoveredHandles.add(currentHandle);

            safeUsers = [...discoveredHandles].map(handle => ({
                handle,
                name: handle,
                enabled: true,
                admin: handle === currentHandle ? !!request.user.profile?.admin : false,
            }));
        }

        if (!includeAvatars) {
            return response.json(safeUsers);
        }

        // Enrich with avatar data (base64 data URI or default path)
        const enriched = await Promise.all(
            safeUsers.map(async u => ({
                ...u,
                avatar: await getUserAvatar(u.handle).catch(() => '/img/default-user.png'),
            })),
        );

        return response.json(enriched);
    } catch (err) {
        console.error('[UsersGet] Failed:', err);
        return response.status(500).send('Failed to retrieve users');
    }
});

// POST /api/worldinfo/user-avatar
// Returns the profile avatar for any given handle.
// Used by inbox detail modals to show the sender's profile picture.
router.post('/user-avatar', async (request, response) => {
    const handle = String(request.body?.handle || '').trim();
    if (!handle) return response.status(400).send('handle required');
    try {
        const avatar = await getUserAvatar(handle);
        return response.json({ avatar });
    } catch {
        return response.json({ avatar: '/img/default-user.png' });
    }
});

router.post('/submit', async (request, response) => {
    const {
        content_type = 'character_lorebook_bundle',
        content_name = '',
        source_lorebook_name = '',
        character_name = '',
        character_avatar = '',
        notes = '',
        priority = 'normal',
        primary_lorebook_name = '',
        secondary_lorebook_name = '',
        secondary_lorebooks = [],
        lorebook_bundle = [],
    } = request.body || {};

    const submitterHandle = request.user.profile?.handle;
    const isAdminSubmitter = Boolean(request.user.profile?.admin);
    const displayName = String(content_name || '').trim();
    const primaryLorebookName = String(primary_lorebook_name || source_lorebook_name || content_name || '').trim();
    const secondaryLorebooks = normalizeLorebookNameList([
        secondary_lorebook_name,
        ...(Array.isArray(secondary_lorebooks) ? secondary_lorebooks : []),
        ...((Array.isArray(lorebook_bundle) ? lorebook_bundle : [])
            .map(entry => String(entry?.role || '').trim().toLowerCase() === 'secondary' ? entry?.source_lorebook_name : '')
            .filter(Boolean)),
    ]).filter(name => name.toLowerCase() !== primaryLorebookName.toLowerCase());
    const sourceLorebookName = String(source_lorebook_name || primary_lorebook_name || content_name || '').trim();
    const characterName = String(character_name || '').trim();
    // Store the avatar PNG filename so the admin can display the thumbnail without
    // relying on the lorebook-name → character lookup (which can fail on name mismatch).
    const characterFiles = character_avatar ? [sanitize(String(character_avatar))] : [];

    if (!displayName) return response.status(400).send('content_name is required');
    if (!primaryLorebookName) return response.status(400).send('primary_lorebook_name or source_lorebook_name is required');
    const displayNameError = getSubmissionLorebookNameValidationError(displayName, submitterHandle, isAdminSubmitter);
    if (displayNameError) return response.status(400).send(displayNameError);
    const primaryLorebookNameError = getSubmissionLorebookNameValidationError(primaryLorebookName, submitterHandle, isAdminSubmitter);
    if (primaryLorebookNameError) return response.status(400).send(primaryLorebookNameError);
    const sourceLorebookNameError = getSubmissionLorebookNameValidationError(sourceLorebookName, submitterHandle, isAdminSubmitter);
    if (sourceLorebookNameError) return response.status(400).send(sourceLorebookNameError);
    const invalidSecondaryLorebook = secondaryLorebooks.find(name => getSubmissionLorebookNameValidationError(name, submitterHandle, isAdminSubmitter));
    if (invalidSecondaryLorebook) {
        return response.status(400).send(getSubmissionLorebookNameValidationError(invalidSecondaryLorebook, submitterHandle, isAdminSubmitter));
    }

    // Non-admin submitters keep their local lorebook name. The distributed/admin-side
    // identity is normalized to the absolute prefix rules for the submitter.
    const desiredDistributionName = getSubmissionDistributionLorebookName(displayName, submitterHandle, isAdminSubmitter);
    const submissionTitle = desiredDistributionName;
    const targetAdminHandle = getSubmissionTargetAdminHandle(submitterHandle, isAdminSubmitter);
    // Rename the local lorebook file when the user typed a different name in the
    // rename field (content_name !== source_lorebook_name). The renamed file becomes
    // the submission source so the admin always sees the dd-prefixed name on disk.
    let effectiveSourceLorebookName = sourceLorebookName;
    const renameMeta = primaryLorebookName !== displayName
        ? await renameLorebookForSubmission(request, primaryLorebookName, displayName, characterName)
        : { renamed: false, updated_characters: [] };

    if (renameMeta.renamed) {
        effectiveSourceLorebookName = displayName;
    }

    const submissionLorebookBundle = Array.isArray(lorebook_bundle) && lorebook_bundle.length > 0
        ? normalizeLorebookBundleEntries(lorebook_bundle)
        : buildSubmissionLorebookBundle({
            primarySourceLorebookName: effectiveSourceLorebookName,
            primaryPushedLorebookName: submissionTitle,
            secondarySourceLorebooks: secondaryLorebooks,
            creatorHandle: submitterHandle,
            isAdminSubmission: Boolean(request.user.profile?.admin),
        });

    const submission = {
        submission_id: makeId('submission'),
        content_type,
        content_name: submissionTitle,
        source_lorebook_name: effectiveSourceLorebookName,
        primary_lorebook_name: primaryLorebookName,
        secondary_lorebook_name: secondaryLorebooks[0] || undefined,
        secondary_lorebooks: secondaryLorebooks,
        lorebook_bundle: submissionLorebookBundle,
        character_name: characterName,
        character_files: characterFiles,
        notes: String(notes || ''),
        priority: ['low', 'normal', 'high'].includes(priority) ? priority : 'normal',
        submitter_handle: request.user.profile?.handle,
        submitter_name: request.user.profile?.name || request.user.profile?.handle,
        submitter_is_admin: isAdminSubmitter,
        target_admin_handle: targetAdminHandle,
        status: 'pending',
        created_at: Date.now(),
        reviewed_at: null,
        reviewed_by: null,
        reply: '',
    };

    const all = readAdminSubmissions();
    all.push(submission);
    writeAdminSubmissions(all);

    // Snapshot the submitter's character PNG(s) into the stable submissions thumbs
    // directory so they remain available for admin review and push even if the
    // submitter later renames or deletes the file from their own characters folder.
    try {
        const submitterCharsDir = getUserDirectories(submitterHandle).characters;
        const thumbDir = path.join(SUBMISSION_THUMBS_DIR, submitterHandle);
        if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
        for (const charFile of characterFiles) {
            const srcPath = path.join(submitterCharsDir, charFile);
            if (fs.existsSync(srcPath)) {
                fs.copyFileSync(srcPath, path.join(thumbDir, charFile));
            }
        }
    } catch (snapErr) {
        console.warn('[Submit] Failed to snapshot character thumb:', snapErr.message);
    }

    // Notify admins with details about the submission and renaming
    try {
        const admins = normalizeLorebookNameList([targetAdminHandle]);
        const submitterName = request.user.profile?.name || submitterHandle;
        const finalName = submissionTitle;
        const wasRenamed = renameMeta.renamed;
        const renameInfo = wasRenamed ? ` (renamed from "${sourceLorebookName}")` : '';
        const adminNotification = `New user submission from ${submitterName}: "${finalName}"${renameInfo}`;

        for (const adminHandle of admins) {
            if (adminHandle !== request.user.profile?.handle) {
                writePushNotification(adminHandle, adminNotification);
            }
        }
    } catch {
        // no-op
    }

    // Notify the submitter that their submission was received
    try {
        const userNotification = `Submitted: "${effectiveSourceLorebookName}" (will be distributed as "${submissionTitle}")`;
        writePushNotification(submitterHandle, userNotification);
    } catch {
        // no-op
    }

    return response.json({
        ok: true,
        submission,
        renamed_source_lorebook: renameMeta.renamed,
        rebound_character_files: renameMeta.updated_characters,
        submission_details: {
            content_name: submission.content_name,
            source_lorebook_name: effectiveSourceLorebookName,
            secondary_lorebooks: submission.secondary_lorebooks || [],
            was_renamed: renameMeta.renamed,
            original_name: sourceLorebookName,
            final_name: effectiveSourceLorebookName,
            distribution_name: submissionTitle,
            naming_info: `Your local lorebook stays "${effectiveSourceLorebookName}" and will be distributed as "${submissionTitle}"`,
            characters_updated: renameMeta.updated_characters.length,
            status: 'pending_admin_review',
            next_step: 'Admin will review and approve your submission',
        },
    });
});

router.post('/admin-inbox', (request, response) => {
    if (!request.user.profile?.admin) {
        return response.status(403).send('Admin inbox is admin-only');
    }
    const handle = request.user.profile?.handle;
    const submissions = getVisibleAdminSubmissions(handle)
        .map(item => ({ ...item, inbox_item_type: item.inbox_item_type || 'submission' }));
    const notes = readAdminNotes()
        .filter(item => !item.target_admin || item.target_admin === handle)
        .map(item => ({ ...item, inbox_item_type: 'admin_note' }));
    const items = [...submissions, ...notes]
        .map(normalizeAdminInboxItem)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const noteSummary = summarizeAdminNotes(notes);
    return response.json({
        total: items.length,
        pending: submissions.filter(x => x.status === 'pending').length + noteSummary.pending_count,
        unread_notes: noteSummary.unread_count,
        items,
    });
});

router.post('/admin-push-diagnostics', async (request, response) => {
    if (!request.user.profile?.admin) {
        return response.status(403).send('Push diagnostics are admin-only');
    }

    const startedAt = Date.now();
    const adminHandle = String(request.user.profile?.handle || '').trim();
    const checks = [];
    const pushCheck = (name, ok, detail, extra = undefined) => {
        checks.push({
            name,
            ok: Boolean(ok),
            detail: String(detail || ''),
            ...(extra && typeof extra === 'object' ? { extra } : {}),
        });
    };

    try {
        const adminDirs = request.user.directories || {};
        pushCheck(
            'Admin Identity',
            Boolean(adminHandle),
            adminHandle ? `Authenticated as ${adminHandle}` : 'Missing admin handle',
            { admin_handle: adminHandle || null },
        );

        const worldsDir = String(adminDirs.worlds || '');
        const charactersDir = String(adminDirs.characters || '');
        pushCheck(
            'Admin Worlds Directory',
            Boolean(worldsDir) && fs.existsSync(worldsDir),
            worldsDir ? `Path ${worldsDir}` : 'No worlds directory configured',
        );
        pushCheck(
            'Admin Characters Directory',
            Boolean(charactersDir) && fs.existsSync(charactersDir),
            charactersDir ? `Path ${charactersDir}` : 'No characters directory configured',
        );

        const adminSubmissions = getVisibleAdminSubmissions(adminHandle);
        const pendingSubmissions = adminSubmissions.filter(x => String(x.status || 'pending') === 'pending').length;
        pushCheck(
            'Admin Submission Store',
            fs.existsSync(ADMIN_SUBMISSIONS_PATH),
            `${adminSubmissions.length} total submissions, ${pendingSubmissions} pending`,
            { total: adminSubmissions.length, pending: pendingSubmissions, path: ADMIN_SUBMISSIONS_PATH },
        );

        const adminNotes = readAdminNotes().filter(item => !item.target_admin || item.target_admin === adminHandle);
        const adminNotesSummary = summarizeAdminNotes(adminNotes);
        pushCheck(
            'Admin Notes Store',
            fs.existsSync(ADMIN_NOTES_PATH),
            `${adminNotesSummary.total} visible notes, ${adminNotesSummary.unread_count} unread, ${adminNotesSummary.pending_count} pending`,
            { ...adminNotesSummary, path: ADMIN_NOTES_PATH },
        );

        const adminPending = readPendingPushes(adminHandle);
        const adminPendingActive = adminPending.filter(item => isPendingStatus(item.status));
        const adminPendingUnread = adminPendingActive.filter(item => isUnreadFlag(item.unread)).length;
        pushCheck(
            'Admin Pending Push Queue',
            true,
            `${adminPendingActive.length} pending items, ${adminPendingUnread} unread`,
            { total: adminPending.length, pending: adminPendingActive.length, unread: adminPendingUnread },
        );

        const adminInbox = readUserInbox(adminHandle);
        const adminInboxSummary = summarizeUserInbox(adminInbox);
        pushCheck(
            'Admin User Inbox',
            true,
            `${adminInboxSummary.total} inbox items, ${adminInboxSummary.unread_count} unread`,
            adminInboxSummary,
        );

        const adminManifest = readPushManifest(adminHandle);
        const adminManifestPath = getPushManifestPath(adminHandle);
        pushCheck(
            'Admin Push Manifest',
            fs.existsSync(adminManifestPath),
            `${adminManifest.length} tracked push record(s)`,
            { total: adminManifest.length, path: adminManifestPath },
        );

        const notifDir = path.join(path.dirname(adminDirs.worlds || ''), 'push-notifications');
        const notificationFiles = fs.existsSync(notifDir)
            ? fs.readdirSync(notifDir).filter(file => file.endsWith('.json'))
            : [];
        pushCheck(
            'Admin Notification Spool',
            fs.existsSync(notifDir),
            `${notificationFiles.length} queued notification file(s)`,
            { total: notificationFiles.length, path: notifDir },
        );

        const allUsers = await getAllUsers();
        const enabledUsers = allUsers.filter(user => user.enabled);
        const adminUsers = enabledUsers.filter(user => user.admin);
        pushCheck(
            'Enabled User Registry',
            enabledUsers.length > 0,
            `${enabledUsers.length} enabled user(s), ${adminUsers.length} admin(s)`,
            { enabled_users: enabledUsers.length, admin_users: adminUsers.length },
        );

        let aggregatePending = 0;
        let aggregateUnread = 0;
        for (const user of enabledUsers) {
            const userPending = readPendingPushes(user.handle).filter(item => isPendingStatus(item.status));
            aggregatePending += userPending.length;
            aggregateUnread += userPending.filter(item => isUnreadFlag(item.unread)).length;
        }
        pushCheck(
            'Recipient Queue Aggregate',
            true,
            `${aggregatePending} pending push item(s) across enabled users, ${aggregateUnread} unread`,
            { pending_total: aggregatePending, unread_total: aggregateUnread },
        );

        const finishedAt = Date.now();
        const passed = checks.filter(check => check.ok).length;
        const failed = checks.length - passed;

        return response.json({
            ok: true,
            run: {
                started_at: startedAt,
                finished_at: finishedAt,
                duration_ms: Math.max(0, finishedAt - startedAt),
                admin_handle: adminHandle,
            },
            summary: {
                total: checks.length,
                passed,
                failed,
            },
            checks,
        });
    } catch (err) {
        console.error('Failed to run admin push diagnostics:', err);
        const finishedAt = Date.now();
        return response.status(500).json({
            ok: false,
            run: {
                started_at: startedAt,
                finished_at: finishedAt,
                duration_ms: Math.max(0, finishedAt - startedAt),
                admin_handle: adminHandle || null,
            },
            error: String(err?.message || err),
            checks,
        });
    }
});

router.post('/admin-inbox-clear', (request, response) => {
    if (!request.user.profile?.admin) {
        return response.status(403).send('Admin inbox is admin-only');
    }

    const handle = request.user.profile?.handle;
    const action = String(request.body?.action || 'clear_processed');
    if (!['clear_processed', 'clear_all'].includes(action)) {
        return response.status(400).send('Invalid action');
    }

    const beforeSubmissions = readAdminSubmissions();
    const beforeNotes = readAdminNotes();
    const visibleSubmissionIds = new Set(getVisibleAdminSubmissions(handle).map(item => item.submission_id));
    let nextSubmissions = beforeSubmissions;
    let nextNotes = beforeNotes;
    if (action === 'clear_processed') {
        nextSubmissions = beforeSubmissions.filter(item => item.status === 'pending' || !visibleSubmissionIds.has(item.submission_id));
        nextNotes = beforeNotes.filter(item => String(item.status || 'pending') === 'pending');
    } else if (action === 'clear_all') {
        nextSubmissions = beforeSubmissions.filter(item => !visibleSubmissionIds.has(item.submission_id));
        nextNotes = [];
    }

    writeAdminSubmissions(nextSubmissions);
    writeAdminNotes(nextNotes);
    const visibleSubmissions = nextSubmissions.filter(item => canAdminAccessSubmission(item, handle));
    const visibleNotes = nextNotes.filter(item => !item.target_admin || item.target_admin === handle);
    return response.json({
        ok: true,
        removed: Math.max(0, (beforeSubmissions.length + beforeNotes.length) - (nextSubmissions.length + nextNotes.length)),
        total: visibleSubmissions.length + visibleNotes.length,
        pending: visibleSubmissions.filter(x => x.status === 'pending').length + summarizeAdminNotes(visibleNotes).pending_count,
    });
});

router.post('/admin-inbox-detail', async (request, response) => {
    if (!request.user.profile?.admin) {
        return response.status(403).send('Admin inbox is admin-only');
    }

    const submissionId = request.body?.submission_id;
    const noteId = request.body?.note_id;
    if (!submissionId && !noteId) return response.status(400).send('submission_id or note_id is required');

    if (noteId) {
        const notes = readAdminNotes();
        const idx = notes.findIndex(x => x.note_id === noteId);
        if (idx === -1) return response.status(404).send('Admin note not found');
        if (!notes[idx].read_at) {
            notes[idx].read_at = Date.now();
            writeAdminNotes(notes);
        }
        return response.json({
            ...notes[idx],
            inbox_item_type: 'admin_note',
            item_id: notes[idx].note_id,
        });
    }

    const submission = readAdminSubmissions().find(x => x.submission_id === submissionId);
    if (!submission) return response.status(404).send('Submission not found');
    if (!canAdminAccessSubmission(submission, request.user.profile?.handle)) {
        return response.status(403).send('This submission is assigned to another admin');
    }

    // Enrich with bound character names from the submitter's files.
    let boundCharacters = [];
    try {
        if (submission.submitter_handle && submission.content_name) {
            const submitterDirs = getUserDirectories(submission.submitter_handle);
            const lookupLorebookName = String(submission.source_lorebook_name || submission.content_name || '');
            boundCharacters = await findCharactersByWorld(submitterDirs, lookupLorebookName);
        }
    } catch (err) {
        console.warn('[AdminInboxDetail] Failed to look up bound characters:', err.message);
    }

    return response.json({ ...submission, inbox_item_type: submission.inbox_item_type || 'submission', item_id: submission.submission_id, bound_characters: boundCharacters });
});

router.post('/admin-inbox-action', (request, response) => {
    if (!request.user.profile?.admin) {
        return response.status(403).send('Admin inbox is admin-only');
    }

    const submissionId = request.body?.submission_id;
    const noteId = request.body?.note_id;
    const action = request.body?.action;
    const reply = String(request.body?.reply || '');

    if ((!submissionId && !noteId) || !action) {
        return response.status(400).send('submission_id or note_id, and action are required');
    }

    if (noteId) {
        const notes = readAdminNotes();
        const idx = notes.findIndex(x => x.note_id === noteId);
        if (idx === -1) return response.status(404).send('Admin note not found');

        if (action === 'delete') {
            notes.splice(idx, 1);
            writeAdminNotes(notes);
            return response.json({ ok: true, deleted: true, note_id: noteId });
        }
        if (!['reviewed'].includes(action)) return response.status(400).send('Invalid action');

        notes[idx].status = 'reviewed';
        notes[idx].read_at = notes[idx].read_at || Date.now();
        notes[idx].reviewed_at = Date.now();
        notes[idx].reviewed_by = request.user.profile?.handle;
        if (reply) {
            notes[idx].admin_reply = reply;
        }
        writeAdminNotes(notes);

        try {
            if (reply && notes[idx].from_handle) {
                const actorHandle = request.user.profile?.handle;
                const actorName = request.user.profile?.name || actorHandle;
                appendUserInbox(notes[idx].from_handle, {
                    type: 'admin_note_reply',
                    title: 'Reply from admin',
                    body: reply,
                    priority: notes[idx].priority || 'normal',
                    from_handle: actorHandle,
                    from_name: actorName,
                    status: 'reviewed',
                    context: {
                        note_id: notes[idx].note_id,
                        target_admin: notes[idx].target_admin || null,
                    },
                });
                writePushNotification(notes[idx].from_handle, 'Admin replied to your note');
            }
        } catch (err) {
            console.warn('[AdminInbox] Failed to reply to admin note submitter:', err.message);
        }

        return response.json({ ok: true, note: notes[idx] });
    }

    const actionToStatus = {
        approve: 'approved',
        reviewed: 'reviewed',
        reject: 'rejected',
        delete: null,
    };
    if (!actionToStatus.hasOwnProperty(action)) return response.status(400).send('Invalid action');

    const all = readAdminSubmissions();
    const idx = all.findIndex(x => x.submission_id === submissionId);
    if (idx === -1) return response.status(404).send('Submission not found');
    if (!canAdminAccessSubmission(all[idx], request.user.profile?.handle)) {
        return response.status(403).send('This submission is assigned to another admin');
    }

    // Delete action: remove the submission entirely.
    // Deletion requests can be dismissed at any status; regular submissions require processing first.
    if (action === 'delete') {
        if (all[idx].status === 'pending' && all[idx].inbox_item_type !== 'deletion_request') {
            return response.status(400).send('Cannot delete a pending submission. Approve, review, or reject it first.');
        }
        all.splice(idx, 1);
        writeAdminSubmissions(all);
        return response.json({ ok: true, deleted: true });
    }

    if (action === 'approve') {
        let applyApproval;
        try {
            applyApproval = approveSubmissionForAdmin(all[idx], request.user.profile?.handle);
        } catch (err) {
            console.error('[AdminInbox] approveSubmissionForAdmin threw an exception:', err);
            return response.status(500).json({
                ok: false,
                error: `Approval failed with error: ${err.message}`,
            });
        }
        if (!applyApproval.ok) {
            return response.status(applyApproval.status || 500).json({
                ok: false,
                error: applyApproval.reason || 'Approval failed to apply submitted content',
            });
        }
        all[idx].applied_push_id = applyApproval.push_id;
        all[idx].applied_at = Date.now();
        all[idx].applied_characters = applyApproval.applied?.characters || [];
        all[idx].applied_lorebook = applyApproval.applied?.lorebook || null;
    }

    all[idx].status = actionToStatus[action];
    all[idx].reviewed_at = Date.now();
    all[idx].reviewed_by = request.user.profile?.handle;
    all[idx].reply = reply;
    writeAdminSubmissions(all);

    try {
        const submission = all[idx];
        const shouldNotifySubmitter = !!submission?.submitter_handle && (!!reply || submission.status !== 'pending');
        if (shouldNotifySubmitter) {
            const actorHandle = request.user.profile?.handle;
            const actorName = request.user.profile?.name || actorHandle;
            const statusTitle = `Submission ${submission.status}`;
            const statusBody = reply
                ? reply
                : `Your submission "${submission.content_name}" was marked ${submission.status}.`;

            appendUserInbox(submission.submitter_handle, {
                type: 'submission_reply',
                title: statusTitle,
                body: statusBody,
                priority: submission.priority || 'normal',
                from_handle: actorHandle,
                from_name: actorName,
                status: submission.status,
                context: {
                    submission_id: submission.submission_id,
                    content_type: submission.content_type,
                    content_name: submission.content_name,
                    source_lorebook_name: submission.source_lorebook_name || submission.content_name,
                    character_name: submission.character_name || null,
                },
            });
            // Enhanced notification with distribution name details
            if (action === 'approve') {
                const contentName = submission.content_name || '';
                const finalDistributionName = getSubmissionDistributionLorebookName(
                    contentName,
                    submission.submitter_handle,
                    Boolean(submission.submitter_is_admin),
                );
                writePushNotification(submission.submitter_handle, `APPROVED: "${contentName}" will be distributed as "${finalDistributionName}"`);
            } else if (action === 'reject') {
                const declineReason = reply || 'No reason provided';
                writePushNotification(submission.submitter_handle, `REJECTED: "${submission.content_name}" - ${declineReason}`);
            } else {
                writePushNotification(submission.submitter_handle, `${statusTitle}: ${submission.content_name}`);
            }
        }
    } catch (err) {
        console.warn('[AdminInbox] Failed to notify submitter:', err.message);
    }

    return response.json({ ok: true, submission: all[idx] });
});
