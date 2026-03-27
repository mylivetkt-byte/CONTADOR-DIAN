const { Client } = require('pg');
const fs = require('fs');
require('dotenv').config();

function getDatabaseUrl(dbName) {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL no esta definida.');
    }
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = `/${dbName}`;
    return url.toString();
}

async function createDatabase() {
    const defaultClient = new Client({
        connectionString: getDatabaseUrl('postgres')
    });

    try {
        await defaultClient.connect();
        const res = await defaultClient.query("SELECT datname FROM pg_database WHERE datname = 'contador_db'");
        if (res.rows.length === 0) {
            console.log("Creando base de datos 'contador_db'...");
            await defaultClient.query('CREATE DATABASE contador_db');
            console.log('Base de datos creada exitosamente.');
        } else {
            console.log("La base de datos 'contador_db' ya existe.");
        }
    } catch (err) {
        console.error('Error conectando a postgres default para crear la DB:', err);
    } finally {
        await defaultClient.end();
    }

    const targetClient = new Client({
        connectionString: getDatabaseUrl('contador_db')
    });

    try {
        await targetClient.connect();
        const sql = fs.readFileSync('e:\\contador\\database.sql', 'utf8');
        console.log('Ejecutando script de tablas...');
        await targetClient.query(sql);
        console.log('Tablas creadas exitosamente.');
        const { rows } = await targetClient.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
        console.log('Tablas actuales en contador_db:', rows.map(r => r.tablename).join(', '));
    } catch (err) {
        console.error('Error creando tablas en contador_db:', err);
    } finally {
        await targetClient.end();
    }
}

createDatabase();
