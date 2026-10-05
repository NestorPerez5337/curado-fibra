// ======================================================
// CONEXIÓN A SQL SERVER (ENSAYOS PH, SOLO LECTURA)
// ======================================================
//
// Si el SQL Server no responde o faltan las variables de entorno, solo falla
// el Visor PH (y Consumos de Energía, que usa esta misma conexión) y el resto
// del programa (PLC, compresores, horómetros) sigue funcionando igual. Los
// intentos de conexión corren en segundo plano y nunca frenan el arranque.

const sql = require('mssql');
const { crearGestorPool } = require('../sql-pool');

function estaConfigurado() {
    return !!(process.env.PH_SQL_SERVER && process.env.PH_SQL_USER && process.env.PH_SQL_PASSWORD);
}

function configuracion() {

    const config = {
        server: process.env.PH_SQL_SERVER,
        database: process.env.PH_SQL_DATABASE || 'Automatizacion',
        user: process.env.PH_SQL_USER,
        password: process.env.PH_SQL_PASSWORD,
        // El SQL Server a veces tarda varios segundos en aceptar conexiones.
        connectionTimeout: 15000,
        requestTimeout: 30000,
        // Las conexiones sin uso se cierran a los 20 s: así no queda una vieja
        // que un firewall ya cortó. Reconectar es rápido (ver ../sql-pool.js).
        pool: { max: 5, min: 0, idleTimeoutMillis: 20000 },
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

// El pool lo maneja ../sql-pool.js: mantiene una conexión viva con un latido
// cada 15 s, falla al instante si el SQL Server no responde y recuerda el
// puerto de la instancia. Para quien consulta, obtenerPool() sigue siendo lo mismo.
const gestor = crearGestorPool({
    nombre: 'PH',
    estaConfigurado,
    configuracion,
    faltante: 'Faltan las variables PH_SQL_* para conectar al SQL Server'
});

gestor.iniciar();

const obtenerPool = gestor.obtenerPool;

// Errores de red / conexión (no de la consulta en sí): vale la pena
// reintentar, o avisar "sin conexión" en vez de "error".
const CODIGOS_CONEXION = ['ESOCKET', 'ETIMEOUT', 'ECONNCLOSED', 'EINSTLOOKUP', 'ENOTOPEN', 'ECONNRESET'];

function esErrorDeConexion(err) {
    return !!err && (CODIGOS_CONEXION.includes(err.code) || err.name === 'ConnectionError');
}

module.exports = {
    sql,
    obtenerPool,
    estaConfigurado,
    esErrorDeConexion,
    // para el panel de Estado del Sistema
    probar: gestor.probar,
    estadoConexion: gestor.estado,
    descripcionCortes: gestor.descripcionCortes
};
