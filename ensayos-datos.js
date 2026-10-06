// ======================================================
// ENSAYOS DE PRESIÓN: DATOS GUARDADOS + PDF BAJO DEMANDA
// ======================================================
//
// Cada ensayo guarda en la base sus muestras de presión (unos pocos KB). Las
// muestras se guardan A MEDIDA QUE SE TOMAN (ver "ensayo en curso"), así un
// reinicio del programa en pleno ensayo no las pierde. El PDF NO se genera
// solo: se arma en el momento, desde esas muestras, cuando el usuario aprieta
// "Generar PDF" en el Visor de Ensayos, y se descarga sin guardarse en el
// servidor. Así no se acumulan archivos en el disco.
//
// Se monta desde server.js con:
//   const ensayosDatos = require('./ensayos-datos')({ db });
//   ensayosDatos.montarRutas(app, { requierePermiso });
//
// El almacenamiento está acá adentro (SQLite). Para pasarlo a SQL Server
// alcanza con reemplazar guardarEnsayo / listarEnsayos / obtenerEnsayo.

const PDFDocument = require('pdfkit');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const ChartDataLabels = require('chartjs-plugin-datalabels');
const ensayosSql = require('./ensayos-sql');

const chartCanvas = new ChartJSNodeCanvas({
    width: 1200,
    height: 600,
    chartCallback: (ChartJS) => {
        ChartJS.register(ChartDataLabels);
    }
});

// Hora LOCAL del servidor como 'YYYY-MM-DD HH:MM:SS'. No usamos
// CURRENT_TIMESTAMP de SQLite ni toISOString() porque ambos dan UTC.
function fechaLocal(fecha) {

    const dos = n => String(n).padStart(2, '0');

    return fecha.getFullYear() + '-' + dos(fecha.getMonth() + 1) + '-' + dos(fecha.getDate()) +
        ' ' + dos(fecha.getHours()) + ':' + dos(fecha.getMinutes()) + ':' + dos(fecha.getSeconds());
}

function dateDesdeFechaLocal(texto) {
    return new Date(texto.replace(' ', 'T'));
}

// Armar un PDF dibuja un gráfico y usa bastante memoria: si varias personas
// piden uno a la vez, se hacen de a uno (los demás esperan su turno) en vez de
// cargar al servidor con varios en paralelo.
let colaPdf = Promise.resolve();

function enCola(tarea) {

    const resultado = colaPdf.then(tarea);

    colaPdf = resultado.catch(() => {});

    return resultado;
}

function nombreArchivoPdf(op, cano, fechaTexto) {

    const limpiar = v => String(v).replace(/[^\w-]/g, '_');
    const compacta = fechaTexto.replace(/[-: ]/g, '');

    return `OP_${limpiar(op)}_CANO_${limpiar(cano)}_${compacta.slice(0, 8)}_${compacta.slice(8, 14)}.pdf`;
}

// ======================================================
// PDF (mismo diseño que tenían los PDF automáticos de antes)
// ======================================================

async function generarPdfEnsayo({ op, cano, fecha, muestras }) {

    const labels = muestras.map((_, i) => i.toFixed(1));

    const configuration = {
        type: 'line',

        data: {
            labels,

            datasets: [{
                label: 'Presión',
                data: muestras,

                borderWidth: 2,
                fill: false,
                tension: 0.1,

                pointRadius: 5,
                pointHoverRadius: 5
            }]
        },

        options: {

            responsive: false,

            plugins: {

                title: {
                    display: true,
                    text: `Ensayo OP ${op} - Caño ${cano}`
                },

                datalabels: {

                    color: 'black',

                    anchor: 'end',

                    align: 'top',

                    offset: 8,

                    rotation: -90,

                    font: {
                        size: 8,
                        weight: 'bold'
                    },

                    formatter: value => value
                }
            },

            scales: {

                x: {
                    title: {
                        display: true,
                        text: 'Tiempo (s)'
                    }
                },

                y: {
                    title: {
                        display: true,
                        text: 'Presión'
                    }
                }
            }
        },

        plugins: [ChartDataLabels]
    };

    const imageBuffer = await chartCanvas.renderToBuffer(configuration);

    return new Promise((resolve, reject) => {

        const doc = new PDFDocument({
            margin: 30
        });

        const trozos = [];

        doc.on('data', t => trozos.push(t));
        doc.on('end', () => resolve(Buffer.concat(trozos)));
        doc.on('error', reject);

        doc.fontSize(22)
            .text('ENSAYO DE PRESIÓN', {
                align: 'center'
            });

        doc.moveDown();

        doc.fontSize(14)
            .text(`OP: ${op}`);

        doc.text(`Caño: ${cano}`);

        doc.text(`Fecha: ${fecha.toLocaleString()}`);

        doc.text(`Muestras: ${muestras.length}`);

        doc.moveDown();

        doc.image(imageBuffer, {
            fit: [520, 320],
            align: 'center'
        });

        doc.end();
    });
}

