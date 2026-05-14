/*
 * ============================================================================
 * DREAMTAVERN CUSTOMIZATION - Co-Author Collaborative Character Editing
 * ============================================================================
 *
 * Allows up to 3 designated co-authors per character to propose full
 * character card edits. Admin reviews a field-by-field diff, approves
 * or rejects, and on approval the updated card is queued as a pending
 * push to all existing manifest recipients.
 *
 * Data files:
 *   data/_co-authors.json              — co-author registry
 *   data/admin-submissions.json        — shared with Push Bot (is_coauthor_edit: true)
 *   data/{handle}/pending-pushes.json  — recipients get update push on approval
 *   data/{handle}/user-inbox.json      — inbox notification on co-author assignment
 *
 * API routes:
 *   Admin-only:
 *     POST /api/coauthors/assign           Add/remove a co-author for a character
 *     POST /api/coauthors/list             List all co-author assignments
 *     POST /api/coauthors/pending-edits    List pending co-author submissions
 *     POST /api/coauthors/admin-action     Approve / reject a submission
 *     POST /api/coauthors/history         List reviewed submissions
 *
 *   Authenticated (co-author verified per-request):
 *     POST /api/coauthors/my-assignments   Characters this user can edit + current values
 *     POST /api/coauthors/submit-edit      Submit a proposed character edit
 *     POST /api/coauthors/my-submissions   This user's submission history
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import {
    requireAdminMiddleware,
    getUserDirectories,
    getAllUserHandles,
    getAllUsers,
} from '../users.js';
import { readPushManifest } from './worldinfo.js';
import { read as readCharacterCard, write as writeCharacterCard } from '../character-card-parser.js';

export const router = express.Router();

// ── Paths ────────────────────────────────────────────────────────────────────

const CO_AUTHORS_PATH       = path.join(process.cwd(), 'data', '_co-authors.json');
const ADMIN_SUBMISSIONS_PATH = path.join(process.cwd(), 'data', 'admin-submissions.json');
const COAUTHOR_REQUESTS_PATH = path.join(process.cwd(), 'data', '_coauthor-requests.json');

// ── Character card fields exposed for co-author editing ───────────────────────

const COAUTHOR_FIELDS = [
    'description',
    'personality',
    'scenario',
    'mes_example',
    'system_prompt',
    'creator_notes',
];

// ── Lorebook entry fields exposed for co-author editing ───────────────────────

const COAUTHOR_LOREBOOK_FIELDS = ['comment', 'content', 'key', 'keysecondary', 'disable'];
const CHARACTER_REGISTRY_KEY_SEPARATOR = '::';

// ── Utility helpers ───────────────────────────────────────────────────────────

function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function uniqueStrings(values) {
    return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

function makeCharacterRegistryKey(ownerHandle, characterFile) {
    const normalizedOwnerHandle = String(ownerHandle || '').trim();
    const normalizedCharacterFile = String(characterFile || '').trim();

    if (!normalizedOwnerHandle || !normalizedCharacterFile) {
        return '';
    }

    return `${normalizedOwnerHandle}${CHARACTER_REGISTRY_KEY_SEPARATOR}${normalizedCharacterFile}`;
}

function parseCharacterRegistryKey(characterRegistryKey) {
    const rawKey = String(characterRegistryKey || '').trim();
    const separatorIndex = rawKey.indexOf(CHARACTER_REGISTRY_KEY_SEPARATOR);

    if (!rawKey || separatorIndex === -1) {
        return {
            character_registry_key: rawKey,
            owner_handle: '',
            character_file: rawKey,
        };
    }

    return {
        character_registry_key: rawKey,
        owner_handle: rawKey.slice(0, separatorIndex),
        character_file: rawKey.slice(separatorIndex + CHARACTER_REGISTRY_KEY_SEPARATOR.length),
    };
}

function getCharacterIdentity(payload = {}, fileField = 'character_file') {
    const registryKey = String(payload.character_registry_key || '').trim();
    const parsedRegistryKey = parseCharacterRegistryKey(registryKey);
    const ownerHandle = String(payload.owner_handle || parsedRegistryKey.owner_handle || '').trim();
    const characterFile = String(payload[fileField] || parsedRegistryKey.character_file || '').trim();

    return {
        owner_handle: ownerHandle,
        character_file: characterFile,
        character_registry_key: makeCharacterRegistryKey(ownerHandle, characterFile) || registryKey,
    };
}

function normalizeCoAuthorEntry(rawEntry, fallbackCharacterFile = '', fallbackOwnerHandle = '') {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        return null;
    }

    const ownerHandle = String(rawEntry.owner_handle || fallbackOwnerHandle || '').trim();
    const characterFile = String(rawEntry.character_file || fallbackCharacterFile || '').trim();

    if (!ownerHandle || !characterFile) {
        return null;
    }

    return {
        character_file: characterFile,
        character_display_name: String(rawEntry.character_display_name || characterFile),
        owner_handle: ownerHandle,
        co_authors: uniqueStrings(rawEntry.co_authors),
        assigned_at: Number(rawEntry.assigned_at) || Date.now(),
    };
}

function normalizeCoAuthorRegistry(registry) {
    const normalizedRegistry = {};

    for (const [rawKey, rawEntry] of Object.entries(registry || {})) {
        const parsedKey = parseCharacterRegistryKey(rawKey);
        const normalizedEntry = normalizeCoAuthorEntry(rawEntry, parsedKey.character_file || rawKey, parsedKey.owner_handle);
        if (!normalizedEntry) {
            continue;
        }

        const normalizedKey = makeCharacterRegistryKey(normalizedEntry.owner_handle, normalizedEntry.character_file);
        const existingEntry = normalizedRegistry[normalizedKey];

        if (existingEntry) {
            existingEntry.co_authors = uniqueStrings([...existingEntry.co_authors, ...normalizedEntry.co_authors]);
            existingEntry.assigned_at = Math.min(existingEntry.assigned_at || Date.now(), normalizedEntry.assigned_at || Date.now());
            if (!existingEntry.character_display_name && normalizedEntry.character_display_name) {
                existingEntry.character_display_name = normalizedEntry.character_display_name;
            }
            continue;
        }

        normalizedRegistry[normalizedKey] = normalizedEntry;
    }

    return normalizedRegistry;
}

function resolveRegisteredCharacter(registry, payload = {}, fileField = 'character_file') {
    const identity = getCharacterIdentity(payload, fileField);

    if (identity.character_registry_key && registry[identity.character_registry_key]) {
        return {
            ...identity,
            entry: registry[identity.character_registry_key],
        };
    }

    if (identity.owner_handle && identity.character_file) {
        const computedKey = makeCharacterRegistryKey(identity.owner_handle, identity.character_file);
        if (computedKey && registry[computedKey]) {
            return {
                ...identity,
                character_registry_key: computedKey,
                entry: registry[computedKey],
            };
        }
    }

    return null;
}

function getSubmissionCharacterRegistryKey(submission) {
    const directKey = String(submission?.character_registry_key || '').trim();
    if (directKey) {
        return directKey;
    }

    const ownerHandle = String(submission?.target_character_owner || '').trim();
    const characterFile = String(submission?.target_character_file || '').trim();
    return makeCharacterRegistryKey(ownerHandle, characterFile) || characterFile;
}

function getRequestCharacterRegistryKey(requestRecord) {
    const directKey = String(requestRecord?.character_registry_key || '').trim();
    if (directKey) {
        return directKey;
    }

    const ownerHandle = String(requestRecord?.character_owner_handle || '').trim();
    const characterFile = String(requestRecord?.character_file || '').trim();
    return makeCharacterRegistryKey(ownerHandle, characterFile) || characterFile;
}

function getAdminHandles(users) {
    if (!Array.isArray(users) || users.length === 0) {
        return [];
    }

    return uniqueStrings(users.filter(user => user?.admin).map(user => user.handle));
}

function readCoAuthors() {
    try {
        if (!fs.existsSync(CO_AUTHORS_PATH)) return {};
        const parsed = JSON.parse(fs.readFileSync(CO_AUTHORS_PATH, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }

        return normalizeCoAuthorRegistry(parsed);
    } catch {
        return {};
    }
}

function writeCoAuthors(registry) {
    writeFileAtomicSync(CO_AUTHORS_PATH, JSON.stringify(normalizeCoAuthorRegistry(registry), null, 2));
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
    writeFileAtomicSync(getPendingPushesPath(handle), JSON.stringify(items, null, 2));
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
    writeFileAtomicSync(getUserInboxPath(handle), JSON.stringify(items, null, 2));
}

function appendUserInbox(handle, item) {
    const inbox = readUserInbox(handle);
    const record = {
        inbox_id: makeId('inbox'),
        type: item.type || 'system',
        title: String(item.title || ''),
        body: String(item.body || ''),
        priority: 'normal',
        from_handle: item.from_handle || null,
        from_name: item.from_name || item.from_handle || 'System',
        created_at: Date.now(),
        read_at: null,
        status: item.status || null,
        context: item.context && typeof item.context === 'object' ? item.context : null,
    };
    inbox.push(record);
    writeUserInbox(handle, inbox);
    return record;
}

/**
 * Read the current editable character fields from a PNG file.
 * Returns null if the file can't be read.
 */
