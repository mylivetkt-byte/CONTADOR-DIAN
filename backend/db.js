const { Pool } = require('pg');
require('dotenv').config();

// Configuramos la conexion a PostgreSQL
// Usa la variable DATABASE_URL de tu .env, ejemplo: 
// DATABASE_URL=postgres://usuario:contraseña@localhost:5432/contador_db
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') 
    ? { rejectUnauthorized: false } 
    : false
});

pool.on('error', (err, client) => {
  console.error('Error inesperado en el cliente PostgreSQL', err);
  process.exit(-1);
});

// Funcion helper para realizar queries fácilmente
const query = async (text, params) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log(`[DB Query] ejecutado en ${duration}ms: ${text.slice(0, 50)}...`);
  return res;
};

module.exports = {
  query,
  pool
};
