// ======================================================
// EPISODIOS DE CORTES Y DEMORAS DEL SQL SERVER
// ======================================================
//
// Convierte el historial de la conexión al SQL Server, por capas (tabla
// sql_latidos, ver sql-pool.js), en una lista de episodios: tramos en los que
// hubo demoras o cortes, con cuánto duraron, a qué servicio afectaron y qué
// capa falló (la red hasta el servidor o el propio SQL Server).
//
// Es una función pura (recibe las filas y devuelve la lista): se usa desde el
// panel de Estado y sirve también para armar informes.
//
// Cada fila del historial es una medición:
//   servicio     'PH' (lectura: Visor PH y Energía) o 'ensayos' (escritura de ensayos)
//   tipo         'latido' (consulta mínima por la conexión abierta) o
//                'frio' (abrir una conexión nueva completa)
//   tcp_ms       lo que tardó la red hasta el puerto; -1 si no pudo conectar; null si no se midió
//   consulta_ms  lo que tardó la consulta
//   login_ms     lo que tardó abrir la conexión y entrar
//   error        texto del error si falló

const UMBRAL_LENTO_MS = 1000;

// Dos mediciones malas con menos de esto entre una y otra son el mismo episodio
const UNIR_EPISODIOS_MS = 90 * 1000;

// Un episodio "sigue" si la última medición mala es de hace menos de esto
const SIGUE_EN_CURSO_MS = 45 * 1000;

const NOMBRE_SERVICIO = {
    PH: 'Visor PH y Energía (lectura)',
    ensayos: 'Guardado de ensayos (escritura)'
};

const textoSegundos = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : `${ms} ms`;

function textoDuracion(ms) {

    if (ms < 1000) {
        return 'menos de 1 s';
    }

    const segundos = Math.round(ms / 1000);

    if (segundos < 60) {
        return `${segundos} s`;
    }

    const minutos = Math.floor(segundos / 60);

    if (minutos < 60) {
        return segundos % 60 ? `${minutos} min ${segundos % 60} s` : `${minutos} min`;
    }

    return `${Math.floor(minutos / 60)} h ${minutos % 60} min`;
}

// Cuánto esperó la medición antes de fallar, si el mensaje lo dice
// ("No respondió en 10 s", "Failed to connect to ... in 15000ms")
function esperaDelError(error) {

    if (!error) {
        return 0;
    }

    const segundos = error.match(/No respondió en (\d+) s/);

    if (segundos) {
        return parseInt(segundos[1], 10) * 1000;
    }

    const milisegundos = error.match(/\bin (\d+)ms/);

    return milisegundos ? parseInt(milisegundos[1], 10) : 0;
}

// Qué le pasó a una medición. `mala` es la que cuenta para un episodio.
function evaluarFila(f) {

    const tcp = f.tcp_ms;

    const sinConexion = tcp === -1;
    const sinRespuesta = !!f.error || sinConexion;
    const redLenta = tcp !== null && tcp !== undefined && tcp > UMBRAL_LENTO_MS;
    const loginLento = (f.login_ms || 0) > UMBRAL_LENTO_MS;
    const consultaLenta = (f.consulta_ms || 0) > UMBRAL_LENTO_MS;

    return {
        mala: sinRespuesta || redLenta || loginLento || consultaLenta,
        sinConexion,
        sinRespuesta,
        redLenta,
        loginLento,
        consultaLenta,
        // cuánto tardó, para saber cuándo terminó realmente esa medición
        tardanzaMs: Math.max(f.consulta_ms || 0, f.login_ms || 0, tcp > 0 ? tcp : 0, esperaDelError(f.error))
    };
}

const esErrorDeCredenciales = error => /Login failed|ELOGIN|\b18456\b/i.test(error || '');
const esErrorDePausa = error => /\bpaused\b|en pausa|\b17142\b/i.test(error || '');

