const path = require('path');
const fs = require('fs-extra');
const { extractDataFromPDF } = require('./extractor');
const { query } = require('./db');
const pdf = require('pdf-parse');

const inputDir = path.join(__dirname, '../input');
const processedDir = path.join(__dirname, '../processed');
const DEFAULT_MAX_RETRIES = 3;
const MAX_CONCURRENT = Math.max(1, Number(process.env.QUEUE_CONCURRENCY || 1));
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.QUEUE_POLL_MS || 2000));
const RATE_LIMIT_PAUSE_MS = Math.max(5000, Number(process.env.QUEUE_RATE_LIMIT_PAUSE_MS || 20000));
const INTER_DOCUMENT_DELAY_MS = Math.max(0, Number(process.env.QUEUE_INTER_DOCUMENT_DELAY_MS || 3000));

fs.ensureDirSync(inputDir);
fs.ensureDirSync(processedDir);

let isRunning = false;
let pauseUntil = 0;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordProcessingUsage(doc, { status, provider, durationMs = null, costEst = null }) {
    const userId = Number(doc.assigned_to || doc.uploaded_by || 0) || null;
    await query(`
        INSERT INTO usage_logs (company_id, user_id, action, status, provider, document_id, duration_ms, cost_est)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
        doc.company_id,
        userId,
        'document_processed',
        String(status || '').slice(0, 30),
        String(provider || '').slice(0, 50),
        doc.id,
        Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
        Number.isFinite(costEst) ? costEst : null
    ]);
}

async function processOneDocument(doc) {
    console.log('\n---------------------------------------------------------');
    console.log(`[Queue] PROCESANDO ID ${doc.id}: ${doc.filename}`);
    let durationMs = null;
    let providerForMetrics = 'gemini';

    try {
        await query(`
            UPDATE documents
            SET status = 'processing',
                updated_at = CURRENT_TIMESTAMP,
                last_attempt_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [doc.id]);

        const filePath = path.join(inputDir, doc.filename);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Archivo no encontrado fisicamente en: ${filePath}`);
        }

        console.log(`[Queue] Consultando configuracion de Empresa ID ${doc.company_id}...`);
        const configRes = await query('SELECT * FROM configs WHERE company_id = $1', [doc.company_id]);

        let config = { provider: 'gemini' };
        if (configRes?.rows?.length > 0) {
            config = configRes.rows[0];
        }

        const rawProvider = config.provider || config.active_provider || 'gemini';
        const provName = String(rawProvider).toUpperCase();
        providerForMetrics = String(rawProvider).toLowerCase();

        console.log('[Queue] Extrayendo texto del PDF...');
        const dataBuffer = fs.readFileSync(filePath);
        const pdfData = await pdf(dataBuffer);
        const invoiceText = pdfData.text;

        if (!invoiceText || invoiceText.trim().length < 5) {
            throw new Error('El PDF no tiene texto legible (podria ser una imagen o estar vacio).');
        }
        console.log(`[Queue] Texto extraido (${invoiceText.length} caracteres).`);

        console.log(`[Queue] ENVIANDO A IA (${provName})...`);
        const startTime = Date.now();
        const extractedData = await extractDataFromPDF(invoiceText, config);
        durationMs = Date.now() - startTime;
        const duration = (durationMs / 1000).toFixed(1);

        if (!extractedData) {
            throw new Error(`La IA (${provName}) devolvio una respuesta vacia o invalida.`);
        }
        console.log(`[Queue] RECIBIDO: Datos procesados por IA en ${duration} seg.`);

        await query(`
            UPDATE documents
            SET status = 'completed',
                extracted_data = $1,
                error_message = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
        `, [JSON.stringify(extractedData), doc.id]);

        const destPath = path.join(processedDir, doc.filename);
        await fs.move(filePath, destPath, { overwrite: true });
        await recordProcessingUsage(doc, { status: 'completed', provider: providerForMetrics, durationMs });
        console.log(`[Queue] ID ${doc.id} completado con exito y movido a 'processed'.`);
        return { rateLimited: false };
    } catch (innerErr) {
        console.error(`[Queue] FALLO EN ID ${doc.id}:`, innerErr.message);
        const isRateLimit = String(innerErr.message || '').includes('RATE_LIMIT_GROQ_429');

        if (isRateLimit) {
            pauseUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
            await query(`
                UPDATE documents
                SET status = 'pending',
                    error_message = $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $2
            `, [`Groq rate limit (429). Reintentando en ${Math.round(RATE_LIMIT_PAUSE_MS / 1000)}s.`, doc.id]);
            await recordProcessingUsage(doc, { status: 'rate_limited', provider: providerForMetrics, durationMs });
            console.error(`[Queue] Rate limit detectado. Pausa global de ${Math.round(RATE_LIMIT_PAUSE_MS / 1000)}s.`);
            return { rateLimited: true };
        }

        const nextRetryCount = Number(doc.retry_count || 0) + 1;
        const maxRetries = Number(doc.max_retries || DEFAULT_MAX_RETRIES);
        const nextStatus = nextRetryCount < maxRetries ? 'pending' : 'error';

        await query(`
            UPDATE documents
            SET status = $1,
                error_message = $2,
                retry_count = $3,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $4
        `, [nextStatus, innerErr.message, nextRetryCount, doc.id]);
        await recordProcessingUsage(doc, { status: nextStatus, provider: providerForMetrics, durationMs });

        console.error(`[Queue] Reintento ${nextRetryCount}/${maxRetries} => ${nextStatus}`);
        return { rateLimited: false };
    }
    finally {
        console.log('---------------------------------------------------------\n');
    }
}

async function processPendingFiles() {
    if (isRunning) return;
    if (pauseUntil > Date.now()) return;
    isRunning = true;

    try {
        const { rows } = await query(`
            SELECT *
            FROM documents
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT $1
        `, [MAX_CONCURRENT]);

        if (rows && rows.length > 0) {
            console.log(`[Queue Worker] Lote detectado: ${rows.length} documentos pendientes.`);
        }

        for (const row of rows) {
            const result = await processOneDocument(row);
            if (result?.rateLimited) {
                await sleep(500);
                break;
            }
            if (INTER_DOCUMENT_DELAY_MS > 0) {
                console.log(`[Queue] Esperando ${Math.round(INTER_DOCUMENT_DELAY_MS / 1000)}s antes del siguiente documento.`);
                await sleep(INTER_DOCUMENT_DELAY_MS);
            }
        }
    } catch (criticalErr) {
        console.error('[Queue Critical] Error fatal en ciclo de base de datos:', criticalErr);
    } finally {
        isRunning = false;
    }
}

function startWatcher() {
    console.log('Motor de Inteligencia Artificial iniciado.');
    console.log(`Carpeta input: ${inputDir}`);
    console.log(`Concurrencia de cola: ${MAX_CONCURRENT}`);
    processPendingFiles();
    setInterval(() => {
        processPendingFiles();
    }, POLL_INTERVAL_MS);
}

function getQueueRuntimeState() {
    return {
        isRunning,
        pauseUntil,
        paused: pauseUntil > Date.now(),
        rateLimitPauseMs: RATE_LIMIT_PAUSE_MS,
        maxConcurrent: MAX_CONCURRENT,
        interDocumentDelayMs: INTER_DOCUMENT_DELAY_MS
    };
}

module.exports = { startWatcher, processPendingFiles, getQueueRuntimeState };
