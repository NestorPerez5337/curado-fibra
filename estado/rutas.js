// ======================================================
// ESTADO DEL SISTEMA: RUTAS (solo administradores)
// ======================================================
//
// Panel con cómo está el servidor (memoria, CPU, disco, backups), las
// conexiones a los equipos y a SQL Server, y los últimos errores. Se monta
// desde server.js con:
//
//   require('./estado/rutas')(app, {
//       requiereAdmin, requiereAdminPagina,
//       listarObjetivos,        // equipos/servicios a verificar (ver conexiones.js)
//       resumenEnsayos,         // () => cuántos ensayos esperan subir a SQL Server
//       resumenMonitor          // () => estado de las variables del Monitor
//   });

const path = require('path');
const sistema = require('./sistema');
const { crearVerificador } = require('./conexiones');

const MIN = 60 * 1000;
const HORA = 60 * MIN;

// Umbrales de las alertas
const MEMORIA_AVISO = 0.80;
const MEMORIA_PROBLEMA = 0.90;
const MEMORIA_MAQUINA_AVISO = 0.85;
const MEMORIA_MAQUINA_PROBLEMA = 0.95;
const DISCO_LIBRE_AVISO = 0.15;
const DISCO_LIBRE_PROBLEMA = 0.05;
const DISCO_LIBRE_PROBLEMA_BYTES = 500 * 1024 * 1024;
const LAG_AVISO_MS = 250;
const LAG_PROBLEMA_MS = 1000;
const BACKUP_AVISO_MS = 8 * HORA;       // se hacen cada 6 h
const BACKUP_PROBLEMA_MS = 24 * HORA;
const ENSAYO_PENDIENTE_AVISO_MS = 15 * MIN;
const ENSAYO_PENDIENTE_PROBLEMA_MS = 24 * HORA;
const REINICIO_RECIENTE_MS = 10 * MIN;
const GRACIA_BACKUP_INICIAL_MS = 5 * MIN; // el primero se hace a los 30 s de arrancar

const HORAS_HISTORIAL_VALIDAS = [1, 6, 24];

// Cuánto se guarda el historial de la conexión al SQL Server (ver server.js)
const HORAS_RETENCION_SQL = 7 * 24;

const ORDEN_NIVEL = { ok: 0, info: 0, aviso: 1, problema: 2 };

const porcentaje = (parte, total) => Math.round(parte / total * 100);

const MB = bytes => `${Math.round(bytes / 1024 / 1024)} MB`;

function textoDuracion(ms) {

    const minutos = Math.floor(ms / MIN);

    if (minutos < 1) {
        return 'menos de 1 minuto';
    }

    if (minutos < 60) {
        return `${minutos} min`;
    }

    const horas = Math.floor(minutos / 60);

    return horas < 48 ? `${horas} h ${minutos % 60} min` : `${Math.floor(horas / 24)} días`;
}

// 'YYYY-MM-DD HH:MM:SS' (hora local del servidor) -> epoch en ms
const desdeFechaLocal = texto => new Date(texto.replace(' ', 'T')).getTime();

// ======================================================
// ALERTAS (función pura: recibe los datos, devuelve la lista)
// ======================================================

