import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

export function generateTotpSecret() {
    const bytes = crypto.randomBytes(20);
    let bits = '';
    let secret = '';

    for (const byte of bytes) {
        bits += byte.toString(2).padStart(8, '0');
    }

    for (let i = 0; i + 5 <= bits.length; i += 5) {
        secret += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
    }

    return secret;
}

export function createTotpUrl(secret, account, issuer = 'DreamTavern') {
    const label = encodeURIComponent(`${issuer}:${account}`);
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(TOTP_DIGITS),
        period: String(TOTP_PERIOD_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

export function verifyTotpCode(secret, code, window = 1) {
    const normalizedCode = String(code || '').replace(/\s+/g, '');

    if (!secret || !/^\d{6}$/.test(normalizedCode)) {
        return false;
    }

    const counter = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);

    for (let offset = -window; offset <= window; offset++) {
        if (generateTotpCode(secret, counter + offset) === normalizedCode) {
            return true;
        }
    }

    return false;
}

export function generateBackupCodes(count = 10) {
    return Array.from({ length: count }, () => {
        const first = crypto.randomBytes(4).toString('hex').toUpperCase();
        const second = crypto.randomBytes(4).toString('hex').toUpperCase();
        return `${first}-${second}`;
    });
}

export function getBackupCodeHash(code) {
    return crypto.createHash('sha256').update(normalizeBackupCode(code)).digest('hex');
}

export function normalizeBackupCode(code) {
    return String(code || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

export function consumeBackupCode(hashes, code) {
    const normalizedCode = normalizeBackupCode(code);

    if (!normalizedCode) {
        return { matched: false, hashes };
    }

    const hash = getBackupCodeHash(normalizedCode);
    const index = Array.isArray(hashes) ? hashes.indexOf(hash) : -1;

    if (index === -1) {
        return { matched: false, hashes };
    }

    const nextHashes = hashes.slice();
    nextHashes.splice(index, 1);
    return { matched: true, hashes: nextHashes };
}

function generateTotpCode(secret, counter) {
    const key = base32ToBuffer(secret);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuffer.writeUInt32BE(counter >>> 0, 4);

    const digest = crypto.createHmac('sha1', key).update(counterBuffer).digest();
    const offset = digest[digest.length - 1] & 0xf;
    const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);

    return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function base32ToBuffer(secret) {
    const normalized = String(secret || '').toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
    let bits = '';
    const bytes = [];

    for (const character of normalized) {
        const value = BASE32_ALPHABET.indexOf(character);

        if (value === -1) {
            continue;
        }

        bits += value.toString(2).padStart(5, '0');
    }

    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }

    return Buffer.from(bytes);
}
