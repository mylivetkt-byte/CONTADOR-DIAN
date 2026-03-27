const assert = require('node:assert/strict');

const { normalizeExtraction, inferCommonIdentifiers } = require('../backend/extractor');

function run(name, fn) {
    try {
        fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`not ok - ${name}`);
        throw error;
    }
}

run('inferCommonIdentifiers detects invoice and NIT values from plain text', () => {
    const text = `
        ACME SAS
        NIT 900.123.456-7
        FACTURA ELECTRONICA DE VENTA FE-12345
        CLIENTE DEMO CLIENTE NIT 800.456.789-0
    `;

    const result = inferCommonIdentifiers(text);

    assert.equal(result.numeroFactura, 'FE-12345');
    assert.equal(result.nitEmisor, '900.123.456-7');
    assert.equal(result.nitAdquirente, '800.456.789-0');
});

run('normalizeExtraction computes totals and validation from IVA rows', () => {
    const result = normalizeExtraction({
        extractionSource: 'ai_gemini',
        numeroFactura: 'FV-77',
        emisor: 'Proveedor Demo',
        nitEmisor: '900111222',
        subtotal: 1000,
        impuestoConsumo: 0,
        reteFuente: 0,
        reteIca: 0,
        reteIva: 0,
        total: 1190,
        ivasDiscriminados: [
            { porcentaje: 19, base: 1000, valor: 190 },
            { porcentaje: 8, base: 0, valor: 0 },
            { porcentaje: 5, base: 0, valor: 0 },
            { porcentaje: 0, base: 0, valor: 0 }
        ]
    });

    assert.equal(result.base19, 1000);
    assert.equal(result.iva19, 190);
    assert.equal(result.total, 1190);
    assert.equal(result.validacion.diferenciaTotal, 0);
});

run('normalizeExtraction uses item detail when present', () => {
    const result = normalizeExtraction({
        extractionSource: 'ai_groq',
        total: 1249,
        reteFuente: 0,
        reteIca: 0,
        reteIva: 0,
        impuestoConsumo: 0,
        detalleProductos: [
            {
                descripcion: 'Servicio gravado',
                cantidad: 1,
                valorUnitario: 1000,
                descuento: 0,
                baseImpuesto: 1000,
                ivaPorcentaje: 19,
                ivaValor: 190,
                totalLinea: 1190
            },
            {
                descripcion: 'Servicio exento',
                cantidad: 1,
                valorUnitario: 59,
                descuento: 0,
                baseImpuesto: 59,
                ivaPorcentaje: 0,
                ivaValor: 0,
                totalLinea: 59,
                categoriaIva0: 'exenta'
            }
        ]
    });

    assert.equal(result.base19, 1000);
    assert.equal(result.iva19, 190);
    assert.equal(result.baseExento, 59);
    assert.equal(result.total, 1249);
});

console.log('All extractor tests passed.');
