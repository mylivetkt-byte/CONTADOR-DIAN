const { Client } = require('pg');
require('dotenv').config();

async function updateDatabase() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log('Conectado a contador_db. Ejecutando migraciones SaaS...');
        await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'`);
        await client.query(`UPDATE companies SET status = 'active' WHERE status IS NULL OR status = 'pending'`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN DEFAULT false`);
        await client.query(`UPDATE users SET is_superadmin = true, role = 'admin' WHERE id = 1`);
        console.log('Migracion de base de datos exitosa. Roles y estados creados.');
    } catch (err) {
        console.error('Error actualizando la base de datos:', err);
    } finally {
        await client.end();
    }
}

updateDatabase();