function evaluarAlertas({ servidor, disco, conexiones, ensayos, monitor, ahora = Date.now() }) {

    const alertas = [];
    const agregar = (nivel, titulo, detalle) => alertas.push({ nivel, titulo, detalle: detalle || null });

    // ---- Memoria del contenedor / del programa
    const contenedor = servidor.contenedor;

    if (contenedor && contenedor.limiteBytes) {

        const uso = contenedor.usoBytes / contenedor.limiteBytes;

        if (uso >= MEMORIA_PROBLEMA) {
            agregar('problema', 'Memoria del contenedor casi llena',
                `Usa ${MB(contenedor.usoBytes)} de ${MB(contenedor.limiteBytes)} (${porcentaje(contenedor.usoBytes, contenedor.limiteBytes)}%). Si llega al límite Docker lo reinicia.`);
        } else if (uso >= MEMORIA_AVISO) {
            agregar('aviso', 'Memoria del contenedor alta',
                `Usa ${MB(contenedor.usoBytes)} de ${MB(contenedor.limiteBytes)} (${porcentaje(contenedor.usoBytes, contenedor.limiteBytes)}%).`);
        }
    }

    // ---- Memoria de la máquina
    const maquina = servidor.maquina;
    const usoMaquina = (maquina.totalBytes - maquina.libreBytes) / maquina.totalBytes;

    if (usoMaquina >= MEMORIA_MAQUINA_PROBLEMA) {
        agregar('problema', 'Memoria del servidor casi llena',
            `Está usada al ${Math.round(usoMaquina * 100)}%: hay riesgo de que el sistema empiece a cortar procesos.`);
    } else if (usoMaquina >= MEMORIA_MAQUINA_AVISO) {
        agregar('aviso', 'Memoria del servidor alta', `Está usada al ${Math.round(usoMaquina * 100)}%.`);
    }

    // ---- Retraso del event loop
    const lag = servidor.eventLoop.max;

    if (lag !== null && lag >= LAG_PROBLEMA_MS) {
        agregar('problema', 'El programa se trabó',
            `En los últimos segundos tuvo una pausa de ${Math.round(lag)} ms: las lecturas de los PLC y las pantallas se demoran.`);
    } else if (lag !== null && lag >= LAG_AVISO_MS) {
        agregar('aviso', 'El programa tuvo una pausa',
            `En los últimos segundos tuvo una pausa de ${Math.round(lag)} ms (puede ser normal mientras se genera un PDF).`);
    }

    // ---- Disco (un aviso por disco físico, no por carpeta)
    const vistos = new Set();

    for (const v of (disco && disco.volumenes) || []) {

        if (v.totalBytes === null || v.totalBytes === 0) {
            continue;
        }

        const clave = `${v.totalBytes}:${v.libreBytes}`;

        if (vistos.has(clave)) {
            continue;
        }

        vistos.add(clave);

        const libre = v.libreBytes / v.totalBytes;
        const detalle = `Quedan ${(v.libreBytes / 1024 / 1024 / 1024).toFixed(1)} GB libres (${Math.round(libre * 100)}%). Afecta a: datos, PDFs y backups.`;

        if (libre < DISCO_LIBRE_PROBLEMA || v.libreBytes < DISCO_LIBRE_PROBLEMA_BYTES) {
            agregar('problema', 'Disco casi lleno', detalle);
        } else if (libre < DISCO_LIBRE_AVISO) {
            agregar('aviso', 'Poco espacio en disco', detalle);
        }
    }

    // ---- Backups
    const iniciadoHace = ahora - servidor.arranque;

    if (disco && iniciadoHace > GRACIA_BACKUP_INICIAL_MS) {

        for (const [clave, nombre] of [['recetas', 'de la base principal'], ['monitor', 'de la base del Monitor']]) {

            const ultimo = disco.backups[clave].ultimo;

            if (ultimo === null) {
                agregar('aviso', `Todavía no hay backups ${nombre}`, 'Se generan solos cada 6 horas; también se puede hacer uno a mano desde Administración.');
                continue;
            }

            const edad = ahora - ultimo;

            if (edad > BACKUP_PROBLEMA_MS) {
                agregar('problema', `El último backup ${nombre} es muy viejo`, `Se hizo hace ${textoDuracion(edad)} (deberían hacerse cada 6 horas).`);
            } else if (edad > BACKUP_AVISO_MS) {
                agregar('aviso', `El último backup ${nombre} se atrasó`, `Se hizo hace ${textoDuracion(edad)} (deberían hacerse cada 6 horas).`);
            }
        }
    }

    // ---- Conexiones
    for (const c of (conexiones && conexiones.resultados) || []) {

        if (c.estado === 'error') {
            agregar(c.critico ? 'problema' : 'aviso', `Sin conexión: ${c.nombre}`, [c.destino, c.detalle].filter(Boolean).join(' — '));
        } else if (c.estado === 'lento') {
            agregar('aviso', `Respuesta lenta: ${c.nombre}`, [`Tarda ${c.latencia_ms} ms en responder.`, c.detalle].filter(Boolean).join(' '));
        } else if (c.estado === 'sin_configurar') {
            agregar('aviso', `Sin configurar: ${c.nombre}`, c.detalle);
        }
    }

    // ---- Ensayos esperando subir a SQL Server
    if (ensayos && ensayos.configurado && ensayos.pendientes > 0 && ensayos.masAntiguo) {

        const espera = ahora - desdeFechaLocal(ensayos.masAntiguo);

        if (espera >= ENSAYO_PENDIENTE_AVISO_MS) {
            agregar(espera >= ENSAYO_PENDIENTE_PROBLEMA_MS ? 'problema' : 'aviso',
                `${ensayos.pendientes} ensayo(s) sin subir a SQL Server`,
                `El más viejo espera hace ${textoDuracion(espera)}. Están guardados en la base local y se reintenta solo cada 5 minutos.` +
                (ensayos.ultimoError ? ` Último error: ${ensayos.ultimoError}` : ''));
        }
    }

    // ---- Monitor de Variables
    if (monitor && monitor.conProblema.length > 0) {
        agregar('aviso', `${monitor.conProblema.length} variable(s) del Monitor con problemas`,
            monitor.conProblema.map(v => v.nombre).slice(0, 8).join(', '));
    }

    // ---- Reinicio reciente (informativo)
    if (iniciadoHace < REINICIO_RECIENTE_MS) {
        agregar('info', 'El programa arrancó hace poco', `Se inició hace ${textoDuracion(iniciadoHace)} (reinicio o actualización).`);
    }

    // problemas primero
    return alertas.sort((a, b) => ORDEN_NIVEL[b.nivel] - ORDEN_NIVEL[a.nivel]);
}

function nivelGeneral(alertas) {

    return alertas.reduce(
        (peor, a) => ORDEN_NIVEL[a.nivel] > ORDEN_NIVEL[peor] ? a.nivel : peor,
        'ok'
    );
}

