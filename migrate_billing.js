const { Client } = require('pg');
require('dotenv').config();

async function upgrade() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });
    try {
        await client.connect();
        await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS next_billing_date DATE`);
        await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'Mensual Pro'`);
        await client.query(`UPDATE companies SET next_billing_date = CURRENT_DATE + INTERVAL '30 days' WHERE next_billing_date IS NULL`);
        console.log('BD migrada: campos de facturacion listos.');
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

upgrade();