// De qué lado estuvo el problema, según qué capas fallaron
function explicar(ep) {

    const redMal = ep.hayRedLenta || ep.haySinConexion;
    const sqlMal = ep.hayLoginMalo || ep.hayConsultaMala;

    let causa;
    let titulo;
    let explicacion;

    if (ep.hayPausa) {

        causa = 'pausa';
        titulo = 'El servicio SQL Server estaba en pausa';
        explicacion = 'El servidor aceptaba la conexión pero respondía que el servicio está en pausa y no admite conexiones nuevas. Suele ser una acción manual de quien administra el servidor.';

    } else if (ep.hayCredenciales && !redMal) {

        causa = 'credenciales';
        titulo = 'El servidor rechazó el usuario o la contraseña';
        explicacion = 'La red y el servidor respondieron, pero rechazaron el inicio de sesión. Revisar que la contraseña cargada en Portainer (PH_SQL_PASSWORD o ENSAYOS_SQL_PASSWORD) sea la vigente y que la cuenta no haya sido cambiada o bloqueada.';

    } else if (ep.haySinConexion) {

        causa = 'puerto';
        titulo = 'No se pudo abrir la conexión con el SQL Server';
        explicacion = 'Falló la conexión de red al puerto de SQL Server. Si dura menos de un minuto suele ser un reinicio del servicio; si dura más, el servidor o la red hasta él están caídos.';

    } else if (ep.hayRedLenta) {

        causa = 'red';
        titulo = 'La red hasta el servidor se demoró';
        explicacion = `La conexión de red hasta el servidor tardó hasta ${textoSegundos(ep.peor.tcpMs)}. Apunta a la red o a la máquina del servidor.`;

    } else if (sqlMal) {

        causa = 'sql';
        titulo = 'SQL Server tardó o no contestó';
        explicacion = 'La red hasta el servidor respondió bien (la conexión se abrió en milisegundos), pero SQL Server no completó el inicio de sesión o la consulta a tiempo. Apunta al servidor SQL (ocupado o trabado), no a la red ni a este programa.';

        if (ep.hayLoginMalo && !ep.hayConsultaMala) {
            explicacion += ' Las conexiones que ya estaban abiertas respondieron normalmente: afectó a las conexiones nuevas.';
        }

    } else {

        causa = 'otra';
        titulo = 'Falla sin clasificar';
        explicacion = 'Hubo mediciones fuera de lo normal pero no alcanzan para decir de qué lado estuvo el problema.';
    }

    return { causa, titulo, explicacion };
}

function impactoDelEpisodio(servicios, gravedad) {

    const partes = [];

    if (servicios.includes('PH')) {
        partes.push(gravedad === 'corte'
            ? 'las pantallas del Visor PH y de Energía pudieron mostrar error'
            : 'las pantallas del Visor PH y de Energía pudieron tardar en cargar');
    }

    if (servicios.includes('ensayos')) {
        partes.push(gravedad === 'corte'
            ? 'los ensayos terminados se guardan en la base local y se suben solos cuando vuelve la conexión'
            : 'el guardado de ensayos pudo demorarse');
    }

    return partes.length ? partes.join('; ') + '.' : '';
}

function peorTexto(ep) {

    const partes = [];

    // solo las capas que realmente se vieron mal (una consulta de 5 ms en una fila mala no es noticia)
    if (ep.peor.loginMs > UMBRAL_LENTO_MS) {
        partes.push(`conexión nueva ${textoSegundos(ep.peor.loginMs)}`);
    }

    if (ep.peor.consultaMs > UMBRAL_LENTO_MS) {
        partes.push(`consulta ${textoSegundos(ep.peor.consultaMs)}`);
    }

    if (ep.peor.tcpMs > UMBRAL_LENTO_MS) {
        partes.push(`red ${textoSegundos(ep.peor.tcpMs)}`);
    }

    if (ep.sinRespuesta) {
        partes.push(`${ep.sinRespuesta} sin respuesta`);
    }

    return partes.join(' · ');
}

