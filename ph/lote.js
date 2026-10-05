// ======================================================
// DESCARGA MASIVA: ADMINISTRADOR DEL LOTE
// ======================================================
//
// Hay UN SOLO lote a la vez para toda la app (no por usuario): mientras
// uno se genera, cualquier otro pedido se rechaza y todos ven el mismo
// progreso. Así, aunque se apriete "Generar" diez veces desde cinco PCs,
// se arma un solo ZIP.
//
// El ZIP queda en una carpeta temporal del contenedor hasta que vence o
// se pide otro lote. Si la app se reinicia, el lote en curso se pierde y
// hay que pedirlo de nuevo (la carpeta se vacía al arrancar).

const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CARPETA = path.join(os.tmpdir(), 'curado-fibra-lotes');
const MAXIMO_ENSAYOS = 3000;
const VENCE_MS = 6 * 60 * 60 * 1000;

let lote = null;
let proceso = null;
let timerVencimiento = null;

fs.rmSync(CARPETA, { recursive: true, force: true });
fs.mkdirSync(CARPETA, { recursive: true });

function borrarArchivo(archivo) {
    fs.rm(archivo, { force: true }, () => {});
}

function descartarLoteAnterior() {
    clearTimeout(timerVencimiento);
    if (lote && lote.archivo) borrarArchivo(lote.archivo);
    lote = null;
}

function generando() {
    return !!lote && lote.estado === 'generando';
}

function estado(usuario) {

    if (!lote) return { estado: 'libre' };

    const transcurrido = (lote.fin || Date.now()) - lote.inicio;
    const segundosRestantes = lote.estado === 'generando' && lote.hecho > 0
        ? Math.round(transcurrido / lote.hecho * (lote.total - lote.hecho) / 1000)
        : null;

    return {
        estado: lote.estado,
        maquina: lote.maquina,
        filtros: lote.filtros,
        usuario: lote.usuario,
        inicio: lote.inicio,
        total: lote.total,
        hecho: lote.hecho,
        errores: lote.errores,
        porcentaje: lote.total ? Math.floor(lote.hecho / lote.total * 100) : 0,
        segundosRestantes,
        nombreZip: lote.nombreZip,
        bytes: lote.bytes || null,
        error: lote.error || null,
        venceEn: lote.vence || null,
        esMio: !!usuario && lote.usuario === usuario
    };
}

function iniciar({ maquinaClave, maquinaNombre, ids, filtros, nombreZip, usuario }) {

    if (generando()) {
        const e = new Error(`Ya hay una descarga masiva en curso, pedida por ${lote.usuario}`);
        e.status = 409;
        throw e;
    }

    descartarLoteAnterior();

    const id = Date.now();

    lote = {
        estado: 'generando',
        maquina: maquinaNombre,
        filtros,
        usuario,
        inicio: id,
        total: ids.length,
        hecho: 0,
        errores: 0,
        nombreZip,
        archivo: path.join(CARPETA, `lote-${id}.zip`)
    };

    const este = lote;

    proceso = fork(path.join(__dirname, 'lote-proceso.js'));

    // Prioridad baja: la app principal y los otros contenedores primero.
    try {
        os.setPriority(proceso.pid, 10);
    } catch (err) {
        console.error('Lote PH: no se pudo bajar la prioridad del generador:', err.message);
    }

    proceso.on('message', m => {

        if (lote !== este) return;

        if (m.tipo === 'progreso') {
            este.hecho = m.hecho;
            este.errores = m.errores;
        } else if (m.tipo === 'listo') {
            este.estado = 'listo';
            este.fin = Date.now();
            este.bytes = m.bytes;
            este.errores = m.errores;
            este.vence = este.fin + VENCE_MS;
            timerVencimiento = setTimeout(() => { if (lote === este) descartarLoteAnterior(); }, VENCE_MS);
            console.log(`Lote PH listo: ${este.total} ensayos, ${m.errores} con error, pedido por ${este.usuario}`);
        } else if (m.tipo === 'error') {
            este.estado = 'error';
            este.error = m.mensaje;
        }
    });

    proceso.on('exit', codigo => {

        proceso = null;

        if (este.estado === 'generando') {
            este.estado = 'error';
            este.error = `El generador se detuvo inesperadamente (código ${codigo})`;
        }

        if (este.estado !== 'listo') {
            este.fin = este.fin || Date.now();
            borrarArchivo(este.archivo);
            if (este.estado === 'error') console.error('Lote PH con error:', este.error);
        }
    });

    proceso.send({ maquinaClave, ids, archivo: lote.archivo, usuario });

    console.log(`Lote PH iniciado: ${ids.length} ensayos (${filtros}), pedido por ${usuario}`);
}

function cancelar(usuario, esAdmin) {

    if (!generando()) return { ok: false, status: 409, error: 'No hay ninguna descarga en curso' };

    if (lote.usuario !== usuario && !esAdmin) {
        return { ok: false, status: 403, error: `Solo ${lote.usuario} o un administrador pueden cancelarla` };
    }

    lote.estado = 'cancelado';
    lote.fin = Date.now();
    if (proceso) proceso.kill();

    console.log(`Lote PH cancelado por ${usuario}`);

    return { ok: true };
}

function archivoListo() {
    return lote && lote.estado === 'listo' ? { archivo: lote.archivo, nombre: lote.nombreZip } : null;
}

module.exports = { iniciar, cancelar, estado, archivoListo, MAXIMO_ENSAYOS };
