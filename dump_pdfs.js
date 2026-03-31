const fs = require('fs');
const pdf = require('pdf-parse');
const path = require('path');

const files = [
    '2026-02-01_CARMEN LUCIA CADENA PATIÑO CARMEN CADENA (DSG-00000490).pdf',
    '2026-02-07_DOLLYS DISTRIBUCIONES SAS (FPOS-50917).pdf',
    '2026-02-23_EMPAQUETADOS EL TRECE S.A.S (FE-605367).pdf',
    '2026-02-18_SOCIEDAD TRANSPORTADORA Y LOGISTIC S.A.S. (FE-261076).pdf',
    '2026-02-18_TRONEX S.A.S (HHME-1520428).pdf'
];

const folder = 'C:\\Users\\SERVIDO KNS PLUS\\Downloads\\PRUEBA IA';

async function dump() {
    for (const file of files) {
        try {
            const dataBuffer = fs.readFileSync(path.join(folder, file));
            const data = await pdf(dataBuffer);
            console.log(`=== FILE: ${file} ===`);
            console.log(data.text);
            console.log('\n\n');
        } catch (e) {
            console.error(`Error reading ${file}: ${e.message}`);
        }
    }
}

dump();
