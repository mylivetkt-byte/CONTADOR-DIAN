const { Client } = require('pg');
require('dotenv').config();

async function migrateSaaSMaster() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });
    try {
        await client.connect();
        console.log('--- Reforzando estructura SaaS Master ---');

        await client.query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_boxes INTEGER DEFAULT 1`);
        await client.query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS modules_json JSONB DEFAULT '{}'`);
        await client.query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS support_type VARCHAR(50) DEFAULT 'Email'`);
        await client.query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS api_access BOOLEAN DEFAULT FALSE`);
        await client.query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_docs_month INTEGER DEFAULT 10`);

        await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS nit VARCHAR(20) DEFAULT ''`);
        await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT ''`);
        await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone VARCHAR(20) DEFAULT ''`);
        await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_contact VARCHAR(100) DEFAULT ''`);
        await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS start_date DATE DEFAULT CURRENT_DATE`);
        await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS total_boxes_used INTEGER DEFAULT 0`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS payments (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
                amount DECIMAL(10,2) NOT NULL,
                payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                method VARCHAR(50),
                period_months INTEGER DEFAULT 1,
                observation TEXT,
                created_by INTEGER REFERENCES users(id)
            );
        `);

        await client.query(`
            INSERT INTO plans (id, name, price_monthly, max_users, max_boxes, max_docs_month, modules_json, support_type, api_access)
            VALUES
            (1, 'Basico', 50000, 1, 1, 50, '{"extraction": true}', 'Email', false),
            (2, 'Profesional', 150000, 5, 3, 1000, '{"extraction": true, "chat_ai": true, "excel": true}', 'WhatsApp/Email', false),
            (3, 'Empresarial', 450000, 20, 10, 10000, '{"extraction": true, "chat_ai": true, "excel": true, "api": true}', 'Prioritario 24/7', true)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                price_monthly = EXCLUDED.price_monthly,
                max_users = EXCLUDED.max_users,
                max_boxes = EXCLUDED.max_boxes,
                max_docs_month = EXCLUDED.max_docs_month,
                support_type = EXCLUDED.support_type;
        `);

        console.log('--- Migracion SaaS Master exitosa ---');
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

migrateSaaSMaster();
