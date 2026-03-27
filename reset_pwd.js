const bcrypt = require('bcryptjs');
const { Client } = require('pg');
require('dotenv').config();

async function reset() {
    const newPassword = process.argv[2];
    if (!newPassword || newPassword.length < 12) {
        throw new Error('Debes enviar una nueva clave de al menos 12 caracteres: node reset_pwd.js "<nueva-clave>"');
    }

    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        const hash = await bcrypt.hash(newPassword, 12);
        await client.query('UPDATE users SET password_hash = $1 WHERE id = 1', [hash]);
        console.log('Contrasena de SuperAdmin actualizada.');
    } catch (err) {
        console.error('Error reseteando:', err);
    } finally {
        await client.end();
    }
}

reset();
