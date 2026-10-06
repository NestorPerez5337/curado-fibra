// ======================================================
// ANÁLISIS DE LA SONDA DEL SQL SERVER
// ======================================================
//
// Lee los registros que deja herramientas/sonda-sql.js y resume:
//   1) cobertura: cuándo corrió la sonda y si hubo huecos (PC apagada o suspendida)
//   2) tiempos por capa: mediana, p95 y máximo
//   3) episodios: tramos con demoras o cortes, con la capa afectada y qué indica
//   4) (opcional) comparación con las ventanas que se quieran revisar y con el
//      historial de producción que se descarga del panel de Estado del Sistema
//
// Uso:
//   node herramientas/analizar-sonda.js [--carpeta <carpeta de la sonda>] [--desde "2026-10-05 20:00"] [--hasta "2026-10-06 08:00"]
//        [--umbral 1000] [--ventanas "2026-10-05 21:51-21:59;2026-10-05 23:50-23:54"]
//        [--produccion sql_historial_3d.csv]
//
// En --ventanas la fecha se escribe una vez: "2026-10-05 21:51-21:59" es de 21:51 a 21:59 de ese día.

const fs = require('fs');
const path = require('path');

function argumento(nombre, defecto) {

    const i = process.argv.indexOf('--' + nombre);

    if (i === -1) {
        return defecto;
    }

    const siguiente = process.argv[i + 1];

    return siguiente === undefined || siguiente.startsWith('--') ? true : siguiente;
}

const CARPETA = path.resolve(argumento('carpeta', path.join(__dirname, '..', '..', 'diagnostico-sql')));
const UMBRAL_MS = parseInt(argumento('umbral', '1000'), 10) || 1000;
const HUECO_MAX_S = 5 * 60;
const UNIR_EPISODIOS_S = 30;

const dos = n => String(n).padStart(2, '0');
const fechaLocal = ms => { const d = new Date(ms); return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`; };
const hora = ms => fechaLocal(ms).slice(11);
const textoDuracion = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`; };
const desdeTexto = t => new Date(t.replace(' ', 'T')).getTime();

function percentil(valores, p) {

    if (!valores.length) return null;

    const ordenados = valores.slice().sort((a, b) => a - b);

    return ordenados[Math.min(ordenados.length - 1, Math.floor(ordenados.length * p))];
}

// ------------------------------------------------------
// Lectura de la sonda
// ------------------------------------------------------

function leerMediciones() {

    if (!fs.existsSync(CARPETA)) {
        console.error(`No existe la carpeta ${CARPETA}`);
        process.exit(1);
    }

    const filas = [];
    const inicios = [];
    const fines = [];

    for (const nombre of fs.readdirSync(CARPETA).filter(n => /^sonda_sql_.*\.jsonl$/.test(n)).sort()) {

        for (const linea of fs.readFileSync(path.join(CARPETA, nombre), 'utf8').split('\n')) {

            if (!linea.trim()) continue;

            let f;

            try { f = JSON.parse(linea); } catch { continue; }

            if (f.tipo === 'medicion') filas.push(f);
            else if (f.tipo === 'inicio') inicios.push(f);
            else if (f.tipo === 'fin') fines.push(f);
        }
    }

    filas.sort((a, b) => a.epoch - b.epoch);

    return { filas, inicios, fines };
}

const CAPAS = [
    ['ping', 'Ping (ICMP)'],
    ['udp', 'SQL Browser (UDP)'],
    ['tcp', 'Red hasta el puerto (TCP)'],
    ['login', 'Conexión nueva (login)'],
    ['consultaNueva', 'Consulta por conexión nueva'],
    ['abierta', 'Consulta por conexión abierta']
];

// Qué capas se ven mal en una medición: { capa: valor|'sin respuesta' }
function capasAfectadas(f, pingSirve, udpSirve) {

    const mal = {};

    for (const [capa] of CAPAS) {

        if (capa === 'ping' && !pingSirve) continue;
        if (capa === 'udp' && !udpSirve) continue;

        // Si todavía no se conocía el puerto, el TCP no se pudo medir (no es una falla de la red)
        if (capa === 'tcp' && f.errores && f.errores.tcp === 'puerto desconocido') continue;

        const v = f[capa];

        if (v === null || v === undefined) {
            // consultaNueva solo falta si el login también falló: ya cuenta como "login"
            if (capa === 'consultaNueva' && (f.login === null || f.login === undefined)) continue;
            mal[capa] = 'sin respuesta';
        } else if (v > UMBRAL_MS) {
            mal[capa] = v;
        }
    }

    return mal;
}

