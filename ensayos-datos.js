// ======================================================
// ENSAYOS DE PRESIÓN: DATOS GUARDADOS + PDF BAJO DEMANDA
// ======================================================
//
// Cada ensayo guarda en la base sus muestras de presión (unos pocos KB). El
// PDF NO se genera solo: se arma en el momento, desde esas muestras, cuando el
// usuario aprieta "Generar PDF" en el Visor de Ensayos, y se descarga sin
// guardarse en el servidor. Así no se acumulan archivos en el disco.
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
            sql_id INTEGER
        )
    `).then(() => ejecutar(
        `CREATE INDEX IF NOT EXISTS idx_ensayos_datos_fecha ON ensayos_datos (fecha)`
    ));

    tablaLista.catch(err => console.error('Error creando la tabla ensayos_datos:', err));

    async function guardarEnsayo({ op, cano, fecha, muestras }) {

        await tablaLista;

        const resultado = await ejecutar(
            `INSERT INTO ensayos_datos (op, cano, fecha, cantidad, muestras)
             VALUES (?, ?, ?, ?, ?)`,
            [String(op), String(cano), fechaLocal(fecha), muestras.length, JSON.stringify(muestras)]
        );

        return resultado.lastID;
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

    async function sincronizar() {

        if (sincronizando || !ensayosSql.estaConfigurado()) {
            return;
        }

        sincronizando = true;
        estadoSync.ultimoIntento = Date.now();

        try {

            await tablaLista;

            for (;;) {

                const pendientes = await consultarTodos(
                    `SELECT id, op, cano, fecha, muestras FROM ensayos_datos
                     WHERE sincronizado = 0 ORDER BY id LIMIT 20`
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

                    console.log(`Ensayo OP ${fila.op} Caño ${fila.cano} guardado en SQL Server (id ${sqlId}).`);
                }
            }

            estadoSync.ultimoOk = Date.now();
            estadoSync.ultimoError = null;

        } catch (err) {

            estadoSync.ultimoError = err.message;

            console.error('No se pudo guardar el ensayo en SQL Server (se reintenta solo):', err.message);

        } finally {

            sincronizando = false;
        }
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
             FROM ensayos_datos WHERE sincronizado = 0`
        );

        const total = await consultarUno(`SELECT COUNT(*) AS cantidad FROM ensayos_datos`);

        return {
            configurado: ensayosSql.estaConfigurado(),
            total: total.cantidad,
            pendientes: fila.pendientes,
            masAntiguo: fila.masAntiguo,
            ...estadoSync
        };
    }

    async function listarEnsayos() {

        await tablaLista;

        return consultarTodos(
            `SELECT id, op, cano, fecha, cantidad, archivo
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

    function montarRutas(app, { requierePermiso }) {

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
        sincronizar,
        resumenSincronizacion,
        generarPdfEnsayo,
        nombreArchivoPdf,
        fechaLocal,
        montarRutas
    };
};
