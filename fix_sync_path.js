const { query } = require('./backend/db');

async function run() {
    try {
        const path = 'C:\\Users\\SERVIDO KNS PLUS\\Downloads\\PRUEBA IA';
        const name = 'Descargas PRUEBA IA';
        const companyId = 2; // Basado en los logs

        // Verificar si ya existe
        const { rows } = await query('SELECT id FROM local_sync_paths WHERE company_id = $1 AND path = $2', [companyId, path]);
        
        if (rows.length === 0) {
            await query('INSERT INTO local_sync_paths (company_id, path, name) VALUES ($1, $2, $3)', [companyId, path, name]);
            console.log('✅ Carpeta vinculada con éxito para la empresa 2.');
        } else {
            console.log('ℹ️ La carpeta ya estaba vinculada.');
        }
        process.exit(0);
    } catch (err) {
        console.error('❌ Error al vincular:', err.message);
        process.exit(1);
    }
}

run();
