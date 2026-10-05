// ======================================================
// ESTADO DEL SISTEMA: VERIFICACIÓN DE CONEXIONES
// ======================================================
//
// Comprueba si el programa llega a los equipos y servicios que usa (PLCs,
// compresores, SQL Server, broker MQTT). Cada "objetivo" lo arma server.js
// y puede ser de tres tipos:
//
//   tcp   -> se intenta abrir una conexión TCP a host:puerto y se mide cuánto tarda
//   sql   -> se hace una consulta mínima (SELECT 1) con la función `probar`
//   vivo  -> el programa ya mantiene esa conexión (ej.: el PLC del ensayo, que
//            se lee cada segundo): se informa su estado actual en vez de
//            abrir otra conexión que le compita al PLC.
//
// Solo se verifica cuando alguien tiene abierto el panel: no hay un
// monitoreo permanente (para eso está el Monitor de Variables).

const net = require('net');
const { LATENCIA_LENTA_MS } = require('../sql-pool');

const TIMEOUT_TCP_MS = 2500;
const TIMEOUT_SQL_MS = 12000;

// Con varios paneles abiertos (o el refresco automático) no se repite la
// verificación antes de este tiempo; el botón "Probar ahora" la fuerza, pero
// no más seguido que ESPERA_MINIMA_FORZADA_MS.
const VIGENCIA_MS = 10 * 1000;
const ESPERA_MINIMA_FORZADA_MS = 2 * 1000;

function traducirError(err) {

    switch (err && err.code) {

        case 'ECONNREFUSED':
            return 'Conexión rechazada (el equipo responde pero no hay servicio en ese puerto)';
        case 'EHOSTUNREACH':
        case 'ENETUNREACH':
            return 'Sin ruta hasta el equipo (apagado o fuera de la red)';
        case 'ETIMEDOUT':
            return 'Tiempo de espera agotado';
        case 'ENOTFOUND':
            return 'No se pudo resolver el nombre del equipo';
        case 'ECONNRESET':
            return 'La conexión fue cortada por el equipo';
        default:
            return (err && (err.message || err.code)) || 'Error desconocido';
    }
}

function probarTcp(host, puerto) {

    return new Promise(resolve => {

        const inicio = Date.now();
        const socket = new net.Socket();

        let terminado = false;

        const terminar = resultado => {

            if (terminado) {
                return;
            }

            terminado = true;
            socket.destroy();
            resolve(resultado);
        };

        socket.setTimeout(TIMEOUT_TCP_MS);

        socket.once('connect', () => terminar({ estado: 'ok', latencia_ms: Date.now() - inicio }));

        socket.once('timeout', () => terminar({
            estado: 'error',
            detalle: `No responde (se esperó ${TIMEOUT_TCP_MS / 1000} s)`
        }));

        socket.once('error', err => terminar({ estado: 'error', detalle: traducirError(err) }));

        socket.connect({ host, port: puerto });
    });
}

// Corta la espera si la promesa tarda más que `ms` (la operación original
// sigue por su cuenta, pero el panel no queda colgado esperándola).
function conLimite(promesa, ms, mensaje) {

    let temporizador;

    const limite = new Promise((_, rechazar) => {
        temporizador = setTimeout(() => rechazar(new Error(mensaje)), ms);
    });

    return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

async function evaluar(objetivo) {

    const base = {
        grupo: objetivo.grupo,
        nombre: objetivo.nombre,
        destino: objetivo.destino || null,
        critico: !!objetivo.critico,
        verificado: Date.now()
    };

    try {

        if (objetivo.tipo === 'tcp') {
            return { ...base, ...(await probarTcp(objetivo.host, objetivo.puerto)) };
        }

        if (objetivo.tipo === 'vivo') {
            return { ...base, ...objetivo.leer() };
        }

        if (objetivo.tipo === 'sql') {

            if (!objetivo.configurado()) {
                return { ...base, estado: 'sin_configurar', detalle: objetivo.faltante };
            }

            const ms = await conLimite(
                objetivo.probar(),
                TIMEOUT_SQL_MS,
                `No responde (se esperó ${TIMEOUT_SQL_MS / 1000} s)`
            );

            // "nota": dato extra del propio servicio, ej. los cortes que tuvo
            const nota = objetivo.nota ? objetivo.nota() : null;

            return {
                ...base,
                estado: ms > LATENCIA_LENTA_MS ? 'lento' : 'ok',
                latencia_ms: ms,
                ...(nota ? { detalle: nota } : {})
            };
        }

        return { ...base, estado: 'error', detalle: `Tipo de verificación desconocido: ${objetivo.tipo}` };

    } catch (err) {

        const nota = objetivo.nota ? objetivo.nota() : null;

        return { ...base, estado: 'error', detalle: [traducirError(err), nota].filter(Boolean).join(' ') };
    }
}

// listarObjetivos() devuelve (puede ser async) la lista de objetivos a
// verificar; se vuelve a llamar en cada verificación para que los equipos
// que se agreguen o cambien (ej.: IP de un compresor) se tomen solos.
function crearVerificador({ listarObjetivos }) {

    let cache = { momento: 0, resultados: [] };
    let enCurso = null;

    async function verificar({ forzar = false } = {}) {

        if (enCurso) {
            return enCurso;
        }

        const vigencia = forzar ? ESPERA_MINIMA_FORZADA_MS : VIGENCIA_MS;

        if (Date.now() - cache.momento < vigencia) {
            return cache;
        }

        enCurso = (async () => {

            try {

                const objetivos = await listarObjetivos();
                const resultados = await Promise.all(objetivos.map(evaluar));

                cache = { momento: Date.now(), resultados };

            } catch (err) {

                console.error('Estado: no se pudieron verificar las conexiones:', err.message);

            } finally {

                enCurso = null;
            }

            return cache;
        })();

        return enCurso;
    }

    return { verificar, ultimo: () => cache };
}

module.exports = { crearVerificador, probarTcp, evaluar };
