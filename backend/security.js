const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || '';
const APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || '';

function getEncryptionKey() {
    const source = APP_ENCRYPTION_KEY || JWT_SECRET;
    if (!source) return null;
    if (/^[a-f0-9]{64}$/i.test(source)) {
        return Buffer.from(source, 'hex');
    }
    return crypto.createHash('sha256').update(source).digest();
}

function encryptSecret(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    const key = getEncryptionKey();
    if (!key) return normalized;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    const key = getEncryptionKey();
    if (!key) return normalized;

    const parts = normalized.split(':');
    if (parts.length !== 3) return normalized;

    try {
        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const payload = Buffer.from(parts[2], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
        return decrypted.toString('utf8');
    } catch (err) {
        console.error('[SECRET DECRYPT ERROR]:', err.message);
        return '';
    }
}

function readConfigSecret(config, encryptedField, legacyField, legacyAlias) {
    const encryptedValue = decryptSecret(config?.[encryptedField]);
    if (encryptedValue) return encryptedValue;
    return String(config?.[legacyField] || config?.[legacyAlias] || '').trim();
}

function hasConfigSecret(config, encryptedField, legacyField, legacyAlias) {
    return !!readConfigSecret(config, encryptedField, legacyField, legacyAlias);
}

module.exports = {
    decryptSecret,
    encryptSecret,
    hasConfigSecret,
    readConfigSecret
};
