const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const morgan = require('morgan');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
require('dotenv').config();
const { query } = require('./db');
const { startWatcher, processPendingFiles, getQueueRuntimeState } = require('./watcher');
const { encryptSecret } = require('./security');

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_DIR = path.join(__dirname, '../frontend');
const INPUT_DIR = path.join(__dirname, '../input');
const PROCESSED_DIR = path.join(__dirname, '../processed');
const JWT_COOKIE_NAME = 'auth_token';
const JWT_SECRET = process.env.JWT_SECRET;
const APP_BASE_URL = String(process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const rateLimitStore = new Map();

if (!JWT_SECRET || JWT_SECRET === 'super_secret_key_12345' || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET debe existir, no puede ser el valor por defecto y debe tener al menos 32 caracteres.');
}

if (process.env.CORS_ORIGIN) {
    app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}

app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    if (req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
    }
    next();
});
app.use(express.static(FRONTEND_DIR, {
    extensions: ['html'],
    setHeaders: (res, servedPath) => {
        if (servedPath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store');
        }
    }
}));
app.get('/', (req, res) => res.redirect('/app'));
app.get('/app', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(FRONTEND_DIR, 'app.html'));
});
app.get('/saas', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(FRONTEND_DIR, 'saas.html'));
});

function parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) return {};
    return header.split(';').reduce((acc, part) => {
        const idx = part.indexOf('=');
        if (idx === -1) return acc;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        acc[key] = decodeURIComponent(value);
        return acc;
    }, {});
}

function getTokenFromRequest(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    return parseCookies(req)[JWT_COOKIE_NAME];
}

function setAuthCookie(res, token) {
    const secure = process.env.NODE_ENV === 'production';
    const parts = [
        `${JWT_COOKIE_NAME}=${encodeURIComponent(token)}`,
        'HttpOnly',
        'Path=/',
        'SameSite=Strict',
        'Max-Age=43200'
    ];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res) {
    res.setHeader('Set-Cookie', `${JWT_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createRateLimiter({ keyPrefix, windowMs, limit, message }) {
    return (req, res, next) => {
        const now = Date.now();
        const bucketKey = `${keyPrefix}:${getClientIp(req)}`;
        const current = rateLimitStore.get(bucketKey);

        if (!current || current.resetAt <= now) {
            rateLimitStore.set(bucketKey, { count: 1, resetAt: now + windowMs });
            return next();
        }

        if (current.count >= limit) {
            const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
            res.setHeader('Retry-After', String(retryAfter));
            return res.status(429).json({ error: message });
        }

        current.count += 1;
        next();
    };
}

function issueAuthToken(user) {
    return jwt.sign(userPayload(user), JWT_SECRET, { expiresIn: '12h' });
}

function buildResetUrl(rawToken) {
    return `${APP_BASE_URL}/app?reset_token=${encodeURIComponent(rawToken)}`;
}

async function sendPasswordResetMessage({ email, name, rawToken }) {
    const resetUrl = buildResetUrl(rawToken);
    const deliveryMode = String(process.env.PASSWORD_RESET_DELIVERY || 'log').toLowerCase();
    const payload = {
        to: email,
        subject: 'Recuperacion de clave',
        text: `Hola ${name || ''}. Usa este enlace para restablecer tu clave: ${resetUrl}`,
        reset_url: resetUrl,
        token: rawToken
    };

    if (deliveryMode === 'webhook' && process.env.PASSWORD_RESET_WEBHOOK_URL) {
        const response = await fetch(process.env.PASSWORD_RESET_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw new Error(`Webhook de correo respondio con ${response.status}`);
        }
        return { mode: 'webhook', resetUrl };
    }

    console.log('[PASSWORD RESET DELIVERY]', JSON.stringify(payload));
    return { mode: 'log', resetUrl };
}

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of rateLimitStore.entries()) {
        if (!value || value.resetAt <= now) {
            rateLimitStore.delete(key);
        }
    }
}, 60 * 1000).unref();

function sanitizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeText(value, maxLength = 255) {
    return String(value || '').trim().slice(0, maxLength);
}

function normalizeRelativePath(value) {
    const cleaned = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return cleaned.slice(0, 500);
}

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function parseExtractedData(row) {
    let ed = row.extracted_data;
    if (!ed) return null;
    if (typeof ed === 'string') {
        try { ed = JSON.parse(ed); } catch (_) { return null; }
    }
    if (!ed || typeof ed !== 'object') return null;

    const ivaRows = Array.isArray(ed.ivasDiscriminados) ? ed.ivasDiscriminados : [];
    const pick = (pct) => ivaRows.find((x) => Number(x?.porcentaje) === Number(pct)) || {};
    const iva0 = pick(0), iva5 = pick(5), iva8 = pick(8), iva19 = pick(19);
    const zeroTax = ed.zeroTaxBreakdown || {};
    const baseExenta = toNumber(ed.baseExenta ?? zeroTax.exenta ?? 0);
    const baseExcluida = toNumber(ed.baseExcluida ?? zeroTax.excluida ?? 0);
    const baseNoGravada = toNumber(ed.baseNoGravada ?? zeroTax.no_gravada ?? 0);
    const baseExento = toNumber(ed.baseExento ?? iva0.base ?? (baseExenta + baseExcluida + baseNoGravada));
    const detalleProductos = Array.isArray(ed.detalleProductos) ? ed.detalleProductos : [];

    return {
        factura: ed.numeroFactura || [ed.prefijo, ed.numero].filter(Boolean).join('-') || row.original_filename || row.filename || '',
        nit: ed.nitEmisor || ed.nitAdquirente || ed.nit || '',
        origen: String(ed.extractionSource || 'desconocido'),
        totalFactura: toNumber(ed.total),
        baseExento,
        base5: toNumber(iva5.base ?? ed.base5 ?? 0),
        iva5: toNumber(iva5.valor ?? ed.iva5 ?? 0),
        base8: toNumber(iva8.base ?? ed.base8 ?? 0),
        iva8: toNumber(iva8.valor ?? ed.iva8 ?? 0),
        base19: toNumber(iva19.base ?? ed.base19 ?? 0),
        iva19: toNumber(iva19.valor ?? ed.iva19 ?? 0),
        reteFuente: toNumber(ed.reteFuente),
        reteIva: toNumber(ed.reteIva),
        reteIca: toNumber(ed.reteIca),
        impuestoConsumo: toNumber(ed.impuestoConsumo),
        diferenciaTotal: toNumber(ed?.validacion?.diferenciaTotal),
        detalleProductos
    };
}

function sourceLabel(source) {
    const src = String(source || '').toLowerCase();
    if (src.includes('dian')) return 'Parser DIAN';
    if (src.includes('gemini')) return 'IA Gemini';
    if (src.includes('groq')) return 'IA Groq';
    if (src.includes('desconocido')) return 'Sin fuente';
    return 'IA';
}

function formatMoney(value) {
    return new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(toNumber(value));
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

function cleanDisplayFileName(value) {
    return String(value ?? '')
        .replace(/^\d{4}-\d{2}-\d{2}[_\s-]+/, '')
        .trim();
}

function userPayload(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        company_id: user.company_id,
        role: user.role,
        is_superadmin: !!user.is_superadmin,
        active: user.active !== false,
        session_version: Number(user.session_version || 0)
    };
}

function canManageCompany(req) {
    return !!req.user && (req.user.role === 'admin' || req.user.is_superadmin);
}

function isCompanyAdmin(req, res, next) {
    if (!canManageCompany(req)) {
        return res.status(403).json({ error: 'Acceso reservado para administradores.' });
    }
    next();
}

async function writeAudit(companyId, userId, action, targetType, targetId, detail = {}) {
    await query(
        `INSERT INTO audit_logs (company_id, user_id, action, target_type, target_id, detail_json)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [companyId, userId, action, targetType, targetId, JSON.stringify(detail)]
    );
}

