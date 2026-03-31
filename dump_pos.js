const fs = require('fs');
const pdf = require('pdf-parse');
const path = require('path');

const file = '2026-02-11_SUPERMERCADO MERCADIARIO LTDA (PE2M-150491).pdf';
const folder = 'C:\\Users\\SERVIDO KNS PLUS\\Downloads\\PRUEBA IA';

async function dump() {
    const dataBuffer = fs.readFileSync(path.join(folder, file));
    const data = await pdf(dataBuffer);
    console.log(data.text);
}

dump();
