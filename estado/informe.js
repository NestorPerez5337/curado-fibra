// ======================================================
// INFORME DE LA CONEXIÓN AL SQL SERVER (para quien administra el servidor)
// ======================================================
//
// Arma, con los episodios de cortes y demoras del período (ver episodios.js),
// un texto listo para mandar a quien administra el servidor SQL: qué pasó, a
// qué hora exacta, de qué lado estuvo el problema y qué conviene revisar.
//
// Es una función pura (recibe los datos y devuelve el texto): se usa desde el
// botón "Informe para IT" del panel de Estado.

const { textoTiempoEncendido } = require('./arranques');

const ANCHO = 100;

// Se listan los episodios más recientes si hay muchísimos
const MAX_EPISODIOS_EN_INFORME = 150;

const numero = n => Number(n).toLocaleString('es-AR');

// ------------------------------------------------------
// Fechas en una zona horaria concreta, siempre en 24 horas
// ------------------------------------------------------

function crearFormato(zona) {

    const formato = new Intl.DateTimeFormat('es-AR', {
        timeZone: zona,
        hourCycle: 'h23',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    const partes = ms => Object.fromEntries(formato.formatToParts(new Date(ms)).map(p => [p.type, p.value]));

    return {
        fecha: ms => { const p = partes(ms); return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`; },
        hora: ms => { const p = partes(ms); return `${p.hour}:${p.minute}:${p.second}`; },
        dia: ms => { const p = partes(ms); return `${p.day}/${p.month}/${p.year}`; },
        horaDelDia: ms => parseInt(partes(ms).hour, 10)
    };
}

// "UTC-03:00" para la zona (o null si esta versión de Node no lo sabe decir)
function desfaseDeLaZona(zona, ms) {

    try {

        const parte = new Intl.DateTimeFormat('en-US', { timeZone: zona, timeZoneName: 'longOffset' })
            .formatToParts(new Date(ms))
            .find(p => p.type === 'timeZoneName');

        return parte ? parte.value.replace('GMT', 'UTC') : null;

    } catch {
        return null;
    }
}

// ------------------------------------------------------
// Texto
// ------------------------------------------------------

// Parte un texto largo en renglones de hasta `ancho` caracteres, con sangría.
// `primera` es lo que va al principio del primer renglón (una viñeta o un número);
// los demás empiezan con `sangria`.
function envolver(texto, sangria = '', ancho = ANCHO, primera = sangria) {

    const renglones = [];
    let actual = '';

    const inicio = () => renglones.length === 0 ? primera : sangria;

    for (const palabra of String(texto).split(/\s+/).filter(Boolean)) {

        if (actual && (inicio() + actual + ' ' + palabra).length > ancho) {
            renglones.push(inicio() + actual);
            actual = palabra;
        } else {
            actual = actual ? actual + ' ' + palabra : palabra;
        }
    }

    if (actual) {
        renglones.push(inicio() + actual);
    }

    return renglones;
}

const titulo = (texto, lineas) => lineas.push('', texto, '-'.repeat(texto.length));

function textoPeriodo(horas) {

    if (horas % 24 === 0) {
        const dias = horas / 24;
        return dias === 1 ? 'últimas 24 horas' : `últimos ${dias} días`;
    }

    return `últimas ${horas} horas`;
}

// episodios: del más viejo al más nuevo (como los devuelve detectarEpisodios)
// reinicios: los del período, { arranque, previo }; ultimoArranque: { arranque } o null
function armarInforme({ desde, hasta, ahora = hasta, mediciones = 0, episodios = [], resumen, reinicios = [], ultimoArranque = null, servidor = null, zona }) {

    zona = zona || Intl.DateTimeFormat().resolvedOptions().timeZone;

    const f = crearFormato(zona);
    const desfase = desfaseDeLaZona(zona, ahora);
    const horasPeriodo = Math.round((hasta - desde) / 3600e3);

    const l = [];

    l.push('INFORME DE LA CONEXIÓN AL SQL SERVER');
    l.push('Programa de curado de fibra · panel "Estado del Sistema"');
    l.push('');
    l.push(`Generado:   ${f.fecha(ahora)}`);
    l.push(`Período:    ${textoPeriodo(horasPeriodo)} (${f.fecha(desde)} a ${f.fecha(hasta)})`);
    l.push(`Horas en:   ${zona}${desfase ? ` (${desfase})` : ''}`);

    if (servidor) {
        l.push(`Servidor:   ${servidor}`);
    }

    // ---- 1) resumen
    titulo('1. RESUMEN', l);

    if (mediciones === 0) {

        l.push('No hay mediciones guardadas en este período, así que no se puede decir si hubo cortes.');

    } else if (episodios.length === 0) {

        l.push('En este período no hubo cortes ni demoras: todas las mediciones respondieron en menos de 1 segundo.');

    } else {

        l.push(`${episodios.length === 1 ? 'Se registró' : 'Se registraron'} ${episodios.length} episodio${episodios.length === 1 ? '' : 's'}: ${resumen.cortes} corte${resumen.cortes === 1 ? '' : 's'} y ${resumen.demoras} demora${resumen.demoras === 1 ? '' : 's'}.`);
        l.push(`  · Tiempo total con problemas: ${resumen.tiempoTotalTexto} (el más largo: ${resumen.masLargoTexto}).`);

        if (resumen.causaMasFrecuente) {

            const ejemplo = episodios.find(e => e.causa === resumen.causaMasFrecuente.causa);

            l.push(`  · Causa más frecuente: ${ejemplo ? ejemplo.titulo : resumen.causaMasFrecuente.causa} (${resumen.causaMasFrecuente.veces} de ${episodios.length}).`);
        }
    }

    if (reinicios.length) {
        l.push(`  · Reinicios del servicio SQL Server en el período: ${reinicios.length}.`);
    }

    if (ultimoArranque) {
        l.push(`  · Servicio SQL Server encendido desde: ${f.fecha(ultimoArranque.arranque)} (hace ${textoTiempoEncendido(ahora - ultimoArranque.arranque)}).`);
    }

    if (mediciones > 0) {
        l.push(`  · Mediciones analizadas: ${numero(mediciones)}.`);
    }

    // ---- 2) cómo se mide
    titulo('2. CÓMO SE MIDE', l);

    l.push(...envolver('El programa mide la conexión con el SQL Server cada 15 segundos (cada 5 si está caída), con dos cuentas distintas: la de lectura (Visor PH y Consumos de Energía) y la de escritura de ensayos. En cada medición separa:'));
    l.push(...envolver('la red hasta el puerto del servidor (conexión TCP, sin usuario ni contraseña);', '    ', ANCHO, '  - '));
    l.push(...envolver('una consulta mínima (SELECT 1) por una conexión ya abierta;', '    ', ANCHO, '  - '));
    l.push(...envolver('y, una vez por minuto, abrir una conexión nueva completa (usuario, contraseña y consulta).', '    ', ANCHO, '  - '));
    l.push(...envolver('Si la red responde bien pero el inicio de sesión o la consulta no, el problema está en el SQL Server (ocupado o trabado) y no en la red ni en el programa. Un "corte" es un episodio con alguna medición sin respuesta; una "demora", uno en que respondió pero tardó más de 1 segundo. Las mediciones malas separadas por menos de 90 segundos cuentan como un solo episodio.'));

    if (episodios.length === 0) {
        return cerrar(l);
    }

    // ---- 3) episodios
    titulo('3. EPISODIOS (del más viejo al más nuevo)', l);

    const mostrados = episodios.slice(-MAX_EPISODIOS_EN_INFORME);

    if (mostrados.length < episodios.length) {
        l.push(`Se muestran los ${mostrados.length} más recientes de ${episodios.length}.`, '');
    }

    const anchoNumero = String(episodios.length).length;

    mostrados.forEach((e, i) => {

        const numeroEpisodio = String(episodios.length - mostrados.length + i + 1).padStart(anchoNumero, ' ');
        const mismoDia = f.dia(e.inicio) === f.dia(e.fin);
        const tramo = `${f.fecha(e.inicio)} a ${mismoDia ? f.hora(e.fin) : f.fecha(e.fin)}`;

        l.push(`${numeroEpisodio}. ${tramo} (${e.duracionTexto}) · ${e.gravedad === 'corte' ? 'CORTE' : 'DEMORA'}`);

        const detalle = [e.titulo, e.serviciosTexto.join(' y '), e.peorTexto].filter(Boolean).join(' · ');

        l.push(...envolver(detalle, ' '.repeat(anchoNumero + 2)));

        if (e.reinicio) {
            l.push(' '.repeat(anchoNumero + 2) + `El servicio arrancó el ${f.fecha(e.reinicio.arranque)}.`);
        }
    });

    // ---- 4) horas del día
    const porHora = {};
    const diasPorHora = {};

    // Un reinicio o una pausa del servicio son acciones puntuales, no una falla que se repite a cierta hora
    const paraLasHoras = episodios.filter(e => e.causa !== 'reinicio' && e.causa !== 'pausa');

    for (const e of paraLasHoras) {

        const hora = f.horaDelDia(e.inicio);

        porHora[hora] = (porHora[hora] || 0) + 1;
        (diasPorHora[hora] = diasPorHora[hora] || new Set()).add(f.dia(e.inicio));
    }

    titulo('4. HORAS DEL DÍA EN QUE EMPEZARON', l);

    if (paraLasHoras.length === 0) {
        l.push('Todos los episodios del período fueron reinicios o pausas del servicio.');
    } else {

        l.push(...envolver('Episodios por hora de inicio: ' + Object.keys(porHora).map(Number).sort((a, b) => a - b)
            .map(h => `${String(h).padStart(2, '0')} h: ${porHora[h]}`).join(' · ') +
            (paraLasHoras.length < episodios.length ? ' (sin contar reinicios ni pausas del servicio).' : '')));
    }

    const repetidas = Object.keys(diasPorHora).map(Number).sort((a, b) => a - b).filter(h => diasPorHora[h].size >= 2);

    if (repetidas.length) {

        l.push(...envolver(`Horas con episodios en más de un día: ${repetidas.map(h => `${String(h).padStart(2, '0')} h (en ${diasPorHora[h].size} días)`).join(', ')}. ` +
            'Si el servidor tiene tareas programadas, antivirus, backups o agentes de monitoreo que corran a esas horas, conviene revisarlos primero.'));
    }

    // ---- 5) qué significa cada causa
    titulo('5. QUÉ SIGNIFICA CADA CAUSA', l);

    const vistas = new Set();

    for (const e of episodios) {

        if (vistas.has(e.causa)) {
            continue;
        }

        vistas.add(e.causa);

        l.push(`· ${e.titulo}`);
        l.push(...envolver(e.explicacion, '  '));
        l.push('');
    }

    l.pop();

    // ---- 6) qué pedir
    titulo('6. QUÉ SE PIDE REVISAR EN EL SERVIDOR', l);

    const cuenta = causa => episodios.filter(e => e.causa === causa).length;
    const pedidos = [];

    pedidos.push('Uso de memoria y de procesador del servidor, y qué procesos los consumen, en las horas de la sección 3 (parte de esa información solo se conserva unas horas).');
    pedidos.push('Tareas programadas (Windows y SQL Agent), antivirus, backups o instantáneas de la máquina o de la virtualización que coincidan con esas horas.');
    pedidos.push('Visor de eventos de Windows y registro de errores de SQL Server en esas horas.');

    if (cuenta('reinicio')) {
        pedidos.push(`Hubo ${cuenta('reinicio')} reinicio${cuenta('reinicio') === 1 ? '' : 's'} del servicio SQL Server confirmado${cuenta('reinicio') === 1 ? '' : 's'}: ¿fue${cuenta('reinicio') === 1 ? '' : 'ron'} planificado${cuenta('reinicio') === 1 ? '' : 's'}? ¿Qué ${cuenta('reinicio') === 1 ? 'lo causó' : 'los causó'}?`);
    }

    if (cuenta('puerto')) {
        pedidos.push(`En ${cuenta('puerto')} episodio${cuenta('puerto') === 1 ? '' : 's'} no se pudo abrir la conexión con el puerto del SQL Server: ¿hubo un reinicio del servicio, un corte de red o un cambio de configuración en ese momento?`);
    }

    if (cuenta('red')) {
        pedidos.push(`En ${cuenta('red')} episodio${cuenta('red') === 1 ? '' : 's'} la red hasta el servidor se demoró: revisar la red entre el servidor del programa y el SQL Server.`);
    }

    if (cuenta('credenciales')) {
        pedidos.push(`En ${cuenta('credenciales')} episodio${cuenta('credenciales') === 1 ? '' : 's'} el servidor rechazó el usuario o la contraseña: ¿se cambió o bloqueó alguna de las cuentas del programa?`);
    }

    if (cuenta('pausa')) {
        pedidos.push(`El servicio estaba en pausa en ${cuenta('pausa')} episodio${cuenta('pausa') === 1 ? '' : 's'}: ¿alguien lo pausó a propósito?`);
    }

    pedidos.push('Si hace falta, el programa incluye un script de solo lectura para ejecutar en el servidor y juntar estos datos: sql/diagnostico_servidor_sql.sql.');

    pedidos.forEach((p, i) => l.push(...envolver(p, '   ', ANCHO, `${i + 1}. `)));

    return cerrar(l);
}

function cerrar(lineas) {

    lineas.push('', ...envolver('El historial completo, medición por medición, se descarga como CSV desde el panel "Estado del Sistema".'));

    return lineas.join('\r\n') + '\r\n';
}

module.exports = {
    armarInforme,
    envolver,
    MAX_EPISODIOS_EN_INFORME
};
