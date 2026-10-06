// ======================================================
// SQL SERVER: CONEXIÓN SIEMPRE LISTA Y VIGILADA
// ======================================================
//
// Lo usan el Visor PH, Consumos de Energía (ph/sql.js) y el guardado de
// ensayos (ensayos-sql.js). Resuelve tres problemas que se notaban como
// "después de un rato sin usarlo cuesta hacer una consulta":
//
// 1) Conexión nueva lenta. Al conectar por nombre de instancia
//    (servidor\instancia) la librería pregunta primero el puerto al servicio
//    SQL Browser por UDP, esperando 2 s por intento y reintentando hasta 3
//    veces: si se pierde un paquete, la conexión tarda 2, 4 o 6 s de más. Acá
//    el puerto se consulta una vez con reintentos rápidos y se recuerda.
//
// 2) Conexión inactiva que murió. Un firewall o el propio servidor pueden
//    cortar una conexión sin avisar, y la primera consulta se queda esperando
//    hasta el tiempo límite (30 s). Cada 15 s se hace un latido (SELECT 1):
//    mantiene la conexión viva y detecta enseguida si dejó de responder, para
//    armar una conexión nueva antes de que la use una persona.
//
// 3) Base caída: esperar 15-30 s para recién ver el cartel de error. Si el
//    latido detecta que no hay respuesta, los pedidos fallan al instante (con
//    un error de conexión, el mismo que ya manejan las pantallas) y el propio
//    latido sigue probando, cada 5 s, hasta que la base vuelve.
//
// El estado (ok / lenta / caída) y los cortes de esta ejecución los muestra
// el panel de Estado del Sistema.

const dgram = require('dgram');
const net = require('net');
const sql = require('mssql');

// Diagnóstico por capas: además del tiempo total de cada latido se mide por
// separado (a) la red hasta el puerto del SQL Server (TCP, sin login), (b) la
// consulta por la conexión ya abierta y (c) cada minuto una conexión NUEVA
// completa (login + consulta). Si la red responde bien y la consulta tarda, el
// SQL Server está ocupado; si tarda la red, es la red o la máquina. Cada medición
// se informa a quien se suscriba con alLatir(), para guardar el historial.
const TIMEOUT_TCP_MS = 5 * 1000;
const TIMEOUT_LOGIN_FRIO_MS = 15 * 1000;
const INTERVALO_LOGIN_FRIO_MS = 60 * 1000;

const INTERVALO_LATIDO_MS = 15 * 1000;
const INTERVALO_LATIDO_CAIDA_MS = 5 * 1000;     // con la base caída se prueba más seguido
const TIMEOUT_LATIDO_MS = 10 * 1000;
const FALLOS_PARA_CAIDA = 2;
const LATENCIA_LENTA_MS = 2000;
// Seguro: si por algún motivo el latido dejara de correr, no se bloquean los
// pedidos para siempre estando "caída": pasado este tiempo se vuelve a intentar.
const MAX_SIN_LATIDO_CAIDA_MS = 60 * 1000;
const MAX_CORTES_GUARDADOS = 20;

const VIGENCIA_PUERTO_MS = 30 * 60 * 1000;
const PUERTO_SQL_BROWSER = 1434;
const INTENTOS_SQL_BROWSER = 4;
const ESPERA_SQL_BROWSER_MS = 700;

const dos = n => String(n).padStart(2, '0');

function fechaHora(ms) {

    const f = new Date(ms);

    return `${dos(f.getDate())}/${dos(f.getMonth() + 1)} ${dos(f.getHours())}:${dos(f.getMinutes())}:${dos(f.getSeconds())}`;
}

