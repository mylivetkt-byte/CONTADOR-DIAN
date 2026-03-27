const { Client } = require('pg');
require('dotenv').config();

async function migrateSaaSEnterprise() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });
    try {
        await client.connect();
        console.log('--- Iniciando migracion SaaS Enterprise ---');

        await client.query(`
            CREATE TABLE IF NOT EXISTS plans (
                id SERIAL PRIMARY KEY,
                name VARCHAR(50) NOT NULL,
                price_monthly DECIMAL(10,2) DEFAULT 0.00,
                max_documents_month INTEGER DEFAULT 10,
                max_users INTEGER DEFAULT 1,
                features JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        const planCheck = await client.query('SELECT COUNT(*) FROM plans');
        if (parseInt(planCheck.rows[0].count, 10) === 0) {
            await client.query(`
                INSERT INTO plans (name, price_monthly, max_documents_month, max_users, features)
                VALUES
                ('Free Trial', 0, 10, 1, '{"support": "community"}'),
                ('Contador Pro', 49.99, 500, 3, '{"support": "email", "custom_csv": true}'),
                ('Estudio Enterprise', 199.99, 5000, 20, '{"support": "priority", "api_access": true}');
            `);
        }

        await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES plans(id) DEFAULT 1`);
        await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS notes TEXT`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS usage_logs (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id),
                action VARCHAR(100),
                provider VARCHAR(50),
                cost_est DECIMAL(10,5),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('--- Migracion completada: estructura SaaS nivel 2.0 lista ---');
    } catch (err) {
        console.error('Error en migracion:', err);
    } finally {
        await client.end();
    }
}

migrateSaaSEnterprise();