// Qué indica un episodio, según qué capas fallaron
function interpretar(capas) {

    const tiene = c => c in capas;
    const redMal = tiene('tcp') || tiene('ping');
    const sqlMal = tiene('login') || tiene('consultaNueva') || tiene('abierta');

    if (redMal && !sqlMal) return 'RED o MÁQUINA: falló la conexión de red hasta el servidor.';
    if (redMal && sqlMal) return 'TODO: no respondió ni la red ni SQL Server (servidor, red o máquina virtual caídos o colgados).';
    if (sqlMal) return 'SQL SERVER: la red hasta el servidor respondió bien, pero SQL Server tardó o no contestó (está ocupado o trabado).';
    if (tiene('udp')) return 'SQL BROWSER (UDP): solo tardó la consulta del puerto de la instancia; el resto anduvo bien.';

    return 'Sin clasificar.';
}

function armarEpisodios(filas, pingSirve, udpSirve) {

    const episodios = [];
    let actual = null;

    for (const f of filas) {

        const capas = capasAfectadas(f, pingSirve, udpSirve);

        if (Object.keys(capas).length === 0) continue;

        if (actual && f.epoch - actual.fin <= UNIR_EPISODIOS_S * 1000) {
            actual.fin = f.epoch;
            actual.mediciones++;
        } else {
            actual = { inicio: f.epoch, fin: f.epoch, mediciones: 1, capas: {} };
            episodios.push(actual);
        }

        for (const [capa, v] of Object.entries(capas)) {

            const previo = actual.capas[capa] || { veces: 0, peor: null, sinRespuesta: 0 };

            previo.veces++;

            if (v === 'sin respuesta') previo.sinRespuesta++;
            else if (previo.peor === null || v > previo.peor) previo.peor = v;

            actual.capas[capa] = previo;
        }
    }

    return episodios;
}

function describirCapas(capas) {

    return CAPAS.filter(([c]) => c in capas).map(([c, nombre]) => {
        const x = capas[c];
        const detalle = [x.peor !== null ? `máx ${x.peor} ms` : null, x.sinRespuesta ? `${x.sinRespuesta} sin respuesta` : null].filter(Boolean).join(', ');
        return `${nombre}: ${detalle} (${x.veces}x)`;
    }).join(' | ');
}

// ------------------------------------------------------
// Historial de producción (CSV del panel de Estado)
// ------------------------------------------------------

function parsearCsv(texto) {

    const filas = [];
    let campo = '', fila = [], enComillas = false;

    for (let i = 0; i < texto.length; i++) {

        const c = texto[i];

        if (enComillas) {
            if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
            else if (c === '"') enComillas = false;
            else campo += c;
        } else if (c === '"') enComillas = true;
        else if (c === ',') { fila.push(campo); campo = ''; }
        else if (c === '\n') { fila.push(campo.replace(/\r$/, '')); filas.push(fila); fila = []; campo = ''; }
        else campo += c;
    }

    if (campo !== '' || fila.length) { fila.push(campo.replace(/\r$/, '')); filas.push(fila); }

    const [cabecera, ...datos] = filas;
    const columnas = cabecera.map(c => c.replace(/^﻿/, ''));

    return datos.filter(d => d.length >= columnas.length).map(d => Object.fromEntries(columnas.map((c, i) => [c, d[i]])));
}

function episodiosProduccion(filas) {

    const resultado = [];

    for (const servicio of [...new Set(filas.map(f => f.servicio))]) {

        let actual = null;

        for (const f of filas.filter(x => x.servicio === servicio).sort((a, b) => a.epoch - b.epoch)) {

            const consulta = f.consulta_ms === '' ? null : Number(f.consulta_ms);
            const login = f.login_ms === '' ? null : Number(f.login_ms);
            const tcp = f.tcp_ms === '' ? null : Number(f.tcp_ms);

            const mal = !!f.error || tcp === -1 || (consulta || 0) > UMBRAL_MS || (login || 0) > UMBRAL_MS || (tcp || 0) > UMBRAL_MS;

            if (!mal) continue;

            const epoch = Number(f.epoch);

            if (actual && epoch - actual.fin <= 90 * 1000) {
                actual.fin = epoch;
            } else {
                actual = { servicio, inicio: epoch, fin: epoch, redMal: false, sqlMal: false, ejemplo: f.error || '' };
                resultado.push(actual);
            }

            if (tcp === -1 || (tcp || 0) > UMBRAL_MS) actual.redMal = true;
            if (f.error || (consulta || 0) > UMBRAL_MS || (login || 0) > UMBRAL_MS) actual.sqlMal = true;
            if (!actual.ejemplo && f.error) actual.ejemplo = f.error;
        }
    }

    return resultado.sort((a, b) => a.inicio - b.inicio);
}