async function createPasswordResetToken(userId) {
    const rawToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at)
         VALUES ($1,$2,NOW() + INTERVAL '30 minutes')`,
        [userId, tokenHash]
    );
    return rawToken;
}

function generateTemporaryPassword(length = 12) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    const bytes = crypto.randomBytes(length);
    let output = '';
    for (let i = 0; i < length; i += 1) {
        output += alphabet[bytes[i] % alphabet.length];
    }
    return output;
}

async function ensureRuntimeSchema() {
    // Definir tablas base si no existen para evitar errores en ALTER
    await query(`
        CREATE TABLE IF NOT EXISTS companies (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            company_id INTEGER REFERENCES companies(id),
            name VARCHAR(255),
            email VARCHAR(255) UNIQUE,
            password_hash VARCHAR(255),
            role VARCHAR(20) DEFAULT 'user',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await query(`
        CREATE TABLE IF NOT EXISTS documents (
            id SERIAL PRIMARY KEY,
            company_id INTEGER REFERENCES companies(id),
            uploaded_by INTEGER REFERENCES users(id),
            status VARCHAR(20) DEFAULT 'pending',
            extracted_data JSONB,
            error_message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await query(`
        CREATE TABLE IF NOT EXISTS configs (
            id SERIAL PRIMARY KEY,
            company_id INTEGER UNIQUE REFERENCES companies(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Ahora aplicamos las modificaciones de columnas de forma segura
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER DEFAULT 0`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP`);

    await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'`);
    await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_id INTEGER DEFAULT 1`);
    await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS next_billing_date DATE DEFAULT (CURRENT_DATE + INTERVAL '30 days')`);
    await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS nit VARCHAR(20) DEFAULT ''`);
    await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT ''`);
    await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone VARCHAR(20) DEFAULT ''`);
    await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_contact VARCHAR(100) DEFAULT ''`);

    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS filename VARCHAR(255)`);
    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS "fileName" VARCHAR(255)`);
    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS original_filename VARCHAR(255)`);
    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_path VARCHAR(500) DEFAULT ''`);
    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0`);
    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS max_retries INTEGER DEFAULT 3`);
    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMP`);
    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL`);

    await query(`ALTER TABLE configs ADD COLUMN IF NOT EXISTS provider VARCHAR(50) DEFAULT 'gemini'`);
    await query(`ALTER TABLE configs ADD COLUMN IF NOT EXISTS gemini_api_key TEXT`);
    await query(`ALTER TABLE configs ADD COLUMN IF NOT EXISTS groq_api_key TEXT`);
    await query(`ALTER TABLE configs ADD COLUMN IF NOT EXISTS active_provider VARCHAR(50) DEFAULT 'gemini'`);
    await query(`ALTER TABLE configs ADD COLUMN IF NOT EXISTS api_key_gemini TEXT`);
    await query(`ALTER TABLE configs ADD COLUMN IF NOT EXISTS api_key_groq TEXT`);
    await query(`ALTER TABLE configs ADD COLUMN IF NOT EXISTS gemini_api_key_enc TEXT`);
    await query(`ALTER TABLE configs ADD COLUMN IF NOT EXISTS groq_api_key_enc TEXT`);
    await query(`
        CREATE TABLE IF NOT EXISTS plans (
            id SERIAL PRIMARY KEY,
            name VARCHAR(50) NOT NULL,
            price_monthly DECIMAL(10,2) DEFAULT 0.00,
            max_documents_month INTEGER DEFAULT 10,
            max_docs_month INTEGER DEFAULT 10,
            max_users INTEGER DEFAULT 1,
            max_boxes INTEGER DEFAULT 1,
            features JSONB DEFAULT '{}'::jsonb,
            modules_json JSONB DEFAULT '{}'::jsonb,
            support_type VARCHAR(50) DEFAULT 'Email',
            api_access BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_docs_month INTEGER DEFAULT 10`);
    await query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_documents_month INTEGER DEFAULT 10`);
    await query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_boxes INTEGER DEFAULT 1`);
    await query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_monthly DECIMAL(10,2) DEFAULT 0.00`);
    await query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_users INTEGER DEFAULT 1`);
    await query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '{}'::jsonb`);
    await query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS modules_json JSONB DEFAULT '{}'::jsonb`);
    await query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS support_type VARCHAR(50) DEFAULT 'Email'`);
    await query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS api_access BOOLEAN DEFAULT FALSE`);
    await query(`
        CREATE TABLE IF NOT EXISTS usage_logs (
            id SERIAL PRIMARY KEY,
            company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id),
            action VARCHAR(100),
            status VARCHAR(30),
            provider VARCHAR(50),
            document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
            duration_ms INTEGER,
            cost_est DECIMAL(10,5),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await query(`ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS status VARCHAR(30)`);
    await query(`ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER`);
    await query(`
        CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
            amount DECIMAL(10,2) NOT NULL,
            payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            method VARCHAR(50),
            period_months INTEGER DEFAULT 1,
            observation TEXT,
            created_by INTEGER REFERENCES users(id)
        )
    `);
    await query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id),
            action VARCHAR(100) NOT NULL,
            target_type VARCHAR(50) DEFAULT '',
            target_id INTEGER,
            detail_json JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await query(`
        CREATE TABLE IF NOT EXISTS password_resets (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            token_hash VARCHAR(255) NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            used_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await query(`
        CREATE TABLE IF NOT EXISTS local_sync_paths (
            id SERIAL PRIMARY KEY,
            company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            name VARCHAR(100),
            last_sync TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await query(`
        CREATE TABLE IF NOT EXISTS subscriptions (
            id SERIAL PRIMARY KEY,
            company_id INTEGER UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
            status VARCHAR(20) DEFAULT 'active',
            plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
            current_period_end DATE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await query(`UPDATE documents SET filename = "fileName" WHERE filename IS NULL AND "fileName" IS NOT NULL`);
    await query(`UPDATE documents SET original_filename = filename WHERE original_filename IS NULL AND filename IS NOT NULL`);
    await query(`UPDATE users SET active = TRUE WHERE active IS NULL`);
    await query(`UPDATE users SET session_version = 0 WHERE session_version IS NULL`);
    await query(`UPDATE documents SET assigned_to = uploaded_by WHERE assigned_to IS NULL AND uploaded_by IS NOT NULL`);
    await query(`UPDATE configs SET provider = active_provider WHERE provider IS NULL AND active_provider IS NOT NULL`);
    await query(`UPDATE configs SET gemini_api_key = api_key_gemini WHERE gemini_api_key IS NULL AND api_key_gemini IS NOT NULL`);
    await query(`UPDATE configs SET groq_api_key = api_key_groq WHERE groq_api_key IS NULL AND api_key_groq IS NOT NULL`);
    await query(`UPDATE plans SET max_docs_month = max_documents_month WHERE max_docs_month IS NULL AND max_documents_month IS NOT NULL`);
    await query(`UPDATE plans SET max_documents_month = max_docs_month WHERE max_documents_month IS NULL AND max_docs_month IS NOT NULL`);
    await query(`UPDATE documents SET "fileName" = filename WHERE "fileName" IS NULL AND filename IS NOT NULL`);
    await query(`UPDATE configs SET active_provider = provider WHERE active_provider IS NULL AND provider IS NOT NULL`);
    await query(`UPDATE configs SET api_key_gemini = gemini_api_key WHERE api_key_gemini IS NULL AND gemini_api_key IS NOT NULL`);
    await query(`UPDATE configs SET api_key_groq = groq_api_key WHERE api_key_groq IS NULL AND groq_api_key IS NOT NULL`);
    await query(`UPDATE companies SET status = 'active' WHERE status IS NULL OR status = ''`);
    await query(`UPDATE companies SET plan_id = 1 WHERE plan_id IS NULL`);
    await query(`UPDATE companies SET next_billing_date = CURRENT_DATE + INTERVAL '30 days' WHERE next_billing_date IS NULL`);
    await query(`
        INSERT INTO plans (id, name, price_monthly, max_documents_month, max_docs_month, max_users, max_boxes, features, modules_json, support_type, api_access)
        VALUES
            (1, 'Basico', 50000, 50, 50, 1, 1, '{"extraction": true}'::jsonb, '{"extraction": true}'::jsonb, 'Email', false),
            (2, 'Profesional', 150000, 1000, 1000, 5, 3, '{"extraction": true, "chat_ai": true, "excel": true}'::jsonb, '{"extraction": true, "chat_ai": true, "excel": true}'::jsonb, 'WhatsApp/Email', false),
            (3, 'Empresarial', 450000, 10000, 10000, 20, 10, '{"extraction": true, "chat_ai": true, "excel": true, "api": true}'::jsonb, '{"extraction": true, "chat_ai": true, "excel": true, "api": true}'::jsonb, 'Prioritario 24/7', true)
        ON CONFLICT (id) DO NOTHING
    `);
    await query(`
        INSERT INTO subscriptions (company_id, status, plan_id, current_period_end)
        SELECT id, status, plan_id, next_billing_date
        FROM companies c
        WHERE NOT EXISTS (
            SELECT 1 FROM subscriptions s WHERE s.company_id = c.id
        )
    `);

    const secretsToMigrate = await query(`
        SELECT id, gemini_api_key, groq_api_key, api_key_gemini, api_key_groq, gemini_api_key_enc, groq_api_key_enc
        FROM configs
    `);
    for (const config of secretsToMigrate.rows) {
        const updates = [];
        const params = [];
        let index = 1;

        const geminiPlain = String(config.gemini_api_key || config.api_key_gemini || '').trim();
        const groqPlain = String(config.groq_api_key || config.api_key_groq || '').trim();

        if (!config.gemini_api_key_enc && geminiPlain) {
            updates.push(`gemini_api_key_enc = $${index++}`);
            params.push(encryptSecret(geminiPlain));
            updates.push(`gemini_api_key = NULL`);
            updates.push(`api_key_gemini = NULL`);
        }

        if (!config.groq_api_key_enc && groqPlain) {
            updates.push(`groq_api_key_enc = $${index++}`);
            params.push(encryptSecret(groqPlain));
            updates.push(`groq_api_key = NULL`);
            updates.push(`api_key_groq = NULL`);
        }

        if (updates.length > 0) {
            params.push(config.id);
            await query(`UPDATE configs SET ${updates.join(', ')} WHERE id = $${index}`, params);
        }
    }

    // Crear empresa maestra y superadmin inicial si no hay usuarios
    const userCount = await query('SELECT COUNT(*)::int AS total FROM users');
    if (userCount.rows[0].total === 0) {
        console.log('[INIT] No se detectaron usuarios. Creando Super Admin inicial...');
        const companyRes = await query(`
            INSERT INTO companies (id, name, status, plan_id)
            VALUES (1, 'Master Company', 'active', 3)
            ON CONFLICT (id) DO NOTHING
            RETURNING id
        `);
        const masterCompanyId = companyRes.rows[0]?.id || 1;

        const adminPasswordHash = await bcrypt.hash('admin123', 12);
        await query(`
            INSERT INTO users (id, company_id, name, email, password_hash, role, is_superadmin, active)
            VALUES (1, $1, 'Master Admin', 'admincontadores@gmail.com', $2, 'admin', TRUE, TRUE)
            ON CONFLICT (id) DO NOTHING
        `, [masterCompanyId, adminPasswordHash]);

        await query(`
            INSERT INTO configs (company_id, provider)
            VALUES ($1, 'gemini')
            ON CONFLICT (company_id) DO NOTHING
        `, [masterCompanyId]);

        await query(`
            INSERT INTO subscriptions (company_id, status, plan_id, current_period_end)
            VALUES ($1, 'active', 3, CURRENT_DATE + INTERVAL '365 days')
            ON CONFLICT (company_id) DO NOTHING
        `, [masterCompanyId]);

        console.log('[INIT] Usuario Super Admin inicial creado: admincontadores@gmail.com / admin123');
    }
}

async function getCompanyWithPlan(companyId) {
    const { rows } = await query(`
        SELECT c.*,
               COALESCE(p.max_users, 1) AS max_users,
               COALESCE(p.max_boxes, 1) AS max_boxes,
               COALESCE(p.max_docs_month, p.max_documents_month, 10) AS max_docs_month
        FROM companies c
        LEFT JOIN plans p ON c.plan_id = p.id
        WHERE c.id = $1
    `, [companyId]);
    return rows[0] || null;
}

async function logUsage(companyId, userId, action) {
    await query('INSERT INTO usage_logs (company_id, user_id, action) VALUES ($1,$2,$3)', [companyId, userId, action]);
}

function triggerQueueProcessing() {
    setImmediate(() => {
        processPendingFiles().catch((err) => {
            console.error('[QUEUE TRIGGER ERROR]:', err.message);
        });
    });
}

const loginRateLimiter = createRateLimiter({
    keyPrefix: 'login',
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: 'Demasiados intentos de inicio de sesion. Espera unos minutos.'
});

const forgotPasswordRateLimiter = createRateLimiter({
    keyPrefix: 'forgot-password',
    windowMs: 30 * 60 * 1000,
    limit: 5,
    message: 'Se excedio el numero de solicitudes de recuperacion.'
});

const resetPasswordRateLimiter = createRateLimiter({
    keyPrefix: 'reset-password',
    windowMs: 30 * 60 * 1000,
    limit: 10,
    message: 'Se excedio el numero de intentos para restablecer la clave.'
});

const uploadRateLimiter = createRateLimiter({
    keyPrefix: 'upload',
    windowMs: 5 * 60 * 1000,
    limit: 30,
    message: 'Demasiadas cargas en poco tiempo. Intenta de nuevo en unos minutos.'
});

const retryRateLimiter = createRateLimiter({
    keyPrefix: 'retry',
    windowMs: 5 * 60 * 1000,
    limit: 40,
    message: 'Demasiados reintentos en poco tiempo.'
});

const authenticateToken = async (req, res, next) => {
    const token = getTokenFromRequest(req);
    if (!token) return res.status(401).json({ error: 'Acceso denegado.' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const { rows } = await query(`
            SELECT id, company_id, name, email, role, is_superadmin, active, session_version
            FROM users
            WHERE id = $1
        `, [decoded.id]);
        if (rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado.' });

        const user = rows[0];
        if (user.active === false) return res.status(403).json({ error: 'Usuario desactivado.' });
        if (Number(decoded.session_version || 0) !== Number(user.session_version || 0)) {
            clearAuthCookie(res);
            return res.status(403).json({ error: 'Sesion invalidada. Inicia sesion nuevamente.' });
        }

        req.user = userPayload(user);
        next();
    } catch (err) {
        clearAuthCookie(res);
        return res.status(403).json({ error: 'Sesion expirada.' });
    }
};

const isSuperAdmin = (req, res, next) => {
    if (!req.user || !req.user.is_superadmin) return res.status(403).json({ error: 'Acceso solo para superadmin.' });
    next();
};

app.use(async (req, res, next) => {
    if (req.path.startsWith('/api/auth') || !req.path.startsWith('/api/')) return next();

    const token = getTokenFromRequest(req);
    if (!token) return next();

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const company = await getCompanyWithPlan(decoded.company_id);

        if (!company) return res.status(403).json({ error: 'Empresa no existe.' });

        const today = new Date();
        const vencimiento = company.next_billing_date ? new Date(company.next_billing_date) : null;
        if (vencimiento && vencimiento < today && !decoded.is_superadmin) {
            return res.status(402).json({ error: 'Suscripcion vencida. Contacte al administrador para reactivar su servicio.' });
        }

        if (company.status !== 'active' && !decoded.is_superadmin) {
            return res.status(403).json({ error: 'Licencia suspendida o pendiente de activacion.' });
        }

        req.company = company;
        next();
    } catch (err) {
        next();
    }
});

app.post('/api/auth/register', loginRateLimiter, async (req, res) => {
    const companyName = normalizeText(req.body.company_name, 255);
    const name = normalizeText(req.body.name, 255);
    const email = sanitizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!companyName || !name || !email || password.length < 8) {
        return res.status(400).json({ error: 'Datos invalidos. Usa un correo valido y una clave de al menos 8 caracteres.' });
    }

    try {
        const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Ese correo ya esta registrado.' });
        }

        const companyResult = await query(`
            INSERT INTO companies (name, status, next_billing_date, plan_id, email_contact)
            VALUES ($1, 'pending', CURRENT_DATE + INTERVAL '30 days', 1, $2)
            RETURNING id
        `, [companyName, email]);
        const companyId = companyResult.rows[0].id;

        const passwordHash = await bcrypt.hash(password, 12);
        await query(`
            INSERT INTO users (company_id, name, email, password_hash, role, is_superadmin)
            VALUES ($1, $2, $3, $4, 'admin', FALSE)
        `, [companyId, name, email, passwordHash]);

        await query(`
            INSERT INTO configs (company_id, provider)
            VALUES ($1, 'gemini')
            ON CONFLICT (company_id) DO NOTHING
        `, [companyId]);
        await query(`
            INSERT INTO subscriptions (company_id, status, plan_id, current_period_end)
            VALUES ($1, 'pending', 1, CURRENT_DATE + INTERVAL '30 days')
            ON CONFLICT (company_id) DO NOTHING
        `, [companyId]);
        await writeAudit(companyId, null, 'register_company_request', 'company', companyId, { email, company_name: companyName });
        res.status(201).json({
            ok: true,
            pending_approval: true,
            message: 'Solicitud recibida. La empresa quedo pendiente de aprobacion en el modulo SaaS.'
        });
    } catch (err) {
        console.error('[AUTH REGISTER ERROR]:', err.message);
        res.status(500).json({ error: 'No se pudo crear la cuenta.' });
    }
});

app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
    const email = sanitizeEmail(req.body.email);
    const password = String(req.body.password || '');

    try {
        const { rows } = await query(`
            SELECT u.*, c.status AS company_status, c.next_billing_date
            FROM users u
            JOIN companies c ON u.company_id = c.id
            WHERE u.email = $1
        `, [email]);
        if (rows.length === 0) return res.status(400).json({ error: 'Credenciales invalidas.' });

        const user = rows[0];
        if (user.active === false) {
            return res.status(403).json({ error: 'Usuario desactivado.' });
        }
        if (!await bcrypt.compare(password, user.password_hash)) {
            return res.status(400).json({ error: 'Credenciales invalidas.' });
        }
        if (user.company_status !== 'active' && !user.is_superadmin) {
            return res.status(403).json({ error: 'Empresa pendiente de aprobacion o suspendida. Debe activarse desde el modulo SaaS.' });
        }

        if (user.next_billing_date && new Date(user.next_billing_date) < new Date() && !user.is_superadmin) {
            return res.status(402).json({ error: 'Tu servicio ha expirado. Procede con el pago para ingresar.' });
        }

        await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
        const token = issueAuthToken(user);
        setAuthCookie(res, token);
        await writeAudit(user.company_id, user.id, 'login', 'user', user.id, {});
        res.json({ ok: true, user: userPayload(user) });
    } catch (err) {
        console.error('[AUTH LOGIN ERROR]:', err.message);
        res.status(500).json({ error: 'Error interno.' });
    }
});

