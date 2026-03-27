const fs = require('fs-extra');
const path = require('path');

const configPath = path.join(__dirname, '../config.json');

// Initialize with defaults if it doesn't exist
if (!fs.existsSync(configPath)) {
    fs.writeJsonSync(configPath, {
        activeProvider: 'gemini', // 'gemini', 'groq', or 'openai'
        apiKeys: {
            gemini: process.env.GEMINI_API_KEY || '',
            groq: '',
            openai: ''
        }
    });
}

async function getConfig() {
    return await fs.readJson(configPath);
}

async function updateConfig(newConfig) {
    const current = await getConfig();
    const merged = { ...current, ...newConfig };
    await fs.writeJson(configPath, merged);
    return merged;
}

module.exports = { getConfig, updateConfig };
