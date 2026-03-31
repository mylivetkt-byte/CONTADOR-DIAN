const fs = require('fs');
const pdf = require('pdf-parse');
const path = require('path');

const folder = 'C:\\Users\\SERVIDO KNS PLUS\\Downloads\\PRUEBA IA';

async function scan() {
    const files = fs.readdirSync(folder).filter(f => f.endsWith('.pdf'));
    const summary = [];
    for (const file of files) {
        try {
            const dataBuffer = fs.readFileSync(path.join(folder, file));
            const data = await pdf(dataBuffer);
            const text = data.text;
            const opTypeMatch = text.match(/Tipo de Operación\s*[:\-]?\s*([^\n\r]+)/i);
            const opType = opTypeMatch ? opTypeMatch[1].trim() : 'Unknown';
            const docNumMatch = text.match(/Número de (?:Factura|Documento|Nota)\s*[:\-]?\s*([^\n\r]+)/i);
            const docNum = docNumMatch ? docNumMatch[1].trim() : 'Unknown';
            summary.push({ file, opType, docNum });
        } catch (e) {
            summary.push({ file, opType: 'Error: ' + e.message, docNum: 'Unknown' });
        }
    }
    console.log(JSON.stringify(summary, null, 2));
}

scan();
