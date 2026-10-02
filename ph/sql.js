// ======================================================
// CONEXIÓN A SQL SERVER (ENSAYOS PH, SOLO LECTURA)
// ======================================================
//
// La conexión se abre recién la primera vez que alguien usa el visor, no
// al arrancar la app: si el SQL Server no responde o faltan las variables
// de entorno, solo falla el Visor PH y el resto del programa (PLC,
// compresores, horómetros) sigue funcionando igual.

const sql = require('mssql');

let poolPromise = null;

function estaConfigurado() {
    return !!(process.env.PH_SQL_SERVER && process.env.PH_SQL_USER && process.env.PH_SQL_PASSWORD);
}

function configuracion() {

    const config = {
        server: process.env.PH_SQL_SERVER,
        database: process.env.PH_SQL_DATABASE || 'Automatizacion',
        user: process.env.PH_SQL_USER,
        password: process.env.PH_SQL_PASSWORD,
        connectionTimeout: 8000,
        requestTimeout: 30000,
        pool: { max: 5, min: 0, idleTimeoutMillis: 60000 },
        options: {
            encrypt: false,
            trustServerCertificate: true,
            // Node-RED guarda las fechas en hora local de la planta, no en UTC.
            useUTC: false
        }
    };

    // Con puerto fijo se usa ese; si no, la instancia con nombre
    // (la resuelve el servicio SQL Browser del servidor).
    if (process.env.PH_SQL_PORT) {
        config.port = parseInt(process.env.PH_SQL_PORT, 10);
    } else if (process.env.PH_SQL_INSTANCE) {
        config.options.instanceName = process.env.PH_SQL_INSTANCE;
    }

    return config;
}

function obtenerPool() {

    if (!estaConfigurado()) {
        return Promise.reject(new Error('Faltan las variables PH_SQL_* para conectar al SQL Server'));
    }

    if (!poolPromise) {

        const pool = new sql.ConnectionPool(configuracion());

        // Si la conexión se cae, descartamos el pool para que el próximo
        // pedido intente reconectar en vez de quedar roto para siempre.
        pool.on('error', err => {
            console.error('SQL PH: error en la conexión:', err.message);
            poolPromise = null;
        });

        poolPromise = pool.connect().catch(err => {
            poolPromise = null;
            throw err;
        });
    }

    return poolPromise;
}

module.exports = { sql, obtenerPool, estaConfigurado };
