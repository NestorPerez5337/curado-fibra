// ======================================================
// CONSULTAS DE ENSAYOS PH
// ======================================================
//
// Los nombres de tabla salen de maquinas.js (lista fija); los valores que
// manda el usuario (OP, caño, id) van siempre como parámetros.
//
// Las fechas se devuelven como texto 'YYYY-MM-DD HH:MM:SS' armado por el
// propio SQL Server, tal como las guardó Node-RED, para que ninguna
// conversión de zona horaria las corra en el camino.

const { sql, obtenerPool } = require('./sql');

const FECHA = col => `CONVERT(varchar(19), ${col}, 120)`;

// Las columnas de OP y caño son nvarchar(25).
const texto = valor => [sql.NVarChar(25), valor];

// "0" o vacío en NumeroCano2 significa que se ensayó un solo caño.
function normalizarCano2(valor) {
    const v = (valor || '').trim();
    return v && v !== '0' ? v : null;
}

async function listarOps(maquina) {

    const pool = await obtenerPool();

    const r = await pool.request().query(`
        SELECT TOP 300 NumeroOP AS op, COUNT(*) AS ensayos, ${FECHA('MAX(FechaEnsayo)')} AS ultimo
        FROM ${maquina.maestro}
        WHERE NumeroOP IS NOT NULL AND NumeroOP <> ''
        GROUP BY NumeroOP
        ORDER BY MAX(FechaEnsayo) DESC`);

    return r.recordset;
}

async function listarCanos(maquina, op) {

    const pool = await obtenerPool();

    const segundoCano = maquina.tieneCano2 ? `
            UNION ALL
            SELECT NumeroCano2 FROM ${maquina.maestro}
            WHERE NumeroOP = @op AND NumeroCano2 IS NOT NULL AND NumeroCano2 NOT IN ('', '0')` : '';

    const r = await pool.request()
        .input('op', ...texto(op))
        .query(`
            SELECT cano, COUNT(*) AS ensayos FROM (
                SELECT NumeroCano AS cano FROM ${maquina.maestro}
                WHERE NumeroOP = @op AND NumeroCano IS NOT NULL AND NumeroCano <> ''
                ${segundoCano}
            ) x
            GROUP BY cano
            ORDER BY TRY_CAST(cano AS int), cano`);

    return r.recordset;
}

async function listarEnsayos(maquina, op, cano) {

    const pool = await obtenerPool();

    const r = await pool.request()
        .input('op', ...texto(op))
        .input('cano', ...texto(cano))
        .query(`
            SELECT m.Id AS id,
                   m.NumeroCano AS cano,
                   ${maquina.tieneCano2 ? 'm.NumeroCano2' : 'NULL'} AS cano2,
                   ${FECHA('m.FechaEnsayo')} AS fechaEnsayo,
                   ${FECHA('d.inicio')} AS inicio,
                   ${FECHA('d.fin')} AS fin,
                   d.muestras
            FROM ${maquina.maestro} m
            OUTER APPLY (
                SELECT MIN(FechaHora) AS inicio, MAX(FechaHora) AS fin, COUNT(*) AS muestras
                FROM ${maquina.detalle} WHERE Id_Maestro = m.Id
            ) d
            WHERE m.NumeroOP = @op
              AND (m.NumeroCano = @cano ${maquina.tieneCano2 ? 'OR m.NumeroCano2 = @cano' : ''})
            ORDER BY m.FechaEnsayo DESC, m.Id DESC`);

    return r.recordset.map(e => ({ ...e, cano2: normalizarCano2(e.cano2) }));
}

async function obtenerEnsayo(maquina, id) {

    const pool = await obtenerPool();

    const r = await pool.request()
        .input('id', sql.Int, id)
        .query(`
            SELECT Id AS id, NumeroOP AS op, NumeroCano AS cano,
                   ${maquina.tieneCano2 ? 'NumeroCano2' : 'NULL'} AS cano2,
                   CodigoProducto AS producto, PresionMin AS min, PresionMax AS max,
                   UnidadPresion AS unidad, ${FECHA('FechaEnsayo')} AS fechaEnsayo
            FROM ${maquina.maestro}
            WHERE Id = @id;

            SELECT ${FECHA('FechaHora')} AS t, Presion AS p
            FROM ${maquina.detalle}
            WHERE Id_Maestro = @id AND FechaHora IS NOT NULL AND Presion IS NOT NULL
            ORDER BY FechaHora, Id;`);

    const m = r.recordsets[0][0];

    if (!m) return null;

    const puntos = r.recordsets[1].map(d => ({ t: d.t, p: Number(d.p) }));
    const min = m.min === null ? null : Number(m.min);
    const max = m.max === null ? null : Number(m.max);

    return {
        ...m,
        maquina: maquina.nombre,
        cano2: normalizarCano2(m.cano2),
        min,
        max,
        unidad: (m.unidad || 'PSI').trim(),
        puntos,
        resumen: calcularResumen(puntos, min)
    };
}

// ------------------------------------------------------
// Resumen del ensayo (solo informativo: no dice si aprobó)
// ------------------------------------------------------

function segundos(t) {
    return Date.parse(t.replace(' ', 'T') + 'Z') / 1000;
}

function calcularResumen(puntos, min) {

    if (!puntos.length) return null;

    const t0 = segundos(puntos[0].t);
    let pico = puntos[0];
    let cruceMin = null;
    let segSobreMin = 0;

    puntos.forEach((pt, i) => {

        if (pt.p > pico.p) pico = pt;

        if (min !== null && pt.p >= min) {
            if (!cruceMin) cruceMin = pt;
            if (i + 1 < puntos.length) segSobreMin += segundos(puntos[i + 1].t) - segundos(pt.t);
        }
    });

    const ultimo = puntos[puntos.length - 1];

    return {
        inicio: puntos[0].t,
        fin: ultimo.t,
        duracionSeg: segundos(ultimo.t) - t0,
        muestras: puntos.length,
        pico,
        cruceMin,
        segSobreMin: min === null ? null : segSobreMin
    };
}

module.exports = { listarOps, listarCanos, listarEnsayos, obtenerEnsayo, segundos };