app.post('/api/auth/forgot-password', forgotPasswordRateLimiter, async (req, res) => {
    const email = sanitizeEmail(req.body.email);
    try {
        const { rows } = await query('SELECT id, company_id, name, email FROM users WHERE email = $1 AND active = TRUE', [email]);
        if (rows.length > 0) {
            const resetToken = await createPasswordResetToken(rows[0].id);
            const delivery = await sendPasswordResetMessage({
                email: rows[0].email,
                name: rows[0].name,
                rawToken: resetToken
            });
            await writeAudit(rows[0].company_id, rows[0].id, 'request_password_reset', 'user', rows[0].id, {});
            const response = {
                ok: true,
                message: delivery.mode === 'webhook' ? 'Se envio el enlace de recuperacion.' : 'Token generado.'
            };
            if (delivery.mode === 'log' && process.env.NODE_ENV !== 'production') {
                response.reset_token = resetToken;
                response.reset_url = delivery.resetUrl;
            }
            return res.json(response);
        }
        res.json({ ok: true, message: 'Si el usuario existe, se genero un token.' });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo generar el token.' });
    }
});

app.post('/api/auth/reset-password', resetPasswordRateLimiter, async (req, res) => {
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');
    if (!token || password.length < 8) {
        return res.status(400).json({ error: 'Token o clave invalidos.' });
    }
    try {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const { rows } = await query(`
            SELECT pr.id, pr.user_id, u.company_id
            FROM password_resets pr
            JOIN users u ON pr.user_id = u.id
            WHERE pr.token_hash = $1
              AND pr.used_at IS NULL
              AND pr.expires_at > NOW()
            ORDER BY pr.created_at DESC
            LIMIT 1
        `, [tokenHash]);
        if (rows.length === 0) {
            return res.status(400).json({ error: 'Token invalido o expirado.' });
        }
        const passwordHash = await bcrypt.hash(password, 12);
        await query('UPDATE users SET password_hash = $1, session_version = session_version + 1 WHERE id = $2', [passwordHash, rows[0].user_id]);
        await query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [rows[0].id]);
        await writeAudit(rows[0].company_id, rows[0].user_id, 'reset_password', 'user', rows[0].user_id, {});
        res.json({ ok: true, message: 'Clave actualizada.' });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo actualizar la clave.' });
    }
});

app.get('/api/team/users', authenticateToken, isCompanyAdmin, async (req, res) => {
    try {
        const { rows } = await query(`
            SELECT id, company_id, name, email, role, is_superadmin, active, created_at
            FROM users
            WHERE company_id = $1
            ORDER BY created_at ASC
        `, [req.user.company_id]);
        res.json(rows.map(userPayload));
    } catch (err) {
        res.status(500).json({ error: 'No se pudo cargar el equipo.' });
    }
});

app.post('/api/team/users', authenticateToken, isCompanyAdmin, async (req, res) => {
    const name = normalizeText(req.body.name, 255);
    const email = sanitizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const role = ['admin', 'user', 'viewer'].includes(req.body.role) ? req.body.role : 'user';
    if (!name || !email || password.length < 8) {
        return res.status(400).json({ error: 'Datos invalidos para crear usuario.' });
    }
    try {
        const countResult = await query('SELECT COUNT(*)::int AS total FROM users WHERE company_id = $1 AND active = TRUE', [req.user.company_id]);
        const activeUsers = countResult.rows[0]?.total || 0;
        const maxUsers = Number(req.company?.max_users || 1);
        if (activeUsers >= maxUsers) {
            return res.status(403).json({ error: `Limite de usuarios activos alcanzado (${maxUsers}).` });
        }
        const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Ese correo ya existe.' });
        }
        const passwordHash = await bcrypt.hash(password, 12);
        const { rows } = await query(`
            INSERT INTO users (company_id, name, email, password_hash, role, is_superadmin, active)
            VALUES ($1,$2,$3,$4,$5,FALSE,TRUE)
            RETURNING id, company_id, name, email, role, is_superadmin, active
        `, [req.user.company_id, name, email, passwordHash, role]);
        await writeAudit(req.user.company_id, req.user.id, 'create_user', 'user', rows[0].id, { role, email });
        res.status(201).json({ ok: true, user: userPayload(rows[0]) });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo crear el usuario.' });
    }
});

