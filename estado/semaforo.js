// ======================================================
// SEMÁFORO "¿SE PUEDE ACTUALIZAR AHORA?"
// ======================================================
//
// Cada actualización del programa lo reinicia. Si en ese momento hay un ensayo
// de presión en marcha, el ensayo queda cortado: lo medido hasta ahí se guarda
// como "Interrumpido" (sin subir al SQL Server) y el resto se guarda aparte.
// Este semáforo dice, de un vistazo, si es buen momento:
//
//   verde      no hay ensayo y el PLC del ensayo responde: se puede actualizar
//   amarillo   mejor esperar un momento (se está guardando un ensayo recién
//              terminado, o no se puede saber si hay uno porque el PLC no responde)
//   rojo       hay un ensayo en curso: no actualizar
//
// Es una función pura (recibe los datos y devuelve el estado).

// Con 3 lecturas seguidas fallidas se considera que el PLC no responde (igual que el panel de Conexiones)
const FALLOS_PLC_SIN_RESPUESTA = 3;

// Si hace más que esto que no hay una lectura buena del PLC, no se puede asegurar que no haya un ensayo
const LECTURA_VIGENTE_MS = 30 * 1000;

const MIN = 60 * 1000;

function textoDuracion(ms) {

    const minutos = Math.floor(ms / MIN);

    if (minutos < 1) {
        return 'menos de 1 min';
    }

    if (minutos < 60) {
        return `${minutos} min`;
    }

    return `${Math.floor(minutos / 60)} h ${minutos % 60} min`;
}

// ensayo: { activo, enGracia, guardando, op, cano, muestras, inicio }   (inicio en ms, o null)
// plc:    { ultimaLecturaOk, fallosSeguidos, mensajeFallo }
// Si no se pudo averiguar el estado (ensayo == null), el semáforo no dice "verde".
function evaluarSemaforo({ ensayo, plc, ahora = Date.now() } = {}) {

    if (!ensayo) {

        return {
            nivel: 'amarillo',
            puedeActualizar: false,
            titulo: 'No se pudo saber si hay un ensayo en curso',
            textoCorto: 'Esperar un momento',
            detalle: 'El programa no pudo leer el estado del ensayo. Mejor esperar unos segundos y volver a mirar.',
            ensayo: null
        };
    }

    // ---- rojo: hay un ensayo en curso
    if (ensayo.activo) {

        const duracion = ensayo.inicio ? textoDuracion(Math.max(0, ahora - ensayo.inicio)) : null;

        const datos = [
            ensayo.op !== null && ensayo.op !== undefined && ensayo.op !== '' ? `OP ${ensayo.op}` : null,
            ensayo.cano !== null && ensayo.cano !== undefined && ensayo.cano !== '' ? `caño ${ensayo.cano}` : null
        ].filter(Boolean).join(', ');

        const avance = `${ensayo.muestras || 0} muestra${ensayo.muestras === 1 ? '' : 's'} tomada${ensayo.muestras === 1 ? '' : 's'}${duracion ? ` (lleva ${duracion})` : ''}`;

        return {
            nivel: 'rojo',
            puedeActualizar: false,
            titulo: 'Hay un ensayo en curso: no actualizar',
            textoCorto: 'Ensayo en curso: no actualizar',
            detalle: [
                `${datos ? datos + ': ' : ''}${avance}.`,
                ensayo.enGracia ? 'El ensayo está terminando: se toman unas muestras más y se guarda.' : null,
                'Si se actualiza ahora el programa se reinicia: el ensayo queda guardado como "Interrumpido" (con lo medido hasta ese momento, sin subir al SQL Server) y el resto se guarda aparte.'
            ].filter(Boolean).join(' '),
            ensayo: {
                op: ensayo.op ?? null,
                cano: ensayo.cano ?? null,
                muestras: ensayo.muestras || 0,
                inicio: ensayo.inicio || null,
                enGracia: !!ensayo.enGracia
            }
        };
    }

    // ---- amarillo: se está guardando un ensayo que acaba de terminar
    if (ensayo.guardando) {

        return {
            nivel: 'amarillo',
            puedeActualizar: false,
            titulo: 'Se está guardando un ensayo: esperar unos segundos',
            textoCorto: 'Guardando un ensayo',
            detalle: 'Un ensayo acaba de terminar y se está guardando. Conviene esperar a que termine antes de actualizar.',
            ensayo: null
        };
    }

    // ---- amarillo: no se puede saber si hay un ensayo (el PLC del ensayo no responde)
    const fallos = (plc && plc.fallosSeguidos) || 0;
    const ultimaLectura = plc ? plc.ultimaLecturaOk : null;

    if (fallos >= FALLOS_PLC_SIN_RESPUESTA) {

        return {
            nivel: 'amarillo',
            puedeActualizar: false,
            titulo: 'No se puede saber si hay un ensayo: el PLC del ensayo no responde',
            textoCorto: 'PLC del ensayo sin respuesta',
            detalle: `Hace ${fallos} lecturas seguidas que el PLC del ensayo no responde${plc.mensajeFallo ? ` (${plc.mensajeFallo})` : ''}. Si hay un ensayo en marcha no se está viendo. Conviene verificarlo en planta antes de actualizar.`,
            ensayo: null
        };
    }

    if (!ultimaLectura) {

        return {
            nivel: 'amarillo',
            puedeActualizar: false,
            titulo: 'Todavía no se leyó el PLC del ensayo',
            textoCorto: 'Esperar un momento',
            detalle: 'El programa acaba de arrancar y todavía no pudo leer el PLC del ensayo. En unos segundos se va a saber si hay un ensayo en curso.',
            ensayo: null
        };
    }

    if (ahora - ultimaLectura > LECTURA_VIGENTE_MS) {

        return {
            nivel: 'amarillo',
            puedeActualizar: false,
            titulo: 'No se puede asegurar que no haya un ensayo',
            textoCorto: 'Esperar un momento',
            detalle: `La última lectura buena del PLC del ensayo es de hace ${textoDuracion(ahora - ultimaLectura)}. Mejor esperar unos segundos y volver a mirar.`,
            ensayo: null
        };
    }

    // ---- verde
    return {
        nivel: 'verde',
        puedeActualizar: true,
        titulo: 'Se puede actualizar',
        textoCorto: 'Se puede actualizar',
        detalle: 'No hay ningún ensayo en curso y el PLC del ensayo responde.',
        ensayo: null
    };
}

module.exports = {
    evaluarSemaforo,
    FALLOS_PLC_SIN_RESPUESTA,
    LECTURA_VIGENTE_MS
};