// ------------------------------------------------------
// Informe
// ------------------------------------------------------

const { filas, inicios, fines } = leerMediciones();

if (!filas.length) {
    console.log('No hay mediciones en la carpeta todavía.');
    process.exit(0);
}

const desde = argumento('desde', null) ? desdeTexto(argumento('desde', null)) : -Infinity;
const hasta = argumento('hasta', null) ? desdeTexto(argumento('hasta', null)) : Infinity;
const medidas = filas.filter(f => f.epoch >= desde && f.epoch <= hasta);

// ¿El ping y el UDP sirven? (si nunca respondieron, no se consideran fallas)
const pingSirve = medidas.some(f => f.ping !== null && f.ping !== undefined);
const udpSirve = medidas.some(f => f.udp !== null && f.udp !== undefined);

console.log('='.repeat(78));
console.log('SONDA DEL SQL SERVER: ANÁLISIS');
console.log('='.repeat(78));
console.log(`Carpeta: ${CARPETA}`);
console.log(`Mediciones: ${medidas.length}   Desde ${fechaLocal(medidas[0].epoch)}   Hasta ${fechaLocal(medidas[medidas.length - 1].epoch)}`);
console.log(`Umbral de "lento": ${UMBRAL_MS} ms` + (pingSirve ? '' : '   (el ping nunca respondió: ICMP bloqueado, no se usa)') + (udpSirve ? '' : '   (UDP no aplica o nunca respondió: no se usa)'));

// 1) cobertura
const huecos = [];

for (let i = 1; i < medidas.length; i++) {
    if (medidas[i].epoch - medidas[i - 1].epoch > HUECO_MAX_S * 1000) {
        huecos.push({ desde: medidas[i - 1].epoch, hasta: medidas[i].epoch });
    }
}

console.log('\n--- 1) COBERTURA: ¿corrió la sonda todo el tiempo? ---');

if (!huecos.length) {
    console.log('Sin huecos: hubo mediciones continuas.');
} else {
    console.log(`Hubo ${huecos.length} hueco(s) de más de ${HUECO_MAX_S / 60} min sin mediciones (PC apagada o suspendida, o la sonda detenida):`);
    huecos.forEach(h => console.log(`   ${fechaLocal(h.desde)}  ->  ${fechaLocal(h.hasta)}   (${textoDuracion(h.hasta - h.desde)})`));
}

fines.slice(-3).forEach(f => console.log(`   Registro de fin: ${f.fecha} - ${f.motivo}`));

// 2) tiempos por capa
console.log('\n--- 2) TIEMPOS POR CAPA (ms) ---');
console.log('Capa'.padEnd(34) + 'Mediana'.padStart(9) + 'p95'.padStart(9) + 'p99'.padStart(9) + 'Máx'.padStart(9) + 'Sin resp.'.padStart(11) + `  > ${UMBRAL_MS} ms`);

for (const [capa, nombre] of CAPAS) {

    if ((capa === 'ping' && !pingSirve) || (capa === 'udp' && !udpSirve)) continue;

    const valores = medidas.map(f => f[capa]).filter(v => v !== null && v !== undefined);
    const sinRespuesta = medidas.length - valores.length;
    const lentos = valores.filter(v => v > UMBRAL_MS).length;

    console.log(
        nombre.padEnd(34) +
        String(percentil(valores, 0.5) ?? '—').padStart(9) + String(percentil(valores, 0.95) ?? '—').padStart(9) +
        String(percentil(valores, 0.99) ?? '—').padStart(9) + String(valores.length ? Math.max(...valores) : '—').padStart(9) +
        String(sinRespuesta).padStart(11) + String(lentos).padStart(10)
    );
}

// 3) episodios
const episodios = armarEpisodios(medidas, pingSirve, udpSirve);

console.log(`\n--- 3) EPISODIOS CON DEMORAS O CORTES (${episodios.length}) ---`);