app.patch('/api/team/users/:id', authenticateToken, isCompanyAdmin, async (req, res) => {
    const userId = Number(req.params.id);
    const role = ['admin', 'user', 'viewer'].includes(req.body.role) ? req.body.role : null;
    const active = typeof req.body.active === 'boolean' ? req.body.active : null;
    if (role === null && active === null) {
        return res.status(400).json({ error: 'No hay cambios para aplicar.' });
    }
    try {
        const { rows } = await query(`
            SELECT id, company_id, role, active
            FROM users
            WHERE id = $1 AND company_id = $2
        `, [userId, req.user.company_id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });
        if (userId === req.user.id && active === false) {
            return res.status(400).json({ error: 'No puedes desactivar tu propia cuenta.' });
        }
        await query(`
            UPDATE users
            SET role = COALESCE($1, role),
                active = COALESCE($2, active),
                session_version = CASE WHEN $2 = FALSE THEN session_version + 1 ELSE session_version END
            WHERE id = $3
        `, [role, active, userId]);
        await writeAudit(req.user.company_id, req.user.id, 'update_user', 'user', userId, { role, active });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo actualizar el usuario.' });
    }
});

app.get('/api/audit', authenticateToken, isCompanyAdmin, async (req, res) => {
    try {
        const { rows } = await query(`
            SELECT a.id, a.action, a.target_type, a.target_id, a.detail_json, a.created_at,
                   u.name AS actor_name
            FROM audit_logs a
            LEFT JOIN users u ON a.user_id = u.id
            WHERE a.company_id = $1
            ORDER BY a.created_at DESC
            LIMIT 200
        `, [req.user.company_id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'No se pudo cargar la auditoria.' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const { rows } = await query(`
            SELECT id, company_id, name, email, role, is_superadmin, active, session_version
            FROM users
            WHERE id = $1
        `, [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });
        res.json({ user: userPayload(rows[0]) });
    } catch (err) {
        res.status(500).json({ error: 'Error interno.' });
    }
});

app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
    const currentPassword = String(req.body.current_password || '');
    const newPassword = String(req.body.new_password || '');
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'La nueva clave debe tener al menos 8 caracteres.' });
    }
    try {
        const { rows } = await query('SELECT id, company_id, password_hash FROM users WHERE id = $1', [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });
        const user = rows[0];
        if (!await bcrypt.compare(currentPassword, user.password_hash)) {
            return res.status(400).json({ error: 'Clave actual incorrecta.' });
        }
        const passwordHash = await bcrypt.hash(newPassword, 12);
        await query('UPDATE users SET password_hash = $1, session_version = session_version + 1 WHERE id = $2', [passwordHash, user.id]);
        clearAuthCookie(res);
        await writeAudit(user.company_id, user.id, 'change_password', 'user', user.id, {});
        res.json({ ok: true, message: 'Clave actualizada. Debes iniciar sesion nuevamente.' });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo cambiar la clave.' });
    }
});

app.post('/api/team/users/:id/reset-password', authenticateToken, isCompanyAdmin, async (req, res) => {
    const userId = Number(req.params.id);
    const newPassword = String(req.body.new_password || '');
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'La nueva clave debe tener al menos 8 caracteres.' });
    }
    try {
        const { rows } = await query('SELECT id, company_id FROM users WHERE id = $1 AND company_id = $2', [userId, req.user.company_id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });
        const passwordHash = await bcrypt.hash(newPassword, 12);
        await query('UPDATE users SET password_hash = $1, session_version = session_version + 1 WHERE id = $2', [passwordHash, userId]);
        await writeAudit(req.user.company_id, req.user.id, 'admin_reset_password', 'user', userId, {});
        res.json({ ok: true, message: 'Clave reseteada.' });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo resetear la clave.' });
    }
});

app.get('/api/saas/dashboard-master', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const stats = await query(`
            SELECT
                (SELECT COUNT(*) FROM companies WHERE status = 'active') AS active_c,
                (SELECT COUNT(*) FROM companies WHERE next_billing_date < CURRENT_DATE) AS vencidos_c,
                (SELECT COALESCE(SUM(p.price_monthly),0) FROM companies c LEFT JOIN plans p ON c.plan_id = p.id WHERE c.status = 'active') AS mrr,
                (SELECT COUNT(*) FROM usage_logs WHERE created_at > NOW() - INTERVAL '24 hours') AS extraction_24h
        `);
        const companies = await query(`
            SELECT c.*, p.name AS plan_name, COALESCE(p.max_users, 1) AS plan_max_u,
                   COALESCE(conf.provider, conf.active_provider, 'gemini') AS provider,
                   CASE WHEN COALESCE(conf.gemini_api_key_enc, conf.gemini_api_key, conf.api_key_gemini, '') <> '' THEN TRUE ELSE FALSE END AS has_gemini_api_key,
                   CASE WHEN COALESCE(conf.groq_api_key_enc, conf.groq_api_key, conf.api_key_groq, '') <> '' THEN TRUE ELSE FALSE END AS has_groq_api_key,
                   (SELECT COUNT(*) FROM users WHERE company_id = c.id) AS current_users
            FROM companies c
            LEFT JOIN plans p ON c.plan_id = p.id
            LEFT JOIN configs conf ON c.id = conf.company_id
            ORDER BY c.id DESC
        `);
        res.json({ stats: stats.rows[0], companies: companies.rows });
    } catch (err) {
        console.error('[SAAS MASTER ERROR]:', err.message);
        res.status(500).json({ error: 'SaaS master backend error.' });
    }
});

app.get('/api/saas/companies', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const companies = await query(`
            SELECT c.*, p.name AS plan_name, COALESCE(p.max_users, 1) AS plan_max_u,
                   COALESCE(conf.provider, conf.active_provider, 'gemini') AS provider,
                   CASE WHEN COALESCE(conf.gemini_api_key_enc, conf.gemini_api_key, conf.api_key_gemini, '') <> '' THEN TRUE ELSE FALSE END AS has_gemini_api_key,
                   CASE WHEN COALESCE(conf.groq_api_key_enc, conf.groq_api_key, conf.api_key_groq, '') <> '' THEN TRUE ELSE FALSE END AS has_groq_api_key,
                   (SELECT COUNT(*) FROM users WHERE company_id = c.id AND active = TRUE) AS active_users,
                   (SELECT COUNT(*) FROM documents WHERE company_id = c.id) AS documents_total,
                   (SELECT status FROM subscriptions WHERE company_id = c.id LIMIT 1) AS subscription_status
            FROM companies c
            LEFT JOIN plans p ON c.plan_id = p.id
            LEFT JOIN configs conf ON c.id = conf.company_id
            ORDER BY c.id DESC
        `);
        res.json(companies.rows);
    } catch (err) {
        res.status(500).json({ error: 'No se pudieron cargar las empresas.' });
    }
});

app.post('/api/saas/companies', authenticateToken, isSuperAdmin, async (req, res) => {
    const companyName = normalizeText(req.body.company_name, 255);
    const adminName = normalizeText(req.body.admin_name, 255);
    const adminEmail = sanitizeEmail(req.body.admin_email);
    const adminPassword = String(req.body.admin_password || '');
    const planId = Number(req.body.plan_id) || 1;
    const status = normalizeText(req.body.status, 20) || 'active';
    const nextBillingDate = req.body.next_billing_date && String(req.body.next_billing_date).trim() !== '' ? req.body.next_billing_date : null;
    const nit = normalizeText(req.body.nit, 20);
    const city = normalizeText(req.body.city, 100);
    const phone = normalizeText(req.body.phone, 20);
    const emailContact = sanitizeEmail(req.body.email_contact || req.body.admin_email);
    const provider = normalizeText(req.body.provider, 50) || 'gemini';

    if (!companyName || !adminName || !adminEmail || adminPassword.length < 8) {
        return res.status(400).json({ error: 'Empresa, admin, correo y clave valida son obligatorios.' });
    }

    try {
        const existing = await query('SELECT id FROM users WHERE email = $1', [adminEmail]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Ese correo admin ya existe.' });
        }

        const companyResult = await query(`
            INSERT INTO companies (name, status, next_billing_date, plan_id, nit, city, phone, email_contact)
            VALUES ($1, $2, COALESCE($3, CURRENT_DATE + INTERVAL '30 days'), $4, $5, $6, $7, $8)
            RETURNING id
        `, [companyName, status, nextBillingDate, planId, nit, city, phone, emailContact]);
        const companyId = companyResult.rows[0].id;

        const passwordHash = await bcrypt.hash(adminPassword, 12);
        await query(`
            INSERT INTO users (company_id, name, email, password_hash, role, is_superadmin, active)
            VALUES ($1, $2, $3, $4, 'admin', FALSE, TRUE)
        `, [companyId, adminName, adminEmail, passwordHash]);

        await query(`
            INSERT INTO configs (company_id, provider)
            VALUES ($1, $2)
            ON CONFLICT (company_id) DO UPDATE SET provider = EXCLUDED.provider
        `, [companyId, provider]);

        await query(`
            INSERT INTO subscriptions (company_id, status, plan_id, current_period_end, updated_at)
            VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE + INTERVAL '30 days'), CURRENT_TIMESTAMP)
            ON CONFLICT (company_id) DO UPDATE SET
                status = EXCLUDED.status,
                plan_id = EXCLUDED.plan_id,
                current_period_end = EXCLUDED.current_period_end,
                updated_at = CURRENT_TIMESTAMP
        `, [companyId, status, planId, nextBillingDate]);

        res.status(201).json({ ok: true, company_id: companyId, message: 'Empresa creada en el SaaS.' });
    } catch (err) {
        console.error('[CREATE SAAS COMPANY ERROR]:', err.message);
        res.status(500).json({ error: 'No se pudo crear la empresa.' });
    }
});

app.get('/api/saas/payments', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const payments = await query(`
            SELECT p.*, c.name AS company_name, u.name AS created_by_name
            FROM payments p
            LEFT JOIN companies c ON p.company_id = c.id
            LEFT JOIN users u ON p.created_by = u.id
            ORDER BY p.payment_date DESC
            LIMIT 200
        `);
        res.json(payments.rows);
    } catch (err) {
        res.status(500).json({ error: 'No se pudieron cargar los pagos.' });
    }
});