// ======================================================
// RUTAS
// ======================================================

module.exports = function montarEstado(app, { requiereAdmin, requiereAdminPagina, listarObjetivos, resumenEnsayos, resumenMonitor, listarLatidosSql }) {

    const verificador = crearVerificador({ listarObjetivos });

    const sinFallar = promesa => Promise.resolve(promesa).catch(err => {
        console.error('Estado: no se pudo leer una parte del panel:', err.message);
        return null;
    });

    // Cantidad de personas con sesión abierta (el almacén de sesiones es en memoria)
    const sesionesActivas = req => new Promise(resolve => {

        if (!req.sessionStore || typeof req.sessionStore.length !== 'function') {
            return resolve(null);
        }

        req.sessionStore.length((err, cantidad) => resolve(err ? null : cantidad));
    });

    async function armarEstado(req) {

        const [disco, ensayos, monitor, sesiones] = await Promise.all([
            sinFallar(sistema.disco()),
            sinFallar(resumenEnsayos()),
            sinFallar(resumenMonitor()),
            sesionesActivas(req)
        ]);

        const servidor = sistema.snapshot();
        const conexiones = verificador.ultimo();

        const alertas = evaluarAlertas({ servidor, disco, conexiones, ensayos, monitor });

        return {
            generado: Date.now(),
            general: nivelGeneral(alertas),
            alertas,
            servidor,
            sesiones,
            disco,
            conexiones,
            ensayos,
            monitor,
            errores: sistema.ultimosErrores()
        };
    }

    app.get('/estado', requiereAdminPagina, (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'protegido', 'estado.html'));
    });

    // Foto rápida: usa el último resultado de las conexiones (no las prueba).
    app.get('/api/estado', requiereAdmin, async (req, res) => {

        try {
            res.json(await armarEstado(req));
        } catch (err) {
            console.error('Estado: error armando el panel:', err);
            res.status(500).send('Error');
        }
    });

    // Prueba las conexiones (si el último resultado es viejo, o siempre con
    // ?forzar=1) y devuelve la foto completa.
    app.get('/api/estado/conexiones', requiereAdmin, async (req, res) => {

        try {
            await verificador.verificar({ forzar: req.query.forzar === '1' });
            res.json(await armarEstado(req));
        } catch (err) {
            console.error('Estado: error verificando conexiones:', err);
            res.status(500).send('Error');
        }
    });

    app.get('/api/estado/historial', requiereAdmin, (req, res) => {

        const horas = parseInt(req.query.horas, 10);

        res.json(sistema.historial(HORAS_HISTORIAL_VALIDAS.includes(horas) ? horas : 1));
    });

    // ---- Historial de la conexión al SQL Server, por capas (para el gráfico y para descargar)

    const entero = (valor, minimo, maximo, defecto) => {

        const n = parseInt(valor, 10);

        return Number.isInteger(n) && n >= minimo && n <= maximo ? n : defecto;
    };

    app.get('/api/estado/sql-historial', requiereAdmin, async (req, res) => {

        if (!listarLatidosSql) {
            return res.json({ desde: Date.now(), hasta: Date.now(), filas: [] });
        }

        try {

            const horas = entero(req.query.horas, 1, HORAS_RETENCION_SQL, 6);
            const hasta = Date.now();
            const desde = hasta - horas * HORA;

            const filas = await listarLatidosSql({ desde, hasta, limite: 30000 });

            res.json({ desde, hasta, filas });

        } catch (err) {
            console.error('Estado: error leyendo el historial de SQL:', err.message);
            res.status(500).send('Error');
        }
    });

    // El mismo historial como CSV (se abre en Excel o se le pasa a quien administra el servidor)
    app.get('/api/estado/sql-historial.csv', requiereAdmin, async (req, res) => {

        if (!listarLatidosSql) {
            return res.status(404).send('Sin historial');
        }

        try {

            const dias = entero(req.query.dias, 1, HORAS_RETENCION_SQL / 24, 3);
            const hasta = Date.now();
            const filas = await listarLatidosSql({ desde: hasta - dias * 24 * HORA, hasta, limite: 200000 });

            const celda = valor => {

                if (valor === null || valor === undefined) {
                    return '';
                }

                const texto = String(valor);

                return /[",\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
            };

            const columnas = ['fecha_hora', 'epoch', 'servicio', 'tipo', 'fase', 'tcp_ms', 'consulta_ms', 'login_ms', 'error'];

            const csv = [columnas.join(',')]
                .concat(filas.map(f => columnas.map(c => celda(f[c])).join(',')))
                .join('\r\n');

            res.set({
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="sql_historial_${dias}d.csv"`
            });

            res.send('﻿' + csv);

        } catch (err) {
            console.error('Estado: error exportando el historial de SQL:', err.message);
            res.status(500).send('Error');
        }
    });

    return { evaluarAlertas };
};

module.exports.evaluarAlertas = evaluarAlertas;
module.exports.nivelGeneral = nivelGeneral;
