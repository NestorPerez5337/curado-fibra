// ======================================================
// CONSUMOS DE ENERGÍA: EXCEL (.xlsx)
// ======================================================
//
// Dos hojas: "Resumen" (consumo por sector según el medidor, con las
// aclaraciones) y "Detalle" (todas las lecturas guardadas). Se escribe en
// streaming directo a la respuesta: las lecturas no se juntan en memoria.

const ExcelJS = require('exceljs');

const NUM = '#,##0.000';

const dos = n => String(n).padStart(2, '0');

// 'YYYY-MM-DD HH:MM' -> fecha (Date en UTC, como la espera exceljs) y hora
// como fracción de día, para que Excel las trate como fecha/hora de verdad.
function partes(t) {
    const [f, h] = t.split(' ');
    const [a, m, d] = f.split('-').map(Number);
    const [hh, mm] = h.split(':').map(Number);
    return { fecha: new Date(Date.UTC(a, m - 1, d)), hora: (hh * 60 + mm) / 1440 };
}

// 'YYYY-MM-DDTHH:MM' o 'YYYY-MM-DD HH:MM' -> 'DD/MM/YYYY HH:MM'
const legible = t => `${t.slice(8, 10)}/${t.slice(5, 7)}/${t.slice(0, 4)} ${t.slice(11, 16)}`;

function nombreArchivo(filtros) {
    const f = t => t.replace('T', '_').replace(':', '');
    return `Consumos_${filtros.sector || 'Todos'}_${f(filtros.desde)}_a_${f(filtros.hasta)}.xlsx`;
}

const faltanTxt = n => n === 1 ? 'Falta 1 lectura' : `Faltan ${n} lecturas`;

function observacion(l) {

    if (l.huecoDesde && l.perdido > 0) {
        return `${faltanTxt(l.huecoFaltan)} desde las ${legible(l.huecoDesde).slice(11)} del ${legible(l.huecoDesde).slice(0, 10)}: ` +
               `${l.perdido.toFixed(3)} kWh de ese lapso no están en el detalle (sí en el medidor).`;
    }
    if (l.huecoDesde) {
        return `${faltanTxt(l.huecoFaltan)} desde las ${legible(l.huecoDesde).slice(11)} del ${legible(l.huecoDesde).slice(0, 10)}: ` +
               `este consumo cubre ${l.minutos} minutos (incluye el lapso sin lecturas).`;
    }
    if (l.perdido > 0) {
        return `${l.perdido.toFixed(3)} kWh registrados por el medidor no están en esta lectura.`;
    }
    return '';
}

async function escribirExcel(salida, { filtros, resumen, usuario }, recorrerDetalle) {

    const libro = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: salida, useStyles: true, useSharedStrings: false });
    libro.creator = 'curado-fibra';
    libro.created = new Date();

    // ---------------- Hoja Resumen ----------------

    const r = libro.addWorksheet('Resumen');
    r.columns = [
        { width: 24 }, { width: 18 }, { width: 12 }, { width: 12 }, { width: 18 }, { width: 18 }, { width: 70 }
    ];

    const ahora = new Date();
    const generado = `${dos(ahora.getDate())}/${dos(ahora.getMonth() + 1)}/${ahora.getFullYear()} ${dos(ahora.getHours())}:${dos(ahora.getMinutes())}`;

    const titulo = r.addRow(['Consumos de Energía']);
    titulo.font = { bold: true, size: 14 };
    titulo.commit();
    r.addRow(['Período', `${legible(filtros.desde)} → ${legible(filtros.hasta)} (incluye "desde", excluye "hasta")`]).commit();
    r.addRow(['Sector', filtros.sector || 'Todos']).commit();
    r.addRow(['Generado', `${generado}${usuario ? ` por ${usuario}` : ''}`]).commit();
    r.addRow([]).commit();

    const encabezado = r.addRow([
        'Sector', 'Consumo (kWh) según medidor', 'Lecturas guardadas', 'Lecturas faltantes',
        'Suma del detalle (kWh)', 'No registrado en el detalle (kWh)', 'Observaciones'
    ]);
    encabezado.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    encabezado.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F3A52' } };
    encabezado.alignment = { wrapText: true, vertical: 'middle' };
    encabezado.commit();

    const total = { consumo: 0, lecturas: 0, faltan: 0, suma: 0, noReg: 0 };

    resumen.forEach(s => {
        const fila = r.addRow([
            s.sector, s.consumo, s.lecturas, s.faltan, s.sumaDetalle, s.noRegistrado,
            s.advertencias.join(' · ')
        ]);
        [2, 5, 6].forEach(c => { fila.getCell(c).numFmt = NUM; });
        fila.commit();
        total.consumo += s.consumo; total.lecturas += s.lecturas; total.faltan += s.faltan;
        total.suma += s.sumaDetalle; total.noReg += s.noRegistrado;
    });

    const filaTotal = r.addRow(['Total', total.consumo, total.lecturas, total.faltan, total.suma, total.noReg, '']);
    filaTotal.font = { bold: true };
    [2, 5, 6].forEach(c => { filaTotal.getCell(c).numFmt = NUM; });
    filaTotal.commit();

    r.addRow([]).commit();
    [
        '¿Cómo se calcula el consumo?',
        'El consumo es la diferencia del medidor (Energía total) entre la última lectura del período y la última lectura anterior al período. Es el consumo real aunque falten lecturas.',
        'La hoja Detalle tiene solo las lecturas que se pudieron guardar. Cada "Consumo" es lo consumido desde la lectura anterior: normalmente 10 minutos (ver columna "Minutos que cubre").',
        'Cuando hay cortes de comunicación faltan lecturas. Casi siempre la lectura siguiente trae todo el consumo del corte (cubre más minutos); a veces no, y esa energía queda solo en el medidor ("No registrado en el detalle").'
    ].forEach((texto, i) => {
        const fila = r.addRow([texto]);
        if (i === 0) fila.font = { bold: true };
        fila.commit();
    });

    r.commit();

    // ---------------- Hoja Detalle ----------------

    const d = libro.addWorksheet('Detalle', { views: [{ state: 'frozen', ySplit: 1 }] });
    d.columns = [
        { header: 'Sector', key: 'sector', width: 22 },
        { header: 'Fecha', key: 'fecha', width: 12, style: { numFmt: 'dd/mm/yyyy' } },
        { header: 'Hora', key: 'hora', width: 8, style: { numFmt: 'hh:mm' } },
        { header: 'Energía total (kWh)', key: 'energia', width: 20, style: { numFmt: NUM } },
        { header: 'Consumo (kWh)', key: 'consumo', width: 15, style: { numFmt: NUM } },
        { header: 'Minutos que cubre', key: 'minutos', width: 11 },
        { header: 'Observación', key: 'obs', width: 90 }
    ];
    d.autoFilter = 'A1:G1';
    d.getRow(1).font = { bold: true };

    await recorrerDetalle(l => {
        const { fecha, hora } = partes(l.t);
        d.addRow({
            sector: l.sector, fecha, hora,
            energia: l.energia, consumo: l.consumo, minutos: l.minutos,
            obs: observacion(l)
        }).commit();
    });

    d.commit();
    await libro.commit();
}

module.exports = { escribirExcel, nombreArchivo };