app.get('/api/saas/usage', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const usage = await query(`
            WITH document_stats AS (
                SELECT
                    c.id,
                    COUNT(d.id)::int AS documents_total,
                    COUNT(*) FILTER (WHERE d.created_at >= date_trunc('month', CURRENT_TIMESTAMP))::int AS docs_month,
                    COUNT(*) FILTER (WHERE d.status = 'completed')::int AS completed_docs,
                    COUNT(*) FILTER (WHERE d.status = 'completed' AND d.created_at >= date_trunc('month', CURRENT_TIMESTAMP))::int AS completed_docs_month,
                    COUNT(*) FILTER (WHERE d.status = 'error')::int AS error_docs,
                    COUNT(*) FILTER (WHERE d.status = 'error' AND d.created_at >= date_trunc('month', CURRENT_TIMESTAMP))::int AS error_docs_month,
                    COUNT(*) FILTER (WHERE d.status = 'pending')::int AS pending_docs,
                    COUNT(*) FILTER (WHERE d.status = 'processing')::int AS processing_docs,
                    MAX(d.updated_at) AS last_document_activity_at
                FROM companies c
                LEFT JOIN documents d ON c.id = d.company_id
                GROUP BY c.id
            ),
            usage_stats AS (
                SELECT
                    c.id,
                    COUNT(*) FILTER (WHERE ul.action = 'document_processed')::int AS processed_events_total,
                    COUNT(*) FILTER (WHERE ul.action = 'document_processed' AND ul.created_at >= date_trunc('month', CURRENT_TIMESTAMP))::int AS processed_events_month,
                    COUNT(*) FILTER (WHERE ul.action = 'document_processed' AND ul.status = 'completed' AND ul.created_at >= date_trunc('month', CURRENT_TIMESTAMP))::int AS processed_ok_month,
                    COUNT(*) FILTER (WHERE ul.action = 'document_processed' AND ul.status = 'error' AND ul.created_at >= date_trunc('month', CURRENT_TIMESTAMP))::int AS processed_error_month,
                    ROUND(COALESCE(AVG(ul.duration_ms) FILTER (
                        WHERE ul.action = 'document_processed'
                          AND ul.status = 'completed'
                          AND ul.created_at >= date_trunc('month', CURRENT_TIMESTAMP)
                          AND ul.duration_ms IS NOT NULL
                    ), 0)::numeric, 0) AS avg_processing_ms_month,
                    ROUND(COALESCE(SUM(ul.cost_est) FILTER (
                        WHERE ul.action = 'document_processed'
                          AND ul.created_at >= date_trunc('month', CURRENT_TIMESTAMP)
                    ), 0)::numeric, 5) AS estimated_cost_month,
                    COUNT(DISTINCT ul.user_id) FILTER (
                        WHERE ul.created_at >= date_trunc('month', CURRENT_TIMESTAMP)
                          AND ul.user_id IS NOT NULL
                    )::int AS active_users_month,
                    STRING_AGG(DISTINCT ul.provider, ', ' ORDER BY ul.provider) FILTER (
                        WHERE COALESCE(ul.provider, '') <> ''
                    ) AS providers_used,
                    MAX(ul.created_at) AS last_usage_at
                FROM companies c
                LEFT JOIN usage_logs ul ON c.id = ul.company_id
                GROUP BY c.id
            )
            SELECT c.id,
                   c.name,
                   c.plan_id,
                   p.name AS plan_name,
                   COALESCE(p.max_docs_month, p.max_documents_month, 0)::int AS quota_docs_month,
                   COALESCE(ds.documents_total, 0) AS documents_total,
                   COALESCE(ds.docs_month, 0) AS docs_month,
                   COALESCE(ds.completed_docs, 0) AS completed_docs,
                   COALESCE(ds.completed_docs_month, 0) AS completed_docs_month,
                   COALESCE(ds.error_docs, 0) AS error_docs,
                   COALESCE(ds.error_docs_month, 0) AS error_docs_month,
                   COALESCE(ds.pending_docs, 0) AS pending_docs,
                   COALESCE(ds.processing_docs, 0) AS processing_docs,
                   COALESCE(us.active_users_month, 0) AS active_users_month,
                   COALESCE(us.processed_events_total, 0) AS processed_events_total,
                   COALESCE(us.processed_events_month, 0) AS processed_events_month,
                   COALESCE(us.processed_ok_month, 0) AS processed_ok_month,
                   COALESCE(us.processed_error_month, 0) AS processed_error_month,
                   ROUND(COALESCE(us.avg_processing_ms_month, 0) / 1000.0, 1) AS avg_processing_seconds_month,
                   COALESCE(us.estimated_cost_month, 0) AS estimated_cost_month,
                   COALESCE(us.providers_used, '') AS providers_used,
                   GREATEST(ds.last_document_activity_at, us.last_usage_at) AS last_activity_at,
                   CASE
                       WHEN COALESCE(p.max_docs_month, p.max_documents_month, 0) > 0
                       THEN ROUND((COALESCE(ds.docs_month, 0)::numeric / COALESCE(p.max_docs_month, p.max_documents_month, 0)::numeric) * 100, 1)
                       ELSE 0
                   END AS quota_used_pct,
                   CASE
                       WHEN COALESCE(ds.docs_month, 0) > 0
                       THEN ROUND((COALESCE(ds.error_docs_month, 0)::numeric / ds.docs_month::numeric) * 100, 1)
                       ELSE 0
                   END AS error_rate_pct
            FROM companies c
            LEFT JOIN plans p ON c.plan_id = p.id
            LEFT JOIN document_stats ds ON c.id = ds.id
            LEFT JOIN usage_stats us ON c.id = us.id
            ORDER BY docs_month DESC, documents_total DESC
        `);
        res.json(usage.rows);
    } catch (err) {
        res.status(500).json({ error: 'No se pudo cargar el uso.' });
    }
});

app.get('/api/saas/plans', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const plans = await query(`
            SELECT id, name, price_monthly, COALESCE(max_docs_month, max_documents_month, 0) AS max_docs_month,
                   COALESCE(max_documents_month, max_docs_month, 0) AS max_documents_month,
                   COALESCE(max_users, 1) AS max_users,
                   COALESCE(max_boxes, 1) AS max_boxes,
                   COALESCE(features, '{}'::jsonb) AS features,
                   COALESCE(modules_json, '{}'::jsonb) AS modules_json,
                   COALESCE(support_type, 'Email') AS support_type,
                   COALESCE(api_access, FALSE) AS api_access,
                   created_at
            FROM plans
            ORDER BY price_monthly ASC, id ASC
        `);
        res.json(plans.rows);
    } catch (err) {
        res.status(500).json({ error: 'No se pudieron cargar los planes.' });
    }
});

app.post('/api/saas/plans', authenticateToken, isSuperAdmin, async (req, res) => {
    const {
        name, price_monthly, max_docs_month, max_users, max_boxes, support_type, api_access, features, modules_json
    } = req.body;
    try {
        const created = await query(`
            INSERT INTO plans (name, price_monthly, max_documents_month, max_docs_month, max_users, max_boxes, features, modules_json, support_type, api_access)
            VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9)
            RETURNING id
        `, [
            normalizeText(name, 50),
            Number(price_monthly) || 0,
            Number(max_docs_month) || 0,
            Number(max_users) || 1,
            Number(max_boxes) || 1,
            typeof features === 'object' && features ? JSON.stringify(features) : '{}',
            typeof modules_json === 'object' && modules_json ? JSON.stringify(modules_json) : '{}',
            normalizeText(support_type, 50) || 'Email',
            !!api_access
        ]);
        res.json({ ok: true, id: created.rows[0]?.id, message: 'Plan creado.' });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo crear el plan.' });
    }
});

app.patch('/api/saas/plans/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    const planId = Number(req.params.id);
    const {
        name, price_monthly, max_docs_month, max_users, max_boxes, support_type, api_access, features, modules_json
    } = req.body;
    try {
        await query(`
            UPDATE plans
            SET name = $1,
                price_monthly = $2,
                max_documents_month = $3,
                max_docs_month = $3,
                max_users = $4,
                max_boxes = $5,
                support_type = $6,
                api_access = $7,
                features = $8,
                modules_json = $9
            WHERE id = $10
        `, [
            normalizeText(name, 50),
            Number(price_monthly) || 0,
            Number(max_docs_month) || 0,
            Number(max_users) || 1,
            Number(max_boxes) || 1,
            normalizeText(support_type, 50) || 'Email',
            !!api_access,
            typeof features === 'object' && features ? JSON.stringify(features) : '{}',
            typeof modules_json === 'object' && modules_json ? JSON.stringify(modules_json) : '{}',
            planId
        ]);
        res.json({ ok: true, message: 'Plan actualizado.' });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo actualizar el plan.' });
    }
});

app.post('/api/saas/payments', authenticateToken, isSuperAdmin, async (req, res) => {
    const { company_id, amount, method, period_months, observation } = req.body;
    try {
        await query(
            'INSERT INTO payments (company_id, amount, method, period_months, observation, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
            [company_id, amount, method, period_months, observation, req.user.id]
        );
        await query(`
            UPDATE companies
            SET next_billing_date = COALESCE(next_billing_date, CURRENT_DATE) + ($1 || ' month')::interval,
                status = 'active'
            WHERE id = $2
        `, [period_months, company_id]);
        await query(`
            INSERT INTO subscriptions (company_id, status, plan_id, current_period_end, updated_at)
            SELECT id, 'active', plan_id, next_billing_date, CURRENT_TIMESTAMP
            FROM companies
            WHERE id = $1
            ON CONFLICT (company_id) DO UPDATE SET
                status = 'active',
                plan_id = EXCLUDED.plan_id,
                current_period_end = EXCLUDED.current_period_end,
                updated_at = CURRENT_TIMESTAMP
        `, [company_id]);
        res.json({ ok: true, message: 'Pago registrado y licencia extendida.' });
    } catch (err) {
        res.status(500).json({ error: 'Error al procesar pago.' });
    }
});

