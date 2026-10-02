// ======================================================
// DESCARGA MASIVA: PROCESO GENERADOR
// ======================================================
//
// Corre como proceso aparte (lo lanza lote.js con child_process.fork),
// no como worker thread: la librería canvas que dibuja los gráficos
// crashea dentro de un worker thread y se llevaría puesta toda la app.
// Así, si algo falla acá, muere solo este proceso.
//
// Recibe { maquinaClave, ids, archivo, usuario }, genera un PDF por
// ensayo de a uno y los va escribiendo directo al ZIP en disco, sin
// juntarlos en memoria. Informa el avance con mensajes 'progreso'.

const fs = require('fs');
const archiver = require('archiver');
const { obtenerMaquina } = require('./maquinas');
const consultas = require('./consultas');
const { generarPdfEnsayo, nombreArchivoPdf } = require('./pdf');
const { esErrorDeConexion } = require('./sql');

// Respiro entre PDFs para no saturar el SQL Server ni el servidor, que
// comparte CPU con Node-RED, Grafana, Ollama, etc.
const PAUSA_MS = 200;

// Si los primeros ensayos fallan todos (sin conexión, por ejemplo),
// cortamos en vez de seguir intentando miles.
const FALLOS_PARA_ABORTAR = 5;

const pausa = ms => new Promise(resolve => setTimeout(resolve, ms));

// Si la app principal se cierra o reinicia, este proceso no tiene a quién
// avisar: terminamos también.
process.on('disconnect', () => process.exit(0));

process.once('message', async tarea => {
    try {
        await generar(tarea);
        process.exit(0);
    } catch (err) {
        process.send({ tipo: 'error', mensaje: err.message }, () => process.exit(1));
    }
});

async function generarUno(maquina, id, usuario) {
    const ensayo = await consultas.obtenerEnsayo(maquina, id);
    if (!ensayo) throw new Error('ya no existe en la base');
    return { pdf: await generarPdfEnsayo([ensayo], usuario), nombre: nombreArchivoPdf([ensayo]) };
}

// El SQL Server tiene "baches" de hasta ~1 minuto en los que no acepta
// conexiones (medido el 02/10/2026). Un bache no debería arruinar un lote
// de cientos de PDFs: los errores de conexión se reintentan con esperas
// crecientes.
const ESPERAS_REINTENTO_MS = [5000, 15000, 30000];

async function conReintentos(tarea) {
    for (let intento = 0; ; intento++) {
        try {
            return await tarea();
        } catch (err) {
            if (!esErrorDeConexion(err) || intento >= ESPERAS_REINTENTO_MS.length) throw err;
            await pausa(ESPERAS_REINTENTO_MS[intento]);
        }
    }
}

async function generar({ maquinaClave, ids, archivo, usuario }) {

    const maquina = obtenerMaquina(maquinaClave);

    const salida = fs.createWriteStream(archivo);
    // Los PDFs ya vienen comprimidos: comprimir de nuevo solo gasta CPU.
    const zip = archiver('zip', { zlib: { level: 1 } });

    const escrito = new Promise((resolve, reject) => {
        salida.on('close', resolve);
        salida.on('error', reject);
        zip.on('error', reject);
    });

    zip.pipe(salida);

    const fallidos = [];
    let hecho = 0;

    for (const id of ids) {

        try {
            const { pdf, nombre } = await conReintentos(() => generarUno(maquina, id, usuario));
            zip.append(pdf, { name: nombre });
        } catch (err) {
            fallidos.push(`Ensayo ${id}: ${err.message}`);
        }

        hecho++;
        process.send({ tipo: 'progreso', hecho, errores: fallidos.length });

        if (hecho === FALLOS_PARA_ABORTAR && fallidos.length === hecho) {
            throw new Error(`No se pudo generar ningún PDF (${fallidos[0]})`);
        }

        await pausa(PAUSA_MS);
    }

    if (fallidos.length) {
        zip.append(fallidos.join('\r\n'), { name: 'ERRORES.txt' });
    }

    await zip.finalize();
    await escrito;

    await new Promise(resolve => process.send({
        tipo: 'listo',
        bytes: fs.statSync(archivo).size,
        errores: fallidos.length
    }, resolve));
}
