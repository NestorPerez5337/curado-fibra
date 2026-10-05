// ======================================================
// ENSAYOS DE PRESIÓN: GUARDADO EN SQL SERVER
// ======================================================
//
// Guarda cada ensayo en Bursting_Maestro (una fila por ensayo) y
// Bursting_Detalle (una lectura de presión por segundo), la misma
// estructura que PH1/PH2/PH9 en la base Automatizacion.
//
// Usa su propia cuenta (ENSAYOS_SQL_USER / ENSAYOS_SQL_PASSWORD) con permiso
// de escritura, distinta de la cuenta de solo lectura del Visor PH. El servidor,
// la instancia y la base son los mismos (PH_SQL_SERVER / INSTANCE / DATABASE).
//
// La conexión se abre recién cuando hace falta: si el SQL Server no responde
// solo falla este guardado (se reintenta solo) y el resto del programa sigue.

const sql = require('mssql');

let poolPromise = null;

function estaConfigurado() {
    return !!(process.env.PH_SQL_SERVER && process.env.ENSAYOS_SQL_USER && process.env.ENSAYOS_SQL_PASSWORD);
}

function configuracion() {

    const config = {
        server: process.env.PH_SQL_SERVER,
        database: process.env.PH_SQL_DATABASE || 'Automatizacion',
        user: process.env.ENSAYOS_SQL_USER,
        password: process.env.ENSAYOS_SQL_PASSWORD,
        connectionTimeout: 15000,
        requestTimeout: 30000,
        pool: { max: 2, min: 0, idleTimeoutMillis: 60000 },
        options: {
            encrypt: false,
            trustServerCertificate: true,
            // Las fechas se guardan en hora local de la planta, como hace Node-RED.
            useUTC: false
        }
    };

    if (process.env.PH_SQL_PORT) {
        config.port = parseInt(process.env.PH_SQL_PORT, 10);
    } else if (process.env.PH_SQL_INSTANCE) {
        config.options.instanceName = process.env.PH_SQL_INSTANCE;
    }

    return config;
}

function obtenerPool() {

    if (!estaConfigurado()) {
        return Promise.reject(new Error('Faltan las variables ENSAYOS_SQL_* para conectar al SQL Server'));
    }

    if (!poolPromise) {

        const pool = new sql.ConnectionPool(configuracion());

        // Si la conexión se cae, descartamos el pool para que el próximo
        // intento reconecte en vez de quedar roto para siempre.
        pool.on('error', err => {
            console.error('SQL ensayos: error en la conexión:', err.message);
            poolPromise = null;
        });

        poolPromise = pool.connect().catch(err => {
            poolPromise = null;
            throw err;
        });
    }

    return poolPromise;
}

// Guarda el ensayo completo (maestro + todas las lecturas) en una sola
// transacción: o queda entero o no queda nada. Si el mismo ensayo (OP,
// caño y fecha) ya estaba guardado devuelve su id sin duplicarlo, así un
// reintento después de un corte no genera filas repetidas.
//
// Las lecturas se toman una por segundo y la fecha del ensayo es la del
// fin de la prueba, así que la hora de cada lectura se calcula hacia atrás
// desde ahí.
async function guardarEnsayo({ op, cano, fecha, muestras }) {

    const pool = await obtenerPool();
    const transaccion = new sql.Transaction(pool);

    await transaccion.begin();

    try {

        const existente = await new sql.Request(transaccion)
            .input('op', sql.NVarChar(25), op)
            .input('cano', sql.NVarChar(25), cano)
            .input('fecha', sql.DateTime, fecha)
            .query(`SELECT TOP 1 Id FROM dbo.Bursting_Maestro
                    WHERE NumeroOP = @op AND NumeroCano = @cano AND FechaEnsayo = @fecha`);

        if (existente.recordset.length > 0) {
            await transaccion.commit();
            return existente.recordset[0].Id;
        }

        const maestro = await new sql.Request(transaccion)
            .input('op', sql.NVarChar(25), op)
            .input('cano', sql.NVarChar(25), cano)
            .input('minimo', sql.Decimal(10, 2), Math.min(...muestras))
            .input('maximo', sql.Decimal(10, 2), Math.max(...muestras))
            .input('fecha', sql.DateTime, fecha)
            .query(`INSERT INTO dbo.Bursting_Maestro (NumeroOP, NumeroCano, PresionMin, PresionMax, FechaEnsayo)
                    OUTPUT INSERTED.Id
                    VALUES (@op, @cano, @minimo, @maximo, @fecha)`);

        const idMaestro = maestro.recordset[0].Id;

        const detalle = new sql.Table('dbo.Bursting_Detalle');
        detalle.create = false;
        detalle.columns.add('Id_Maestro', sql.Int, { nullable: false });
        detalle.columns.add('Presion', sql.Decimal(18, 2), { nullable: true });
        detalle.columns.add('FechaHora', sql.DateTime, { nullable: true });

        muestras.forEach((presion, i) => {
            const segundosAntesDelFin = muestras.length - 1 - i;
            detalle.rows.add(idMaestro, presion, new Date(fecha.getTime() - segundosAntesDelFin * 1000));
        });

        await new sql.Request(transaccion).bulk(detalle);

        await transaccion.commit();

        return idMaestro;

    } catch (err) {

        try {
            await transaccion.rollback();
        } catch {
            // la transacción ya estaba cerrada por el error de conexión
        }

        throw err;
    }
}

// Prueba la conexión con una consulta mínima (la usa el panel de Estado del
// Sistema). Devuelve cuántos ms tardó; si no responde, lanza el error.
async function probar() {

    const pool = await obtenerPool();

    const inicio = Date.now();

    await pool.request().query('SELECT 1 AS ok');

    return Date.now() - inicio;
}

module.exports = { estaConfigurado, guardarEnsayo, probar };
