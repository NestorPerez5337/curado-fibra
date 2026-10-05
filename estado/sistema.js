// ======================================================
// ESTADO DEL SISTEMA: MEMORIA, CPU, DISCO Y ERRORES
// ======================================================
//
// Mide cómo está el servidor: memoria y CPU del programa y de la máquina,
// retraso del bucle de eventos de Node (si está "pesado" o trabado),
// sockets TCP abiertos, espacio en disco y los últimos errores que
// escribió el programa en el log.
//
// Cada INTERVALO_MUESTRA_MS toma una muestra y guarda las últimas 24 horas
// EN MEMORIA (alcanza para ver la tendencia; al reiniciar el programa el
// historial vuelve a empezar, y eso mismo queda a la vista en "arrancó hace").
//
// Se inicia una sola vez desde server.js con iniciar(); las rutas del panel
// (estado/rutas.js) lo consultan.

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { monitorEventLoopDelay } = require('perf_hooks');

const RAIZ = path.join(__dirname, '..');

const INTERVALO_MUESTRA_MS = 15 * 1000;
const HORAS_HISTORIAL = 24;
const MAX_MUESTRAS = Math.round(HORAS_HISTORIAL * 3600 * 1000 / INTERVALO_MUESTRA_MS);
const PUNTOS_MAXIMOS_GRAFICO = 240;

// El histograma de Node mide el retraso incluyendo la propia resolución del
// timer: sin carga da ~RESOLUCION_LAG_MS. Se resta para que "sin carga" sea 0.
const RESOLUCION_LAG_MS = 20;

const MAX_ERRORES = 100;
const LARGO_MAX_ERROR = 800;

const VIGENCIA_DISCO_MS = 60 * 1000;

// ======================================================
// MEMORIA DEL CONTENEDOR (cgroup)
// ======================================================
// Dentro de Docker, os.totalmem() devuelve la memoria de TODA la máquina,
// no el límite del contenedor. Para ver cuánto está usando de verdad el
// contenedor (y contra qué límite, si tiene uno) se leen los archivos del
// cgroup. Se resta la caché de archivos inactiva, igual que hace
// "docker stats", porque Linux la libera sola cuando hace falta.

function extraerNumero(texto, clave) {

    if (!texto) {
        return null;
    }

    const coincidencia = texto.match(new RegExp('^' + clave + ' (\\d+)$', 'm'));

    return coincidencia ? Number(coincidencia[1]) : null;
}

// Recibe el contenido de los archivos del cgroup (texto o null si no
// existen). Sin límite configurado devuelve limiteBytes = null.
function interpretarCgroup({ limite, uso, estadisticas, claveInactivo }, memoriaTotal) {

    if (uso === null || uso === undefined) {
        return null;
    }

    const usoBytes = Number(uso);

    if (!Number.isFinite(usoBytes)) {
        return null;
    }

    const inactivo = extraerNumero(estadisticas, claveInactivo) || 0;

    const limiteBytes = limite && limite !== 'max' ? Number(limite) : null;

    return {
        usoBytes: Math.max(0, usoBytes - inactivo),
        // En cgroup v1 "sin límite" es un número gigante (9223372036854771712)
        limiteBytes: Number.isFinite(limiteBytes) && limiteBytes > 0 && limiteBytes < memoriaTotal
            ? limiteBytes
            : null
    };
}

function leerArchivo(ruta) {

    try {
        return fs.readFileSync(ruta, 'utf8').trim();
    } catch {
        return null;
    }
}

