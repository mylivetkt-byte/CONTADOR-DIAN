const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
const { readConfigSecret } = require('./security');

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function round2(value) {
    return Number((toNumber(value)).toFixed(2));
}

function normalizeText(value, max = 300) {
    return String(value || '').trim().slice(0, max);
}

function matchFirst(text, regex, group = 1) {
    const match = String(text || '').match(regex);
    return match ? normalizeText(match[group], 500) : '';
}

function classifyZeroTaxText(value) {
    const upper = String(value || '').toUpperCase();
    if (upper.includes('EXCLUID')) return 'excluida';
    if (upper.includes('NO GRAVAD') || upper.includes('NO CAUSA')) return 'no_gravada';
    if (upper.includes('EXENTO')) return 'exenta';
    if (upper.includes('IVA - NO RESPONSABLE') || upper.includes('NO RESPONSABLE')) return 'no_gravada';
    return 'exenta';
}

function sumZeroTaxBreakdown(breakdown = {}) {
    return round2(
        toNumber(breakdown.exenta) +
        toNumber(breakdown.excluida) +
        toNumber(breakdown.no_gravada)
    );
}

function normalizeInvoiceText(text) {
    return String(text || '')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

function preprocessInvoiceText(text) {
    let src = normalizeInvoiceText(text);
    src = src.replace(/IVA\/IC/g, 'IVA_IC');
    src = src.replace(/([0-9.,]+)E([0-9.,]+)/g, '$1 0% $2');
    src = src.replace(/UNIDAD([0-9.,]+)E([0-9.,]+)/g, 'UNIDAD $1 0% $2');
    src = src.replace(/NO RESPONSABLE DE IVA/gi, 'NO RESPONSABLE DE IVA (0%)');
    return src;
}

function inferCommonIdentifiers(text) {
    const src = normalizeInvoiceText(text);
    const upper = src.toUpperCase();
    const firstChunk = src.slice(0, 1200);
    const topLineCandidate = firstChunk
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /[A-ZÁÉÍÓÚÑ]/i.test(line) && !/^\d+\/\d+$/.test(line) && !/^NIT\b/i.test(line) && line.length > 3) || '';

    const numeroFactura =
        matchFirst(src, /FACTURA(?:\s+ELECTR[ÓO]NICA(?:\s+DE\s+VENTA)?)?\s*(?:NO\.?|NRO\.?|NUMERO|NÚMERO)?\s*[:#]?\s*([A-Z]{1,10}-?\d{1,})/i) ||
        matchFirst(src, /\bNO\.?\s*([A-Z]{1,10}-?\d{1,})/i) ||
        matchFirst(src, /\b(PREFIJO\s*[:\-]?\s*[A-Z]{1,10})[\s\S]{0,30}?(?:NO\.?|NUMERO|NÚMERO)\s*[:\-]?\s*(\d{1,})/i, 2);

    const nitMatches = Array.from(src.matchAll(/\bNIT\b\.?\s*[:#]?\s*([0-9.\-]{6,})/gi)).map((m) => normalizeText(m[1], 80));
    const nitEmisor =
        matchFirst(firstChunk, /\bNIT\b\.?\s*[:#]?\s*([0-9.\-]{6,})/i) ||
        nitMatches[0] ||
        '';
    const nitAdquirente =
        matchFirst(src, /CLIENTE[\s\S]{0,220}?\bNIT\b\.?\s*[:#]?\s*([0-9.\-]{6,})/i) ||
        matchFirst(src, /ADQUIRIENTE[\s\S]{0,220}?\bNIT\b\.?\s*[:#]?\s*([0-9.\-]{6,})/i) ||
        matchFirst(src, /NÚMERO DOCUMENTO\s*[:#]?\s*([0-9.\-]{6,})/i) ||
        matchFirst(src, /NUMERO DOCUMENTO\s*[:#]?\s*([0-9.\-]{6,})/i) ||
        (nitMatches.length > 1 ? nitMatches[1] : '');

    const emisorRaw =
        matchFirst(src, /^([^\n]+)\n\s*NIT\b/mi) ||
        matchFirst(src, /RAZÓN SOCIAL\s*[:#]?\s*([^\n]+)/i) ||
        matchFirst(src, /RAZON SOCIAL\s*[:#]?\s*([^\n]+)/i);
    const emisor = /^\d+\/\d+$/.test(String(emisorRaw || '').trim())
        ? normalizeText(topLineCandidate, 200)
        : (emisorRaw || normalizeText(topLineCandidate, 200));
    const adquirente =
        matchFirst(src, /CLIENTE\s*([^\n]+?)\s*NIT/i) ||
        matchFirst(src, /RAZÓN SOCIAL\s*:\s*([^\n]+)/i) ||
        matchFirst(src, /RAZON SOCIAL\s*:\s*([^\n]+)/i);

    return {
        numeroFactura,
        nitEmisor,
        nitAdquirente,
        emisor,
        adquirente
    };
}

function isLikelyDianStructuredInvoice(text, summary = {}) {
    const upper = normalizeInvoiceText(text).toUpperCase();
    const dianMarkers = [
        'CUFE',
        'CUDE',
        'FACTURA ELECTRONICA DE VENTA',
        'FACTURA ELECTRÓNICA DE VENTA',
        'RESOLUCION DIAN',
        'RESOLUCIÓN DIAN',
        'ADQUIRIENTE',
        'EMISOR'
    ];
    const markerHits = dianMarkers.filter((marker) => upper.includes(marker)).length;
    const hasTotals = toNumber(summary.subtotal) > 0 && toNumber(summary.total) > 0;
    return markerHits >= 2 && hasTotals;
}

function isLikelyOfficialDianStructuredInvoice(text, summary = {}) {
    const upper = normalizeInvoiceText(text).toUpperCase();
    const structuralMarkers = [
        'DATOS DEL DOCUMENTO',
        'DATOS DEL EMISOR / VENDEDOR',
        'DATOS DEL ADQUIRIENTE / COMPRADOR',
        'DETALLES DE PRODUCTOS',
        'DATOS TOTALES'
    ];
    const validationMarkers = [
        'DOCUMENTO VALIDADO POR LA DIAN',
        'SOLUCION GRATUITA DIAN',
        'SOLUCIÃ“N GRATUITA DIAN',
        'PDF GENERADO POR:',
        'XML GENERADO POR: PROVEEDOR TECNOLOGICO',
        'XML GENERADO POR: PROVEEDOR TECNOLÃ“GICO'
    ];
    const structureHits = structuralMarkers.filter((marker) => upper.includes(marker)).length;
    const validationHits = validationMarkers.filter((marker) => upper.includes(marker)).length;
    const hasTotals = toNumber(summary.subtotal) > 0 && toNumber(summary.total) > 0;
    return structureHits >= 3 && validationHits >= 1 && hasTotals;
}

function buildEmptyIvas() {
    return [19, 8, 5, 0].map((porcentaje) => ({ porcentaje, base: 0, valor: 0 }));
}

function parseLocaleNumber(value) {
    const src = String(value || '').trim();
    if (!src) return 0;
    const cleaned = src.replace(/[^\d,.-]/g, '');
    if (!cleaned) return 0;

    if (cleaned.includes(',') && cleaned.includes('.')) {
        return toNumber(cleaned.replace(/\./g, '').replace(',', '.'));
    }

    if (cleaned.includes(',')) {
        const parts = cleaned.split(',');
        if (parts.length === 2 && parts[1].length <= 2) {
            return toNumber(parts[0].replace(/\./g, '') + '.' + parts[1]);
        }
        return toNumber(cleaned.replace(/,/g, ''));
    }

    return toNumber(cleaned.replace(/\./g, ''));
}

function findMoneyCandidates(chunk) {
    const matches = String(chunk || '').match(/\d[\d.,]{0,20}/g) || [];
    return matches
        .map(parseLocaleNumber)
        .filter((n) => Number.isFinite(n) && n > 0);
}

function findAmountCandidates(chunk, allowZero = false) {
    const matches = String(chunk || '').match(/\d[\d.,]{0,20}/g) || [];
    return matches
        .map(parseLocaleNumber)
        .filter((n) => Number.isFinite(n) && (allowZero ? n >= 0 : n > 0));
}

function findFormattedAmounts(chunk, allowZero = false) {
    const matches = String(chunk || '').match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || [];
    return matches
        .map(parseLocaleNumber)
        .filter((n) => Number.isFinite(n) && (allowZero ? n >= 0 : n > 0));
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineHasLabel(upperLine, label) {
    const escaped = escapeRegExp(label);
    return new RegExp(`^\\s*${escaped}(?:\\b|\\s|:|\\$|$)`).test(upperLine);
}

function extractLineAmount(text, labels, options = {}) {
    const lines = normalizeInvoiceText(text)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const allowZero = !!options.allowZero;

    for (let i = 0; i < lines.length; i++) {
        const upper = lines[i].toUpperCase();
        if (!labels.some((label) => lineHasLabel(upper, label))) continue;

        const sameLine = findAmountCandidates(lines[i], allowZero);
        let nextBest = null;

        for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++) {
            const nextNums = findAmountCandidates(lines[j], allowZero);
            if (nextNums.length) {
                nextBest = nextNums[nextNums.length - 1];
                break;
            }
        }

        if (sameLine.length) {
            const sameBest = sameLine[sameLine.length - 1];
            if (nextBest !== null && sameBest > 0 && nextBest > sameBest * 100) {
                return nextBest;
            }
            return sameBest;
        }

        if (nextBest !== null) return nextBest;
    }

    return null;
}

function extractAmountNearLabel(text, labels, options = {}) {
    const direct = extractLineAmount(text, labels, options);
    if (direct !== null) return direct;

    const src = normalizeInvoiceText(text).toUpperCase();
    const windowSize = options.windowSize || 140;
    for (const label of labels) {
        const idx = src.indexOf(label);
        if (idx === -1) continue;
        const chunk = src.slice(idx, idx + windowSize);
        const nums = findAmountCandidates(chunk, !!options.allowZero);
        if (nums.length) {
            return nums[0];
        }
    }
    return 0;
}

function extractStrictAmount(text, labels, options = {}) {
    const src = normalizeInvoiceText(text);
    const direct = extractLineAmount(src, labels.map((label) => label.toUpperCase()), options);
    if (direct !== null) return direct;

    const allowZero = !!options.allowZero;
    const pick = (arr) => {
        if (!arr.length) return null;
        return options.preferLast ? arr[arr.length - 1] : arr[0];
    };

    for (const label of labels) {
        const escaped = escapeRegExp(label);
        const sameLine = new RegExp(`^\\s*${escaped}[^\\d\\n]{0,24}(?:COP\\s*|\\$\\s*)?([\\d.,]+)`, 'gim');
        const nextLine = new RegExp(`^\\s*${escaped}\\s*(?:\\r?\\n)\\s*(?:COP\\s*|\\$\\s*)?([\\d.,]+)`, 'gim');

        const sameMatches = Array.from(src.matchAll(sameLine)).map((m) => parseLocaleNumber(m[1])).filter((n) => Number.isFinite(n) && (allowZero ? n >= 0 : n > 0));
        const nextMatches = Array.from(src.matchAll(nextLine)).map((m) => parseLocaleNumber(m[1])).filter((n) => Number.isFinite(n) && (allowZero ? n >= 0 : n > 0));
        const found = pick(sameMatches) ?? pick(nextMatches);
        if (found !== null) return found;
    }

    return extractAmountNearLabel(src, labels.map((label) => label.toUpperCase()), options);
}

function hasAny(upper, patterns) {
    return patterns.some((pattern) => upper.includes(pattern));
}

function detectRateFromLine(upper) {
    if (upper.includes('EXENTO')) return 0;
    const tailRate = upper.match(/(19|08|8|05|5|00|0)[.,]00\s+[\d.,]+\s*$/);
    if (tailRate) {
        const raw = tailRate[1];
        if (raw === '05') return 5;
        if (raw === '08') return 8;
        if (raw === '00') return 0;
        return Number(raw);
    }
    if (/(?:^|[^0-9])19(?:[.,]00)?(?:\s*%|\s{2,}|$)/.test(upper)) return 19;
    if (/(?:^|[^0-9])8(?:[.,]00)?(?:\s*%|\s{2,}|$)/.test(upper)) return 8;
    if (/(?:^|[^0-9])5(?:[.,]00)?(?:\s*%|\s{2,}|$)/.test(upper)) return 5;
    if (/(?:^|[^0-9])0(?:[.,]00)?(?:\s*%|\s{2,}|$)/.test(upper)) return 0;
    return null;
}

function buildTotalsBlock(text) {
    const src = normalizeInvoiceText(text);
    const upper = src.toUpperCase();
    const primaryAnchors = ['DATOS TOTALES', 'NOTASTOTALES', 'SUBTOTAL BRUTO', 'SUBTOTAL'];
    let start = -1;
    for (const anchor of primaryAnchors) {
        const idx = upper.lastIndexOf(anchor);
        if (idx > start) start = idx;
    }
    if (start < 0) {
        for (const anchor of ['TOTAL A PAGAR', 'TOTAL CON IVA', 'TOTAL FACTURA']) {
            const idx = upper.lastIndexOf(anchor);
            if (idx > start) start = idx;
        }
    }

    if (start < 0) return src;

    let end = src.length;
    for (const anchor of ['VALOR EN LETRAS', 'OBSERVACIONES', 'NOTAS FINALES', 'CUFE :', 'CUFE:', 'CUDE:', 'NUMERO DE AUTORIZACIÓN']) {
        const idx = upper.indexOf(anchor, start + 1);
        if (idx >= 0 && idx < end) end = idx;
    }

    return src.slice(start, end);
}

function sliceSection(text, startLabel, endLabels = []) {
    const src = normalizeInvoiceText(text);
    const upper = src.toUpperCase();
    const start = upper.indexOf(String(startLabel || '').toUpperCase());
    if (start < 0) return '';
    let end = src.length;
    for (const label of endLabels) {
        const idx = upper.indexOf(String(label || '').toUpperCase(), start + String(startLabel || '').length);
        if (idx >= 0 && idx < end) end = idx;
    }
    return src.slice(start, end).trim();
}

function extractSectionValue(section, label, stopLabels = []) {
    const escapedLabel = escapeRegExp(label);
    const stopPattern = stopLabels.length
        ? stopLabels.map((x) => escapeRegExp(x)).join('|')
        : '\\n|$';
    const regex = new RegExp(`${escapedLabel}\\s*[:\\-]?\\s*(.+?)(?=\\s*(?:${stopPattern}))`, 'is');
    const match = String(section || '').match(regex);
    return match ? normalizeText(match[1], 500) : '';
}

function hydrateIvaRows(rows, summary) {
    const out = normalizeIvas(rows);
    const activeTaxRows = out.filter((row) => row.porcentaje !== 0 && row.base > 0);
    const summaryIva = toNumber(summary.genericIva);

    if (summaryIva > 0 && activeTaxRows.length === 1) {
        activeTaxRows[0].valor = summaryIva;
        return out;
    }

    for (const row of activeTaxRows) {
        if (toNumber(row.valor) <= 0) {
            row.valor = round2(toNumber(row.base) * (row.porcentaje / 100));
        }
    }

    return out;
}

function scoreIvaRows(rows, totals) {
    const sum = sumIvaComponents(rows);
    const expected = round2(sum.base + sum.iva + toNumber(totals.impuestoConsumo) - (
        toNumber(totals.reteFuente) + toNumber(totals.reteIca) + toNumber(totals.reteIva)
    ));
    const subtotalDiff = totals.subtotal > 0 ? Math.abs(round2(sum.base - totals.subtotal)) : 0;
    const totalDiff = totals.total > 0 ? Math.abs(round2(expected - totals.total)) : 0;
    const ivaDiff = totals.genericIva > 0 ? Math.abs(round2(sum.iva - totals.genericIva)) : 0;
    return subtotalDiff + totalDiff + ivaDiff;
}

function inferIvasFromText(text, summary) {
    const src = normalizeInvoiceText(text);
    const upperLines = src.split('\n').map((line) => line.trim()).filter(Boolean);
    const rows = buildEmptyIvas();
    const acc = { 19: 0, 8: 0, 5: 0, 0: 0 };

    if (/AIU/i.test(src) && toNumber(summary.subtotal) > 0 && toNumber(summary.genericIva) > 0) {
        let base19 = round2(toNumber(summary.genericIva) / 0.19);
        let base0 = 0;
        for (const line of upperLines) {
            const upper = line.toUpperCase();
            const amounts = findFormattedAmounts(line, true);
            if (upper.includes('AIU') && amounts.length >= 4) {
                base19 = Math.max(base19, amounts[3]);
            }
            if (!upper.includes('AIU') && amounts.filter((n) => n === 0).length >= 2 && amounts.some((n) => n > 1000)) {
                base0 = Math.max(base0, amounts[amounts.length - 1]);
            }
        }
        if (base0 <= 0) {
            base0 = round2(Math.max(0, toNumber(summary.subtotal) - base19));
        }
        return [
            { porcentaje: 19, base: base19, valor: toNumber(summary.genericIva) },
            { porcentaje: 8, base: 0, valor: 0 },
            { porcentaje: 5, base: 0, valor: 0 },
            { porcentaje: 0, base: base0, valor: 0 }
        ];
    }

    if (/DOCUMENTO EQUIVALENTE POS/i.test(src) && /IVA\s*-\s*NO RESPONSABLE/i.test(src)) {
        const base = Math.max(toNumber(summary.subtotal), toNumber(summary.total));
        if (base > 0) {
            return [{ porcentaje: 19, base: 0, valor: 0 }, { porcentaje: 8, base: 0, valor: 0 }, { porcentaje: 5, base: 0, valor: 0 }, { porcentaje: 0, base, valor: 0 }];
        }
    }

    let inDetail = false;
    let detailHits = 0;

    for (const line of upperLines) {
        const upper = line.toUpperCase();
        const formattedAmounts = findFormattedAmounts(line, true);

        if (!inDetail && hasAny(upper, [
            'CODDESCRIP', 'ITEMCODIGO', 'ITEMCÓDIGO', 'CODIGONOMBRE', 'CÓDIGONOMBRE',
            'DETALLES DE PRODUCTOS', 'CODIGO DESCRIPCION', 'CÓDIGO DESCRIPCIÓN', 'CODDESCRIPCI'
        ])) {
            inDetail = true;
            continue;
        }

        if (inDetail && hasAny(upper, [
            'SUBTOTAL', 'DATOS TOTALES', 'TOTAL A PAGAR', 'TOTAL CON IVA', 'TOTAL FACTURA',
            'VALOR EN LETRAS', 'NOTAS FINALES', 'RETENCIONES', 'IMPUESTOS TIPOBASE', 'PAG.', 'HOJA '
        ])) {
            inDetail = false;
        }

        if (inDetail && detailHits > 0 && upper === 'IMPUESTOS') {
            inDetail = false;
        }

        if (inDetail) {
            if (hasAny(upper, ['IVA%', 'INC%', 'VR. UNITARIO', 'PRECIO UNITARIO', 'DESCUENTO', 'RECARGO'])) continue;
            let pct = detectRateFromLine(upper);
            if (pct === null && formattedAmounts.filter((n) => n === 0).length >= 2 && formattedAmounts.some((n) => n > 0)) {
                pct = 0;
            }
            if (pct === null) continue;
            const amounts = formattedAmounts.filter((n) => n > 0);
            if (!amounts.length) continue;
            const baseCandidate = amounts[amounts.length - 1];
            if (baseCandidate <= 0) continue;
            if (summary.subtotal > 0 && baseCandidate > summary.subtotal * 1.1) continue;
            acc[pct] += baseCandidate;
            detailHits += 1;
        }

        if (upper.includes('EXENTO')) {
            const amounts = formattedAmounts.filter((n) => n > 0);
            if (amounts.length) acc[0] = Math.max(acc[0], amounts[0]);
        }
    }

    if (detailHits === 0 && acc[0] <= 0) {
        return buildEmptyIvas();
    }

    for (const row of rows) {
        row.base = round2(acc[row.porcentaje]);
    }

    return hydrateIvaRows(rows, summary);
}

function inferSummaryFromText(text) {
    const src = normalizeInvoiceText(text);
    const totalsBlock = buildTotalsBlock(src);
    const subtotal = extractStrictAmount(totalsBlock, ['SUBTOTAL BRUTO', 'SUBTOTAL'], { allowZero: true, preferLast: true });
    const total = extractStrictAmount(totalsBlock, ['TOTAL A PAGAR', 'TOTAL CON IVA', 'TOTAL FACTURA', 'VALOR TOTAL', 'TOTAL:', 'TOTAL$'], { allowZero: true, preferLast: true });
    const descuentoTotal = extractStrictAmount(totalsBlock, ['DESCUENTO DETALLE', 'DESCUENTO GLOBAL', 'DESCUENTO'], { allowZero: true, preferLast: true });
    const reteFuente = extractStrictAmount(totalsBlock, ['RETEFUENTE', 'RETENCION EN LA FUENTE', 'RETE FUENTE'], { allowZero: true, preferLast: true });
    const reteIva = extractStrictAmount(totalsBlock, ['RETEIVA', 'RETE IVA'], { allowZero: true, preferLast: true });
    const reteIca = extractStrictAmount(totalsBlock, ['RETEICA', 'RETE ICA'], { allowZero: true, preferLast: true });
    const impuestoConsumo = extractStrictAmount(totalsBlock, ['IMPUESTO AL CONSUMO', 'IMPOCONSUMO', 'I.A.C'], { allowZero: true, preferLast: true });
    const genericIva = extractStrictAmount(totalsBlock, ['IVA 19 %', 'IVA 19%', 'VALOR IVA', 'IVA'], { allowZero: true, preferLast: true });

    return {
        subtotal,
        total,
        descuentoTotal,
        reteFuente,
        reteIva,
        reteIca,
        impuestoConsumo,
        genericIva,
        ivaRows: inferIvasFromText(src, { subtotal, total, reteFuente, reteIva, reteIca, impuestoConsumo, genericIva })
    };
}

function mergeSummaryFallback(raw = {}, summary = {}) {
    const merged = { ...raw };
    for (const key of ['subtotal', 'total', 'descuentoTotal', 'reteFuente', 'reteIca', 'reteIva', 'impuestoConsumo']) {
        const rawValue = toNumber(merged[key]);
        const summaryValue = toNumber(summary[key]);
        const totalRef = Math.max(toNumber(merged.total), summary.total);
        const looksBrokenRetention = ['reteFuente', 'reteIca', 'reteIva'].includes(key) && totalRef > 0 && rawValue >= totalRef * 0.9 && summaryValue <= totalRef * 0.1;
        if ((rawValue <= 0 && summaryValue > 0) || looksBrokenRetention) {
            merged[key] = summary[key];
        }
    }

    if ((!Array.isArray(merged.ivasDiscriminados) || merged.ivasDiscriminados.length === 0) && summary.genericIva > 0) {
        const base = Math.max(0, round2(toNumber(merged.subtotal)));
        let porcentaje = 19;
        if (base > 0) {
            const pct = Math.round((summary.genericIva / base) * 100);
            porcentaje = normalizePct(pct);
        }
        merged.ivasDiscriminados = [
            { porcentaje: 19, base: porcentaje === 19 ? base : 0, valor: porcentaje === 19 ? summary.genericIva : 0 },
            { porcentaje: 8, base: porcentaje === 8 ? base : 0, valor: porcentaje === 8 ? summary.genericIva : 0 },
            { porcentaje: 5, base: porcentaje === 5 ? base : 0, valor: porcentaje === 5 ? summary.genericIva : 0 },
            { porcentaje: 0, base: porcentaje === 0 ? base : 0, valor: 0 }
        ];
    }

    if (Array.isArray(merged.ivasDiscriminados) && merged.ivasDiscriminados.length > 0 && summary.genericIva > 0) {
        const rows = normalizeIvas(merged.ivasDiscriminados);
        const allTax = rows.reduce((acc, row) => acc + toNumber(row.valor), 0);
        const totalRef = Math.max(toNumber(merged.total), summary.total);
        if (allTax > totalRef * 0.8 || allTax <= 0) {
            const subtotal = Math.max(toNumber(merged.subtotal), summary.subtotal);
            const pct = subtotal > 0 ? normalizePct(Math.round((summary.genericIva / subtotal) * 100)) : 19;
            merged.ivasDiscriminados = rows.map((row) => ({
                porcentaje: row.porcentaje,
                base: row.porcentaje === pct ? subtotal : 0,
                valor: row.porcentaje === pct ? summary.genericIva : 0
            }));
        }
    }

    if (Array.isArray(summary.ivaRows) && summary.ivaRows.length > 0) {
        const textRows = hydrateIvaRows(summary.ivaRows, summary);
        const textBase = textRows.reduce((acc, row) => acc + toNumber(row.base), 0);
        if (textBase > 0) {
            const currentRows = normalizeIvas(merged.ivasDiscriminados);
            const totals = {
                subtotal: Math.max(toNumber(merged.subtotal), toNumber(summary.subtotal)),
                total: Math.max(toNumber(merged.total), toNumber(summary.total)),
                reteFuente: toNumber(merged.reteFuente),
                reteIca: toNumber(merged.reteIca),
                reteIva: toNumber(merged.reteIva),
                impuestoConsumo: toNumber(merged.impuestoConsumo),
                genericIva: toNumber(summary.genericIva)
            };
            const currentScore = scoreIvaRows(currentRows, totals);
            const textScore = scoreIvaRows(textRows, totals);
            if (textScore + 1 < currentScore || currentRows.every((row) => toNumber(row.base) <= 0 && toNumber(row.valor) <= 0)) {
                merged.ivasDiscriminados = textRows;
            }
        }
    }

    return merged;
}

function safeParseModelJson(text) {
    const src = String(text || '').trim();
    if (!src) throw new Error('Respuesta vacia del modelo');

    const cleaned = src
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

    try {
        return JSON.parse(cleaned);
    } catch (_) {}

    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
        const candidate = cleaned.slice(first, last + 1);
        try {
            return JSON.parse(candidate);
        } catch (_) {}
    }

    const compact = cleaned.replace(/[\u0000-\u001F]+/g, ' ').trim();
    const first2 = compact.indexOf('{');
    const last2 = compact.lastIndexOf('}');
    if (first2 >= 0 && last2 > first2) {
        return JSON.parse(compact.slice(first2, last2 + 1));
    }

    throw new Error('JSON invalido devuelto por el modelo');
}

function normalizeIvas(ivas) {
    const source = Array.isArray(ivas) ? ivas : [];
    const wanted = [19, 8, 5, 0];
    return wanted.map((pct) => {
        const found = source.find((x) => Number(x?.porcentaje) === pct) || {};
        return {
            porcentaje: pct,
            base: toNumber(found.base),
            valor: toNumber(found.valor)
        };
    });
}

function sumIvaComponents(ivas) {
    return ivas.reduce((acc, row) => {
        const pct = Number(row.porcentaje);
        acc.base += toNumber(row.base);
        acc.iva += pct === 0 ? 0 : toNumber(row.valor);
        return acc;
    }, { base: 0, iva: 0 });
}

function normalizeItems(items) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 300).map((it) => {
        const qtyRaw = toNumber(it?.cantidad);
        const qty = qtyRaw > 0 ? qtyRaw : 1;
        const unit = toNumber(it?.valorUnitario);
        const discount = toNumber(it?.descuento);
        const impuestoPct = toNumber(it?.ivaPorcentaje);

        const baseFromModel = toNumber(it?.baseImpuesto);
        const baseFromMath = qty * unit - discount;
        const base = round2(baseFromModel > 0 ? baseFromModel : baseFromMath);

        const ivaFromModel = toNumber(it?.ivaValor);
        const ivaFromMath = base * (impuestoPct / 100);
        const iva = round2(ivaFromModel > 0 ? ivaFromModel : ivaFromMath);

        const totalFromModel = toNumber(it?.totalLinea);
        const totalFromMath = base + iva;
        const total = round2(totalFromModel > 0 ? totalFromModel : totalFromMath);

        return {
            descripcion: normalizeText(it?.descripcion, 500),
            cantidad: qty,
            unidadMedida: normalizeText(it?.unidadMedida, 40),
            valorUnitario: unit,
            descuento: discount,
            baseImpuesto: base,
            ivaPorcentaje: impuestoPct,
            ivaValor: iva,
            totalLinea: total,
            exento: impuestoPct === 0,
            categoriaIva0: impuestoPct === 0 ? classifyZeroTaxText(it?.categoriaIva0 || it?.descripcion) : ''
        };
    });
}

function normalizePct(value) {
    const allowed = [0, 5, 8, 19];
    const rounded = Math.round(toNumber(value));
    if (allowed.includes(rounded)) return rounded;
    let best = 0;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const p of allowed) {
        const diff = Math.abs(rounded - p);
        if (diff < bestDiff) {
            best = p;
            bestDiff = diff;
        }
    }
    return best;
}

function aggregateIvasFromItems(items) {
    const acc = {
        19: { porcentaje: 19, base: 0, valor: 0 },
        8: { porcentaje: 8, base: 0, valor: 0 },
        5: { porcentaje: 5, base: 0, valor: 0 },
        0: { porcentaje: 0, base: 0, valor: 0 }
    };
    const zeroTaxBreakdown = { exenta: 0, excluida: 0, no_gravada: 0 };
    for (const item of items) {
        const pct = normalizePct(item.ivaPorcentaje);
        acc[pct].base += toNumber(item.baseImpuesto);
        acc[pct].valor += toNumber(item.ivaValor);
        if (pct === 0) {
            const bucket = classifyZeroTaxText(item.categoriaIva0 || item.descripcion);
            zeroTaxBreakdown[bucket] += toNumber(item.baseImpuesto);
        }
    }
    return {
        rows: [19, 8, 5, 0].map((p) => ({
            porcentaje: p,
            base: round2(acc[p].base),
            valor: round2(acc[p].valor)
        })),
        zeroTaxBreakdown: {
            exenta: round2(zeroTaxBreakdown.exenta),
            excluida: round2(zeroTaxBreakdown.excluida),
            no_gravada: round2(zeroTaxBreakdown.no_gravada)
        }
    };
}

function isLikelyDetailStopLine(upper) {
    return hasAny(upper, [
        'SUBTOTAL',
        'DATOS TOTALES',
        'TOTAL A PAGAR',
        'TOTAL FACTURA',
        'VALOR EN LETRAS',
        'CUFE',
        'CUDE',
        'OBSERVACIONES',
        'RETENCIONES',
        'NOTAS FINALES',
        'REFERENCIAS',
        'HOJA ',
        'DOCUMENTO GENERADO EL'
    ]);
}

function cleanDianDescription(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    text = text
        .replace(/^\d+\s*/, '')
        .replace(/^[A-Z0-9-]{6,}(?=[A-ZÁÉÍÓÚÑ])/i, '')
        .replace(/^[A-Z0-9-]{6,}\s+/, '')
        .replace(/\b(?:UND|UNIDAD|KG|KILO|KILOS|CJ|CAJA|BOL|PAQ|LT|LTS|GAL|SERV|SERVICIO|PK|ZZ)\s*\d+(?:[.,]\d+)?\s*$/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    return text;
}

function cleanDianDescriptionSafe(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    text = text
        .replace(/^\d+\s*/, '')
        .replace(/^\d{6,}(?=[A-ZÁÉÍÓÚÑ])/i, '')
        .replace(/\b(?:UND|UNIDAD|KG|KILO|KILOS|CJ|CAJA|BOL|PAQ|LT|LTS|GAL|SERV|SERVICIO|PK|ZZ)\s*\d+(?:[.,]\d+)?\s*$/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    return text;
}

function inferDianItemFromLine(line, pendingParts = []) {
    const upper = String(line || '').toUpperCase();
    const formatted = findFormattedAmounts(line, true);
    const pct = detectRateFromLine(upper);
    if (pct === null || formatted.length < 2) return null;

    const amountStart = line.search(/\d{1,3}(?:\.\d{3})*,\d{2}/);
    const prefix = amountStart >= 0 ? line.slice(0, amountStart) : line;
    const prefixUnitMatch = prefix.match(/(UNIDAD|SERVICIO|SERV|KILOS|KILO|CAJA|UND|PAQ|BOL|GAL|LTS|CJ|LT|KG|PK|ZZ)\s*$/i);
    const unitQtyMatch =
        line.match(/\b([A-Z]{1,5})\s*(\d{1,3}(?:[.,]\d{2})?)\s*(?=\d{1,3}(?:\.\d{3})*,\d{2})/i) ||
        line.match(/([A-Z]{1,5})(\d{1,3}(?:[.,]\d{2})?)(?=\d{1,3}(?:\.\d{3})*,\d{2})/i);

    let cantidad = 1;
    let unidadMedida = '';
    const firstAmount = formatted[0] || 0;
    const lastAmount = formatted[formatted.length - 1] || 0;
    const prevAmount = formatted.length >= 2 ? formatted[formatted.length - 2] : 0;
    const looksLikeLeadingQty = firstAmount > 0 && firstAmount <= 1000 && formatted.length >= 3;

    if (looksLikeLeadingQty) {
        cantidad = firstAmount;
        unidadMedida = normalizeText((prefixUnitMatch && prefixUnitMatch[1]) || '', 20).toUpperCase();
    } else if (unitQtyMatch) {
        unidadMedida = normalizeText(unitQtyMatch[1], 20).toUpperCase();
        cantidad = parseLocaleNumber(unitQtyMatch[2]) || 1;
    } else if (prefixUnitMatch) {
        unidadMedida = normalizeText(prefixUnitMatch[1], 20).toUpperCase();
    }

    const prefixWithoutUnit = unidadMedida
        ? prefix.replace(new RegExp(`${escapeRegExp(unidadMedida)}\\s*$`, 'i'), '')
        : prefix;
    const prefixSeed = prefixWithoutUnit
        .replace(/^\d{6,}(?=[A-ZÁÉÍÓÚÑ])/i, '')
        .replace(/^\d+\s+[A-Z0-9-]{4,}\s+/, '')
        .trim();
    let prefixDesc = cleanDianDescriptionSafe(prefixSeed);
    if (!prefixDesc || prefixDesc.length < 5 || /^[A-Z]\s+\d/.test(prefixDesc)) {
        prefixDesc = prefixSeed.replace(/\b(PK|ZZ|UND|KG|LT|CJ)\s*$/i, '').trim();
    }
    const descriptionParts = [...pendingParts.map(cleanDianDescriptionSafe).filter(Boolean).filter((part) => !['VENTA', 'DE VENTA', 'DETALLE'].includes(part.toUpperCase()))];
    if (prefixDesc) descriptionParts.push(prefixDesc);
    const descripcion = descriptionParts.join(' ').replace(/\s{2,}/g, ' ').trim() || 'ITEM';

    let baseImpuesto = lastAmount;
    let ivaValor = 0;
    let valorUnitario = looksLikeLeadingQty && formatted[1] ? formatted[1] : (firstAmount || lastAmount);

    if (pct > 0) {
        const expectedIvaFromBase = round2(lastAmount * (pct / 100));
        if (prevAmount > 0 && Math.abs(prevAmount - expectedIvaFromBase) <= Math.max(2, expectedIvaFromBase * 0.15)) {
            baseImpuesto = lastAmount;
            ivaValor = prevAmount;
            valorUnitario = cantidad > 0 ? round2(baseImpuesto / cantidad) : firstAmount;
        } else {
            baseImpuesto = cantidad > 0 && firstAmount > 0 ? round2(cantidad * firstAmount) : lastAmount;
            ivaValor = round2(baseImpuesto * (pct / 100));
            valorUnitario = firstAmount || round2(baseImpuesto / Math.max(cantidad, 1));
        }
    } else {
        baseImpuesto = lastAmount;
        valorUnitario = cantidad > 0 && firstAmount > 0 ? firstAmount : round2(baseImpuesto / Math.max(cantidad, 1));
    }

    return {
        descripcion,
        cantidad,
        unidadMedida,
        valorUnitario: round2(valorUnitario),
        descuento: 0,
        baseImpuesto: round2(baseImpuesto),
        ivaPorcentaje: pct,
        ivaValor: round2(ivaValor),
        totalLinea: round2(baseImpuesto + ivaValor),
        categoriaIva0: pct === 0 ? classifyZeroTaxText(descripcion) : ''
    };
}

function inferItemsFromDianText(text) {
    const src = sliceSection(text, 'Detalles de Productos', ['Referencias', 'Notas Finales', 'Datos Totales', 'Hoja ', 'Documento generado el']) || normalizeInvoiceText(text);
    const lines = src.split('\n').map((line) => line.trim()).filter(Boolean);
    const items = [];
    let inDetail = lines.length > 0 && /DETALLES?\s+DE\s+PRODUCTOS/i.test(lines[0]);
    let pendingParts = [];
    let seenItem = false;

    for (const line of lines) {
        const upper = line.toUpperCase();

        if (!inDetail && hasAny(upper, [
            'CODIGO DESCRIP',
            'CÓDIGO DESCRIP',
            'DESCRIPCION CANTIDAD',
            'DESCRIPCIÓN CANTIDAD',
            'DETALLE DE PRODUCTOS',
            'DETALLES DE PRODUCTOS',
            'DESCRIPCION DEL PRODUCTO',
            'DESCRIPCIÓN DEL PRODUCTO'
        ])) {
            inDetail = true;
            pendingParts = [];
            seenItem = false;
            continue;
        }

        if (!inDetail) continue;

        if (seenItem && isLikelyDetailStopLine(upper)) {
            break;
        }

        if (upper === 'DETALLES DE PRODUCTOS' || upper === 'DETALLE DE PRODUCTOS' || upper === 'DE VENTA' || upper === 'VENTA' || upper === 'DETALLE') {
            continue;
        }

        if (hasAny(upper, [
            'IMPUESTOS',
            'PRECIO UNITARIO',
            'PRECIO',
            'UNITARIO DE',
            'NRO.CODIGO',
            'NRO.CÓDIGO',
            'DESCUENTO',
            'RECARGO DETALLE',
            'IVA%',
            'INC%'
        ])) {
            continue;
        }

        if (/^\d+$/.test(upper)) {
            continue;
        }

        const item = inferDianItemFromLine(line, pendingParts);
        if (item) {
            items.push(item);
            pendingParts = [];
            seenItem = true;
            continue;
        }

        if (!isLikelyDetailStopLine(upper)) {
            pendingParts.push(line);
        }
    }

    return items.slice(0, 150);
}

function inferDianStructuredExtraction(text) {
    const src = normalizeInvoiceText(text);
    const summary = inferSummaryFromText(src);
    if (!isLikelyOfficialDianStructuredInvoice(src, summary)) return null;

    const docSection = sliceSection(src, 'Datos del Documento', ['Datos del Emisor / Vendedor', 'Datos del Emisor', 'Detalles de Productos']);
    const emitterSection = sliceSection(src, 'Datos del Emisor / Vendedor', ['Datos del Adquiriente / Comprador', 'Detalles de Productos']);
    const buyerSection = sliceSection(src, 'Datos del Adquiriente / Comprador', ['Detalles de Productos', 'Referencias', 'Notas Finales', 'Datos Totales']);

    const detalleProductos = inferItemsFromDianText(src);
    const subtotal = toNumber(summary.subtotal);
    const total = toNumber(summary.total);
    if (subtotal <= 0 || total <= 0) return null;

    const cufe = matchFirst(src, /(?:CUFE|CUDE)\s*[:#]?\s*([A-Z0-9-]{20,})/i);
    const numeroFactura =
        extractSectionValue(docSection, 'Número de Factura', ['Forma de pago', 'Fecha de Emisión', 'Medio de Pago']) ||
        extractSectionValue(docSection, 'Numero de Factura', ['Forma de pago', 'Fecha de Emision', 'Medio de Pago']) ||
        matchFirst(docSection, /\b([A-Z]{2,10}\s*-\s*\d{2,})\b/i) ||
        matchFirst(src, /\b([A-Z]{2,6}-\d{2,})\b/);
    const fechaEmision =
        extractSectionValue(docSection, 'Fecha de Emisión', ['Medio de Pago', 'Fecha de Vencimiento']) ||
        extractSectionValue(docSection, 'Fecha de Emision', ['Medio de Pago', 'Fecha de Vencimiento']) ||
        matchFirst(src, /FECHA(?:\s+DE)?\s+EMISION\s*[:\-]?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[\/-][0-9]{1,2}[\/-][0-9]{2,4})/i) ||
        matchFirst(src, /FECHA\s*[:\-]?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[\/-][0-9]{1,2}[\/-][0-9]{2,4})/i);
    const fechaVencimiento =
        extractSectionValue(docSection, 'Fecha de Vencimiento', ['Orden de pedido', 'Tipo de Operación', 'Tipo de Operacion']) ||
        matchFirst(src, /VENCIMIENTO\s*[:\-]?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[\/-][0-9]{1,2}[\/-][0-9]{2,4})/i);
    const nitEmisor =
        extractSectionValue(emitterSection, 'Nit del Emisor', ['País', 'Pais', 'Tipo de Contribuyente']) ||
        extractSectionValue(emitterSection, 'NIT del Emisor', ['País', 'Pais', 'Tipo de Contribuyente']) ||
        matchFirst(emitterSection, /NIT\s+EMISOR\s*[:\-]?\s*([0-9.\-]+)/i) ||
        matchFirst(emitterSection, /EMISOR[\s\S]{0,120}?NIT\s*[:\-]?\s*([0-9.\-]+)/i);
    const nitAdquirente =
        extractSectionValue(buyerSection, 'Número Documento', ['Departamento', 'Tipo de Contribuyente']) ||
        extractSectionValue(buyerSection, 'Numero Documento', ['Departamento', 'Tipo de Contribuyente']) ||
        matchFirst(buyerSection, /NIT\s+ADQUIRIENTE\s*[:\-]?\s*([0-9.\-]+)/i) ||
        matchFirst(buyerSection, /ADQUIRIENTE[\s\S]{0,160}?NIT\s*[:\-]?\s*([0-9.\-]+)/i);
    const emisor =
        extractSectionValue(emitterSection, 'Razón Social', ['Nombre Comercial', 'Nit del Emisor']) ||
        extractSectionValue(emitterSection, 'Razon Social', ['Nombre Comercial', 'Nit del Emisor']) ||
        matchFirst(emitterSection, /RAZON SOCIAL\s+EMISOR\s*[:\-]?\s*(.+)/i) ||
        matchFirst(emitterSection, /EMISOR\s*[:\-]?\s*(.+)/i, 1);
    const adquirente =
        extractSectionValue(buyerSection, 'Nombre o Razón Social', ['Tipo de Documento', 'Número Documento']) ||
        extractSectionValue(buyerSection, 'Nombre o Razon Social', ['Tipo de Documento', 'Numero Documento']) ||
        matchFirst(buyerSection, /RAZON SOCIAL\s+ADQUIRIENTE\s*[:\-]?\s*(.+)/i) ||
        matchFirst(buyerSection, /ADQUIRIENTE\s*[:\-]?\s*(.+)/i, 1);

    const numeroFacturaResolved = normalizeText(numeroFactura.replace(/\s+/g, '').replace(/-+/g, '-'), 80) ||
        matchFirst(src, /NUMERO\s+DE\s+FACTURA\s*[:\-]?\s*([A-Z0-9-]+)/i) ||
        matchFirst(src, /(?:PREFIJO|PREF)\s*[:\-]?\s*([A-Z]{1,8})[\s\S]{0,30}?(?:NUMERO|NUMERO FACTURA)\s*[:\-]?\s*([0-9]{2,})/i, 2);
    const nitEmisorResolved = nitEmisor ||
        matchFirst(emitterSection, /RAZON SOCIAL[\s\S]{0,200}?NIT\s*[:\-]?\s*([0-9.\-]+)/i) ||
        matchFirst(emitterSection, /\bNIT\b\s*[:\-]?\s*([0-9]{6,}[-0-9.]*)/i);
    const emisorResolved = emisor || matchFirst(emitterSection, /NOMBRE\s+O\s+RAZON\s+SOCIAL\s+EMISOR\s*[:\-]?\s*(.+)/i);
    const adquirenteResolved = adquirente || matchFirst(buyerSection, /NOMBRE\s+O\s+RAZON\s+SOCIAL\s+ADQUIRIENTE\s*[:\-]?\s*(.+)/i);

    const raw = {
        extractionSource: 'dian_parser',
        tipoDocumento: 'factura_venta',
        prefijo: numeroFacturaResolved.includes('-') ? numeroFacturaResolved.split('-')[0] : '',
        numeroFactura: numeroFacturaResolved,
        cufe,
        codigoQr: '',
        moneda: 'COP',
        fechaEmision,
        fechaVencimiento,
        horaEmision: '',
        emisor: emisorResolved,
        nitEmisor: nitEmisorResolved,
        direccionEmisor: '',
        ciudadEmisor: '',
        regimenEmisor: '',
        adquirente: adquirenteResolved,
        nitAdquirente,
        direccionAdquirente: '',
        ciudadAdquirente: '',
        formaPago: extractSectionValue(docSection, 'Forma de pago', ['Fecha de Emisión', 'Fecha de Emision', 'Medio de Pago']),
        medioPago: extractSectionValue(docSection, 'Medio de Pago', ['Fecha de Vencimiento', 'Orden de pedido']),
        subtotal: summary.subtotal,
        descuentoTotal: summary.descuentoTotal,
        cargoTotal: 0,
        impuestoConsumo: summary.impuestoConsumo,
        reteFuente: summary.reteFuente,
        reteIca: summary.reteIca,
        reteIva: summary.reteIva,
        total: summary.total,
        ivasDiscriminados: summary.ivaRows,
        detalleProductos
    };

    const normalized = normalizeExtraction(raw);
    const diff = Math.abs(toNumber(normalized.validacion?.diferenciaTotal));
    if (diff > 1.5 && detalleProductos.length === 0) return null;
    return normalized;
}

function autoRepairIvas({ ivas, total, impuestoConsumo, reteFuente, reteIca, reteIva }) {
    const rows = ivas.map((x) => ({ porcentaje: Number(x.porcentaje), base: round2(x.base), valor: round2(x.valor) }));
    const sum = sumIvaComponents(rows);
    const expected = round2(sum.base + sum.iva + impuestoConsumo - (reteFuente + reteIca + reteIva));
    let diff = round2(total - expected);

    if (Math.abs(diff) <= 1) {
        return { rows, repaired: false, diff };
    }

    const base0 = rows.find((r) => r.porcentaje === 0) || { base: 0, valor: 0 };
    const taxRows = rows.filter((r) => r.porcentaje !== 0 && (r.base > 0 || r.valor > 0));
    const otherFixed = round2(base0.base + impuestoConsumo - (reteFuente + reteIca + reteIva));
    const targetTaxable = round2(total - otherFixed);

    if (targetTaxable > 0 && taxRows.length === 1) {
        const row = taxRows[0];
        const rate = row.porcentaje / 100;
        const newBase = round2(targetTaxable / (1 + rate));
        const newIva = round2(newBase * rate);
        row.base = newBase;
        row.valor = newIva;
        const sum2 = sumIvaComponents(rows);
        const expected2 = round2(sum2.base + sum2.iva + impuestoConsumo - (reteFuente + reteIca + reteIva));
        return { rows, repaired: true, diff: round2(total - expected2) };
    }

    if (targetTaxable > 0 && taxRows.length > 1) {
        const currentTaxable = round2(taxRows.reduce((a, r) => a + r.base + r.valor, 0));
        if (currentTaxable > 0) {
            const factor = targetTaxable / currentTaxable;
            for (const row of taxRows) {
                const newBase = round2(row.base * factor);
                row.base = newBase;
                row.valor = round2(newBase * (row.porcentaje / 100));
            }
            const sum2 = sumIvaComponents(rows);
            const expected2 = round2(sum2.base + sum2.iva + impuestoConsumo - (reteFuente + reteIca + reteIva));
            diff = round2(total - expected2);
            return { rows, repaired: true, diff };
        }
    }

    return { rows, repaired: false, diff };
}

function normalizeExtraction(raw = {}) {
    const rawIvas = normalizeIvas(raw.ivasDiscriminados);
    const detalleProductos = normalizeItems(raw.detalleProductos || raw.items);
    const itemTaxData = aggregateIvasFromItems(detalleProductos);
    const itemIvas = itemTaxData.rows;
    const hasItemTaxData = itemIvas.some((x) => x.base > 0 || x.valor > 0);
    const ivasDiscriminados = hasItemTaxData ? itemIvas : rawIvas;
    const reteFuente = toNumber(raw.reteFuente);
    const reteIca = toNumber(raw.reteIca);
    const reteIva = toNumber(raw.reteIva);
    const impuestoConsumo = toNumber(raw.impuestoConsumo);
    const rawTotal = toNumber(raw.total);
    const repaired = autoRepairIvas({
        ivas: ivasDiscriminados,
        total: rawTotal,
        impuestoConsumo,
        reteFuente,
        reteIca,
        reteIva
    });
    const fixedIvas = repaired.rows;
    const iva0 = fixedIvas.find((x) => x.porcentaje === 0) || { base: 0, valor: 0 };
    const iva5 = fixedIvas.find((x) => x.porcentaje === 5) || { base: 0, valor: 0 };
    const iva8 = fixedIvas.find((x) => x.porcentaje === 8) || { base: 0, valor: 0 };
    const iva19 = fixedIvas.find((x) => x.porcentaje === 19) || { base: 0, valor: 0 };
    const rawZeroTaxBreakdown = raw.zeroTaxBreakdown || {};
    const itemZeroTaxBreakdown = itemTaxData.zeroTaxBreakdown || {};
    const zeroTaxBreakdown = hasItemTaxData ? itemZeroTaxBreakdown : {
        exenta: toNumber(rawZeroTaxBreakdown.exenta),
        excluida: toNumber(rawZeroTaxBreakdown.excluida),
        no_gravada: toNumber(rawZeroTaxBreakdown.no_gravada)
    };
    const zeroTaxKnown = sumZeroTaxBreakdown(zeroTaxBreakdown);
    if (toNumber(iva0.base) > 0 && zeroTaxKnown <= 0) {
        zeroTaxBreakdown.exenta = toNumber(iva0.base);
    }

    const subtotalFromIvas = round2(iva0.base + iva5.base + iva8.base + iva19.base);
    const rawSubtotal = toNumber(raw.subtotal);
    const subtotal = hasItemTaxData ? subtotalFromIvas : rawSubtotal;

    const computedTotal = round2(
        iva0.base + iva5.base + iva8.base + iva19.base +
        iva5.valor + iva8.valor + iva19.valor +
        impuestoConsumo - (reteFuente + reteIca + reteIva)
    );
    const total = hasItemTaxData && Math.abs(rawTotal - computedTotal) > 1 ? computedTotal : (rawTotal || computedTotal);

    return {
        schemaVersion: 'co_factura_v1',
        extractionSource: normalizeText(raw.extractionSource || raw.processingSource || 'ai', 40),
        tipoDocumento: normalizeText(raw.tipoDocumento || 'factura_venta', 40),
        prefijo: normalizeText(raw.prefijo, 30),
        numeroFactura: normalizeText(raw.numeroFactura, 80),
        cufe: normalizeText(raw.cufe, 200),
        codigoQr: normalizeText(raw.codigoQr, 500),
        moneda: normalizeText(raw.moneda || 'COP', 8),

        fechaEmision: normalizeText(raw.fechaEmision, 40),
        fechaVencimiento: normalizeText(raw.fechaVencimiento, 40),
        horaEmision: normalizeText(raw.horaEmision, 20),

        emisor: normalizeText(raw.emisor, 300),
        nitEmisor: normalizeText(raw.nitEmisor, 80),
        direccionEmisor: normalizeText(raw.direccionEmisor, 300),
        ciudadEmisor: normalizeText(raw.ciudadEmisor, 120),
        regimenEmisor: normalizeText(raw.regimenEmisor, 120),

        adquirente: normalizeText(raw.adquirente, 300),
        nitAdquirente: normalizeText(raw.nitAdquirente, 80),
        direccionAdquirente: normalizeText(raw.direccionAdquirente, 300),
        ciudadAdquirente: normalizeText(raw.ciudadAdquirente, 120),

        formaPago: normalizeText(raw.formaPago, 120),
        medioPago: normalizeText(raw.medioPago, 120),

        subtotal,
        descuentoTotal: toNumber(raw.descuentoTotal),
        cargoTotal: toNumber(raw.cargoTotal),
        impuestoConsumo,
        reteFuente,
        reteIca,
        reteIva,
        total,

        baseExento: round2(iva0.base || sumZeroTaxBreakdown(zeroTaxBreakdown)),
        baseExenta: round2(toNumber(zeroTaxBreakdown.exenta)),
        baseExcluida: round2(toNumber(zeroTaxBreakdown.excluida)),
        baseNoGravada: round2(toNumber(zeroTaxBreakdown.no_gravada)),
        zeroTaxBreakdown,
        base5: iva5.base,
        iva5: iva5.valor,
        base8: iva8.base,
        iva8: iva8.valor,
        base19: iva19.base,
        iva19: iva19.valor,
        ivasDiscriminados: fixedIvas,

        detalleProductos,

        validacion: {
            totalCalculado: computedTotal,
            diferenciaTotal: round2(total - computedTotal),
            repairedIvas: repaired.repaired
        }
    };
}

function buildPrompt(text) {
    return `Analiza esta FACTURA COLOMBIANA y responde SOLO JSON valido.

Objetivo:
- Extraer TODOS los datos utiles para contabilidad.
- Si un dato no existe, devuelve cadena vacia o 0.
- Sin markdown, sin comentarios, solo JSON.
- La estructura del PDF puede variar, venir corrida o con columnas mezcladas.
- Prioriza la logica contable sobre la posicion visual del texto.
- Si el detalle de items sale roto, usa anclas como SUBTOTAL, IVA, TOTAL, RETEFUENTE, RETEIVA, RETEICA e IMPUESTO AL CONSUMO.

Debe incluir exactamente este esquema (con estas claves):
{
  "tipoDocumento": "factura_venta",
  "prefijo": "",
  "numeroFactura": "",
  "cufe": "",
  "codigoQr": "",
  "moneda": "COP",
  "fechaEmision": "",
  "fechaVencimiento": "",
  "horaEmision": "",
  "emisor": "",
  "nitEmisor": "",
  "direccionEmisor": "",
  "ciudadEmisor": "",
  "regimenEmisor": "",
  "adquirente": "",
  "nitAdquirente": "",
  "direccionAdquirente": "",
  "ciudadAdquirente": "",
  "formaPago": "",
  "medioPago": "",
  "subtotal": 0,
  "descuentoTotal": 0,
  "cargoTotal": 0,
  "impuestoConsumo": 0,
  "reteFuente": 0,
  "reteIca": 0,
  "reteIva": 0,
  "total": 0,
  "zeroTaxBreakdown": {
    "exenta": 0,
    "excluida": 0,
    "no_gravada": 0
  },
  "ivasDiscriminados": [
    {"porcentaje": 19, "base": 0, "valor": 0},
    {"porcentaje": 8, "base": 0, "valor": 0},
    {"porcentaje": 5, "base": 0, "valor": 0},
    {"porcentaje": 0, "base": 0, "valor": 0}
  ],
  "detalleProductos": [
    {
      "descripcion": "",
      "cantidad": 0,
      "unidadMedida": "",
      "valorUnitario": 0,
      "descuento": 0,
      "baseImpuesto": 0,
      "ivaPorcentaje": 0,
      "ivaValor": 0,
      "totalLinea": 0,
      "categoriaIva0": ""
    }
  ]
}

Reglas obligatorias:
1) Base 0% debe intentar distinguir entre exenta, excluida y no gravada.
2) Separar bases e IVA para 5%, 8% y 19%.
3) Extraer ReteFuente, ReteICA y ReteIVA.
4) Validar matematica: (bases + IVAs + imp consumo - retenciones) ~= total.
5) En cada item, baseImpuesto debe respetar cantidad x valorUnitario menos descuento.
6) Si cantidad > 1, nunca uses valor unitario como total de linea.
7) Cuando existan varias tarifas, consolida por linea y luego suma por porcentaje.
8) No inventes una tabla perfecta si el PDF viene desordenado; conserva la logica numerica.
9) Si la factura no distingue exenta/excluida/no gravada, usa exenta como fallback de 0%.

Texto factura:
${text}`;
}

async function extractDataFromPDF(text, config = { provider: 'gemini' }) {
    const provider = typeof config === 'string' ? config : (config.provider || 'gemini');

    const geminiKey = readConfigSecret(config, 'gemini_api_key_enc', 'gemini_api_key', 'api_key_gemini') || process.env.GEMINI_API_KEY;
    const groqKey = readConfigSecret(config, 'groq_api_key_enc', 'groq_api_key', 'api_key_groq') || process.env.GROQ_API_KEY;

    console.log(`[EXTRACTOR] Procesando con provider: ${provider}`);
    const normalizedText = preprocessInvoiceText(text);
    const localDian = inferDianStructuredExtraction(normalizedText);
    if (localDian) {
        console.log('[EXTRACTOR] Factura DIAN estructurada resuelta sin IA.');
        return localDian;
    }
    const prompt = buildPrompt(normalizedText);
    const summaryFallback = inferSummaryFromText(normalizedText);
    const identifierFallback = inferCommonIdentifiers(normalizedText);

    try {
        if (provider === 'gemini') {
            if (!geminiKey) throw new Error('No hay Gemini API key configurada.');
            const client = new GoogleGenerativeAI(geminiKey);
            const model = client.getGenerativeModel({ model: 'gemini-1.5-flash' });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const resText = response.text();
            return normalizeExtraction({
                ...identifierFallback,
                ...mergeSummaryFallback(safeParseModelJson(resText), summaryFallback),
                extractionSource: 'ai_gemini'
            });
        }

        if (provider === 'groq') {
            if (!groqKey) throw new Error('No hay Groq API key configurada.');
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${groqKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.1,
                    response_format: { type: 'json_object' }
                })
            });
            if (!response.ok) {
                if (response.status === 429) {
                    throw new Error('RATE_LIMIT_GROQ_429');
                }
                throw new Error(`Groq API respondio con ${response.status}`);
            }
            const data = await response.json();
            if (!data.choices || data.choices.length === 0) {
                const apiErr = data.error ? data.error.message : 'Respuesta desconocida del servidor';
                throw new Error(`Groq API rechazada: ${apiErr}`);
            }
            const resText = data.choices[0].message.content;
            return normalizeExtraction({
                ...identifierFallback,
                ...mergeSummaryFallback(safeParseModelJson(resText), summaryFallback),
                extractionSource: 'ai_groq'
            });
        }

        return null;
    } catch (error) {
        console.error('[EXTRACTOR FATAL ERROR]:', error.message);
        throw error;
    }
}

module.exports = { extractDataFromPDF, normalizeExtraction, inferCommonIdentifiers };