if (!episodios.length) {
    console.log('Ninguno: todas las capas respondieron por debajo del umbral.');
}

episodios.forEach((e, i) => {
    console.log(`\n#${i + 1}  ${fechaLocal(e.inicio)}  ->  ${hora(e.fin)}   (${textoDuracion(e.fin - e.inicio + 1000)}, ${e.mediciones} mediciones)`);
    console.log(`    ${describirCapas(e.capas)}`);
    console.log(`    => ${interpretar(e.capas)}`);
});

// 4a) ventanas a revisar
const ventanasTexto = argumento('ventanas', null);

if (ventanasTexto && ventanasTexto !== true) {

    console.log('\n--- 4) VENTANAS REVISADAS (del servidor / de producción) ---');

    for (const v of ventanasTexto.split(';').map(s => s.trim()).filter(Boolean)) {

        const m = v.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);

        if (!m) {
            console.log(`   "${v}": formato no válido (se espera "2026-10-05 21:51-21:59")`);
            continue;
        }

        const ini = desdeTexto(`${m[1]} ${m[2]}`) - 60 * 1000;
        const fin = desdeTexto(`${m[1]} ${m[3]}`) + 60 * 1000;
        const dentro = medidas.filter(f => f.epoch >= ini && f.epoch <= fin);

        if (!dentro.length) {
            console.log(`\n   ${v}: la sonda NO tiene mediciones en esa ventana (¿estaba apagada?).`);
            continue;
        }

        const afectadas = dentro.filter(f => Object.keys(capasAfectadas(f, pingSirve, udpSirve)).length);
        const eps = episodios.filter(e => e.fin >= ini && e.inicio <= fin);

        console.log(`\n   ${v}: ${dentro.length} mediciones, ${afectadas.length} con problemas.`);

        if (!eps.length) {
            console.log('      La sonda NO vio demoras ni cortes desde esta PC en esa ventana (el problema pudo ser solo de la máquina o red de producción).');
        }

        eps.forEach(e => {
            console.log(`      La sonda SÍ vio: ${fechaLocal(e.inicio)} -> ${hora(e.fin)}  ${describirCapas(e.capas)}`);
            console.log(`      => ${interpretar(e.capas)}`);
        });
    }
}

// 4b) historial de producción
const archivoProduccion = argumento('produccion', null);

if (archivoProduccion && archivoProduccion !== true) {

    console.log('\n--- 5) COMPARACIÓN CON EL HISTORIAL DE PRODUCCIÓN ---');

    const produccion = episodiosProduccion(parsearCsv(fs.readFileSync(path.resolve(archivoProduccion), 'utf8')))
        .filter(e => e.fin >= desde && e.inicio <= hasta);

    if (!produccion.length) {
        console.log('El historial de producción no tiene episodios con demoras o cortes en este período.');
    }

    let coinciden = 0;

    produccion.forEach(p => {

        const cerca = episodios.filter(e => e.fin >= p.inicio - 60000 && e.inicio <= p.fin + 60000);
        const cubierto = medidas.some(f => f.epoch >= p.inicio - 60000 && f.epoch <= p.fin + 60000);

        if (cerca.length) coinciden++;

        const tipo = p.redMal ? (p.sqlMal ? 'red y SQL' : 'solo red') : 'SQL (la red respondió)';

        console.log(`\n   Producción [${p.servicio}] ${fechaLocal(p.inicio)} -> ${hora(p.fin)} (${textoDuracion(p.fin - p.inicio + 15000)})  vio: ${tipo}${p.ejemplo ? '  | ' + p.ejemplo.slice(0, 90) : ''}`);

        if (!cubierto) console.log('      La sonda no tiene mediciones en ese momento (no se puede comparar).');
        else if (cerca.length) console.log(`      => TAMBIÉN lo vio la sonda desde esta PC (${cerca.map(e => fechaLocal(e.inicio).slice(11) + '-' + hora(e.fin)).join(', ')}): apunta al SERVIDOR SQL o a la red hasta él.`);
        else console.log('      => La sonda NO lo vio: apunta a la máquina o la red de PRODUCCIÓN (o al contenedor), no al servidor.');
    });

    if (produccion.length) {
        console.log(`\n   Resumen: ${coinciden} de ${produccion.length} episodios de producción también se vieron desde esta PC.`);
    }
}

console.log('\n' + '='.repeat(78));
