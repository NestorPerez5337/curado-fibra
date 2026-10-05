// ======================================================
// CONSUMOS DE ENERGÍA: CONSULTAS (dbo.PAC_Lecturas)
// ======================================================
//
// Cada fila de PAC_Lecturas es una lectura del medidor de un sector, más o
// menos cada 10 minutos (la escribe Node-RED):
//   EnergiaTotal  = valor acumulado del medidor (kWh)
//   Consumo10min  = EnergiaTotal - lectura anterior, o sea lo consumido en
//                   los ~10 minutos ANTERIORES a esa lectura.
//
// Cuando hay cortes de comunicación se pierden lecturas, y la lectura que
// vuelve solo trae su propio Consumo10min: la suma del detalle da menos que
// el consumo real. Por eso el CONSUMO del resumen se calcula con el medidor
// (última lectura del rango - última lectura antes del rango) y los huecos
// se informan aparte.
//
// Rango: "desde" incluido, "hasta" excluido, como un >= / <. Los bordes se
// corren 30 s porque las horas se muestran redondeadas al minuto: la
// lectura de las 17:59:59,99 se ve como 18:00 y tiene que caer en el mismo
// lado del corte que la de las 18:00:00,02.

const { sql, obtenerPool } = require('../ph/sql');

// Más de 15 minutos entre dos lecturas = faltó al menos una.
const HUECO_SEG = 15 * 60;

// Hora redondeada al minuto, como texto 'YYYY-MM-DD HH:MM'
const MINUTO = col => `CONVERT(varchar(16), DATEADD(second, 30, ${col}), 120)`;

// filtros.desde / hasta llegan como 'YYYY-MM-DDTHH:MM' (validados en rutas.js)
// y se pasan como 'YYYY-MM-DD HH:MM:00' (estilo 120 de SQL Server).
const fechaSql = t => `${t.replace('T', ' ')}:00`;

function nuevaConsulta(pool, filtros) {
    return pool.request()
        .input('desde', sql.VarChar(19), fechaSql(filtros.desde))
        .input('hasta', sql.VarChar(19), fechaSql(filtros.hasta))
        .input('sector', sql.VarChar(20), filtros.sector || null);
}

// Lecturas del rango + la última lectura anterior al rango de cada sector
// (para el medidor de inicio y para detectar un hueco que cruza "desde"),
// con la lectura previa de cada una (tPrev / ePrev).
const LECTURAS_CON_PREVIA = `
    DECLARE @d datetime2 = DATEADD(second, -30, CONVERT(datetime2, @desde, 120));
    DECLARE @h datetime2 = DATEADD(second, -30, CONVERT(datetime2, @hasta, 120));

    WITH sectores AS (
        SELECT DISTINCT Sector FROM dbo.PAC_Lecturas
        WHERE @sector IS NULL OR Sector = @sector
    ),
    base AS (
        SELECT Sector, Timestamp, EnergiaTotal, Consumo10min, 1 AS enRango
        FROM dbo.PAC_Lecturas
        WHERE Timestamp >= @d AND Timestamp < @h AND (@sector IS NULL OR Sector = @sector)
        UNION ALL
        SELECT s.Sector, p.Timestamp, p.EnergiaTotal, p.Consumo10min, 0
        FROM sectores s
        CROSS APPLY (
            SELECT TOP 1 Timestamp, EnergiaTotal, Consumo10min
            FROM dbo.PAC_Lecturas
            WHERE Sector = s.Sector AND Timestamp < @d
            ORDER BY Timestamp DESC
        ) p
    ),
    w AS (
        SELECT *,
            LAG(Timestamp)    OVER (PARTITION BY Sector ORDER BY Timestamp) AS tPrev,
            LAG(EnergiaTotal) OVER (PARTITION BY Sector ORDER BY Timestamp) AS ePrev
        FROM base
    ),
    l AS (
        SELECT *,
            CASE WHEN tPrev IS NOT NULL AND DATEDIFF(second, tPrev, Timestamp) > ${HUECO_SEG}
                 THEN 1 ELSE 0 END AS hayHueco,
            -- Energía que el medidor registró y esta lectura NO trae en su
            -- Consumo10min (0 salvo después de algunos huecos).
            CASE WHEN tPrev IS NOT NULL AND EnergiaTotal - ePrev - ISNULL(Consumo10min, 0) > 0.01
                 THEN EnergiaTotal - ePrev - ISNULL(Consumo10min, 0) ELSE 0 END AS perdido
        FROM w
    )`;

// Hay dos clases de huecos (verificado con datos de septiembre 2026):
//  - la mayoría: la lectura que vuelve trae en su Consumo10min TODO lo
//    consumido durante el hueco (cubre más de 10 minutos; perdido = 0);
//  - algunos: la lectura que vuelve trae solo una parte (perdido > 0), y esa
//    energía no aparece en el detalle aunque sí en el medidor.
// "minutos" dice cuántos minutos cubre cada lectura, para no confundir una
// lectura posterior a un hueco con un pico de consumo.
const COLUMNAS_DETALLE = `
    Sector AS sector, ${MINUTO('Timestamp')} AS t,
    EnergiaTotal AS energia, Consumo10min AS consumo,
    CASE WHEN tPrev IS NOT NULL THEN ROUND(DATEDIFF(second, tPrev, Timestamp) / 60.0, 0) END AS minutos,
    CASE WHEN hayHueco = 1 THEN ${MINUTO('tPrev')} END AS huecoDesde,
    CASE WHEN hayHueco = 1 THEN ROUND(DATEDIFF(second, tPrev, Timestamp) / 600.0, 0) - 1 END AS huecoFaltan,
    perdido`;

