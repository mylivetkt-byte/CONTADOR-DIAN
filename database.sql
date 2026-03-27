-- Tablas base para Contador SaaS Multiempresa

CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    plan_id INTEGER,
    next_billing_date DATE DEFAULT (CURRENT_DATE + INTERVAL '30 days'),
    nit VARCHAR(20) DEFAULT '',
    city VARCHAR(100) DEFAULT '',
    phone VARCHAR(20) DEFAULT '',
    email_contact VARCHAR(100) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'user',
    is_superadmin BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    session_version INTEGER DEFAULT 0,
    last_login_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plans (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    price_monthly DECIMAL(10,2) DEFAULT 0.00,
    max_documents_month INTEGER DEFAULT 10,
    max_docs_month INTEGER DEFAULT 10,
    max_users INTEGER DEFAULT 1,
    max_boxes INTEGER DEFAULT 1,
    features JSONB DEFAULT '{}',
    modules_json JSONB DEFAULT '{}',
    support_type VARCHAR(50) DEFAULT 'Email',
    api_access BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS configs (
    id SERIAL PRIMARY KEY,
    company_id INTEGER UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
    provider VARCHAR(50) DEFAULT 'gemini',
    gemini_api_key TEXT,
    groq_api_key TEXT,
    gemini_api_key_enc TEXT,
    groq_api_key_enc TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    filename VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255),
    source_path VARCHAR(500) DEFAULT '',
    status VARCHAR(50) DEFAULT 'pending',
    extracted_data JSONB,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    last_attempt_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS usage_logs (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(100),
    provider VARCHAR(50),
    cost_est DECIMAL(10,5),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    company_id INTEGER UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'active',
    plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    current_period_end DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50) DEFAULT '',
    target_id INTEGER,
    detail_json JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS password_resets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO plans (id, name, price_monthly, max_documents_month, max_docs_month, max_users, max_boxes, features, modules_json, support_type, api_access)
VALUES
    (1, 'Basico', 50000, 50, 50, 1, 1, '{"extraction": true}', '{"extraction": true}', 'Email', false),
    (2, 'Profesional', 150000, 1000, 1000, 5, 3, '{"extraction": true, "chat_ai": true, "excel": true}', '{"extraction": true, "chat_ai": true, "excel": true}', 'WhatsApp/Email', false),
    (3, 'Empresarial', 450000, 10000, 10000, 20, 10, '{"extraction": true, "chat_ai": true, "excel": true, "api": true}', '{"extraction": true, "chat_ai": true, "excel": true, "api": true}', 'Prioritario 24/7', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name) VALUES (1, 'Mi Empresa Demo') ON CONFLICT DO NOTHING;
INSERT INTO configs (company_id, provider) VALUES (1, 'gemini') ON CONFLICT DO NOTHING;
INSERT INTO subscriptions (company_id, status, plan_id, current_period_end) VALUES (1, 'active', 1, CURRENT_DATE + INTERVAL '30 days') ON CONFLICT (company_id) DO NOTHING;
