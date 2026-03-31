const fs = require('fs');
const pdf = require('pdf-parse');
const path = require('path');

const file = 'f629d225802e9eefee33d237e099b2061f8dc815cda8b3c32292e4471735e379c259d58c8f0ff21b39433b63091b6afd.pdf';
const folder = 'C:\\Users\\SERVIDO KNS PLUS\\Downloads\\PRUEBA IA';

async function dump() {
    const dataBuffer = fs.readFileSync(path.join(folder, file));
    const data = await pdf(dataBuffer);
    console.log(data.text);
}

dump();
