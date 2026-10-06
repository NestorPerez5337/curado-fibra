// ======================================================
// SONDA DE LA CONEXIÓN AL SQL SERVER (se deja corriendo en una PC)
// ======================================================
//
// Cada INTERVALO segundos mide, al mismo tiempo y capa por capa, cómo responde
// el SQL Server desde ESTA máquina y lo anota en un archivo de registro (una
// línea JSON por medición). Sirve para saber si las demoras o los cortes que
// ve el programa en producción también se ven desde acá (y entonces son del
// servidor) o no (y entonces son de la máquina o la red de producción).
//
// Capas que mide en cada vuelta (null = no respondió):
//   ping           ICMP al servidor (puede estar bloqueado: si siempre da null, no sirve)
//   udp            consulta al SQL Browser (UDP 1434): dice en qué puerto está la instancia
//   tcp            conexión TCP al puerto de la instancia (solo la red, sin login)
//   login          abrir una conexión NUEVA (entrar con usuario y contraseña)
//   consultaNueva  un SELECT 1 por esa conexión nueva
//   abierta        un SELECT 1 por una conexión que se mantiene abierta
//
// Solo hace SELECT 1: no lee ni escribe datos. La contraseña no se escribe en el registro.
//
// Uso (desde la carpeta del proyecto):
//   node herramientas/sonda-sql.js [--salida <carpeta>] [--intervalo 10] [--horas 36] [--env <archivo .env>] [--forzar]
//
// Cómo detenerla: crear un archivo vacío llamado PARAR dentro de la carpeta de salida
// (la sonda lo ve en la siguiente vuelta, termina sola y borra el archivo).
//
// Para analizar el resultado: node herramientas/analizar-sonda.js --carpeta <carpeta>

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const dgram = require('dgram');
const { execFile } = require('child_process');

const RAIZ = path.join(__dirname, '..');

function argumento(nombre, defecto) {

    const i = process.argv.indexOf('--' + nombre);

    if (i === -1) {
        return defecto;
    }

    const siguiente = process.argv[i + 1];

    return siguiente === undefined || siguiente.startsWith('--') ? true : siguiente;
}

const SALIDA = path.resolve(argumento('salida', path.join(RAIZ, '..', 'diagnostico-sql')));
const INTERVALO_S = Math.max(2, parseInt(argumento('intervalo', '10'), 10) || 10);
const HORAS_MAX = parseFloat(argumento('horas', '36')) || 36;
const ARCHIVO_ENV = path.resolve(argumento('env', path.join(RAIZ, '.env')));
const FORZAR = argumento('forzar', false) === true;

require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: ARCHIVO_ENV });
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

const SERVIDOR = process.env.PH_SQL_SERVER;
const INSTANCIA = process.env.PH_SQL_INSTANCE;
const PUERTO_FIJO = process.env.PH_SQL_PORT ? parseInt(process.env.PH_SQL_PORT, 10) : null;
const BASE = process.env.PH_SQL_DATABASE || 'Automatizacion';
const USUARIO = process.env.ENSAYOS_SQL_USER || process.env.PH_SQL_USER;
const CLAVE = process.env.ENSAYOS_SQL_PASSWORD || process.env.PH_SQL_PASSWORD;

if (!SERVIDOR || !USUARIO || !CLAVE) {
    console.error(`Faltan PH_SQL_SERVER y un usuario/contraseña (ENSAYOS_SQL_* o PH_SQL_*) en ${ARCHIVO_ENV}`);
    process.exit(1);
}

const TIMEOUT_PING_MS = 2000;
const TIMEOUT_UDP_MS = 2500;
const TIMEOUT_TCP_MS = 5000;
const TIMEOUT_SQL_MS = 15000;

const dos = n => String(n).padStart(2, '0');

function fechaLocal(d = new Date()) {
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
}

const espera = ms => new Promise(resolver => setTimeout(resolver, ms));

// Cada capa devuelve { ms } o { ms: null, error }. Nunca lanza.
function conLimite(tarea, limiteMs) {

    let temporizador;

    const limite = new Promise(resolver => {
        temporizador = setTimeout(() => resolver({ ms: null, error: `sin respuesta en ${limiteMs / 1000} s` }), limiteMs);
    });

    return Promise.race([tarea().catch(err => ({ ms: null, error: `${err.code ? err.code + ': ' : ''}${err.message}` })), limite])
        .finally(() => clearTimeout(temporizador));
}

// ---------------- capas ----------------

function capaPing() {

    return conLimite(() => new Promise(resolver => {

        const windows = process.platform === 'win32';
        const argumentos = windows ? ['-n', '1', '-w', String(TIMEOUT_PING_MS), SERVIDOR] : ['-c', '1', '-W', String(TIMEOUT_PING_MS / 1000), SERVIDOR];
        const inicio = Date.now();

        execFile('ping', argumentos, { timeout: TIMEOUT_PING_MS + 1500, windowsHide: true }, (err, salida) => {

            // "tiempo=1ms", "tiempo<1m", "time=1 ms"
            const coincidencia = String(salida || '').match(/(?:tiempo|time)\s*([=<])\s*(\d+)/i);

            if (coincidencia) {
                return resolver({ ms: coincidencia[1] === '<' ? 0 : Number(coincidencia[2]) });
            }

            resolver({ ms: null, error: err ? 'sin respuesta (o ICMP bloqueado)' : `no se pudo leer la respuesta (${Date.now() - inicio} ms)` });
        });

    }), TIMEOUT_PING_MS + 2000);
}