async function listarSectores() {

    const pool = await obtenerPool();
    const r = await pool.request().query(`SELECT DISTINCT Sector FROM dbo.PAC_Lecturas ORDER BY Sector`);
    return r.recordset.map(f => f.Sector);
}

async function resumen(filtros) {

    const pool = await obtenerPool();

    const r = await nuevaConsulta(pool, filtros).query(`
        ${LECTURAS_CON_PREVIA},
        n AS (
            SELECT *,
                ROW_NUMBER() OVER (PARTITION BY Sector, enRango ORDER BY Timestamp)      AS nAsc,
                ROW_NUMBER() OVER (PARTITION BY Sector, enRango ORDER BY Timestamp DESC) AS nDesc
            FROM l
        )
        SELECT Sector AS sector,
            SUM(enRango) AS lecturas,
            SUM(CASE WHEN enRango = 1 THEN ISNULL(Consumo10min, 0) END) AS sumaDetalle,
            MAX(CASE WHEN enRango = 0 THEN EnergiaTotal END) AS medidorPrevio,
            MAX(CASE WHEN enRango = 1 AND nAsc = 1 THEN EnergiaTotal - ISNULL(Consumo10min, 0) END) AS medidorAntesPrimera,
            MAX(CASE WHEN enRango = 1 AND nDesc = 1 THEN EnergiaTotal END) AS medidorFin,
            MAX(CASE WHEN enRango = 1 AND nAsc = 1 THEN ${MINUTO('Timestamp')} END) AS primera,
            MAX(CASE WHEN enRango = 1 AND nDesc = 1 THEN ${MINUTO('Timestamp')} END) AS ultima,
            SUM(CASE WHEN enRango = 1 THEN hayHueco ELSE 0 END) AS huecos,
            SUM(CASE WHEN enRango = 1 AND hayHueco = 1 THEN ROUND(DATEDIFF(second, tPrev, Timestamp) / 600.0, 0) - 1 ELSE 0 END) AS faltan,
            SUM(CASE WHEN enRango = 1 AND perdido > 0 THEN 1 ELSE 0 END) AS huecosConPerdida
        FROM n
        GROUP BY Sector
        HAVING SUM(enRango) > 0
        ORDER BY Sector`);

    return r.recordset.map(armarSector);
}

// Arma el resultado de un sector: consumo según el medidor y advertencias.
function armarSector(f) {

    const advertencias = [];
    let inicio = f.medidorPrevio;

    if (inicio === null) {
        // No hay lecturas anteriores al rango (el medidor empezó después):
        // tomamos el valor del medidor 10 min antes de la primera lectura.
        inicio = f.medidorAntesPrimera;
        advertencias.push('sin lectura anterior al período: el consumo se cuenta desde la primera lectura');
    }

    let consumo = f.medidorFin - inicio;

    if (consumo < 0) {
        // El medidor volvió a cero o se cambió: no se puede restar.
        consumo = f.sumaDetalle;
        advertencias.push('el medidor se reinició en el período: el consumo es la suma de las lecturas guardadas');
    }

    return {
        sector: f.sector,
        consumo,
        lecturas: f.lecturas,
        sumaDetalle: f.sumaDetalle || 0,
        noRegistrado: Math.max(0, consumo - (f.sumaDetalle || 0)),
        huecos: f.huecos,
        faltan: f.faltan,
        huecosConPerdida: f.huecosConPerdida,
        primera: f.primera,
        ultima: f.ultima,
        advertencias
    };
}

// Una página del detalle, ordenado por sector y hora.
async function detalle(filtros, desdeFila, cantidad) {

    const pool = await obtenerPool();

    const r = await nuevaConsulta(pool, filtros)
        .input('offset', sql.Int, desdeFila)
        .input('cantidad', sql.Int, cantidad)
        .query(`
            ${LECTURAS_CON_PREVIA}
            SELECT ${COLUMNAS_DETALLE}
            FROM l
            WHERE enRango = 1
            ORDER BY Sector, Timestamp
            OFFSET @offset ROWS FETCH NEXT @cantidad ROWS ONLY`);

    return r.recordset;
}

// Todas las lecturas del rango, de a una (para el Excel, sin cargar todo en
// memoria). alLeer(fila) se llama por cada lectura.
async function recorrerDetalle(filtros, alLeer) {

    const pool = await obtenerPool();
    const req = nuevaConsulta(pool, filtros);
    req.stream = true;

    return new Promise((resolve, reject) => {
        req.on('row', alLeer);
        req.on('error', reject);
        req.on('done', resolve);
        req.query(`
            ${LECTURAS_CON_PREVIA}
            SELECT ${COLUMNAS_DETALLE}
            FROM l
            WHERE enRango = 1
            ORDER BY Sector, Timestamp`);
    });
}

module.exports = { listarSectores, resumen, detalle, recorrerDetalle };