// filas: las del historial (ver arriba), en cualquier orden. Devuelve los
// episodios del más viejo al más nuevo.
function detectarEpisodios(filas, { ahora = Date.now() } = {}) {

    const malas = filas
        .map(f => ({ f, e: evaluarFila(f) }))
        .filter(x => x.e.mala)
        .sort((a, b) => a.f.epoch - b.f.epoch);

    const episodios = [];
    let actual = null;

    for (const { f, e } of malas) {

        const termina = f.epoch + e.tardanzaMs;

        if (actual && f.epoch - actual.fin <= UNIR_EPISODIOS_MS) {
            actual.fin = Math.max(actual.fin, termina);
            actual.ultimaMedicion = f.epoch;
        } else {

            actual = {
                inicio: f.epoch,
                fin: termina,
                ultimaMedicion: f.epoch,
                servicios: new Set(),
                mediciones: 0,
                sinRespuesta: 0,
                peor: { loginMs: 0, consultaMs: 0, tcpMs: 0 },
                haySinConexion: false,
                hayRedLenta: false,
                hayLoginMalo: false,
                hayConsultaMala: false,
                hayCredenciales: false,
                hayPausa: false,
                errorEjemplo: null
            };

            episodios.push(actual);
        }

        actual.servicios.add(f.servicio);
        actual.mediciones++;

        if (e.sinRespuesta) actual.sinRespuesta++;

        actual.peor.loginMs = Math.max(actual.peor.loginMs, f.login_ms || 0);
        actual.peor.consultaMs = Math.max(actual.peor.consultaMs, f.consulta_ms || 0);
        actual.peor.tcpMs = Math.max(actual.peor.tcpMs, f.tcp_ms > 0 ? f.tcp_ms : 0);

        if (e.sinConexion) actual.haySinConexion = true;
        if (e.redLenta) actual.hayRedLenta = true;

        // Una conexión nueva que falla o se demora (al entrar o en su primera consulta) cuenta como "login";
        // una consulta lenta o con error por la conexión abierta cuenta como "consulta".
        // Si la red no pudo conectar, el error ya se explica por la red.
        if (f.tipo === 'frio') {
            if (e.loginLento || e.consultaLenta || (e.sinRespuesta && !e.sinConexion)) actual.hayLoginMalo = true;
        } else if (e.consultaLenta || (e.sinRespuesta && !e.sinConexion)) {
            actual.hayConsultaMala = true;
        }

        if (e.loginLento && f.tipo !== 'frio') actual.hayLoginMalo = true;

        if (f.error) {

            if (esErrorDeCredenciales(f.error)) actual.hayCredenciales = true;
            if (esErrorDePausa(f.error)) actual.hayPausa = true;

            if (!actual.errorEjemplo) actual.errorEjemplo = f.error.slice(0, 200);
        }
    }

    return episodios.map(ep => {

        const servicios = ['PH', 'ensayos'].filter(s => ep.servicios.has(s));
        const gravedad = ep.sinRespuesta > 0 ? 'corte' : 'demora';
        const duracionMs = Math.max(0, ep.fin - ep.inicio);
        const { causa, titulo, explicacion } = explicar(ep);

        return {
            inicio: ep.inicio,
            fin: ep.fin,
            duracionMs,
            duracionTexto: textoDuracion(duracionMs),
            sigue: ahora - ep.ultimaMedicion < SIGUE_EN_CURSO_MS,
            gravedad,
            causa,
            titulo,
            explicacion,
            servicios,
            serviciosTexto: servicios.map(s => NOMBRE_SERVICIO[s]),
            impacto: impactoDelEpisodio(servicios, gravedad),
            mediciones: ep.mediciones,
            sinRespuesta: ep.sinRespuesta,
            peor: ep.peor,
            peorTexto: peorTexto(ep),
            soloConexionesNuevas: ep.hayLoginMalo && !ep.hayConsultaMala && !ep.haySinConexion,
            errorEjemplo: ep.errorEjemplo
        };
    });
}

// Totales para mostrar arriba de la tabla
function resumirEpisodios(episodios) {

    const porCausa = {};

    for (const ep of episodios) {
        porCausa[ep.causa] = (porCausa[ep.causa] || 0) + 1;
    }

    const causaMasFrecuente = Object.entries(porCausa).sort((a, b) => b[1] - a[1])[0];
    const duraciones = episodios.map(e => e.duracionMs);
    const tiempoTotalMs = duraciones.reduce((suma, ms) => suma + ms, 0);

    return {
        total: episodios.length,
        cortes: episodios.filter(e => e.gravedad === 'corte').length,
        demoras: episodios.filter(e => e.gravedad === 'demora').length,
        tiempoTotalMs,
        tiempoTotalTexto: textoDuracion(tiempoTotalMs),
        masLargoMs: duraciones.length ? Math.max(...duraciones) : 0,
        masLargoTexto: duraciones.length ? textoDuracion(Math.max(...duraciones)) : null,
        causaMasFrecuente: causaMasFrecuente ? { causa: causaMasFrecuente[0], veces: causaMasFrecuente[1] } : null,
        porCausa
    };
}

module.exports = {
    detectarEpisodios,
    resumirEpisodios,
    evaluarFila,
    textoDuracion,
    UMBRAL_LENTO_MS,
    UNIR_EPISODIOS_MS
};