let puertoRecordado = PUERTO_FIJO;

function capaUdp() {

    if (PUERTO_FIJO || !INSTANCIA) {
        return Promise.resolve({ ms: null, error: 'no aplica (puerto fijo o sin instancia)', noAplica: true });
    }

    return conLimite(() => new Promise(resolver => {

        const socket = dgram.createSocket('udp4');
        const inicio = Date.now();
        const paquete = Buffer.concat([Buffer.from([0x04]), Buffer.from(INSTANCIA, 'ascii'), Buffer.from([0x00])]);

        const terminar = resultado => {
            try { socket.close(); } catch { /* ya cerrado */ }
            resolver(resultado);
        };

        socket.on('message', mensaje => {

            const coincidencia = mensaje.slice(3).toString('ascii').match(/;tcp;(\d+)/);

            if (coincidencia) {
                puertoRecordado = Number(coincidencia[1]);
            }

            terminar({ ms: Date.now() - inicio });
        });

        socket.on('error', err => terminar({ ms: null, error: err.message }));

        socket.send(paquete, 1434, SERVIDOR, err => err && terminar({ ms: null, error: err.message }));

    }), TIMEOUT_UDP_MS);
}

function capaTcp(puerto) {

    if (!puerto) {
        return Promise.resolve({ ms: null, error: 'puerto desconocido' });
    }

    return conLimite(() => new Promise(resolver => {

        const inicio = Date.now();
        const socket = new net.Socket();

        socket.setTimeout(TIMEOUT_TCP_MS);
        socket.once('connect', () => { socket.destroy(); resolver({ ms: Date.now() - inicio }); });
        socket.once('timeout', () => { socket.destroy(); resolver({ ms: null, error: 'sin respuesta' }); });
        socket.once('error', err => { socket.destroy(); resolver({ ms: null, error: err.code || err.message }); });

        socket.connect({ host: SERVIDOR, port: puerto });

    }), TIMEOUT_TCP_MS + 1000);
}

function configuracionSql(puerto) {

    const config = {
        server: SERVIDOR, database: BASE, user: USUARIO, password: CLAVE,
        connectionTimeout: TIMEOUT_SQL_MS, requestTimeout: TIMEOUT_SQL_MS,
        pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
        options: { encrypt: false, trustServerCertificate: true, useUTC: false }
    };

    if (puerto) {
        config.port = puerto;
    } else if (INSTANCIA) {
        config.options.instanceName = INSTANCIA;
    }

    return config;
}

// Conexión nueva: login y consulta por separado
async function capaLoginNuevo(puerto) {

    const resultado = { login: null, consultaNueva: null, errores: {} };
    const inicio = Date.now();
    const pool = new sql.ConnectionPool(configuracionSql(puerto));

    const r = await conLimite(async () => {

        await pool.connect();

        resultado.login = Date.now() - inicio;

        const t1 = Date.now();

        await pool.request().query('SELECT 1 AS ok');

        resultado.consultaNueva = Date.now() - t1;

        return { ms: 0 };

    }, TIMEOUT_SQL_MS + 1000);

    if (r.error) {
        resultado.errores[resultado.login === null ? 'login' : 'consultaNueva'] = r.error;
    }

    try { await pool.close(); } catch { /* ya cerrado */ }

    return resultado;
}

// Conexión que se mantiene abierta entre vueltas
let poolAbierto = null;

async function capaAbierta(puerto) {

    const r = await conLimite(async () => {

        if (!poolAbierto) {
            poolAbierto = new sql.ConnectionPool({ ...configuracionSql(puerto), pool: { max: 1, min: 1, idleTimeoutMillis: 3600000 } });
            poolAbierto.on('error', () => { poolAbierto = null; });
            await poolAbierto.connect();
        }

        const inicio = Date.now();

        await poolAbierto.request().query('SELECT 1 AS ok');

        return { ms: Date.now() - inicio };

    }, TIMEOUT_SQL_MS + 1000);

    if (r.error) {

        // Se descarta: la próxima vuelta arma una conexión nueva
        const vieja = poolAbierto;
        poolAbierto = null;

        if (vieja) {
            vieja.close().catch(() => {});
        }
    }

    return r;
}

// ---------------- archivos ----------------

fs.mkdirSync(SALIDA, { recursive: true });

const ARCHIVO_ESTADO = path.join(SALIDA, 'sonda_estado.json');
const ARCHIVO_PARAR = path.join(SALIDA, 'PARAR');

function archivoDelDia(fecha) {
    return path.join(SALIDA, `sonda_sql_${fecha.slice(0, 10)}.jsonl`);
}

