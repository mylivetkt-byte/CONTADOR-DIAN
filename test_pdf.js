const fs = require('fs');
const pdf = require('pdf-parse');

const filePath = 'e:/contador/input/FVL090109140300025.pdf';
if (fs.existsSync(filePath)) {
    const dataBuffer = fs.readFileSync(filePath);
    pdf(dataBuffer).then(res => {
        console.log('SUCCESS! Text length:', res.text.length);
        console.log('Snippet:', res.text.substring(0, 50));
    }).catch(err => {
        console.error('ERROR!', err);
    });
}
