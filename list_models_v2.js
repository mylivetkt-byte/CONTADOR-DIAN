const dotenv = require('dotenv');
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

async function listModels() {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.models) {
            console.log('Available Models for your Key:');
            data.models.forEach(m => {
                console.log(`- ${m.name.replace('models/', '')}`);
            });
        } else {
            console.log('Error listing models:', data);
        }
    } catch (e) {
        console.error('Fetch Error:', e);
    }
}

listModels();