function textoDuracion(ms) {

    const s = Math.round(ms / 1000);

    if (s < 60) return `${s} s`;

    const m = Math.floor(s / 60);

    return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Cuánto tarda en abrirse una conexión TCP al puerto del SQL Server (solo la
// red, sin login). Devuelve los ms, o null si no se pudo (rechazada o sin respuesta).
function medirTcp(host, puerto) {

    return new Promise(resolve => {

        const inicio = Date.now();
        const socket = new net.Socket();

        let terminado = false;

        const terminar = ms => {

            if (terminado) {
                return;
            }

            terminado = true;
            socket.destroy();
            resolve(ms);
        };

        socket.setTimeout(TIMEOUT_TCP_MS);

        socket.once('connect', () => terminar(Date.now() - inicio));
        socket.once('timeout', () => terminar(null));
        socket.once('error', () => terminar(null));

        socket.connect({ host, port: puerto });
    });
}

// Pregunta al SQL Browser (UDP 1434) en qué puerto TCP escucha la instancia.
// Devuelve el puerto, o null si no respondió (entonces se conecta por nombre
// de instancia, como antes).
function consultarPuertoInstancia(servidor, instancia) {

    return new Promise(resolve => {

        const paquete = Buffer.concat([Buffer.from([0x04]), Buffer.from(instancia, 'ascii'), Buffer.from([0x00])]);
        const socket = dgram.createSocket('udp4');

        let intentos = 0;
        let temporizador = null;

        const terminar = puerto => {
            clearTimeout(temporizador);
            try { socket.close(); } catch { /* ya estaba cerrado */ }
            resolve(puerto);
        };

        socket.on('message', mensaje => {
            const coincidencia = mensaje.slice(3).toString('ascii').match(/;tcp;(\d+)/);
            terminar(coincidencia ? Number(coincidencia[1]) : null);
        });

        socket.on('error', () => terminar(null));

        const enviar = () => {

            if (intentos >= INTENTOS_SQL_BROWSER) {
                return terminar(null);
            }

            intentos++;

            socket.send(paquete, PUERTO_SQL_BROWSER, servidor, () => {});

            temporizador = setTimeout(enviar, ESPERA_SQL_BROWSER_MS);
        };

        enviar();
    });
}

// Corta la espera si tarda más que `ms` (lo que se estaba esperando sigue por
// su cuenta, pero el que pregunta no queda colgado).
function conLimite(tarea, ms, mensaje) {

    let temporizador;

    const limite = new Promise((_, rechazar) => {
        temporizador = setTimeout(() => {
            const err = new Error(mensaje);
            err.code = 'ETIMEOUT';
            rechazar(err);
        }, ms);
    });

    return Promise.race([tarea(), limite]).finally(() => clearTimeout(temporizador));
}

function crearGestorPool({ nombre, estaConfigurado, configuracion, faltante }) {

    let poolPromise = null;
    let puerto = { valor: null, momento: 0 };
    let latiendo = null;
    let iniciado = false;
    let ultimoFrio = 0;
    let resolviendoPuerto = null;

    const oyentes = [];

    const estado = {
        fase: 'esperando',      // esperando | ok | lenta | caida
        desde: Date.now(),
        latenciaMs: null,
        ultimoError: null,
        fallosSeguidos: 0,
        ultimoLatido: 0
    };

    // Cortes de esta ejecución, el más nuevo primero: { desde, hasta|null, error }
    const cortes = [];

    // Config final: si se conecta por instancia, usa el puerto recordado (o lo
    // consulta una vez) en vez de que la librería lo busque en cada conexión.
    async function configuracionResuelta() {

        const config = configuracion();

        if (!config.options || !config.options.instanceName || config.port) {
            return config;
        }

        if (!puerto.valor || Date.now() - puerto.momento > VIGENCIA_PUERTO_MS) {

            // Si ya hay una consulta al SQL Browser en curso se espera esa misma
            if (!resolviendoPuerto) {
                resolviendoPuerto = consultarPuertoInstancia(config.server, config.options.instanceName)
                    .finally(() => { resolviendoPuerto = null; });
            }

            puerto = { valor: await resolviendoPuerto, momento: Date.now() };
        }

        if (puerto.valor) {
            config.port = puerto.valor;
            delete config.options.instanceName;
        }

        return config;
    }

    function descartarPool() {

        const promesa = poolPromise;

        poolPromise = null;

        // Se cierra el pool viejo para no dejar conexiones colgadas en el servidor
        if (promesa) {
            promesa.then(pool => pool.close()).catch(() => {});
        }
    }

    function abrirPool() {

        if (poolPromise) {
            return poolPromise;
        }

        const promesa = (async () => {

            let pool = null;

            try {

                pool = new sql.ConnectionPool(await configuracionResuelta());

                // Si la conexión se cae, se descarta el pool para que el próximo
                // pedido reconecte en vez de quedar roto para siempre.
                pool.on('error', err => {
                    console.error(`SQL ${nombre}: error en la conexión:`, err.message);
                    if (poolPromise === promesa) descartarPool();
                });

                await pool.connect();

                return pool;

            } catch (err) {

                if (poolPromise === promesa) poolPromise = null;

                // Puede haber cambiado el puerto de la instancia (reinicio del SQL Server)
                puerto = { valor: null, momento: 0 };

                if (pool) {
                    try { await pool.close(); } catch { /* no llegó a abrirse */ }
                }

                throw err;
            }
        })();

        poolPromise = promesa;

        return promesa;
    }

    function errorSinConexion() {

        const err = new Error(`El SQL Server no responde desde las ${fechaHora(estado.desde)} (${estado.ultimoError || 'sin respuesta'})`);

        // Mismo tipo de error que usan las pantallas para avisar "sin conexión"
        err.code = 'ESOCKET';
        err.name = 'ConnectionError';

        return err;
    }

    // Lo que usan las consultas. Con la base caída falla al instante: nadie
    // espera 15-30 s para ver el cartel de error. Cuándo volvió lo detecta el latido.
    function obtenerPool() {

        if (!estaConfigurado()) {
            return Promise.reject(new Error(faltante));
        }

        if (estado.fase === 'caida' && Date.now() - estado.ultimoLatido < MAX_SIN_LATIDO_CAIDA_MS) {
            return Promise.reject(errorSinConexion());
        }

        return abrirPool();
    }

    function registrarExito(latenciaMs) {

        const anterior = estado.fase;
        const nueva = latenciaMs > LATENCIA_LENTA_MS ? 'lenta' : 'ok';

        estado.fallosSeguidos = 0;
        estado.latenciaMs = latenciaMs;

        if (anterior === 'caida') {

            const corte = cortes[0];

            if (corte && corte.hasta === null) {
                corte.hasta = Date.now();
                console.log(`SQL ${nombre}: conexión recuperada tras ${textoDuracion(corte.hasta - corte.desde)} sin respuesta.`);
            }
        }

        if (nueva === 'lenta' && anterior !== 'lenta') {
            console.warn(`SQL ${nombre}: respuesta lenta (${latenciaMs} ms).`);
        }

        if (anterior !== nueva) {
            estado.fase = nueva;
            estado.desde = Date.now();
        }
    }

    function registrarFallo(err) {

        estado.fallosSeguidos++;
        estado.ultimoError = `${err.code ? err.code + ': ' : ''}${err.message}`;

        if (estado.fallosSeguidos < FALLOS_PARA_CAIDA) {
            return;
        }

        if (estado.fase !== 'caida') {

            estado.fase = 'caida';
            estado.desde = Date.now();

            cortes.unshift({ desde: estado.desde, hasta: null, error: estado.ultimoError });
            cortes.length = Math.min(cortes.length, MAX_CORTES_GUARDADOS);

            console.warn(`SQL ${nombre}: sin respuesta (${estado.ultimoError}). Los pedidos fallan al instante hasta que vuelva.`);
        }

        // Se reintenta con una conexión nueva, no con la que quedó trabada
        descartarPool();
    }

    // Cada medición (latido o conexión en frío) se informa a los suscriptos:
    // { t, tipo: 'latido'|'frio', fase, tcpMs, consultaMs, loginMs, error }
    function alLatir(oyente) {
        oyentes.push(oyente);
    }

    function informar(medicion) {

        for (const oyente of oyentes) {

            try {
                oyente({ ...medicion, fase: estado.fase });
            } catch {
                // un suscripto con problemas no puede afectar a la conexión
            }
        }
    }

    const textoError = err => `${err.code ? err.code + ': ' : ''}${err.message}`;

    // Una conexión NUEVA completa (login + consulta) con una conexión descartable:
    // dice cuánto tarda hoy conectarse desde cero. No espera ni frena al latido.
    async function medirLoginEnFrio() {

        const medicion = { t: Date.now(), tipo: 'frio', tcpMs: null, consultaMs: null, loginMs: null, error: null };
        const inicio = Date.now();

        let pool = null;

        try {

            const config = await configuracionResuelta();

            pool = new sql.ConnectionPool({ ...config, pool: { max: 1, min: 0, idleTimeoutMillis: 1000 } });

            await conLimite(async () => {

                await pool.connect();

                medicion.loginMs = Date.now() - inicio;

                const t1 = Date.now();

                await pool.request().query('SELECT 1 AS ok');

                medicion.consultaMs = Date.now() - t1;

            }, TIMEOUT_LOGIN_FRIO_MS, `No respondió en ${TIMEOUT_LOGIN_FRIO_MS / 1000} s`);

        } catch (err) {

            medicion.error = textoError(err);

        } finally {

            if (pool) {
                try { await pool.close(); } catch { /* ya estaba cerrado */ }
            }
        }

        informar(medicion);
    }

    // Latido: una consulta mínima. Nunca lanza error.
    function latir() {

        if (!estaConfigurado()) {
            return Promise.resolve();
        }

        if (latiendo) {
            return latiendo;
        }

        latiendo = (async () => {

            const inicio = Date.now();

            const medicion = { t: inicio, tipo: 'latido', tcpMs: null, consultaMs: null, loginMs: null, error: null };

            // La red (TCP) se mide al mismo tiempo que la consulta, para comparar el mismo instante.
            // tcpMs: los ms que tardó; -1 si no pudo conectar; null si no se midió (puerto desconocido).
            const medicionTcp = configuracionResuelta()
                .then(async config => {

                    if (!config.port) {
                        return null;
                    }

                    const ms = await medirTcp(config.server, config.port);

                    return ms === null ? -1 : ms;
                })
                .catch(() => null);

            // Cada tanto se mide también una conexión nueva completa (sin esperarla)
            if (estado.fase !== 'caida' && inicio - ultimoFrio >= INTERVALO_LOGIN_FRIO_MS) {
                ultimoFrio = inicio;
                medirLoginEnFrio();
            }

            try {

                const eraNueva = !poolPromise;

                await conLimite(async () => {

                    const antes = Date.now();
                    const pool = await abrirPool();
                    const conectado = Date.now();

                    await pool.request().query('SELECT 1 AS ok');

                    medicion.consultaMs = Date.now() - conectado;

                    // Si el pool se acababa de armar, lo que tardó en conectar también es un login real
                    if (eraNueva) {
                        medicion.loginMs = conectado - antes;
                    }

                }, TIMEOUT_LATIDO_MS, `No respondió en ${TIMEOUT_LATIDO_MS / 1000} s`);

                registrarExito(Date.now() - inicio);

            } catch (err) {

                medicion.error = textoError(err);

                registrarFallo(err);

            } finally {

                medicion.tcpMs = await medicionTcp;

                estado.ultimoLatido = Date.now();
                latiendo = null;

                informar(medicion);
            }
        })();

        return latiendo;
    }

    // Para el panel de Estado: devuelve cuántos ms tardó, o lanza el error.
    // Reusa el último latido si es de hace menos de 2 s.
    async function probar() {

        if (!estaConfigurado()) {
            throw new Error(faltante);
        }

        // Con la base caída no se espera otro intento: el latido ya está
        // probando cada 5 s y se informa el último error al instante.
        if (estado.fase !== 'caida' && (latiendo || Date.now() - estado.ultimoLatido >= 2000)) {
            await latir();
        }

        if (estado.fallosSeguidos > 0) {
            throw new Error(estado.ultimoError || 'Sin respuesta');
        }

        return estado.latenciaMs;
    }

    function descripcionCortes() {

        if (cortes.length === 0) {
            return 'Sin cortes desde que arrancó el programa.';
        }

        const ultimo = cortes[0];

        return `Cortes desde que arrancó el programa: ${cortes.length}. Último: ${fechaHora(ultimo.desde)}` +
            (ultimo.hasta
                ? ` a ${fechaHora(ultimo.hasta)} (${textoDuracion(ultimo.hasta - ultimo.desde)}).`
                : ' (sigue sin respuesta).');
    }

    function iniciar() {

        if (iniciado || !estaConfigurado()) {
            return;
        }

        iniciado = true;

        // Un latido, y el siguiente cuando termina: cada 15 s, o cada 5 s si
        // la base está caída (para enterarse enseguida de que volvió).
        const ciclo = async () => {

            try {
                await latir();
            } catch {
                // latir() no lanza errores; esto es solo para que el ciclo nunca se corte
            }

            setTimeout(ciclo, estado.fase === 'caida' ? INTERVALO_LATIDO_CAIDA_MS : INTERVALO_LATIDO_MS).unref();
        };

        setTimeout(ciclo, 3000).unref();
    }

    return {
        obtenerPool,
        probar,
        latir,
        iniciar,
        alLatir,
        descripcionCortes,
        estado: () => ({ ...estado, cortes: cortes.map(c => ({ ...c })) })
    };
}

module.exports = { crearGestorPool, consultarPuertoInstancia, LATENCIA_LENTA_MS };