// ======================================================
// ALMACENAMIENTO
// ======================================================

module.exports = function crearEnsayosDatos({ db }) {

    const ejecutar = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });

    const consultarTodos = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, filas) => err ? reject(err) : resolve(filas));
    });

    const consultarUno = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, fila) => err ? reject(err) : resolve(fila));
    });

    // estado: 'completo' (el ensayo terminó normalmente) o 'interrumpido' (el
    // programa se reinició o se cayó en pleno ensayo: quedaron las muestras
    // tomadas hasta ese momento; no se sube a SQL Server).
    const tablaLista = ejecutar(`
        CREATE TABLE IF NOT EXISTS ensayos_datos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            op TEXT NOT NULL,
            cano TEXT NOT NULL,
            fecha TEXT NOT NULL,
            cantidad INTEGER NOT NULL,
            muestras TEXT NOT NULL,
            archivo TEXT,
            sincronizado INTEGER NOT NULL DEFAULT 0,
            sql_id INTEGER,
            estado TEXT NOT NULL DEFAULT 'completo'
        )
    `).then(() => ejecutar(
        `CREATE INDEX IF NOT EXISTS idx_ensayos_datos_fecha ON ensayos_datos (fecha)`
    )).then(async () => {

        // Base creada por una versión anterior: se le agrega la columna "estado"
        const columnas = await consultarTodos(`PRAGMA table_info(ensayos_datos)`);

        if (!columnas.some(c => c.name === 'estado')) {
            await ejecutar(`ALTER TABLE ensayos_datos ADD COLUMN estado TEXT NOT NULL DEFAULT 'completo'`);
        }

    }).then(() => ejecutar(`
        CREATE TABLE IF NOT EXISTS ensayo_en_curso (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            op TEXT NOT NULL,
            cano TEXT NOT NULL,
            inicio TEXT NOT NULL,
            actualizado INTEGER NOT NULL,
            cantidad INTEGER NOT NULL,
            muestras TEXT NOT NULL
        )
    `));

    tablaLista.catch(err => console.error('Error creando las tablas de ensayos:', err));

    async function guardarEnsayo({ op, cano, fecha, muestras, estado = 'completo' }) {

        await tablaLista;

        const resultado = await ejecutar(
            `INSERT INTO ensayos_datos (op, cano, fecha, cantidad, muestras, estado)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [String(op), String(cano), fechaLocal(fecha), muestras.length, JSON.stringify(muestras), estado]
        );

        return resultado.lastID;
    }

    // ==================================================
    // ENSAYO EN CURSO: las muestras se guardan a medida que se toman
    // ==================================================
    // Mientras corre el ensayo, la fila única de ensayo_en_curso se actualiza en
    // cada muestra. Si el programa se reinicia o se cae a mitad del ensayo
    // (por ejemplo cuando Portainer redeploya), al arrancar se rescata lo que
    // había: queda guardado como ensayo "interrumpido" en vez de perderse.
    // Al terminar normalmente, el ensayo se guarda completo y esta fila se borra.
    //
    // Todas las operaciones sobre esta tabla se hacen en fila, una detrás de
    // otra, para que ninguna pise a la anterior (ej.: una actualización
    // atrasada no puede reaparecer después de cerrar el ensayo).

    let colaEnCurso = Promise.resolve();

    function enColaEnCurso(tarea) {

        const resultado = colaEnCurso.then(tarea);

        colaEnCurso = resultado.catch(() => {});

        return resultado;
    }

    // Si quedó un ensayo a medias lo guarda como "interrumpido" y limpia la
    // fila. Devuelve lo que rescató, o null si no había nada.
    async function rescatarEnCurso(motivo) {

        await tablaLista;

        const fila = await consultarUno(`SELECT * FROM ensayo_en_curso WHERE id = 1`);

        if (!fila) {
            return null;
        }

        let muestras = [];

        try {
            muestras = JSON.parse(fila.muestras);
        } catch {
            console.error('El avance del ensayo en curso estaba dañado: no se pudo recuperar.');
        }

        // ¿Ya se guardó completo? (el programa se cayó justo después de guardarlo
        // y antes de borrar el avance): entonces no hay nada que rescatar.
        const yaGuardado = await consultarUno(
            `SELECT id FROM ensayos_datos WHERE op = ? AND cano = ? AND estado = 'completo' AND fecha >= ?`,
            [fila.op, fila.cano, fila.inicio]
        );

        let id = null;

        if (!yaGuardado && muestras.length > 0) {

            id = await guardarEnsayo({
                op: fila.op,
                cano: fila.cano,
                fecha: new Date(fila.actualizado),
                muestras,
                estado: 'interrumpido'
            });

            console.warn(
                `⚠️ Se rescató un ensayo que quedó a medias (OP ${fila.op}, Caño ${fila.cano}, ${muestras.length} muestras, ` +
                `${motivo}). Quedó guardado como INTERRUMPIDO (ensayo ${id}) y no se sube a SQL Server.`
            );
        }

        await ejecutar(`DELETE FROM ensayo_en_curso WHERE id = 1`);

        return { id, op: fila.op, cano: fila.cano, muestras: muestras.length };
    }

    // Al arrancar el programa: lo que haya quedado de una ejecución anterior
    const rescateInicial = enColaEnCurso(() => rescatarEnCurso('el programa se reinició durante el ensayo'))
        .catch(err => console.error('No se pudo rescatar el ensayo que había quedado en curso:', err.message));

    function iniciarEnCurso({ op, cano }) {

        return enColaEnCurso(async () => {

            await rescateInicial;

            // Si el ensayo anterior no se llegó a cerrar bien, se rescata antes de empezar el nuevo
            await rescatarEnCurso('no llegó a cerrarse antes de empezar otro ensayo');

            const ahora = Date.now();

            await ejecutar(
                `INSERT INTO ensayo_en_curso (id, op, cano, inicio, actualizado, cantidad, muestras)
                 VALUES (1, ?, ?, ?, ?, 0, '[]')`,
                [String(op), String(cano), fechaLocal(new Date(ahora)), ahora]
            );
        });
    }

    // Se llama en cada muestra. No hace esperar al que llama; si falla solo se avisa.
    function actualizarEnCurso(muestras) {

        const json = JSON.stringify(muestras);
        const cantidad = muestras.length;
        const ahora = Date.now();

        enColaEnCurso(() => ejecutar(
            `UPDATE ensayo_en_curso SET muestras = ?, cantidad = ?, actualizado = ? WHERE id = 1`,
            [json, cantidad, ahora]
        )).catch(err => console.error('No se pudo guardar el avance del ensayo en curso:', err.message));
    }

    // El ensayo terminó y ya se guardó completo: se borra el avance
    function cerrarEnCurso() {

        return enColaEnCurso(() => ejecutar(`DELETE FROM ensayo_en_curso WHERE id = 1`));
    }

    async function obtenerEnCurso() {

        await tablaLista;

        return consultarUno(`SELECT op, cano, inicio, actualizado, cantidad FROM ensayo_en_curso WHERE id = 1`);
    }

    // Sube a SQL Server los ensayos que todavía no están ahí. Esta base
    // local es la que manda: el ensayo se guarda acá primero y, si el SQL
    // Server no responde, queda pendiente y se reintenta solo (cada 5
    // minutos y al arrancar), así un corte no pierde ningún ensayo.
    // Nunca lanza error: lo que falle se loguea y queda para el próximo intento.
    let sincronizando = false;

    // Qué pasó en la última vuelta de subida (lo muestra el panel de Estado
    // del Sistema). Los tiempos son epoch en ms.
    const estadoSync = { ultimoIntento: null, ultimoOk: null, ultimoError: null };

    // Los ensayos "interrumpidos" (quedaron a medias por un reinicio) no se
    // suben: sus datos están incompletos. Devuelve { subidos, pendientes, error }
    // (error = null si todo salió bien).
    async function sincronizar() {

        if (!ensayosSql.estaConfigurado()) {
            return { subidos: 0, pendientes: await contarPendientes(), error: 'SQL Server sin configurar' };
        }

        if (sincronizando) {
            return { subidos: 0, pendientes: await contarPendientes(), error: 'Ya hay una subida en curso' };
        }

        sincronizando = true;
        estadoSync.ultimoIntento = Date.now();

        let subidos = 0;
        let error = null;

        try {

            await tablaLista;

            for (;;) {

                const pendientes = await consultarTodos(
                    `SELECT id, op, cano, fecha, muestras FROM ensayos_datos
                     WHERE sincronizado = 0 AND estado = 'completo' ORDER BY id LIMIT 20`
                );

                if (pendientes.length === 0) {
                    break;
                }

                for (const fila of pendientes) {

                    const sqlId = await ensayosSql.guardarEnsayo({
                        op: fila.op,
                        cano: fila.cano,
                        fecha: dateDesdeFechaLocal(fila.fecha),
                        muestras: JSON.parse(fila.muestras)
                    });

                    await ejecutar(
                        `UPDATE ensayos_datos SET sincronizado = 1, sql_id = ? WHERE id = ?`,
                        [sqlId, fila.id]
                    );

                    subidos++;

                    console.log(`Ensayo OP ${fila.op} Caño ${fila.cano} guardado en SQL Server (id ${sqlId}).`);
                }
            }

            estadoSync.ultimoOk = Date.now();
            estadoSync.ultimoError = null;

        } catch (err) {

            error = err.message;
            estadoSync.ultimoError = err.message;

            console.error('No se pudo guardar el ensayo en SQL Server (se reintenta solo):', err.message);

        } finally {

            sincronizando = false;
        }

        return { subidos, pendientes: await contarPendientes(), error };
    }

    async function contarPendientes() {

        await tablaLista;

        const fila = await consultarUno(
            `SELECT COUNT(*) AS cantidad FROM ensayos_datos WHERE sincronizado = 0 AND estado = 'completo'`
        );

        return fila.cantidad;
    }

    if (ensayosSql.estaConfigurado()) {
        setTimeout(sincronizar, 30 * 1000).unref();
        setInterval(sincronizar, 5 * 60 * 1000).unref();
    }

    // Cuántos ensayos están esperando subir a SQL Server y desde cuándo.
    async function resumenSincronizacion() {

        await tablaLista;

        const fila = await consultarUno(
            `SELECT COUNT(*) AS pendientes, MIN(fecha) AS masAntiguo
             FROM ensayos_datos WHERE sincronizado = 0 AND estado = 'completo'`
        );

        const total = await consultarUno(`SELECT COUNT(*) AS cantidad FROM ensayos_datos`);

        const interrumpidos = await consultarUno(
            `SELECT COUNT(*) AS cantidad FROM ensayos_datos WHERE estado = 'interrumpido'`
        );

        return {
            configurado: ensayosSql.estaConfigurado(),
            total: total.cantidad,
            pendientes: fila.pendientes,
            masAntiguo: fila.masAntiguo,
            interrumpidos: interrumpidos.cantidad,
            enCurso: await obtenerEnCurso(),
            ...estadoSync
        };
    }

    async function listarEnsayos() {

        await tablaLista;

        return consultarTodos(
            `SELECT id, op, cano, fecha, cantidad, archivo, estado, sincronizado, sql_id
             FROM ensayos_datos
             ORDER BY fecha DESC, id DESC
             LIMIT 5000`
        );
    }

    async function obtenerEnsayo(id) {

        await tablaLista;

        const fila = await consultarUno(`SELECT * FROM ensayos_datos WHERE id = ?`, [id]);

        if (!fila) {
            return null;
        }

        return { ...fila, muestras: JSON.parse(fila.muestras) };
    }

    // ==================================================
    // RUTAS
    // ==================================================

    function montarRutas(app, { requierePermiso, registrarLog }) {

        const permiso = requierePermiso('visor');

        const leerId = req => /^\d{1,9}$/.test(req.params.id) ? parseInt(req.params.id, 10) : null;

        app.get('/api/ensayos-datos', permiso, async (req, res) => {

            try {
                res.json(await listarEnsayos());
            } catch (err) {
                console.error('Error listando ensayos guardados:', err);
                res.status(500).send('Error');
            }
        });

        // Estado de la subida a SQL Server y ensayo en curso (para el Visor de Ensayos).
        // Va antes de /:id para que "resumen" no se tome como un id.
        app.get('/api/ensayos-datos/resumen', permiso, async (req, res) => {

            try {

                const r = await resumenSincronizacion();

                res.json({
                    configurado: r.configurado,
                    total: r.total,
                    pendientes: r.pendientes,
                    masAntiguo: r.masAntiguo,
                    interrumpidos: r.interrumpidos,
                    enCurso: r.enCurso,
                    ultimoError: r.ultimoError,
                    ahora: Date.now()
                });

            } catch (err) {
                console.error('Error leyendo el estado de los ensayos:', err);
                res.status(500).send('Error');
            }
        });

        // "Subir pendientes ahora": no espera a la subida automática (cada 5 minutos)
        app.post('/api/ensayos-datos/sincronizar', permiso, async (req, res) => {

            try {

                const r = await sincronizar();

                if (registrarLog && r.subidos > 0) {
                    registrarLog(req, 'ensayos', `Subió ${r.subidos} ensayo(s) pendiente(s) a SQL Server desde el Visor de Ensayos`);
                }

                res.json(r);

            } catch (err) {
                console.error('Error subiendo ensayos pendientes:', err);
                res.status(500).send('Error');
            }
        });

        app.get('/api/ensayos-datos/:id', permiso, async (req, res) => {

            const id = leerId(req);

            if (id === null) {
                return res.status(400).send('Id inválido');
            }

            try {

                const ensayo = await obtenerEnsayo(id);

                if (!ensayo) {
                    return res.status(404).send('Ensayo no encontrado');
                }

                res.json(ensayo);

            } catch (err) {
                console.error('Error leyendo ensayo guardado:', err);
                res.status(500).send('Error');
            }
        });

        app.get('/api/ensayos-datos/:id/pdf', permiso, async (req, res) => {

            const id = leerId(req);

            if (id === null) {
                return res.status(400).send('Id inválido');
            }

            try {

                const ensayo = await obtenerEnsayo(id);

                if (!ensayo) {
                    return res.status(404).send('Ensayo no encontrado');
                }

                const pdf = await enCola(() => generarPdfEnsayo({
                    op: ensayo.op,
                    cano: ensayo.cano,
                    fecha: dateDesdeFechaLocal(ensayo.fecha),
                    muestras: ensayo.muestras
                }));

                res.set({
                    'Content-Type': 'application/pdf',
                    'Content-Disposition': `attachment; filename="${nombreArchivoPdf(ensayo.op, ensayo.cano, ensayo.fecha)}"`
                });

                res.send(pdf);

            } catch (err) {
                console.error('Error generando el PDF del ensayo guardado:', err);
                res.status(500).send('Error generando el PDF');
            }
        });
    }

    return {
        guardarEnsayo,
        iniciarEnCurso,
        actualizarEnCurso,
        cerrarEnCurso,
        rescatarEnCurso: motivo => enColaEnCurso(() => rescatarEnCurso(motivo)),
        obtenerEnCurso,
        listarEnsayos,
        obtenerEnsayo,
        sincronizar,
        resumenSincronizacion,
        generarPdfEnsayo,
        nombreArchivoPdf,
        fechaLocal,
        montarRutas
    };
};
