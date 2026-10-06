// ======================================================
// MONITOR DE VARIABLES: ALMACENAMIENTO
// ======================================================
//
// Base propia (data/monitor.db), separada de recetas.db: el registro de
// eventos puede crecer rápido y así no compite por bloqueos con el resto
// del programa. Entra en cada backup (monitor_AAAAMMDD_HHMMSS.db) junto
// con la base principal: ver respaldar().

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const carpeta = path.join(__dirname, '..', 'data');
fs.mkdirSync(carpeta, { recursive: true });

const db = new sqlite3.Database(path.join(carpeta, 'monitor.db'));

// Hora local del servidor como 'YYYY-MM-DD HH:MM:SS' (no UTC).
function fechaLocal(fecha = new Date()) {

    const dos = n => String(n).padStart(2, '0');

    return fecha.getFullYear() + '-' + dos(fecha.getMonth() + 1) + '-' + dos(fecha.getDate()) +
        ' ' + dos(fecha.getHours()) + ':' + dos(fecha.getMinutes()) + ':' + dos(fecha.getSeconds());
}

const ejecutar = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this);
    });
});

const todos = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, filas) => err ? reject(err) : resolve(filas));
});

const uno = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, fila) => err ? reject(err) : resolve(fila));
});

const lista = (async () => {

    await ejecutar(`
        CREATE TABLE IF NOT EXISTS variables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            tipo TEXT NOT NULL,
            activo INTEGER NOT NULL DEFAULT 1,
            ip TEXT,
            puerto INTEGER,
            unit_id INTEGER,
            funcion TEXT,
            direccion INTEGER,
            formato TEXT,
            broker TEXT,
            topico TEXT,
            campo TEXT,
            intervalo_ms INTEGER NOT NULL DEFAULT 1000,
            banda REAL NOT NULL DEFAULT 0,
            timeout_s INTEGER NOT NULL DEFAULT 0,
            estado TEXT,
            estado_desde TEXT,
            ultimo_valor TEXT,
            ultimo_cambio TEXT,
            creada TEXT NOT NULL
        )
    `);

    await ejecutar(`
        CREATE TABLE IF NOT EXISTS eventos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            variable_id INTEGER NOT NULL,
            variable_nombre TEXT NOT NULL,
            fecha_hora TEXT NOT NULL,
            tipo TEXT NOT NULL,
            valor_anterior TEXT,
            valor_nuevo TEXT,
            detalle TEXT
        )
    `);

    await ejecutar(`CREATE INDEX IF NOT EXISTS idx_eventos_fecha ON eventos (fecha_hora)`);
    await ejecutar(`CREATE INDEX IF NOT EXISTS idx_eventos_variable ON eventos (variable_id, fecha_hora)`);

    // Historial de la conexión al SQL Server, por capas (ver sql-pool.js): una
    // fila por minuto como mínimo y todas las que salieron lentas o con error.
    await ejecutar(`
        CREATE TABLE IF NOT EXISTS sql_latidos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            epoch INTEGER NOT NULL,
            fecha_hora TEXT NOT NULL,
            servicio TEXT NOT NULL,
            tipo TEXT NOT NULL,
            fase TEXT,
            tcp_ms INTEGER,
            consulta_ms INTEGER,
            login_ms INTEGER,
            error TEXT
        )
    `);

    await ejecutar(`CREATE INDEX IF NOT EXISTS idx_sql_latidos_epoch ON sql_latidos (epoch)`);

})();

lista.catch(err => console.error('Monitor: error creando las tablas:', err));

// Campos de la configuración de una variable (lo único que se puede
// escribir desde afuera).
const CAMPOS_CONFIG = [
    'nombre', 'tipo', 'activo',
    'ip', 'puerto', 'unit_id', 'funcion', 'direccion', 'formato',
    'broker', 'topico', 'campo',
    'intervalo_ms', 'banda', 'timeout_s'
];

function soloConfig(datos) {

    const limpio = {};

    for (const campo of CAMPOS_CONFIG) {
        if (datos[campo] !== undefined) {
            limpio[campo] = datos[campo];
        }
    }

    return limpio;
}

async function listarVariables() {
    await lista;
    return todos(`SELECT * FROM variables ORDER BY nombre COLLATE NOCASE, id`);
}

async function obtenerVariable(id) {
    await lista;
    return uno(`SELECT * FROM variables WHERE id = ?`, [id]);
}

async function crearVariable(datos) {

    await lista;

    const campos = { ...soloConfig(datos), creada: fechaLocal() };
    const columnas = Object.keys(campos);

    const resultado = await ejecutar(
        `INSERT INTO variables (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
        columnas.map(c => campos[c])
    );

    return resultado.lastID;
}

// Al editar se reinicia el estado guardado: si cambió la dirección o la IP,
// el valor viejo no tiene que compararse contra el nuevo.
async function actualizarVariable(id, datos) {

    await lista;

    const campos = {
        ...soloConfig(datos),
        estado: null,
        estado_desde: null,
        ultimo_valor: null,
        ultimo_cambio: null
    };

    const columnas = Object.keys(campos);

    await ejecutar(
        `UPDATE variables SET ${columnas.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...columnas.map(c => campos[c]), id]
    );
}