function memoriaContenedor() {

    if (process.platform !== 'linux') {
        return null;
    }

    const total = os.totalmem();

    // cgroup v2
    const v2 = interpretarCgroup({
        limite: leerArchivo('/sys/fs/cgroup/memory.max'),
        uso: leerArchivo('/sys/fs/cgroup/memory.current'),
        estadisticas: leerArchivo('/sys/fs/cgroup/memory.stat'),
        claveInactivo: 'inactive_file'
    }, total);

    if (v2) {
        return v2;
    }

    // cgroup v1
    return interpretarCgroup({
        limite: leerArchivo('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
        uso: leerArchivo('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
        estadisticas: leerArchivo('/sys/fs/cgroup/memory/memory.stat'),
        claveInactivo: 'total_inactive_file'
    }, total);
}

// ======================================================
// MUESTREO (memoria, CPU, event loop, sockets)
// ======================================================

const muestras = [];

let histogramaLag = null;
let previo = null;
let timerMuestreo = null;
let iniciado = false;

function tiemposCpuSistema() {

    let inactivo = 0;
    let total = 0;

    for (const cpu of os.cpus()) {

        for (const tiempo of Object.values(cpu.times)) {
            total += tiempo;
        }

        inactivo += cpu.times.idle;
    }

    return { inactivo, total };
}

function recursosActivos() {

    if (typeof process.getActiveResourcesInfo !== 'function') {
        return { sockets: null, timers: null };
    }

    const cuenta = {};

    for (const recurso of process.getActiveResourcesInfo()) {
        cuenta[recurso] = (cuenta[recurso] || 0) + 1;
    }

    return {
        sockets: cuenta.TCPSocketWrap || 0,
        timers: cuenta.Timeout || 0
    };
}

const aMs = nanosegundos => Math.max(0, nanosegundos / 1e6 - RESOLUCION_LAG_MS);

function leerLag() {

    if (!histogramaLag || !Number.isFinite(histogramaLag.mean)) {
        return { lagMedio: 0, lagP99: 0, lagMax: 0 };
    }

    const lag = {
        lagMedio: aMs(histogramaLag.mean),
        lagP99: aMs(histogramaLag.percentile(99)),
        lagMax: aMs(histogramaLag.max)
    };

    histogramaLag.reset();

    return lag;
}

function tomarMuestra() {

    const ahora = Date.now();
    const memoria = process.memoryUsage();
    const usoCpu = process.cpuUsage();
    const cpuSistema = tiemposCpuSistema();

    let cpuProceso = null;
    let cpuServidor = null;

    if (previo) {

        const transcurridoUs = (ahora - previo.t) * 1000;

        if (transcurridoUs > 0) {
            cpuProceso = ((usoCpu.user - previo.usoCpu.user) + (usoCpu.system - previo.usoCpu.system)) / transcurridoUs * 100;
        }

        const totalDelta = cpuSistema.total - previo.cpuSistema.total;

        if (totalDelta > 0) {
            cpuServidor = (1 - (cpuSistema.inactivo - previo.cpuSistema.inactivo) / totalDelta) * 100;
        }
    }

    previo = { t: ahora, usoCpu, cpuSistema };

    const muestra = {
        t: ahora,
        rss: memoria.rss,
        heapUsado: memoria.heapUsed,
        heapTotal: memoria.heapTotal,
        externa: memoria.external + memoria.arrayBuffers,
        cpuProceso,
        cpuServidor,
        sockets: recursosActivos().sockets,
        ...leerLag()
    };

    muestras.push(muestra);

    if (muestras.length > MAX_MUESTRAS) {
        muestras.shift();
    }

    return muestra;
}

// ======================================================
// ÚLTIMOS ERRORES DEL PROGRAMA
// ======================================================
// Se engancha a console.error / console.warn: todo lo que el programa
// ya escribe como error (PLC sin respuesta, SQL caído, promesas
// rechazadas, etc.) queda también acá, para verlo sin entrar al log del
// contenedor. Los mensajes iguales se agrupan y cuentan las repeticiones
// (un PLC caído genera el mismo error cada segundo).

const errores = new Map();

function registrarError(nivel, argumentos) {

    let texto;

    try {
        texto = util.format(...argumentos);
    } catch {
        texto = '(mensaje que no se pudo formatear)';
    }

    if (texto.length > LARGO_MAX_ERROR) {
        texto = texto.slice(0, LARGO_MAX_ERROR) + '…';
    }

    const clave = nivel + '|' + texto;
    const ahora = Date.now();
    const existente = errores.get(clave);

    if (existente) {

        existente.veces++;
        existente.ultima = ahora;

        // vuelve al final: el orden refleja cuál ocurrió por última vez
        errores.delete(clave);
        errores.set(clave, existente);

        return;
    }

    errores.set(clave, { nivel, mensaje: texto, veces: 1, primera: ahora, ultima: ahora });

    if (errores.size > MAX_ERRORES) {
        errores.delete(errores.keys().next().value);
    }
}

function engancharConsola() {

    for (const nivel of ['error', 'warn']) {

        const original = console[nivel].bind(console);

        console[nivel] = (...argumentos) => {

            try {
                registrarError(nivel, argumentos);
            } catch {
                // registrar nunca debe romper el log original
            }

            original(...argumentos);
        };
    }
}

function ultimosErrores(limite = 40) {

    return [...errores.values()].reverse().slice(0, limite);
}

// ======================================================
// DISCO Y ARCHIVOS
// ======================================================

async function espacioLibre(ruta) {

    try {

        const s = await fs.promises.statfs(ruta);

        return { totalBytes: s.blocks * s.bsize, libreBytes: s.bavail * s.bsize };

    } catch {

        return { totalBytes: null, libreBytes: null };
    }
}

// Suma el tamaño de todo lo que hay en una carpeta (hasta 3 niveles).
async function medirCarpeta(ruta, nivel = 0) {

    let bytes = 0;
    let archivos = 0;

    let entradas;

    try {
        entradas = await fs.promises.readdir(ruta, { withFileTypes: true });
    } catch {
        return { bytes, archivos };
    }

    for (const entrada of entradas) {

        const completa = path.join(ruta, entrada.name);

        try {

            if (entrada.isDirectory()) {

                if (nivel < 3) {
                    const interno = await medirCarpeta(completa, nivel + 1);
                    bytes += interno.bytes;
                    archivos += interno.archivos;
                }

            } else if (entrada.isFile()) {

                bytes += (await fs.promises.stat(completa)).size;
                archivos++;
            }

        } catch {
            // el archivo desapareció mientras se medía (backup rotado, etc.)
        }
    }

    return { bytes, archivos };
}

async function tamanioArchivo(ruta) {

    try {
        return (await fs.promises.stat(ruta)).size;
    } catch {
        return null;
    }
}

// Cuántos backups hay de cada base y cuándo se hizo el último.
async function resumirBackups(carpeta) {

    const resumen = {
        recetas: { cantidad: 0, ultimo: null },
        monitor: { cantidad: 0, ultimo: null }
    };

    let nombres;

    try {
        nombres = await fs.promises.readdir(carpeta);
    } catch {
        return resumen;
    }

    for (const nombre of nombres) {

        const base = nombre.startsWith('recetas_') ? 'recetas' : nombre.startsWith('monitor_') ? 'monitor' : null;

        if (!base || !nombre.endsWith('.db')) {
            continue;
        }

        try {

            const { mtimeMs } = await fs.promises.stat(path.join(carpeta, nombre));

            resumen[base].cantidad++;

            if (resumen[base].ultimo === null || mtimeMs > resumen[base].ultimo) {
                resumen[base].ultimo = mtimeMs;
            }

        } catch {
            // rotado mientras se leía
        }
    }

    return resumen;
}

let cacheDisco = { momento: 0, datos: null };
let calculandoDisco = null;

async function calcularDisco() {

    const carpetas = [
        { clave: 'datos', nombre: 'Datos (bases de datos)', ruta: path.join(RAIZ, 'data') },
        { clave: 'pdfs', nombre: 'PDFs de ensayos', ruta: path.join(RAIZ, 'pdfs') },
        { clave: 'backups', nombre: 'Backups', ruta: path.join(RAIZ, 'backups') }
    ];

    const volumenes = await Promise.all(carpetas.map(async c => ({
        clave: c.clave,
        nombre: c.nombre,
        ...(await espacioLibre(c.ruta)),
        ...(await medirCarpeta(c.ruta))
    })));

    const [recetas, monitor, wal, backups, pdfsRespaldados] = await Promise.all([
        tamanioArchivo(path.join(RAIZ, 'data', 'recetas.db')),
        tamanioArchivo(path.join(RAIZ, 'data', 'monitor.db')),
        tamanioArchivo(path.join(RAIZ, 'data', 'monitor.db-wal')),
        resumirBackups(path.join(RAIZ, 'backups')),
        medirCarpeta(path.join(RAIZ, 'backups', 'pdfs'))
    ]);

    const pdfs = volumenes.find(v => v.clave === 'pdfs');

    return {
        volumenes,
        bases: { recetasBytes: recetas, monitorBytes: monitor === null ? null : monitor + (wal || 0) },
        backups,
        pdfs: { cantidad: pdfs.archivos, respaldados: pdfsRespaldados.archivos }
    };
}

// El conteo de archivos puede tardar si hay miles de PDFs: se calcula como
// mucho una vez por minuto, aunque el panel pida datos cada pocos segundos.
async function disco() {

    if (cacheDisco.datos && Date.now() - cacheDisco.momento < VIGENCIA_DISCO_MS) {
        return cacheDisco.datos;
    }

    if (!calculandoDisco) {

        calculandoDisco = calcularDisco()
            .then(datos => {
                cacheDisco = { momento: Date.now(), datos };
                return datos;
            })
            .finally(() => {
                calculandoDisco = null;
            });
    }

    return calculandoDisco;
}

// ======================================================
// FOTO ACTUAL E HISTORIAL
// ======================================================

function snapshot() {

    const memoria = process.memoryUsage();
    const total = os.totalmem();
    const libre = os.freemem();
    const ultima = muestras[muestras.length - 1] || {};
    const recursos = recursosActivos();

    const haceUnaHora = Date.now() - 60 * 60 * 1000;
    const enLaUltimaHora = muestras.filter(m => m.t >= haceUnaHora);

    // Cuánto creció (o bajó) la memoria del programa en la última hora.
    // Solo tiene sentido con al menos 30 minutos de historial.
    const variacionRss1h = enLaUltimaHora.length > 0 && Date.now() - enLaUltimaHora[0].t >= 30 * 60 * 1000
        ? memoria.rss - enLaUltimaHora[0].rss
        : null;

    const picoRss = muestras.reduce((maximo, m) => Math.max(maximo, m.rss), memoria.rss);

    return {
        memoria: {
            rss: memoria.rss,
            heapUsado: memoria.heapUsed,
            heapTotal: memoria.heapTotal,
            externa: memoria.external + memoria.arrayBuffers,
            variacionRss1h,
            picoRss24h: picoRss
        },
        contenedor: memoriaContenedor(),
        maquina: {
            totalBytes: total,
            libreBytes: libre,
            nucleos: os.cpus().length,
            cargaPromedio: process.platform === 'win32' ? null : os.loadavg()
        },
        cpu: {
            proceso: ultima.cpuProceso === undefined ? null : ultima.cpuProceso,
            servidor: ultima.cpuServidor === undefined ? null : ultima.cpuServidor
        },
        eventLoop: {
            medio: ultima.lagMedio === undefined ? null : ultima.lagMedio,
            p99: ultima.lagP99 === undefined ? null : ultima.lagP99,
            max: ultima.lagMax === undefined ? null : ultima.lagMax
        },
        recursos,
        arranque: Date.now() - process.uptime() * 1000,
        uptimeProgramaS: process.uptime(),
        uptimeServidorS: os.uptime(),
        nodeVersion: process.version,
        plataforma: `${os.type()} ${os.release()} (${process.arch})`,
        pid: process.pid,
        zonaHoraria: Intl.DateTimeFormat().resolvedOptions().timeZone,
        horaServidor: Date.now()
    };
}

// Columnas para graficar. Con muchas muestras se agrupan en tramos
// (promedio; en el retraso del event loop, el máximo del tramo).
function historial(horas) {

    const desde = Date.now() - horas * 3600 * 1000;
    const lista = muestras.filter(m => m.t >= desde);

    const tramo = Math.max(1, Math.ceil(lista.length / PUNTOS_MAXIMOS_GRAFICO));

    const salida = { t: [], rss: [], heapUsado: [], cpuProceso: [], cpuServidor: [], sockets: [], lagMax: [] };

    const promedio = (grupo, campo) => {

        const valores = grupo.map(m => m[campo]).filter(v => v !== null && v !== undefined);

        return valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
    };

    for (let i = 0; i < lista.length; i += tramo) {

        const grupo = lista.slice(i, i + tramo);

        salida.t.push(grupo[grupo.length - 1].t);
        salida.rss.push(promedio(grupo, 'rss'));
        salida.heapUsado.push(promedio(grupo, 'heapUsado'));
        salida.cpuProceso.push(promedio(grupo, 'cpuProceso'));
        salida.cpuServidor.push(promedio(grupo, 'cpuServidor'));
        salida.sockets.push(promedio(grupo, 'sockets'));
        salida.lagMax.push(Math.max(...grupo.map(m => m.lagMax || 0)));
    }

    return salida;
}

function iniciar() {

    if (iniciado) {
        return;
    }

    iniciado = true;

    engancharConsola();

    histogramaLag = monitorEventLoopDelay({ resolution: RESOLUCION_LAG_MS });
    histogramaLag.enable();

    tomarMuestra();

    timerMuestreo = setInterval(tomarMuestra, INTERVALO_MUESTRA_MS);
    timerMuestreo.unref();
}

module.exports = {
    iniciar,
    snapshot,
    historial,
    disco,
    ultimosErrores,
    // expuestas para poder probarlas
    interpretarCgroup,
    tomarMuestra,
    registrarError
};