app.post('/api/saas/companies/:id/update-pro', authenticateToken, isSuperAdmin, async (req, res) => {
    const {
        status, plan_id, next_billing_date, nit, city, phone, email_contact, provider,
        gemini_api_key, groq_api_key
    } = req.body;
    const cid = Number(req.params.id);
    const validDate = next_billing_date && String(next_billing_date).trim() !== '' ? next_billing_date : null;

    try {
        const geminiEncrypted = encryptSecret(gemini_api_key);
        const groqEncrypted = encryptSecret(groq_api_key);
        await query(`
            UPDATE companies
            SET status = $1,
                plan_id = $2,
                next_billing_date = COALESCE($3, next_billing_date),
                nit = $4,
                city = $5,
                phone = $6,
                email_contact = $7
            WHERE id = $8
        `, [
            status || 'active',
            Number(plan_id) || 1,
            validDate,
            normalizeText(nit, 20),
            normalizeText(city, 100),
            normalizeText(phone, 20),
            normalizeText(email_contact, 100),
            cid
        ]);

        await query(`
            INSERT INTO configs (company_id, provider, gemini_api_key, groq_api_key, gemini_api_key_enc, groq_api_key_enc)
            VALUES ($1, $2, NULL, NULL, $3, $4)
            ON CONFLICT (company_id) DO UPDATE SET
                provider = EXCLUDED.provider,
                gemini_api_key = CASE WHEN $5 THEN NULL ELSE configs.gemini_api_key END,
                groq_api_key = CASE WHEN $6 THEN NULL ELSE configs.groq_api_key END,
                api_key_gemini = CASE WHEN $5 THEN NULL ELSE configs.api_key_gemini END,
                api_key_groq = CASE WHEN $6 THEN NULL ELSE configs.api_key_groq END,
                gemini_api_key_enc = CASE WHEN $5 THEN EXCLUDED.gemini_api_key_enc ELSE configs.gemini_api_key_enc END,
                groq_api_key_enc = CASE WHEN $6 THEN EXCLUDED.groq_api_key_enc ELSE configs.groq_api_key_enc END
        `, [cid, provider || 'gemini', geminiEncrypted, groqEncrypted, !!String(gemini_api_key || '').trim(), !!String(groq_api_key || '').trim()]);

        await query(`
            INSERT INTO subscriptions (company_id, status, plan_id, current_period_end, updated_at)
            VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE + INTERVAL '30 days'), CURRENT_TIMESTAMP)
            ON CONFLICT (company_id) DO UPDATE SET
                status = EXCLUDED.status,
                plan_id = EXCLUDED.plan_id,
                current_period_end = EXCLUDED.current_period_end,
                updated_at = CURRENT_TIMESTAMP
        `, [cid, status || 'active', Number(plan_id) || 1, validDate]);

        res.json({ ok: true, message: 'Empresa y configuracion actualizadas.' });
    } catch (err) {
        console.error('[UPDATE COMPANY ERROR]:', err.message);
        res.status(500).json({ error: 'Error al actualizar empresa.' });
    }
});

app.get('/api/saas/companies/:id/users', authenticateToken, isSuperAdmin, async (req, res) => {
    const companyId = Number(req.params.id);
    try {
        const { rows } = await query(`
            SELECT id, company_id, name, email, role, is_superadmin, active, last_login_at, created_at
            FROM users
            WHERE company_id = $1
            ORDER BY created_at ASC
        `, [companyId]);
        res.json(rows.map(userPayload));
    } catch (err) {
        res.status(500).json({ error: 'No se pudieron cargar los usuarios de la empresa.' });
    }
});

app.post('/api/saas/companies/:companyId/users/:userId/reset-password', authenticateToken, isSuperAdmin, async (req, res) => {
    const companyId = Number(req.params.companyId);
    const userId = Number(req.params.userId);
    const providedPassword = String(req.body.new_password || '');
    const newPassword = providedPassword.length >= 8 ? providedPassword : generateTemporaryPassword(12);

    try {
        const { rows } = await query(`
            SELECT id, company_id, email, name
            FROM users
            WHERE id = $1 AND company_id = $2
        `, [userId, companyId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });

        const passwordHash = await bcrypt.hash(newPassword, 12);
        await query(`
            UPDATE users
            SET password_hash = $1,
                session_version = session_version + 1
            WHERE id = $2
        `, [passwordHash, userId]);

        await writeAudit(companyId, req.user.id, 'saas_reset_password', 'user', userId, {
            email: rows[0].email,
            generated: providedPassword.length < 8
        });

        res.json({
            ok: true,
            temporary_password: newPassword,
            message: 'Clave temporal generada. Compartela de forma segura; no se volvera a mostrar.'
        });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo resetear la clave del usuario.' });
    }
});

