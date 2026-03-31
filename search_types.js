const fs = require('fs');
const pdf = require('pdf-parse');
const path = require('path');

const folder = 'C:\\Users\\SERVIDO KNS PLUS\\Downloads\\PRUEBA IA';

async function scan() {
    const files = fs.readdirSync(folder).filter(f => f.endsWith('.pdf'));
    for (const file of files) {
        try {
            const dataBuffer = fs.readFileSync(path.join(folder, file));
            const data = await pdf(dataBuffer);
            if (data.text.includes('SinAporte') || data.text.includes('Mandato') || data.text.includes('Transporte')) {
                 console.log(`FOUND in ${file}:`);
                 const text = data.text;
                 const opTypeMatch = text.match(/Tipo de Operación\s*[:\-]?\s*([^\n\r]+)/i);
                 console.log(`OpType: ${opTypeMatch ? opTypeMatch[1] : 'NONE'}`);
            }
        } catch (e) {}
    }
}

scan();
