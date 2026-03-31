const fs = require('fs-extra');
const path = require('path');
const pdfParse = require('pdf-parse');

async function analyzePDFs() {
    const dir = 'C:\\Users\\SERVIDO KNS PLUS\\Downloads\\PRUEBA IA';
    if (!fs.existsSync(dir)) {
        console.log('La carpeta no existe:', dir);
        return;
    }

    const files = await fs.readdir(dir);
    const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf'));

    console.log(`\n📄 Encontrados ${pdfFiles.length} documentos en la carpeta.\n`);

    for (const file of pdfFiles) {
        try {
            const buffer = await fs.readFile(path.join(dir, file));
            const data = await pdfParse(buffer);
            const text = data.text;
            
            // Extraer primeras líneas no vacías para ver los títulos/encabezados principales
            const lines = text.split('\n')
                              .map(l => l.trim())
                              .filter(l => l.length > 5 && !/^\d+$/.test(l))
                              .slice(0, 10); // Primeras 10 líneas importantes
            
            // Buscar mención específica de "Tipo de Operación"
            const opMatch = text.match(/Tipo de Operaci[oó]n\s*[:\-]?\s*([^\n]+)/i);
            const tipoOperacion = opMatch ? opMatch[1].trim() : 'NO ENCONTRADO';

            // Buscar si contiene ciertas palabras clave
            let posibleTipo = 'Estándar';
            if (text.toUpperCase().includes('DOCUMENTO SOPORTE') || text.toUpperCase().includes('ADQUISICIONES EFECTUADAS')) posibleTipo = 'Documento Soporte';
            if (text.toUpperCase().includes('NOTA CRÉDITO') || text.toUpperCase().includes('NOTA CREDITO')) posibleTipo = 'Nota Crédito';
            if (text.toUpperCase().includes('EQUIVALENTE POS') || text.toUpperCase().includes('SISTEMA P.O.S')) posibleTipo = 'Factura POS';

            console.log(`====================================================`);
            console.log(`📌 Archivo: ${file}`);
            console.log(`🔎 Tipo Operación Extraíble: ${tipoOperacion}`);
            console.log(`🤖 Tipo Deducido Visualmente: ${posibleTipo}`);
            console.log(`📝 Encabezados Reales del PDF:`);
            console.log(lines.join('\n'));
            console.log(`\n`);
        } catch (err) {
            console.error(`Error leyendo ${file}:`, err.message);
        }
    }
}

analyzePDFs();