app.get('/api/data', authenticateToken, async (req, res) => {
    try {
        const scope = req.query.scope === 'all' && canManageCompany(req) ? 'all' : 'mine';
        const params = [req.user.company_id];
        let whereClause = 'd.company_id = $1';
        if (scope === 'mine' && !req.user.is_superadmin) {
            params.push(req.user.id);
            whereClause += ' AND COALESCE(d.assigned_to, d.uploaded_by) = $2';
        }
        const result = await query(`
            SELECT d.id, d.company_id, d.uploaded_by, d.assigned_to, d.filename, d.original_filename, d.source_path, d.status,
                   d.extracted_data, d.error_message, d.retry_count, d.max_retries, d.last_attempt_at, d.created_at, d.updated_at,
                   uploader.name AS uploaded_by_name,
                   assigned.name AS assigned_to_name
            FROM documents d
            LEFT JOIN users uploader ON d.uploaded_by = uploader.id
            LEFT JOIN users assigned ON d.assigned_to = assigned.id
            WHERE ${whereClause}
            ORDER BY d.created_at DESC
        `, params);

        result.rows.forEach((row) => {
            if (row.extracted_data && typeof row.extracted_data === 'object') {
                row.extracted_data = JSON.stringify(row.extracted_data);
            }
        });

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

app.get('/api/export/excel', authenticateToken, async (req, res) => {
    try {
        const scope = req.query.scope === 'all' && canManageCompany(req) ? 'all' : 'mine';
        const params = [req.user.company_id];
        let whereClause = 'd.company_id = $1';
        if (scope === 'mine' && !req.user.is_superadmin) {
            params.push(req.user.id);
            whereClause += ' AND COALESCE(d.assigned_to, d.uploaded_by) = $2';
        }

        const result = await query(`
            SELECT d.id, d.company_id, d.uploaded_by, d.assigned_to, d.filename, d.original_filename, d.source_path, d.status,
                   d.extracted_data, d.error_message, d.retry_count, d.max_retries, d.last_attempt_at, d.created_at, d.updated_at
            FROM documents d
            WHERE ${whereClause}
            ORDER BY d.created_at DESC
        `, params);

        const completed = result.rows.filter((row) => row.status === 'completed' && row.extracted_data);
        const totals = {
            totalFactura: 0, baseExento: 0, base5: 0, iva5: 0, base8: 0, iva8: 0, base19: 0, iva19: 0,
            reteFuente: 0, reteIva: 0, reteIca: 0, impuestoConsumo: 0, diferenciaTotal: 0,
            baseProducto: 0, ivaProducto: 0, totalProducto: 0
        };
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Reporte');
        ws.properties.outlineLevelRow = 1;
        ws.views = [{ state: 'frozen', ySplit: 2 }];
        ws.columns = [
            { header: 'Nivel', key: 'nivel', width: 10 },
            { header: 'Fecha', key: 'fecha', width: 12 },
            { header: 'Origen', key: 'origen', width: 14 },
            { header: 'Factura', key: 'factura', width: 20 },
            { header: 'NIT', key: 'nit', width: 18 },
            { header: 'Descripcion', key: 'descripcion', width: 34 },
            { header: 'Cantidad', key: 'cantidad', width: 12 },
            { header: 'Unidad', key: 'unidad', width: 12 },
            { header: 'Vr Unitario', key: 'valorUnitario', width: 16 },
            { header: 'Total Factura', key: 'totalFactura', width: 16 },
            { header: 'Base Exento', key: 'baseExento', width: 14 },
            { header: 'Base IVA 5', key: 'base5', width: 14 },
            { header: 'IVA 5', key: 'iva5', width: 14 },
            { header: 'Base IVA 8', key: 'base8', width: 14 },
            { header: 'IVA 8', key: 'iva8', width: 14 },
            { header: 'Base IVA 19', key: 'base19', width: 14 },
            { header: 'IVA 19', key: 'iva19', width: 14 },
            { header: 'ReteFuente', key: 'reteFuente', width: 14 },
            { header: 'ReteIVA', key: 'reteIva', width: 14 },
            { header: 'ReteICA', key: 'reteIca', width: 14 },
            { header: 'Imp Consumo', key: 'impuestoConsumo', width: 14 },
            { header: 'Diferencia', key: 'diferenciaTotal', width: 14 },
            { header: 'Base Producto', key: 'baseProducto', width: 16 },
            { header: '% IVA Producto', key: 'porcentajeIvaProducto', width: 16 },
            { header: 'IVA Producto', key: 'ivaProducto', width: 16 },
            { header: 'Total Producto', key: 'totalProducto', width: 16 }
        ];

        ws.insertRow(1, {
            nivel: 'GUIA',
            fecha: 'Usa el simbolo +/- del margen izquierdo para expandir o contraer los productos por factura.'
        });
        ws.mergeCells(1, 2, 1, ws.columns.length);
        ws.getCell('A1').font = { bold: true, color: { argb: 'FFFFD36C' } };
        ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16212B' } };
        ws.getCell('B1').font = { italic: true, bold: true, color: { argb: 'FFF7FBFF' } };
        ws.getCell('B1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16212B' } };
        ws.getRow(2).font = { bold: true };
        ws.getRow(2).height = 22;
        ws.autoFilter = {
            from: { row: 2, column: 1 },
            to: { row: 2, column: ws.columns.length }
        };
        ws.getColumn('A').alignment = { horizontal: 'center' };
        ws.getColumn('F').alignment = { horizontal: 'left' };

        for (const row of completed) {
            const ed = parseExtractedData(row);
            if (!ed) continue;

            const products = Array.isArray(ed.detalleProductos) ? ed.detalleProductos : [];
            const productTotals = { base: 0, iva: 0, total: 0 };

            for (const product of products) {
                const base = toNumber(product.baseImpuesto ?? product.base ?? product.subtotalLinea ?? 0);
                const iva = toNumber(product.ivaValor ?? product.valorIVA ?? product.iva ?? 0);
                const total = toNumber(product.totalLinea ?? product.total ?? (base + iva));
                productTotals.base += base;
                productTotals.iva += iva;
                productTotals.total += total;
            }

            totals.totalFactura += ed.totalFactura;
            totals.baseExento += ed.baseExento;
            totals.base5 += ed.base5;
            totals.iva5 += ed.iva5;
            totals.base8 += ed.base8;
            totals.iva8 += ed.iva8;
            totals.base19 += ed.base19;
            totals.iva19 += ed.iva19;
            totals.reteFuente += ed.reteFuente;
            totals.reteIva += ed.reteIva;
            totals.reteIca += ed.reteIca;
            totals.impuestoConsumo += ed.impuestoConsumo;
            totals.diferenciaTotal += ed.diferenciaTotal;
            totals.baseProducto += productTotals.base;
            totals.ivaProducto += productTotals.iva;
            totals.totalProducto += productTotals.total;

            const invoiceRow = ws.addRow({
                nivel: 'F',
                fecha: new Date(row.created_at).toLocaleDateString('es-CO'),
                origen: sourceLabel(ed.origen),
                factura: ed.factura,
                nit: ed.nit,
                descripcion: cleanDisplayFileName(row.original_filename || row.filename || ''),
                totalFactura: ed.totalFactura,
                baseExento: ed.baseExento,
                base5: ed.base5,
                iva5: ed.iva5,
                base8: ed.base8,
                iva8: ed.iva8,
                base19: ed.base19,
                iva19: ed.iva19,
                reteFuente: ed.reteFuente,
                reteIva: ed.reteIva,
                reteIca: ed.reteIca,
                impuestoConsumo: ed.impuestoConsumo,
                diferenciaTotal: ed.diferenciaTotal,
                baseProducto: productTotals.base,
                ivaProducto: productTotals.iva,
                totalProducto: productTotals.total
            });
            invoiceRow.font = { bold: true };
            invoiceRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C2A36' } };
            invoiceRow.height = 22;
            invoiceRow.eachCell((cell) => {
                cell.font = { ...(cell.font || {}), color: { argb: 'FFF7FBFF' }, bold: true };
                cell.border = {
                    top: { style: 'thin', color: { argb: '33FFD36C' } },
                    bottom: { style: 'thin', color: { argb: '33FFD36C' } }
                };
            });

            if (products.length) {
                for (const product of products) {
                    const cantidad = toNumber(product.cantidad ?? product.qty ?? 0);
                    const unidad = product.unidadMedida || product.unidad || product.um || '';
                    const valorUnitario = toNumber(product.valorUnitario ?? product.precioUnitario ?? product.unitario ?? 0);
                    const base = toNumber(product.baseImpuesto ?? product.base ?? product.subtotalLinea ?? 0);
                    const porcentaje = toNumber(product.porcentajeIVA ?? product.ivaPorcentaje ?? product.tarifaIVA ?? 0);
                    const iva = toNumber(product.ivaValor ?? product.valorIVA ?? product.iva ?? 0);
                    const total = toNumber(product.totalLinea ?? product.total ?? (base + iva));
                    const descripcion = product.descripcion || product.nombre || product.detalle || product.producto || '-';

                    const detailRow = ws.addRow({
                        nivel: 'P',
                        fecha: new Date(row.created_at).toLocaleDateString('es-CO'),
                        origen: sourceLabel(ed.origen),
                        factura: ed.factura,
                        nit: ed.nit,
                        descripcion,
                        cantidad,
                        unidad,
                        valorUnitario,
                        baseProducto: base,
                        porcentajeIvaProducto: porcentaje,
                        ivaProducto: iva,
                        totalProducto: total
                    });
                    detailRow.outlineLevel = 1;
                    detailRow.hidden = true;
                    detailRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FBFE' } };
                    detailRow.eachCell((cell) => {
                        cell.border = {
                            bottom: { style: 'thin', color: { argb: '11000000' } }
                        };
                    });
                }
            } else {
                const emptyRow = ws.addRow({
                    nivel: 'P',
                    fecha: new Date(row.created_at).toLocaleDateString('es-CO'),
                    origen: sourceLabel(ed.origen),
                    factura: ed.factura,
                    nit: ed.nit,
                    descripcion: 'Sin detalle de articulos extraido'
                });
                emptyRow.outlineLevel = 1;
                emptyRow.hidden = true;
            }

            const invoiceTotalRow = ws.addRow({
                nivel: 'T',
                fecha: new Date(row.created_at).toLocaleDateString('es-CO'),
                origen: sourceLabel(ed.origen),
                factura: ed.factura,
                nit: ed.nit,
                descripcion: 'Totales factura',
                totalFactura: ed.totalFactura,
                baseExento: ed.baseExento,
                base5: ed.base5,
                iva5: ed.iva5,
                base8: ed.base8,
                iva8: ed.iva8,
                base19: ed.base19,
                iva19: ed.iva19,
                reteFuente: ed.reteFuente,
                reteIva: ed.reteIva,
                reteIca: ed.reteIca,
                impuestoConsumo: ed.impuestoConsumo,
                diferenciaTotal: ed.diferenciaTotal
            });
            invoiceTotalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF5F1' } };
            invoiceTotalRow.font = { bold: true };
        }

        const totalRow = ws.addRow({
            nivel: 'T',
            descripcion: 'Totales generales',
            totalFactura: totals.totalFactura,
            baseExento: totals.baseExento,
            base5: totals.base5,
            iva5: totals.iva5,
            base8: totals.base8,
            iva8: totals.iva8,
            base19: totals.base19,
            iva19: totals.iva19,
            reteFuente: totals.reteFuente,
            reteIva: totals.reteIva,
            reteIca: totals.reteIca,
            impuestoConsumo: totals.impuestoConsumo,
            diferenciaTotal: totals.diferenciaTotal,
            baseProducto: totals.baseProducto,
            ivaProducto: totals.ivaProducto,
            totalProducto: totals.totalProducto
        });
        totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16212B' } };
        totalRow.font = { bold: true, color: { argb: 'FFFFD36C' } };

        ['I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','Y','Z'].forEach((col) => {
            ws.getColumn(col).numFmt = '"$"#,##0.00;-"$"#,##0.00';
        });
        ws.getColumn('X').numFmt = '0.00';

        const fileName = `Reporte_Detallado_${new Date().toISOString().slice(0, 10)}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('[EXPORT EXCEL ERROR]:', err.message);
        res.status(500).json({ error: 'No se pudo generar el Excel.' });
    }
});

const upload = multer({
    dest: INPUT_DIR,
    limits: { fileSize: 20 * 1024 * 1024, files: 1000 },
    fileFilter: (req, file, cb) => {
        const isPdf = file.mimetype === 'application/pdf' || path.extname(file.originalname).toLowerCase() === '.pdf';
        if (!isPdf) return cb(new Error('Solo se permiten archivos PDF.'));
        cb(null, true);
    }
    });

app.get('/api/sync/paths', authenticateToken, async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM local_sync_paths WHERE company_id = $1 ORDER BY created_at ASC', [req.user.company_id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Fallo al cargar rutas.' }); }
});

app.post('/api/sync/paths', authenticateToken, async (req, res) => {
    const { path: p, name } = req.body;
    if (!p) return res.status(400).json({ error: 'Ruta obligatoria.' });
    try {
        await query('INSERT INTO local_sync_paths (company_id, path, name) VALUES ($1,$2,$3)', [req.user.company_id, p, name || 'Carpeta Local']);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Fallo al guardar ruta.' }); }
});

app.delete('/api/sync/paths/:id', authenticateToken, async (req, res) => {
    try {
        await query('DELETE FROM local_sync_paths WHERE company_id = $1 AND id = $2', [req.user.company_id, req.params.id]);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Fallo al eliminar ruta.' }); }
});

app.post('/api/sync/folder', authenticateToken, async (req, res) => {
    let targetPath = req.body.path;
    const pathId = req.body.id;

    if (pathId) {
        const { rows } = await query('SELECT path FROM local_sync_paths WHERE id = $1 AND company_id = $2', [pathId, req.user.company_id]);
        if (rows.length > 0) targetPath = rows[0].path;
    }
    
    if (!targetPath) return res.status(400).json({ error: 'Debes proporcionar una ruta o un ID.' });

    try {
        if (!await fs.pathExists(targetPath)) return res.status(400).json({ error: 'La ruta no existe o es inaccesible.' });

        const stats = await fs.stat(targetPath);
        if (!stats.isDirectory()) return res.status(400).json({ error: 'No es una carpeta.' });

        const files = await fs.readdir(targetPath);
        const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf'));
        if (pdfFiles.length === 0) return res.json({ ok: true, message: 'No hay PDFs.' });

        let imported = 0;
        for (const filename of pdfFiles) {
            const src = path.join(targetPath, filename);
            const uuidPrefix = crypto.randomUUID().slice(0, 8);
            const internalName = `${Date.now()}_${uuidPrefix}_${filename}`;
            const dest = path.join(INPUT_DIR, internalName);
            await fs.copy(src, dest);
            await query(`INSERT INTO documents (company_id, uploaded_by, filename, original_filename, status, source_path) VALUES ($1,$2,$3,$4,'pending',$5)`, [req.user.company_id, req.user.id, internalName, filename, src]);
            imported++;
        }
        if (pathId) await query('UPDATE local_sync_paths SET last_sync = NOW() WHERE id = $1', [pathId]);

        triggerQueueProcessing();
        res.json({ ok: true, message: `Sincronizados ${imported} archivos.` });
    } catch (err) { res.status(500).json({ error: 'Error en sincronización.' }); }
});

app.post('/api/upload', authenticateToken, uploadRateLimiter, (req, res, next) => {
    upload.array('pdfs')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message || 'No se pudo cargar el archivo.' });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No se recibieron archivos.' });
        }

        let relativePaths = [];
        try {
            relativePaths = JSON.parse(req.body.relative_paths || '[]');
        } catch (err) {
            relativePaths = [];
        }

        const requestedMaxRetries = Number(req.body.max_retries || 3);
        const maxRetries = Number.isFinite(requestedMaxRetries) ? Math.min(Math.max(requestedMaxRetries, 1), 10) : 3;

        const monthlyUsage = await query(`
            SELECT COUNT(*)::int AS total
            FROM documents
            WHERE company_id = $1
              AND created_at >= date_trunc('month', CURRENT_TIMESTAMP)
        `, [req.user.company_id]);
        const currentMonthCount = monthlyUsage.rows[0]?.total || 0;
        const quota = Number(req.company?.max_docs_month || 10);

        if (currentMonthCount + req.files.length > quota) {
            await Promise.all(req.files.map((file) => fs.remove(file.path)));
            return res.status(403).json({ error: `Limite mensual del plan alcanzado (${quota} docs).` });
        }

        for (const [index, file] of req.files.entries()) {
            const originalFilename = normalizeText(file.originalname || file.filename, 255);
            const sourcePath = normalizeRelativePath(relativePaths[index] || originalFilename);
            await query(
                `INSERT INTO documents (
                    company_id, uploaded_by, assigned_to, filename, original_filename, source_path, status, retry_count, max_retries
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [req.user.company_id, req.user.id, req.user.id, file.filename, originalFilename, sourcePath, 'pending', 0, maxRetries]
            );
            await logUsage(req.user.company_id, req.user.id, 'upload_request');
            await writeAudit(req.user.company_id, req.user.id, 'upload_document', 'document', null, { originalFilename, sourcePath });
        }

        triggerQueueProcessing();
        res.json({ ok: true });
    } catch (err) {
        console.error('[UPLOAD ERROR]:', err.message);
        res.status(500).json({ error: 'Error al cargar archivos.' });
    }
});

app.patch('/api/documents/:id/assign', authenticateToken, isCompanyAdmin, async (req, res) => {
    const documentId = Number(req.params.id);
    const assignedTo = req.body.assigned_to === null ? null : Number(req.body.assigned_to);
    try {
        if (assignedTo !== null) {
            const userCheck = await query(`
                SELECT id FROM users WHERE id = $1 AND company_id = $2 AND active = TRUE
            `, [assignedTo, req.user.company_id]);
            if (userCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Usuario destino no encontrado.' });
            }
        }
        const result = await query(`
            UPDATE documents
            SET assigned_to = $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND company_id = $3
        `, [assignedTo, documentId, req.user.company_id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Documento no encontrado.' });
        await writeAudit(req.user.company_id, req.user.id, 'assign_document', 'document', documentId, { assigned_to: assignedTo });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo asignar el documento.' });
    }
});

app.post('/api/documents/:id/retry', authenticateToken, retryRateLimiter, async (req, res) => {
    const documentId = Number(req.params.id);
    try {
        const { rows } = await query(`
            SELECT id, company_id, filename, status, retry_count, max_retries, assigned_to, uploaded_by
            FROM documents
            WHERE id = $1 AND company_id = $2
        `, [documentId, req.user.company_id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Documento no encontrado.' });
        }

        const doc = rows[0];
        if (!canManageCompany(req) && Number(doc.assigned_to || doc.uploaded_by) !== Number(req.user.id)) {
            return res.status(403).json({ error: 'No puedes reenviar un documento asignado a otro usuario.' });
        }
        const inputPath = path.join(INPUT_DIR, doc.filename);
        const processedPath = path.join(PROCESSED_DIR, doc.filename);
        if (!await fs.pathExists(inputPath) && await fs.pathExists(processedPath)) {
            await fs.move(processedPath, inputPath, { overwrite: true });
        }

        await query(`
            UPDATE documents
            SET status = 'pending',
                error_message = NULL,
                retry_count = 0,
                max_retries = COALESCE($1, max_retries, 3),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
        `, [doc.max_retries || 3, documentId]);
        await logUsage(req.user.company_id, req.user.id, 'retry_document');
        await writeAudit(req.user.company_id, req.user.id, 'retry_document', 'document', documentId, {});
        triggerQueueProcessing();
        res.json({ ok: true, message: 'Documento reenviado a la cola.' });
    } catch (err) {
        console.error('[RETRY DOCUMENT ERROR]:', err.message);
        res.status(500).json({ error: 'No se pudo reenviar el documento.' });
    }
});

app.post('/api/documents/retry-failed', authenticateToken, retryRateLimiter, async (req, res) => {
    try {
        const params = [req.user.company_id];
        let scopeWhere = 'company_id = $1 AND status = \'error\'';
        if (!canManageCompany(req) && !req.user.is_superadmin) {
            params.push(req.user.id);
            scopeWhere += ' AND COALESCE(assigned_to, uploaded_by) = $2';
        }
        const { rows } = await query(`
            SELECT id, filename
            FROM documents
            WHERE ${scopeWhere}
            ORDER BY created_at ASC
        `, params);

        for (const doc of rows) {
            const inputPath = path.join(INPUT_DIR, doc.filename);
            const processedPath = path.join(PROCESSED_DIR, doc.filename);
            if (!await fs.pathExists(inputPath) && await fs.pathExists(processedPath)) {
                await fs.move(processedPath, inputPath, { overwrite: true });
            }
        }

        const result = await query(`
            UPDATE documents
            SET status = 'pending',
                error_message = NULL,
                retry_count = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE ${scopeWhere}
        `, params);

        await logUsage(req.user.company_id, req.user.id, 'retry_failed_documents');
        await writeAudit(req.user.company_id, req.user.id, 'retry_failed_documents', 'document', null, { count: result.rowCount });
        triggerQueueProcessing();
        res.json({ ok: true, message: `${result.rowCount} documentos reenviados a la cola.` });
    } catch (err) {
        console.error('[RETRY FAILED ERROR]:', err.message);
        res.status(500).json({ error: 'No se pudieron reenviar los documentos fallidos.' });
    }
});

app.post('/api/documents/reprocess-completed', authenticateToken, retryRateLimiter, async (req, res) => {
    try {
        const params = [req.user.company_id];
        let scopeWhere = 'company_id = $1 AND status = \'completed\'';
        if (!canManageCompany(req) && !req.user.is_superadmin) {
            params.push(req.user.id);
            scopeWhere += ' AND COALESCE(assigned_to, uploaded_by) = $2';
        }

        const { rows } = await query(`
            SELECT id, filename
            FROM documents
            WHERE ${scopeWhere}
            ORDER BY created_at ASC
        `, params);

        for (const doc of rows) {
            const inputPath = path.join(INPUT_DIR, doc.filename);
            const processedPath = path.join(PROCESSED_DIR, doc.filename);
            if (!await fs.pathExists(inputPath) && await fs.pathExists(processedPath)) {
                await fs.move(processedPath, inputPath, { overwrite: true });
            }
        }

        const result = await query(`
            UPDATE documents
            SET status = 'pending',
                error_message = NULL,
                retry_count = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE ${scopeWhere}
        `, params);

        await logUsage(req.user.company_id, req.user.id, 'reprocess_completed_documents');
        await writeAudit(req.user.company_id, req.user.id, 'reprocess_completed_documents', 'document', null, { count: result.rowCount });
        triggerQueueProcessing();
        res.json({ ok: true, message: `${result.rowCount} documentos completados enviados a reproceso.` });
    } catch (err) {
        console.error('[REPROCESS COMPLETED ERROR]:', err.message);
        res.status(500).json({ error: 'No se pudieron reprocesar los documentos completados.' });
    }
});

app.get('/api/queue/status', authenticateToken, async (req, res) => {
    try {
        const counts = await query(`
            SELECT status, COUNT(*)::int AS total
            FROM documents
            WHERE company_id = $1
            GROUP BY status
        `, [req.user.company_id]);
        const recent = await query(`
            SELECT id, original_filename, status, created_at, updated_at
            FROM documents
            WHERE company_id = $1
            ORDER BY id DESC
            LIMIT 10
        `, [req.user.company_id]);
        const timing = await query(`
            SELECT
                ROUND(COALESCE(AVG(duration_ms) FILTER (
                    WHERE action = 'document_processed'
                      AND status = 'completed'
                      AND duration_ms IS NOT NULL
                      AND created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
                ), 0)::numeric, 0) AS avg_processing_ms,
                ROUND(COALESCE(AVG(duration_ms) FILTER (
                    WHERE action = 'document_processed'
                      AND status = 'completed'
                      AND provider IN ('gemini', 'groq')
                      AND duration_ms IS NOT NULL
                      AND created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
                ), 0)::numeric, 0) AS avg_ai_processing_ms,
                COUNT(*) FILTER (
                    WHERE action = 'document_processed'
                      AND status = 'completed'
                      AND duration_ms IS NOT NULL
                      AND created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
                )::int AS sample_size
            FROM usage_logs
            WHERE company_id = $1
        `, [req.user.company_id]);
        res.json({
            counts: counts.rows,
            recent: recent.rows,
            runtime: getQueueRuntimeState(),
            timing: timing.rows[0] || null
        });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo consultar la cola.' });
    }
});

app.delete('/api/queue', authenticateToken, async (req, res) => {
    try {
        const queuedDocs = await query(`
            SELECT id, filename, status
            FROM documents
            WHERE company_id = $1
              AND status IN ('pending', 'processing', 'error')
        `, [req.user.company_id]);

        for (const doc of queuedDocs.rows) {
            if (!doc.filename) continue;
            await fs.remove(path.join(INPUT_DIR, doc.filename));
            await fs.remove(path.join(PROCESSED_DIR, doc.filename));
        }

        const deleted = await query(`
            DELETE FROM documents
            WHERE company_id = $1
              AND status IN ('pending', 'processing', 'error')
        `, [req.user.company_id]);

        await writeAudit(req.user.company_id, req.user.id, 'clear_queue', 'document', null, { count: deleted.rowCount });
        res.json({ ok: true, message: `Se eliminaron ${deleted.rowCount} documentos de la cola.` });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo vaciar la cola.' });
    }
});

app.delete('/api/cleanup', authenticateToken, async (req, res) => {
    try {
        const docs = await query('SELECT filename FROM documents WHERE company_id = $1', [req.user.company_id]);
        for (const doc of docs.rows) {
            if (!doc.filename) continue;
            await fs.remove(path.join(INPUT_DIR, doc.filename));
            await fs.remove(path.join(PROCESSED_DIR, doc.filename));
        }

        await query('DELETE FROM documents WHERE company_id = $1', [req.user.company_id]);
        await logUsage(req.user.company_id, req.user.id, 'cleanup_history');
        await writeAudit(req.user.company_id, req.user.id, 'cleanup_history', 'document', null, { count: docs.rows.length });
        res.json({ ok: true, message: 'Historial y archivos asociados eliminados.' });
    } catch (err) {
        res.status(500).json({ error: 'Error al limpiar datos.' });
    }
});

(async () => {
    try {
        await ensureRuntimeSchema();
        const resetResult = await query("UPDATE documents SET status = 'pending' WHERE status = 'processing'");
        console.log(`[INIT] ${resetResult.rowCount} documentos reseteados para reintento.`);
    } catch (e) {
        console.error('Error en inicializacion:', e);
    }

    startWatcher();
    app.listen(PORT, () => console.log(`SaaS master engine active on port ${PORT}`));
})();
