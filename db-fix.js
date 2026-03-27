const { pool } = require('./backend/db');
(async () => {
    try {
        await pool.query('CREATE TABLE IF NOT EXISTS configs (company_id INTEGER PRIMARY KEY, provider VARCHAR(255) DEFAULT \'gemini\', gemini_api_key TEXT, groq_api_key TEXT);');
        await pool.query('ALTER TABLE configs ADD COLUMN IF NOT EXISTS provider VARCHAR(255) DEFAULT \'gemini\';');
        await pool.query('ALTER TABLE configs ADD COLUMN IF NOT EXISTS gemini_api_key TEXT;');
        await pool.query('ALTER TABLE configs ADD COLUMN IF NOT EXISTS groq_api_key TEXT;');
        console.log("Database configs table fixed");
    } catch(err) {
        console.error(err);
    } finally {
        pool.end();
    }
})();