function anotar(objeto) {
    fs.appendFileSync(archivoDelDia(objeto.fecha), JSON.stringify(objeto) + '\n');
}

function procesoVivo(pid) {

    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function leerEstado() {

    try {
        return JSON.parse(fs.readFileSync(ARCHIVO_ESTADO, 'utf8'));
    } catch {
        return null;
    }
}

// ---------------- programa principal ----------------

(async () => {

    const previo = leerEstado();

    if (!FORZAR && previo && previo.pid && previo.pid !== process.pid && procesoVivo(previo.pid) && Date.now() - previo.ultimoCicloEpoch < 120000) {
        console.error(`Ya hay una sonda corriendo (PID ${previo.pid}). Para forzar otra: --forzar`);
        process.exit(2);
    }

    const inicioEpoch = Date.now();
    const limiteEpoch = inicioEpoch + HORAS_MAX * 3600 * 1000;
    let ciclos = 0;
    let ultimoEstado = 0;
    let terminando = false;

    const escribirEstado = (ultimoCicloEpoch, extra = {}) => {
        fs.writeFileSync(ARCHIVO_ESTADO, JSON.stringify({
            pid: process.pid, equipo: os.hostname(), inicio: fechaLocal(new Date(inicioEpoch)), inicioEpoch,
            ultimoCiclo: fechaLocal(new Date(ultimoCicloEpoch)), ultimoCicloEpoch, ciclos,
            intervaloSegundos: INTERVALO_S, terminaA: fechaLocal(new Date(limiteEpoch)),
            servidor: SERVIDOR, instancia: INSTANCIA || null, puerto: puertoRecordado, salida: SALIDA, ...extra
        }, null, 1));
    };

    const terminar = async motivo => {

        if (terminando) return;
        terminando = true;

        anotar({ fecha: fechaLocal(), epoch: Date.now(), tipo: 'fin', motivo, ciclos });
        escribirEstado(Date.now(), { terminada: true, motivo });

        if (poolAbierto) {
            try { await poolAbierto.close(); } catch { /* ya cerrado */ }
        }

        process.exit(0);
    };

    process.on('SIGINT', () => terminar('interrumpida (Ctrl+C)'));
    process.on('SIGTERM', () => terminar('detenida (SIGTERM)'));

    anotar({
        fecha: fechaLocal(), epoch: inicioEpoch, tipo: 'inicio', equipo: os.hostname(), servidor: SERVIDOR, instancia: INSTANCIA || null,
        puertoFijo: PUERTO_FIJO, intervaloSegundos: INTERVALO_S, horasMax: HORAS_MAX, node: process.version
    });

    console.log(`Sonda iniciada (PID ${process.pid}). Servidor ${SERVIDOR}${INSTANCIA ? '\\' + INSTANCIA : ''}. Registro en ${SALIDA}`);

    while (!terminando) {

        const t0 = Date.now();

        if (fs.existsSync(ARCHIVO_PARAR)) {
            try { fs.unlinkSync(ARCHIVO_PARAR); } catch { /* otro proceso lo borró */ }
            return terminar('pedido de parada (archivo PARAR)');
        }

        if (t0 >= limiteEpoch) {
            return terminar(`se cumplieron las ${HORAS_MAX} horas`);
        }

        // La primera vuelta averigua antes el puerto de la instancia (si no, el TCP no sabría adónde conectar)
        const udpPrevia = puertoRecordado ? null : await capaUdp();

        // Todas las capas a la vez, para comparar el mismo instante
        const [ping, udp, tcp, nuevo, abierta] = await Promise.all([
            capaPing(),
            udpPrevia || capaUdp(),
            capaTcp(puertoRecordado),
            capaLoginNuevo(puertoRecordado),
            capaAbierta(puertoRecordado)
        ]);

        const errores = { ...nuevo.errores };

        if (ping.error) errores.ping = ping.error;
        if (udp.error && !udp.noAplica) errores.udp = udp.error;
        if (tcp.error) errores.tcp = tcp.error;
        if (abierta.error) errores.abierta = abierta.error;

        ciclos++;

        const ahora = new Date();

        anotar({
            fecha: fechaLocal(ahora), epoch: ahora.getTime(), tipo: 'medicion',
            ping: ping.ms, udp: udp.ms, tcp: tcp.ms, login: nuevo.login, consultaNueva: nuevo.consultaNueva, abierta: abierta.ms,
            ...(Object.keys(errores).length ? { errores } : {})
        });

        if (Date.now() - ultimoEstado > 30000) {
            ultimoEstado = Date.now();
            escribirEstado(Date.now());
        }

        await espera(Math.max(0, INTERVALO_S * 1000 - (Date.now() - t0)));
    }
})().catch(err => {
    try { anotar({ fecha: fechaLocal(), epoch: Date.now(), tipo: 'fin', motivo: 'error: ' + err.message }); } catch { /* sin disco */ }
    console.error('La sonda se detuvo por un error:', err);
    process.exit(1);
});