async function cambiarActiva(id, activo) {
    await lista;
    await ejecutar(`UPDATE variables SET activo = ? WHERE id = ?`, [activo ? 1 : 0, id]);
}

async function borrarVariable(id, borrarEventos) {

    await lista;

    await ejecutar(`DELETE FROM variables WHERE id = ?`, [id]);

    if (borrarEventos) {
        await ejecutar(`DELETE FROM eventos WHERE variable_id = ?`, [id]);
    }
}

async function guardarEstado(id, { estado, estado_desde, ultimo_valor, ultimo_cambio }) {

    await lista;

    await ejecutar(
        `UPDATE variables SET estado = ?, estado_desde = ?, ultimo_valor = ?, ultimo_cambio = ? WHERE id = ?`,
        [estado, estado_desde, ultimo_valor, ultimo_cambio, id]
    );
}

async function registrarEvento({ variable_id, variable_nombre, fecha_hora, tipo, valor_anterior, valor_nuevo, detalle }) {

    await lista;

    await ejecutar(
        `INSERT INTO eventos (variable_id, variable_nombre, fecha_hora, tipo, valor_anterior, valor_nuevo, detalle)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [variable_id, variable_nombre, fecha_hora, tipo, valor_anterior ?? null, valor_nuevo ?? null, detalle ?? null]
    );
}

async function listarEventos({ variableId, tipo, desde, hasta, limite }) {

    await lista;

    let sql = `SELECT id, variable_id, variable_nombre, fecha_hora, tipo, valor_anterior, valor_nuevo, detalle
               FROM eventos WHERE 1 = 1`;
    const params = [];

    if (variableId) {
        sql += ` AND variable_id = ?`;
        params.push(variableId);
    }

    if (tipo) {
        sql += ` AND tipo = ?`;
        params.push(tipo);
    }

    if (desde) {
        sql += ` AND fecha_hora >= ?`;
        params.push(desde + ' 00:00:00');
    }

    if (hasta) {
        sql += ` AND fecha_hora <= ?`;
        params.push(hasta + ' 23:59:59');
    }

    sql += ` ORDER BY fecha_hora DESC, id DESC LIMIT ?`;
    params.push(limite);

    return todos(sql, params);
}

// Copia consistente de la base (VACUUM INTO funciona aunque se esté
// escribiendo en simultáneo, a diferencia de copiar el archivo a mano).
// El archivo de destino no debe existir.
async function respaldar(rutaDestino) {

    await lista;

    await ejecutar(`VACUUM INTO ?`, [rutaDestino]);
}

// Cantidad de eventos por tipo desde una fecha local 'YYYY-MM-DD HH:MM:SS'.
async function contarEventosDesde(desde) {

    await lista;

    return todos(
        `SELECT tipo, COUNT(*) AS cantidad FROM eventos WHERE fecha_hora >= ? GROUP BY tipo`,
        [desde]
    );
}

async function totalEventos() {

    await lista;

    const fila = await uno(`SELECT COUNT(*) AS cantidad FROM eventos`);

    return fila ? fila.cantidad : 0;
}

// Una medición de la conexión al SQL Server (ver sql-pool.js). `servicio` es
// 'PH' (lectura: Visor PH y Energía) o 'ensayos' (escritura de ensayos).
async function registrarLatidoSql(servicio, m) {

    await lista;

    await ejecutar(
        `INSERT INTO sql_latidos (epoch, fecha_hora, servicio, tipo, fase, tcp_ms, consulta_ms, login_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.t, fechaLocal(new Date(m.t)), servicio, m.tipo, m.fase || null, m.tcpMs, m.consultaMs, m.loginMs, m.error]
    );
}

async function listarLatidosSql({ desde, hasta, limite = 30000 }) {

    await lista;

    return todos(
        `SELECT epoch, fecha_hora, servicio, tipo, fase, tcp_ms, consulta_ms, login_ms, error
         FROM sql_latidos WHERE epoch >= ? AND epoch <= ? ORDER BY epoch ASC LIMIT ?`,
        [desde, hasta, limite]
    );
}

async function purgarLatidosSql(dias) {

    await lista;

    const resultado = await ejecutar(`DELETE FROM sql_latidos WHERE epoch < ?`, [Date.now() - dias * 24 * 60 * 60 * 1000]);

    return resultado.changes;
}

async function purgarEventosViejos(dias) {

    await lista;

    const limite = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

    const resultado = await ejecutar(`DELETE FROM eventos WHERE fecha_hora < ?`, [fechaLocal(limite)]);

    return resultado.changes;
}

module.exports = {
    fechaLocal,
    listarVariables,
    obtenerVariable,
    crearVariable,
    actualizarVariable,
    cambiarActiva,
    borrarVariable,
    guardarEstado,
    registrarEvento,
    listarEventos,
    respaldar,
    registrarLatidoSql,
    listarLatidosSql,
    purgarLatidosSql,
    contarEventosDesde,
    totalEventos,
    purgarEventosViejos
};