function readCharacterFields(pngPath) {
    try {
        const buf = fs.readFileSync(pngPath);
        const raw = readCharacterCard(buf);
        const parsed = JSON.parse(raw);
        const data = parsed?.data || parsed || {};
        const result = {};
        for (const field of COAUTHOR_FIELDS) {
            result[field] = String(data[field] ?? parsed[field] ?? '');
        }
        return { fields: result, fullJson: parsed };
    } catch (err) {
        console.warn(`[CoAuthor] Failed to read character fields from ${pngPath}:`, err.message);
        return null;
    }
}

/**
 * Read the lorebook world-name from a character JSON blob (for pending push creation).
 */
function getCharacterWorldName(charJson) {
    return charJson?.data?.extensions?.world
        || charJson?.data?.extensions?.dreamtavern_pushed_world
        || charJson?.data?.extensions?.dreamtavern_pushed_lorebook_name
        || '';
}

function readCoAuthorRequests() {
    try {
        if (!fs.existsSync(COAUTHOR_REQUESTS_PATH)) return [];
        const parsed = JSON.parse(fs.readFileSync(COAUTHOR_REQUESTS_PATH, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeCoAuthorRequests(items) {
    writeFileAtomicSync(COAUTHOR_REQUESTS_PATH, JSON.stringify(items, null, 2));
}

// ── Lorebook helpers ──────────────────────────────────────────────────────────

function getLorebookPath(ownerHandle, lorebookName) {
    const dirs = getUserDirectories(ownerHandle);
    return path.join(dirs.worlds, `${lorebookName}.json`);
}

function readLorebook(lorebookPath) {
    try {
        if (!fs.existsSync(lorebookPath)) return null;
        return JSON.parse(fs.readFileSync(lorebookPath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Apply an array of lorebook change records to an entries object.
 * changes: [{ action: 'edit'|'add'|'delete', entry_uid?, proposed? }]
 * Returns a new entries object (shallow clone, modified keys deep-cloned).
 */
function applyLorebookChanges(entries, changes) {
    const result = {};
    for (const k of Object.keys(entries)) {
        result[k] = { ...entries[k] };
    }
    for (const change of changes) {
        if (change.action === 'edit') {
            const key = Object.keys(result).find(k => result[k].uid === change.entry_uid);
            if (key && change.proposed) {
                result[key] = { ...result[key] };
                for (const field of COAUTHOR_LOREBOOK_FIELDS) {
                    if (change.proposed[field] !== undefined) {
                        result[key][field] = change.proposed[field];
                    }
                }
            }
        } else if (change.action === 'add') {
            const numKeys = Object.keys(result).map(Number).filter(n => !isNaN(n));
            const maxKey = numKeys.length > 0 ? Math.max(...numKeys) : -1;
            const newKey = String(maxKey + 1);
            const uids = Object.values(result).map(e => typeof e.uid === 'number' ? e.uid : 0);
            const newUid = uids.length > 0 ? Math.max(...uids) + 1 : 0;
            result[newKey] = {
                uid: newUid,
                key: Array.isArray(change.proposed?.key) ? change.proposed.key : [],
                keysecondary: Array.isArray(change.proposed?.keysecondary) ? change.proposed.keysecondary : [],
                comment: String(change.proposed?.comment || ''),
                content: String(change.proposed?.content || ''),
                disable: Boolean(change.proposed?.disable),
                // Admin-controlled technical fields get safe defaults
                position: 0,
                depth: 4,
                probability: 100,
                constant: false,
                order: 100,
                selectiveLogic: 0,
                addMemo: true,
                insertion_order: 100,
                extensions: {},
            };
        } else if (change.action === 'delete') {
            const key = Object.keys(result).find(k => result[k].uid === change.entry_uid);
            if (key) delete result[key];
        }
    }
    return result;
}

// ── Submission counts helper for overview ─────────────────────────────────────

function pendingSubmissionCountByChar() {
    const subs = readAdminSubmissions();
    const counts = {};
    for (const s of subs) {
        if (s.is_coauthor_edit && s.status === 'pending') {
            const characterRegistryKey = getSubmissionCharacterRegistryKey(s);
            counts[characterRegistryKey] = (counts[characterRegistryKey] || 0) + 1;
        }
    }
    return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/coauthors/assign
 * Add or remove a co-author for a character.
 * Body: { character_file, character_display_name, owner_handle, handle, action: "add"|"remove" }
 */
router.post('/assign', requireAdminMiddleware, (request, response) => {
    const { character_display_name, handle, action } = request.body || {};
    const identity = getCharacterIdentity(request.body || {});
    const characterFile = identity.character_file;
    const effectiveOwner = identity.owner_handle || request.user.profile.handle;
    const characterRegistryKey = makeCharacterRegistryKey(effectiveOwner, characterFile);

    if (!characterFile || !handle || !action) {
        return response.status(400).json({ ok: false, error: 'character_file, handle, and action are required.' });
    }
    if (!['add', 'remove'].includes(action)) {
        return response.status(400).json({ ok: false, error: 'action must be "add" or "remove".' });
    }
    const registry = readCoAuthors();

    if (action === 'add') {
        if (!characterRegistryKey) {
            return response.status(400).json({ ok: false, error: 'owner_handle is required for co-author assignment.' });
        }
        if (!registry[characterRegistryKey]) {
            registry[characterRegistryKey] = {
                character_file: characterFile,
                character_display_name: character_display_name || characterFile,
                owner_handle: effectiveOwner,
                co_authors: [],
                assigned_at: Date.now(),
            };
        }
        const entry = registry[characterRegistryKey];
        if (entry.co_authors.length >= 3) {
            return response.status(400).json({ ok: false, error: 'Maximum of 3 co-authors per character.' });
        }
        if (entry.co_authors.includes(handle)) {
            return response.status(400).json({ ok: false, error: `${handle} is already a co-author of this character.` });
        }
        entry.co_authors.push(handle);
        // Notify the newly assigned co-author via inbox
        try {
            const adminName = request.user.profile?.name || request.user.profile?.handle || 'Admin';
            appendUserInbox(handle, {
                type: 'coauthor_assigned',
                title: '✦ Co-Author Access Granted',
                body: `You have been granted co-author access to "${entry.character_display_name || characterFile}" by ${adminName}. You can now submit proposed edits from the Co-Author Station.`,
                from_handle: request.user.profile?.handle,
                from_name: adminName,
                context: {
                    character_file: characterFile,
                    character_display_name: entry.character_display_name,
                    owner_handle: effectiveOwner,
                    character_registry_key: characterRegistryKey,
                },
            });
        } catch (err) {
            console.warn(`[CoAuthor] Failed to notify ${handle} of co-author assignment:`, err.message);
        }
    } else {
        const resolvedCharacter = resolveRegisteredCharacter(registry, {
            character_registry_key: request.body?.character_registry_key,
            owner_handle: effectiveOwner,
            character_file: characterFile,
        });
        if (!resolvedCharacter) {
            return response.status(404).json({ ok: false, error: 'No co-author entry found for this character.' });
        }
        registry[resolvedCharacter.character_registry_key].co_authors = registry[resolvedCharacter.character_registry_key].co_authors.filter(h => h !== handle);
        if (registry[resolvedCharacter.character_registry_key].co_authors.length === 0) {
            delete registry[resolvedCharacter.character_registry_key];
        }
    }

    writeCoAuthors(registry);
    return response.json({ ok: true, registry });
});

/**
 * POST /api/coauthors/list
 * List all co-author assignments with pending submission counts per character.
 * Returns a flat array sorted by character name.
 */
router.post('/list', requireAdminMiddleware, (request, response) => {
    const registry = readCoAuthors();
    const pendingCounts = pendingSubmissionCountByChar();

    const result = Object.entries(registry).map(([characterRegistryKey, entry]) => ({
        character_registry_key: characterRegistryKey,
        character_file: entry.character_file,
        character_display_name: entry.character_display_name || entry.character_file,
        owner_handle: entry.owner_handle,
        co_authors: entry.co_authors || [],
        assigned_at: entry.assigned_at,
        pending_count: pendingCounts[characterRegistryKey] || 0,
    }));

    result.sort((a, b) => (a.character_display_name || '').localeCompare(b.character_display_name || ''));
    return response.json({ ok: true, assignments: result });
});

/**
 * POST /api/coauthors/pending-edits
 * List all pending co-author submissions (is_coauthor_edit: true, status: "pending").
 */
router.post('/pending-edits', requireAdminMiddleware, (request, response) => {
    const subs = readAdminSubmissions().filter(s => s.is_coauthor_edit && s.status === 'pending');
    subs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return response.json({ ok: true, submissions: subs });
});

/**
 * POST /api/coauthors/history
 * List reviewed (approved/rejected) co-author submissions.
 */
router.post('/history', requireAdminMiddleware, (request, response) => {
    const subs = readAdminSubmissions().filter(s => s.is_coauthor_edit && s.status !== 'pending');
    subs.sort((a, b) => (b.reviewed_at || b.created_at || 0) - (a.reviewed_at || a.created_at || 0));
    return response.json({ ok: true, submissions: subs.slice(0, 100) });
});

/**
 * POST /api/coauthors/admin-action
 * Approve or reject a co-author submission.
 * Body: { submission_id, action: "approve"|"reject", reply? }
 *
 * On approve:
 *   1. Apply proposed_fields to the character PNG in the owner's characters dir.
 *   2. For each manifest recipient, queue an update pending-push.
 *   3. Mark submission approved.
 *
 * On reject:
 *   1. Mark submission rejected, record reply.
 */
router.post('/admin-action', requireAdminMiddleware, async (request, response) => {
    const { submission_id, action, reply } = request.body || {};
    if (!submission_id || !action) {
        return response.status(400).json({ ok: false, error: 'submission_id and action are required.' });
    }
    if (!['approve', 'reject'].includes(action)) {
        return response.status(400).json({ ok: false, error: 'action must be "approve" or "reject".' });
    }

    const submissions = readAdminSubmissions();
    const idx = submissions.findIndex(s => s.submission_id === submission_id && s.is_coauthor_edit);
    if (idx === -1) {
        return response.status(404).json({ ok: false, error: 'Co-author submission not found.' });
    }

    const sub = submissions[idx];
    if (sub.status !== 'pending') {
        return response.status(409).json({ ok: false, error: 'Submission is no longer pending.' });
    }

    const adminHandle = request.user.profile?.handle;
    const adminName = request.user.profile?.name || adminHandle;
    const now = Date.now();

    // ── REJECT ────────────────────────────────────────────────────────────────
    if (action === 'reject') {
        sub.status = 'rejected';
        sub.reviewed_at = now;
        sub.reviewed_by = adminHandle;
        sub.reply = String(reply || '');
        submissions[idx] = sub;
        writeAdminSubmissions(submissions);

        // Notify submitter
        try {
            appendUserInbox(sub.submitter_handle, {
                type: 'coauthor_rejected',
                title: `✕ Edit Rejected — ${sub.character_display_name || sub.target_character_file}`,
                body: reply
                    ? `Your proposed edit was reviewed and rejected.\n\nAdmin note: ${reply}`
                    : 'Your proposed edit was reviewed and rejected.',
                from_handle: adminHandle,
                from_name: adminName,
                context: { submission_id, character_file: sub.target_character_file },
            });
        } catch (err) {
            console.warn(`[CoAuthor] Failed to notify submitter of rejection:`, err.message);
        }

        return response.json({ ok: true, submission: sub });
    }

    // ── APPROVE ───────────────────────────────────────────────────────────────
    const ownerHandle = sub.target_character_owner;
    const charFile = sub.target_character_file;

    if (!ownerHandle || !charFile) {
        return response.status(400).json({ ok: false, error: 'Submission is missing target_character_owner or target_character_file.' });
    }

    const ownerDirs = getUserDirectories(ownerHandle);
    const charPath = path.join(ownerDirs.characters, charFile);

    if (!fs.existsSync(charPath)) {
        return response.status(404).json({ ok: false, error: `Character file "${charFile}" not found in owner's directory.` });
    }

    // ── LOREBOOK APPROVAL ─────────────────────────────────────────────────────
    if (sub.edit_type === 'lorebook') {
        const lorebookName = sub.lorebook_name;
        if (!lorebookName) {
            return response.status(400).json({ ok: false, error: 'Submission missing lorebook_name.' });
        }

        const lorebookPath = getLorebookPath(ownerHandle, lorebookName);
        const lorebook = readLorebook(lorebookPath);
        if (!lorebook) {
            return response.status(404).json({ ok: false, error: `Lorebook "${lorebookName}" not found.` });
        }

        // Apply lorebook changes
        try {
            const updatedEntries = applyLorebookChanges(lorebook.entries || {}, sub.lorebook_changes || []);
            const updatedLorebook = { ...lorebook, entries: updatedEntries };
            writeFileAtomicSync(lorebookPath, JSON.stringify(updatedLorebook, null, 2));
        } catch (err) {
            return response.status(500).json({ ok: false, error: `Failed to update lorebook: ${err.message}` });
        }

        // Read current character PNG (unchanged) for avatar snapshot in push item
        let currentBase64;
        try {
            currentBase64 = fs.readFileSync(charPath).toString('base64');
        } catch (err) {
            return response.status(500).json({ ok: false, error: `Failed to read character PNG: ${err.message}` });
        }

        // Queue pending-push for all manifest recipients
        let lbRecipientsNotified = 0;
        try {
            const manifest = readPushManifest(ownerHandle);
            const charEntry = manifest.find(r =>
                Array.isArray(r.character_files) && r.character_files.includes(charFile),
            );
            const recipients = charEntry?.recipients || [];
            const changeCount = (sub.lorebook_changes || []).length;

            for (const recipientHandle of recipients) {
                try {
                    const pending = readPendingPushes(recipientHandle);
                    const pushItem = {
                        push_id: makeId('push'),
                        status: 'pending',
                        unread: true,
                        created_at: now,
                        processed_at: null,
                        processed_by: null,
                        creator_handle: ownerHandle,
                        effective_creator: ownerHandle,
                        pushed_by_handle: adminHandle,
                        pushed_by_name: adminName,
                        pushed_by_role: 'admin',
                        original_creator_handle: ownerHandle,
                        source_lorebook_name: lorebookName,
                        pushed_lorebook_name: lorebookName,
                        lorebook_bundle: [{
                            role: 'primary',
                            source_lorebook_name: lorebookName,
                            pushed_lorebook_name: lorebookName,
                        }],
                        character_files: [charFile],
                        source_avatar_files: [charFile],
                        original_avatar_snapshots: { [charFile]: currentBase64 },
                        is_coauthor_update: true,
                        coauthor_submitter: sub.submitter_name || sub.submitter_handle,
                        coauthor_submitter_handle: sub.submitter_handle,
                        is_public_announcement: false,
                        preview: {
                            character_count: 1,
                            note: `Lorebook update by ${sub.submitter_name || sub.submitter_handle}, approved by ${adminName}. ${changeCount} lorebook entry change(s).`,
                            version: '',
                        },
                        notes: `Lorebook update: ${changeCount} change(s) to "${lorebookName}" by ${sub.submitter_name || sub.submitter_handle}.`,
                        recipient_handle: recipientHandle,
                    };
                    pending.push(pushItem);
                    writePendingPushes(recipientHandle, pending);
                    lbRecipientsNotified++;
                } catch (err) {
                    console.warn(`[CoAuthor] Failed to queue lorebook push for ${recipientHandle}:`, err.message);
                }
            }
        } catch (err) {
            console.warn(`[CoAuthor] Failed to read push manifest for lorebook distribution:`, err.message);
        }

        // Mark approved
        sub.status = 'approved';
        sub.reviewed_at = now;
        sub.reviewed_by = adminHandle;
        sub.reply = String(reply || '');
        sub.applied_at = now;
        sub.recipients_notified = lbRecipientsNotified;
        submissions[idx] = sub;
        writeAdminSubmissions(submissions);

        // Notify submitter
        try {
            appendUserInbox(sub.submitter_handle, {
                type: 'coauthor_approved',
                title: `✓ Lorebook Edit Approved — ${sub.character_display_name || sub.target_character_file}`,
                body: reply
                    ? `Your proposed lorebook changes to "${sub.lorebook_name}" have been approved!\n\nAdmin note: ${reply}`
                    : `Your proposed lorebook changes to "${sub.lorebook_name}" have been approved and pushed to all users!`,
                from_handle: adminHandle,
                from_name: adminName,
                context: { submission_id, character_file: sub.target_character_file, recipients_notified: lbRecipientsNotified },
            });
        } catch (err) {
            console.warn(`[CoAuthor] Failed to notify submitter of lorebook approval:`, err.message);
        }

        return response.json({ ok: true, submission: sub, recipients_notified: lbRecipientsNotified });
    }

    // 1. Read current character PNG
    let currentPngBuffer;
    let currentCharJson;
    try {
        currentPngBuffer = fs.readFileSync(charPath);
        const raw = readCharacterCard(currentPngBuffer);
        currentCharJson = JSON.parse(raw);
    } catch (err) {
        return response.status(500).json({ ok: false, error: `Failed to read character PNG: ${err.message}` });
    }

    // 2. Apply proposed_fields to the character JSON
    const proposedFields = sub.proposed_fields || {};
    if (!currentCharJson.data) currentCharJson.data = {};

    for (const [field, value] of Object.entries(proposedFields)) {
        if (!COAUTHOR_FIELDS.includes(field)) continue; // only allow known fields
        // Update both root and data sub-object for full spec compatibility
        currentCharJson[field] = value;
        currentCharJson.data[field] = value;
    }

    // 3. Write updated PNG back
    let updatedPngBuffer;
    try {
        updatedPngBuffer = writeCharacterCard(currentPngBuffer, JSON.stringify(currentCharJson));
        writeFileAtomicSync(charPath, updatedPngBuffer);
    } catch (err) {
        return response.status(500).json({ ok: false, error: `Failed to write updated character PNG: ${err.message}` });
    }

    const updatedBase64 = updatedPngBuffer.toString('base64');

    // 4. Find lorebook world name from character (for push item schema)
    const lorebookName = getCharacterWorldName(currentCharJson) || charFile.replace(/\.png$/i, '');

    // 5. Queue pending-push for all manifest recipients
    let recipientsNotified = 0;
    try {
        const manifest = readPushManifest(ownerHandle);
        const charEntry = manifest.find(r =>
            Array.isArray(r.character_files) && r.character_files.includes(charFile),
        );
        const recipients = charEntry?.recipients || [];

        for (const recipientHandle of recipients) {
            try {
                const pending = readPendingPushes(recipientHandle);
                const pushItem = {
                    push_id: makeId('push'),
                    status: 'pending',
                    unread: true,
                    created_at: now,
                    processed_at: null,
                    processed_by: null,
                    // Identify pusher as admin owner
                    creator_handle: ownerHandle,
                    effective_creator: ownerHandle,
                    pushed_by_handle: adminHandle,
                    pushed_by_name: adminName,
                    pushed_by_role: 'admin',
                    original_creator_handle: ownerHandle,
                    // Lorebook info (existing lorebook — unchanged, needed for schema)
                    source_lorebook_name: lorebookName,
                    pushed_lorebook_name: lorebookName,
                    lorebook_bundle: [{
                        role: 'primary',
                        source_lorebook_name: lorebookName,
                        pushed_lorebook_name: lorebookName,
                    }],
                    // Character
                    character_files: [charFile],
                    source_avatar_files: [charFile],
                    original_avatar_snapshots: {
                        [charFile]: updatedBase64,
                    },
                    // Meta
                    is_coauthor_update: true,
                    coauthor_submitter: sub.submitter_name || sub.submitter_handle,
                    coauthor_submitter_handle: sub.submitter_handle,
                    is_public_announcement: false,
                    preview: {
                        character_count: 1,
                        note: `Co-author update by ${sub.submitter_name || sub.submitter_handle}, approved by ${adminName}. Fields updated: ${(sub.changed_fields || []).join(', ')}.`,
                        version: '',
                    },
                    notes: `Co-author update: ${(sub.changed_fields || []).join(', ')} updated by ${sub.submitter_name || sub.submitter_handle}.`,
                    recipient_handle: recipientHandle,
                };
                pending.push(pushItem);
                writePendingPushes(recipientHandle, pending);
                recipientsNotified++;
            } catch (err) {
                console.warn(`[CoAuthor] Failed to queue push for ${recipientHandle}:`, err.message);
            }
        }
    } catch (err) {
        console.warn(`[CoAuthor] Failed to read push manifest for distribution:`, err.message);
    }

    // 6. Mark submission approved
    sub.status = 'approved';
    sub.reviewed_at = now;
    sub.reviewed_by = adminHandle;
    sub.reply = String(reply || '');
    sub.applied_at = now;
    sub.recipients_notified = recipientsNotified;
    submissions[idx] = sub;
    writeAdminSubmissions(submissions);

    // 7. Notify submitter of approval
    try {
        appendUserInbox(sub.submitter_handle, {
            type: 'coauthor_approved',
            title: `✓ Edit Approved — ${sub.character_display_name || sub.target_character_file}`,
            body: reply
                ? `Your proposed edit has been approved and pushed to all users!\n\nAdmin note: ${reply}`
                : 'Your proposed edit has been approved and pushed to all users!',
            from_handle: adminHandle,
            from_name: adminName,
            context: { submission_id, character_file: sub.target_character_file, recipients_notified: recipientsNotified },
        });
    } catch (err) {
        console.warn(`[CoAuthor] Failed to notify submitter of approval:`, err.message);
    }

    return response.json({ ok: true, submission: sub, recipients_notified: recipientsNotified });
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-AUTHOR (USER) ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/coauthors/my-assignments
 * Returns all characters this user has co-author access to, along with
 * current field values (for the Submit Edit "current values" read-only display).
 */
router.post('/my-assignments', (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.status(403).json({ ok: false, error: 'Not authenticated.' });

    const registry = readCoAuthors();
    const myAssignments = [];

    for (const [characterRegistryKey, entry] of Object.entries(registry)) {
        if (!Array.isArray(entry.co_authors) || !entry.co_authors.includes(handle)) continue;

        const ownerDirs = getUserDirectories(entry.owner_handle);
        const charPath = path.join(ownerDirs.characters, entry.character_file);
        const charData = fs.existsSync(charPath) ? readCharacterFields(charPath) : null;

        myAssignments.push({
            character_registry_key: characterRegistryKey,
            character_file: entry.character_file,
            character_display_name: entry.character_display_name || entry.character_file,
            owner_handle: entry.owner_handle,
            current_fields: charData?.fields || null,
        });
    }

    // Attach pending submission counts for this user per character
    const subs = readAdminSubmissions().filter(
        s => s.is_coauthor_edit && s.submitter_handle === handle && s.status === 'pending',
    );
    const pendingByChar = {};
    for (const s of subs) {
        const characterRegistryKey = getSubmissionCharacterRegistryKey(s);
        pendingByChar[characterRegistryKey] = (pendingByChar[characterRegistryKey] || 0) + 1;
    }
    for (const a of myAssignments) {
        a.pending_count = pendingByChar[a.character_registry_key] || 0;
    }

    return response.json({ ok: true, assignments: myAssignments });
});

/**
 * POST /api/coauthors/submit-edit
 * Submit a proposed character field edit or lorebook change for admin review.
 * Body (character): { target_character_file, proposed_fields, notes?, edit_type?: "character" }
 * Body (lorebook):  { target_character_file, lorebook_changes, notes?, edit_type: "lorebook" }
 */
router.post('/submit-edit', (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.status(403).json({ ok: false, error: 'Not authenticated.' });

    const { proposed_fields, notes, edit_type, lorebook_changes } = request.body || {};
    const effectiveEditType = edit_type === 'lorebook' ? 'lorebook' : 'character';
    const identity = getCharacterIdentity(request.body || {}, 'target_character_file');

    if (!identity.character_file) {
        return response.status(400).json({ ok: false, error: 'target_character_file is required.' });
    }

    const registry = readCoAuthors();
    const resolvedCharacter = resolveRegisteredCharacter(registry, {
        character_registry_key: identity.character_registry_key,
        owner_handle: identity.owner_handle,
        character_file: identity.character_file,
    });
    const entry = resolvedCharacter?.entry;

    if (!entry || !Array.isArray(entry.co_authors) || !entry.co_authors.includes(handle)) {
        return response.status(403).json({ ok: false, error: 'You do not have co-author access to this character.' });
    }

    const targetCharacterFile = resolvedCharacter.character_file;
    const characterRegistryKey = resolvedCharacter.character_registry_key;
    const ownerDirs = getUserDirectories(entry.owner_handle);
    const charPath = path.join(ownerDirs.characters, targetCharacterFile);

    // ── LOREBOOK SUBMISSION ────────────────────────────────────────────────────
    if (effectiveEditType === 'lorebook') {
        if (!Array.isArray(lorebook_changes) || lorebook_changes.length === 0) {
            return response.status(400).json({ ok: false, error: 'lorebook_changes array is required for lorebook edits.' });
        }
        const validActions = ['edit', 'add', 'delete'];
        for (const change of lorebook_changes) {
            if (!validActions.includes(change.action)) {
                return response.status(400).json({ ok: false, error: `Invalid action: ${change.action}` });
            }
            if ((change.action === 'edit' || change.action === 'delete') && change.entry_uid == null) {
                return response.status(400).json({ ok: false, error: `${change.action} actions require entry_uid.` });
            }
        }

        // Use the explicitly selected lorebook when provided; otherwise fall back to the linked lorebook.
        let lorebookName = String(request.body?.lorebook_name || '').trim();
        let originalEntries = {};
        try {
            if (!lorebookName) {
                const buf = fs.readFileSync(charPath);
                const raw = readCharacterCard(buf);
                const parsed = JSON.parse(raw);
                lorebookName = getCharacterWorldName(parsed);
            }
            if (lorebookName) {
                const lorebookPath = getLorebookPath(entry.owner_handle, lorebookName);
                const lorebook = readLorebook(lorebookPath);
                if (!lorebook) {
                    return response.status(404).json({ ok: false, error: `Lorebook "${lorebookName}" was not found.` });
                }
                originalEntries = lorebook?.entries || {};
            }
        } catch (err) {
            return response.status(500).json({ ok: false, error: `Could not read character: ${err.message}` });
        }
        if (!lorebookName) {
            return response.status(400).json({ ok: false, error: 'This character has no linked lorebook.' });
        }

        // One pending lorebook submission at a time per character
        const existingLore = readAdminSubmissions().find(
            s => s.is_coauthor_edit
                && s.edit_type === 'lorebook'
                && s.submitter_handle === handle
                && getSubmissionCharacterRegistryKey(s) === characterRegistryKey
                && s.status === 'pending',
        );
        if (existingLore) {
            return response.status(409).json({
                ok: false,
                error: 'You already have a pending lorebook submission for this character. Wait for it to be reviewed before submitting another.',
            });
        }

        // Snapshot original entry values + filter proposed to allowed fields
        const snapshotChanges = lorebook_changes.map(change => {
            const snap = { action: change.action, entry_uid: change.entry_uid ?? null };
            if (change.action === 'edit' || change.action === 'delete') {
                const origEntry = Object.values(originalEntries).find(e => e.uid === change.entry_uid);
                if (origEntry) {
                    snap.original = {
                        uid: origEntry.uid,
                        comment: origEntry.comment || '',
                        content: origEntry.content || '',
                        key: Array.isArray(origEntry.key) ? origEntry.key : [],
                        keysecondary: Array.isArray(origEntry.keysecondary) ? origEntry.keysecondary : [],
                        disable: Boolean(origEntry.disable),
                    };
                }
            }
            if (change.action !== 'delete' && change.proposed && typeof change.proposed === 'object') {
                const filtered = {};
                for (const f of COAUTHOR_LOREBOOK_FIELDS) {
                    if (change.proposed[f] !== undefined) filtered[f] = change.proposed[f];
                }
                snap.proposed = filtered;
            }
            return snap;
        });

        const changedSummary = lorebook_changes.map(c => {
            if (c.action === 'add') return 'new entry';
            const name = c.original?.comment || `uid ${c.entry_uid}`;
            return `${c.action} "${name}"`;
        });

        const submission = {
            submission_id: makeId('submission'),
            is_coauthor_edit: true,
            edit_type: 'lorebook',
            character_registry_key: characterRegistryKey,
            target_character_file: targetCharacterFile,
            target_character_owner: entry.owner_handle,
            character_display_name: entry.character_display_name || targetCharacterFile,
            lorebook_name: lorebookName,
            lorebook_changes: snapshotChanges,
            changed_fields: changedSummary,
            submitter_handle: handle,
            submitter_name: request.user?.profile?.name || handle,
            notes: String(notes || ''),
            status: 'pending',
            created_at: Date.now(),
            reviewed_at: null,
            reviewed_by: null,
            reply: '',
            applied_at: null,
            recipients_notified: null,
        };

        const submissions = readAdminSubmissions();
        submissions.push(submission);
        writeAdminSubmissions(submissions);

        return response.status(201).json({ ok: true, submission });
    }

    // ── CHARACTER FIELD SUBMISSION ─────────────────────────────────────────────
    if (!proposed_fields || typeof proposed_fields !== 'object') {
        return response.status(400).json({ ok: false, error: 'target_character_file and proposed_fields are required.' });
    }

    // Filter to only allowed fields and non-blank values
    const filteredProposed = {};
    for (const field of COAUTHOR_FIELDS) {
        if (proposed_fields[field] !== undefined && String(proposed_fields[field]).trim() !== '') {
            filteredProposed[field] = String(proposed_fields[field]);
        }
    }
    if (Object.keys(filteredProposed).length === 0) {
        return response.status(400).json({ ok: false, error: 'No non-blank proposed fields provided.' });
    }

    // Check for existing pending character submission from this user for this character (one at a time)
    const existing = readAdminSubmissions().find(
        s => s.is_coauthor_edit
            && (s.edit_type === 'character' || !s.edit_type)
            && s.submitter_handle === handle
            && getSubmissionCharacterRegistryKey(s) === characterRegistryKey
            && s.status === 'pending',
    );
    if (existing) {
        return response.status(409).json({
            ok: false,
            error: 'You already have a pending edit submission for this character. Wait for it to be reviewed before submitting another.',
        });
    }

    // Read current character values for diff display
    const charData = fs.existsSync(charPath) ? readCharacterFields(charPath) : null;
    const originalFields = {};
    if (charData) {
        for (const field of Object.keys(filteredProposed)) {
            originalFields[field] = charData.fields[field] ?? '';
        }
    }

    const changedFields = Object.keys(filteredProposed);

    const submission = {
        submission_id: makeId('submission'),
        is_coauthor_edit: true,
        edit_type: 'character',
        character_registry_key: characterRegistryKey,
        target_character_file: targetCharacterFile,
        target_character_owner: entry.owner_handle,
        character_display_name: entry.character_display_name || targetCharacterFile,
        proposed_fields: filteredProposed,
        original_fields: originalFields,
        changed_fields: changedFields,
        submitter_handle: handle,
        submitter_name: request.user?.profile?.name || handle,
        notes: String(notes || ''),
        status: 'pending',
        created_at: Date.now(),
        reviewed_at: null,
        reviewed_by: null,
        reply: '',
        applied_at: null,
        recipients_notified: null,
    };

    const submissions = readAdminSubmissions();
    submissions.push(submission);
    writeAdminSubmissions(submissions);

    return response.status(201).json({ ok: true, submission });
});

/**
 * POST /api/coauthors/my-submissions
 * Returns this user's co-author submission history.
 */
router.post('/my-submissions', (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.status(403).json({ ok: false, error: 'Not authenticated.' });

    const subs = readAdminSubmissions()
        .filter(s => s.is_coauthor_edit && s.submitter_handle === handle)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        .slice(0, 50);

    return response.json({ ok: true, submissions: subs });
});

/**
 * POST /api/coauthors/admin-characters
 * Returns a list of character PNGs from any admin's directory.
 * Used by the Manage Co-Authors tab to populate the character picker.
 */
router.post('/admin-characters', requireAdminMiddleware, async (request, response) => {
    try {
        const allUsers = await getAllUsers();
        const adminHandles = getAdminHandles(allUsers);
        const allHandles = adminHandles.length > 0
            ? adminHandles
            : await getAllUserHandles();
        const chars = [];

        for (const handle of allHandles) {
            const dirs = getUserDirectories(handle);
            if (!dirs?.characters || !fs.existsSync(dirs.characters)) continue;

            try {
                const files = fs.readdirSync(dirs.characters).filter(f => f.toLowerCase().endsWith('.png'));
                for (const file of files) {
                    const charPath = path.join(dirs.characters, file);
                    let displayName = file.replace(/\.png$/i, '');
                    try {
                        const buf = fs.readFileSync(charPath);
                        const raw = readCharacterCard(buf);
                        const parsed = JSON.parse(raw);
                        displayName = parsed?.data?.name || parsed?.name || displayName;
                    } catch {
                        // use filename as display name
                    }
                    chars.push({
                        character_registry_key: makeCharacterRegistryKey(handle, file),
                        character_file: file,
                        character_display_name: displayName,
                        owner_handle: handle,
                    });
                }
            } catch (err) {
                console.warn(`[CoAuthor] Failed to list characters for ${handle}:`, err.message);
            }
        }

        chars.sort((a, b) => (a.character_display_name || '').localeCompare(b.character_display_name || ''));
        return response.json({ ok: true, characters: chars });
    } catch (err) {
        return response.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * POST /api/coauthors/lorebook-list
 * Returns all lorebook names available in the character owner's worlds directory,
 * flagging which one is the character's linked lorebook (linked_lorebook_name).
 * Body: { target_character_file }
 */
router.post('/lorebook-list', (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.status(403).json({ ok: false, error: 'Not authenticated.' });

    const identity = getCharacterIdentity(request.body || {}, 'target_character_file');
    if (!identity.character_file) {
        return response.status(400).json({ ok: false, error: 'target_character_file is required.' });
    }

    const registry = readCoAuthors();
    const resolvedCharacter = resolveRegisteredCharacter(registry, {
        character_registry_key: identity.character_registry_key,
        owner_handle: identity.owner_handle,
        character_file: identity.character_file,
    });
    const entry = resolvedCharacter?.entry;

    if (!entry || !Array.isArray(entry.co_authors) || !entry.co_authors.includes(handle)) {
        return response.status(403).json({ ok: false, error: 'You do not have co-author access to this character.' });
    }

    const ownerDirs = getUserDirectories(entry.owner_handle);
    const charPath = path.join(ownerDirs.characters, resolvedCharacter.character_file);

    // Read linked lorebook name from character PNG
    let linkedLorebookName = '';
    try {
        const buf = fs.readFileSync(charPath);
        const raw = readCharacterCard(buf);
        const parsed = JSON.parse(raw);
        linkedLorebookName = getCharacterWorldName(parsed);
    } catch {
        // proceed without linked name
    }

    // List all lorebooks in owner's worlds directory
    const lorebooks = [];
    try {
        if (fs.existsSync(ownerDirs.worlds)) {
            const files = fs.readdirSync(ownerDirs.worlds).filter(f => f.toLowerCase().endsWith('.json'));
            for (const file of files) {
                const name = file.replace(/\.json$/i, '');
                lorebooks.push({
                    lorebook_name: name,
                    is_linked: name === linkedLorebookName,
                });
            }
        }
    } catch (err) {
        return response.status(500).json({ ok: false, error: `Could not list lorebooks: ${err.message}` });
    }

    // Sort: linked lorebook first, then alphabetical
    lorebooks.sort((a, b) => {
        if (a.is_linked && !b.is_linked) return -1;
        if (!a.is_linked && b.is_linked) return 1;
        return a.lorebook_name.localeCompare(b.lorebook_name);
    });

    return response.json({
        ok: true,
        character_registry_key: resolvedCharacter.character_registry_key,
        lorebooks,
        linked_lorebook_name: linkedLorebookName,
    });
});

/**
 * POST /api/coauthors/lorebook-data
 * Returns lorebook entries for a character the user has co-author access to.
 * Body: { target_character_file, lorebook_name? }
 *   lorebook_name — if omitted, falls back to the character's linked lorebook.
 * Returns: { lorebook_name, entries: { "0": { uid, comment, content, key, keysecondary, disable }, ... } }
 */
router.post('/lorebook-data', (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.status(403).json({ ok: false, error: 'Not authenticated.' });

    const { lorebook_name: requestedLorebook } = request.body || {};
    const identity = getCharacterIdentity(request.body || {}, 'target_character_file');
    if (!identity.character_file) {
        return response.status(400).json({ ok: false, error: 'target_character_file is required.' });
    }

    const registry = readCoAuthors();
    const resolvedCharacter = resolveRegisteredCharacter(registry, {
        character_registry_key: identity.character_registry_key,
        owner_handle: identity.owner_handle,
        character_file: identity.character_file,
    });
    const entry = resolvedCharacter?.entry;
    if (!entry || !Array.isArray(entry.co_authors) || !entry.co_authors.includes(handle)) {
        return response.status(403).json({ ok: false, error: 'You do not have co-author access to this character.' });
    }

    const ownerDirs = getUserDirectories(entry.owner_handle);
    const charPath = path.join(ownerDirs.characters, resolvedCharacter.character_file);

    if (!fs.existsSync(charPath)) {
        return response.status(404).json({ ok: false, error: 'Character file not found.' });
    }

    // Determine which lorebook to load: caller-specified or character-linked
    let lorebookName = String(requestedLorebook || '').trim();
    if (!lorebookName) {
        try {
            const buf = fs.readFileSync(charPath);
            const raw = readCharacterCard(buf);
            const parsed = JSON.parse(raw);
            lorebookName = getCharacterWorldName(parsed);
        } catch (err) {
            return response.status(500).json({ ok: false, error: `Could not read character: ${err.message}` });
        }
    }

    if (!lorebookName) {
        return response.json({ ok: true, lorebook_name: null, entries: null });
    }

    // Guard: lorebook must actually exist in owner's worlds dir (no path traversal)
    const lorebookPath = getLorebookPath(entry.owner_handle, lorebookName);
    if (!lorebookPath.startsWith(ownerDirs.worlds)) {
        return response.status(400).json({ ok: false, error: 'Invalid lorebook name.' });
    }

    const lorebook = readLorebook(lorebookPath);
    if (!lorebook) {
        return response.json({ ok: true, lorebook_name: lorebookName, entries: null });
    }

    // Return only co-author-editable fields per entry
    const entries = lorebook.entries || {};
    const filtered = {};
    for (const [k, e] of Object.entries(entries)) {
        filtered[k] = {
            uid: e.uid,
            comment: e.comment || '',
            content: e.content || '',
            key: Array.isArray(e.key) ? e.key : [],
            keysecondary: Array.isArray(e.keysecondary) ? e.keysecondary : [],
            disable: Boolean(e.disable),
        };
    }

    return response.json({ ok: true, lorebook_name: lorebookName, entries: filtered });
});

/**
 * POST /api/coauthors/user-list
 * Returns all non-admin user handles + names for the co-author assignment picker.
 */
router.post('/user-list', requireAdminMiddleware, async (request, response) => {
    try {
        const allUsers = await getAllUsers();
        const allHandles = allUsers.length > 0
            ? allUsers.filter(user => !user.admin).map(user => user.handle)
            : (await getAllUserHandles());
        // Return all handles — let the UI filter out the current admin if desired
        const users = allHandles.map(h => ({ handle: h }));
        return response.json({ ok: true, users });
    } catch (err) {
        return response.status(500).json({ ok: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-AUTHOR REQUEST ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/coauthors/available-characters
 * Returns all characters from all user directories that the requesting user
 * can submit a co-author request for. Excludes characters they already
 * co-author or have a pending request for.
 */
router.post('/available-characters', async (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.status(403).json({ ok: false, error: 'Not authenticated.' });

    try {
        const adminHandles = getAdminHandles(await getAllUsers());
        const allHandles = adminHandles.length > 0 ? adminHandles : await getAllUserHandles();
        const registry   = readCoAuthors();
        const requests   = readCoAuthorRequests();

        // Build sets for fast exclusion
        const alreadyCoAuthors = new Set(
            Object.entries(registry)
                .filter(([, e]) => Array.isArray(e.co_authors) && e.co_authors.includes(handle))
                .map(([characterRegistryKey]) => characterRegistryKey),
        );
        const pendingRequests = new Set(
            requests
                .filter(r => r.requester_handle === handle && r.status === 'pending')
                .map(r => getRequestCharacterRegistryKey(r)),
        );

        const chars = [];
        for (const ownerHandle of allHandles) {
            const dirs = getUserDirectories(ownerHandle);
            if (!dirs?.characters || !fs.existsSync(dirs.characters)) continue;
            try {
                const files = fs.readdirSync(dirs.characters).filter(f => f.toLowerCase().endsWith('.png'));
                for (const file of files) {
                    const characterRegistryKey = makeCharacterRegistryKey(ownerHandle, file);
                    if (alreadyCoAuthors.has(characterRegistryKey)) continue;
                    if ((registry[characterRegistryKey]?.co_authors || []).length >= 3) continue;
                    const isPending = pendingRequests.has(characterRegistryKey);
                    let displayName = file.replace(/\.png$/i, '');
                    try {
                        const buf = fs.readFileSync(path.join(dirs.characters, file));
                        const raw = readCharacterCard(buf);
                        const parsed = JSON.parse(raw);
                        displayName = parsed?.data?.name || parsed?.name || displayName;
                    } catch { /* use filename */ }
                    chars.push({
                        character_registry_key: characterRegistryKey,
                        character_file: file,
                        character_display_name: displayName,
                        owner_handle: ownerHandle,
                        has_pending_request: isPending,
                    });
                }
            } catch (err) {
                console.warn(`[CoAuthor] available-characters: failed listing ${ownerHandle}:`, err.message);
            }
        }

        chars.sort((a, b) => (a.character_display_name || '').localeCompare(b.character_display_name || ''));
        return response.json({ ok: true, characters: chars });
    } catch (err) {
        return response.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * POST /api/coauthors/request-access
 * Submit a co-author access request for a character.
 * Body: { character_file, message? }
 */
router.post('/request-access', async (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.status(403).json({ ok: false, error: 'Not authenticated.' });

    const { message } = request.body || {};
    const identity = getCharacterIdentity(request.body || {});
    if (!identity.character_file) {
        return response.status(400).json({ ok: false, error: 'character_file is required.' });
    }
    const characterFile = identity.character_file;
    const requestedCharacterRegistryKey = makeCharacterRegistryKey(identity.owner_handle, identity.character_file);

    // Check not already a co-author
    const registry = readCoAuthors();
    const entry = resolveRegisteredCharacter(registry, identity)?.entry;
    if (entry && Array.isArray(entry.co_authors) && entry.co_authors.includes(handle)) {
        return response.status(409).json({ ok: false, error: 'You are already a co-author of this character.' });
    }

    // Check no existing pending request
    const requests = readCoAuthorRequests();
    const existing = requests.find(
        r => r.requester_handle === handle
            && getRequestCharacterRegistryKey(r) === (requestedCharacterRegistryKey || characterFile)
            && r.status === 'pending',
    );
    if (existing) {
        return response.status(409).json({ ok: false, error: 'You already have a pending request for this character.' });
    }

    // Find character display name + owner from any user directory
    let characterDisplayName = characterFile.replace(/\.png$/i, '');
    let ownerHandle = identity.owner_handle || '';
    try {
        if (entry) {
            characterDisplayName = entry.character_display_name || characterDisplayName;
            ownerHandle = entry.owner_handle || '';
        }
    } catch { /* fallback */ }

    if (!ownerHandle) {
        try {
            const adminHandles = getAdminHandles(await getAllUsers());
            const allHandles = adminHandles.length > 0 ? adminHandles : await getAllUserHandles();
            for (const possibleOwnerHandle of allHandles) {
                const dirs = getUserDirectories(possibleOwnerHandle);
                const charPath = path.join(dirs.characters, characterFile);
                if (!fs.existsSync(charPath)) continue;
                ownerHandle = possibleOwnerHandle;
                break;
            }
        } catch { /* fallback */ }
    }

    if (ownerHandle) {
        try {
            const charPath = path.join(getUserDirectories(ownerHandle).characters, characterFile);
            if (fs.existsSync(charPath)) {
                const buf = fs.readFileSync(charPath);
                const raw = readCharacterCard(buf);
                const parsed = JSON.parse(raw);
                characterDisplayName = parsed?.data?.name || parsed?.name || characterDisplayName;
            }
        } catch { /* keep filename fallback */ }
    }

    const finalCharacterRegistryKey = makeCharacterRegistryKey(ownerHandle, characterFile) || requestedCharacterRegistryKey || characterFile;

    const req = {
        request_id: makeId('req'),
        requester_handle: handle,
        requester_name: request.user?.profile?.name || handle,
        character_registry_key: finalCharacterRegistryKey,
        character_file: characterFile,
        character_display_name: characterDisplayName,
        character_owner_handle: ownerHandle,
        message: String(message || '').trim(),
        status: 'pending',
        created_at: Date.now(),
        reviewed_at: null,
        reviewed_by: null,
        reply: '',
    };

    requests.push(req);
    writeCoAuthorRequests(requests);

    return response.status(201).json({ ok: true, request: req });
});

/**
 * POST /api/coauthors/my-requests
 * Returns the requesting user's co-author request history.
 */
router.post('/my-requests', (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.status(403).json({ ok: false, error: 'Not authenticated.' });

    const reqs = readCoAuthorRequests()
        .filter(r => r.requester_handle === handle)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        .slice(0, 50);

    return response.json({ ok: true, requests: reqs });
});

/**
 * POST /api/coauthors/pending-requests
 * Admin: returns all pending co-author access requests.
 */
router.post('/pending-requests', requireAdminMiddleware, (request, response) => {
    const reqs = readCoAuthorRequests()
        .filter(r => r.status === 'pending')
        .sort((a, b) => (a.created_at || 0) - (b.created_at || 0)); // oldest first
    return response.json({ ok: true, requests: reqs });
});

/**
 * POST /api/coauthors/request-action
 * Admin: approve or decline a co-author request.
 * Body: { request_id, action: "approve"|"decline", reply? }
 *
 * On approve: adds requester as co-author (same logic as /assign), notifies them.
 * On decline: notifies requester with optional reply.
 */
router.post('/request-action', requireAdminMiddleware, async (request, response) => {
    const { request_id, action, reply } = request.body || {};
    if (!request_id || !action) {
        return response.status(400).json({ ok: false, error: 'request_id and action are required.' });
    }
    if (!['approve', 'decline'].includes(action)) {
        return response.status(400).json({ ok: false, error: 'action must be "approve" or "decline".' });
    }

    const requests = readCoAuthorRequests();
    const idx = requests.findIndex(r => r.request_id === request_id);
    if (idx === -1) return response.status(404).json({ ok: false, error: 'Request not found.' });

    const req = requests[idx];
    if (req.status !== 'pending') {
        return response.status(409).json({ ok: false, error: 'Request is no longer pending.' });
    }

    const adminHandle = request.user?.profile?.handle;
    const adminName   = request.user?.profile?.name || adminHandle;
    const now = Date.now();

    // ── DECLINE ───────────────────────────────────────────────────────────────
    if (action === 'decline') {
        req.status = 'declined';
        req.reviewed_at = now;
        req.reviewed_by = adminHandle;
        req.reply = String(reply || '');
        requests[idx] = req;
        writeCoAuthorRequests(requests);

        try {
            appendUserInbox(req.requester_handle, {
                type: 'coauthor_request_declined',
                title: `✕ Co-Author Request Declined — ${req.character_display_name || req.character_file}`,
                body: reply
                    ? `Your request to co-author "${req.character_display_name || req.character_file}" was reviewed and declined.\n\nAdmin note: ${reply}`
                    : `Your request to co-author "${req.character_display_name || req.character_file}" was reviewed and declined.`,
                from_handle: adminHandle,
                from_name: adminName,
                context: { request_id, character_file: req.character_file },
            });
        } catch (err) {
            console.warn('[CoAuthor] Failed to notify requester of decline:', err.message);
        }

        return response.json({ ok: true, request: req });
    }

    // ── APPROVE ───────────────────────────────────────────────────────────────
    // Run the same assign logic as /assign
    const registry = readCoAuthors();
    const charFile  = req.character_file;
    let characterRegistryKey = getRequestCharacterRegistryKey(req);

    // Try to find owner from registry; fall back to stored value
    let ownerHandle = req.character_owner_handle || '';
    if (!ownerHandle && characterRegistryKey && registry[characterRegistryKey]) {
        ownerHandle = registry[characterRegistryKey].owner_handle;
    }
    // Last resort: scan all handles
    if (!ownerHandle) {
        try {
            const adminHandles = getAdminHandles(await getAllUsers());
            const allHandles = adminHandles.length > 0 ? adminHandles : await getAllUserHandles();
            for (const h of allHandles) {
                const dirs = getUserDirectories(h);
                if (dirs?.characters && fs.existsSync(path.join(dirs.characters, charFile))) {
                    ownerHandle = h;
                    break;
                }
            }
        } catch { /* proceed without owner */ }
    }

    characterRegistryKey = makeCharacterRegistryKey(ownerHandle, charFile) || characterRegistryKey || charFile;

    if (!registry[characterRegistryKey]) {
        registry[characterRegistryKey] = {
            character_file: charFile,
            character_display_name: req.character_display_name || charFile,
            owner_handle: ownerHandle,
            co_authors: [],
            assigned_at: now,
        };
    }
    const charEntry = registry[characterRegistryKey];
    if (charEntry.co_authors.length >= 3) {
        return response.status(400).json({ ok: false, error: 'This character already has 3 co-authors. Remove one before approving.' });
    }
    if (!charEntry.co_authors.includes(req.requester_handle)) {
        charEntry.co_authors.push(req.requester_handle);
    }
    writeCoAuthors(registry);

    // Mark request approved
    req.status = 'approved';
    req.reviewed_at = now;
    req.reviewed_by = adminHandle;
    req.reply = String(reply || '');
    req.character_registry_key = characterRegistryKey;
    req.character_owner_handle = ownerHandle;
    requests[idx] = req;
    writeCoAuthorRequests(requests);

    // Notify requester
    try {
        appendUserInbox(req.requester_handle, {
            type: 'coauthor_request_approved',
            title: `✦ Co-Author Request Approved — ${req.character_display_name || req.character_file}`,
            body: reply
                ? `Your request to co-author "${req.character_display_name || req.character_file}" has been approved! You can now submit edits from the Co-Author Station.\n\nAdmin note: ${reply}`
                : `Your request to co-author "${req.character_display_name || req.character_file}" has been approved! You can now submit edits from the Co-Author Station.`,
            from_handle: adminHandle,
            from_name: adminName,
            context: { request_id, character_file: req.character_file },
        });
    } catch (err) {
        console.warn('[CoAuthor] Failed to notify requester of approval:', err.message);
    }

    return response.json({ ok: true, request: req });
});
