// ======================================================
// PDF DE ENSAYO PH
// ======================================================
//
// Arma el informe de un ensayo en A4 apaisado y fondo blanco (para que
// se pueda imprimir), con el mismo gráfico que muestra la pantalla
// (ver grafico.js). Devuelve un Buffer: no se guarda nada en disco.

const PDFDocument = require('pdfkit');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const annotationPlugin = require('chartjs-plugin-annotation');
const GraficoPH = require('./grafico');

// Instancia propia (chartjs-node-canvas carga un Chart.js aislado por
// instancia), así el plugin de anotaciones no afecta los PDFs del otro
// ensayo de presión que genera server.js.
const lienzo = new ChartJSNodeCanvas({
    width: 1600,
    height: 720,
    backgroundColour: 'white',
    chartCallback: ChartJS => {
        ChartJS.register(annotationPlugin);
        ChartJS.defaults.font.family = 'Arial, Helvetica, sans-serif';
        ChartJS.defaults.font.size = 15;
    }
});

const dos = n => String(n).padStart(2, '0');

// 'YYYY-MM-DD HH:MM:SS' -> 'DD/MM/YYYY'
const fechaLarga = t => `${t.slice(8, 10)}/${t.slice(5, 7)}/${t.slice(0, 4)}`;

function ahoraTexto() {
    const d = new Date();
    return `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()} ${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

const limpio = v => String(v || '').replace(/[^A-Za-z0-9-]+/g, '-');

// ensayos: el primero es el principal; si hay más, es una comparación.
function nombreArchivoPdf(ensayos) {
    const ensayo = ensayos[0];
    const ref = ensayo.resumen ? ensayo.resumen.inicio : ensayo.fechaEnsayo;
    const fecha = ref.slice(0, 10);
    const hora = ref.slice(11, 13) + ref.slice(14, 16);
    const canos = ensayo.cano2 ? `${limpio(ensayo.cano)}y${limpio(ensayo.cano2)}` : limpio(ensayo.cano);
    const otros = ensayos.slice(1).map(e => `_vs_E${e.id}`).join('');
    return `${limpio(ensayo.maquina)}_OP${limpio(ensayo.op)}_CANO${canos}_${fecha}_${hora}_E${ensayo.id}${otros}.pdf`;
}

async function generarPdfEnsayo(ensayos, usuario) {

    const comparar = ensayos.length > 1;
    const ensayo = ensayos[0];

    const imagen = await lienzo.renderToBuffer(GraficoPH.construir(ensayos, { tema: 'claro', escalaFuente: 1.4 }));

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
    const partes = [];
    doc.on('data', p => partes.push(p));
    const terminado = new Promise((resolve, reject) => {
        doc.on('end', () => resolve(Buffer.concat(partes)));
        doc.on('error', reject);
    });

    const izq = 36;
    const ancho = doc.page.width - 72;
    const r = ensayo.resumen;
    const u = ensayo.unidad;
    const num = v => (v === null || v === undefined) ? '—' : String(Math.round(v));
    const mmss = GraficoPH.mmss;
    const canos = ensayo.cano2 ? `${ensayo.cano} y ${ensayo.cano2}` : ensayo.cano;

    // Encabezado
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#111')
        .text(comparar ? 'COMPARACIÓN DE ENSAYOS HIDRÁULICOS' : 'INFORME DE ENSAYO HIDRÁULICO', izq, 36, { width: ancho, align: 'left' });
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0077b6')
        .text(
            comparar ? `${ensayo.maquina}  ·  ${ensayos.length} ensayos` : `${ensayo.maquina}  ·  Ensayo N° ${ensayo.id}`,
            izq, 40, { width: ancho, align: 'right' }
        );

    doc.moveTo(izq, 62).lineTo(izq + ancho, 62).lineWidth(1).strokeColor('#0077b6').stroke();

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111')
        .text(ensayo.producto || '', izq, 72, { width: ancho });

    // Tarjetas de datos, en filas de 4
    const datos = comparar ? [
        ['OP', ensayo.op],
        [ensayo.cano2 ? 'Caños' : 'Caño', canos],
        ['Presión mín / máx', `${num(ensayo.min)} / ${num(ensayo.max)} ${u}`],
        ['Ensayos comparados', ensayos.map(e => `N° ${e.id}`).join(', ')]
    ] : [
        ['OP', ensayo.op],
        [ensayo.cano2 ? 'Caños' : 'Caño', canos],
        ['Fecha', r ? fechaLarga(r.inicio) : fechaLarga(ensayo.fechaEnsayo)],
        ['Inicio – Fin', r ? `${r.inicio.slice(11, 19)} – ${r.fin.slice(11, 19)}` : '—'],
        ['Presión mín / máx', `${num(ensayo.min)} / ${num(ensayo.max)} ${u}`],
        ['Pico alcanzado', r ? `${num(r.pico.p)} ${u}  (${r.pico.t.slice(11, 19)})` : '—'],
        ['Tiempo sobre mínima', r && r.segSobreMin !== null ? mmss(r.segSobreMin) : '—'],
        ['Duración', r ? `${mmss(r.duracionSeg)}  (${r.muestras} lecturas)` : '—']
    ];

    const colAncho = ancho / 4;
    const filaAlto = 34;
    const yGrilla = 92;

    datos.forEach(([titulo, valor], i) => {
        const x = izq + (i % 4) * colAncho;
        const y = yGrilla + Math.floor(i / 4) * filaAlto;
        doc.rect(x + 2, y, colAncho - 4, filaAlto - 4).fillColor('#f3f6f9').fill();
        doc.font('Helvetica').fontSize(7).fillColor('#667')
            .text(titulo.toUpperCase(), x + 8, y + 4, { width: colAncho - 16 });
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111')
            .text(String(valor || '—'), x + 8, y + 15, { width: colAncho - 16, lineBreak: false, ellipsis: true });
    });

    let yGrafico = yGrilla + Math.ceil(datos.length / 4) * filaAlto + 8;

    // Comparación: una fila por ensayo con el color de su curva
    if (comparar) {

        const colores = GraficoPH.TEMAS.claro.curvas;
        const columnas = [
            ['Ensayo', 0.16], ['Fecha', 0.12], ['Inicio – Fin', 0.20],
            ['Duración', 0.14], ['Pico alcanzado', 0.20], ['Tiempo sobre mínima', 0.18]
        ];
        const altoFila = 16;
        let y = yGrafico;

        const fila = (celdas, negrita) => {
            let x = izq;
            celdas.forEach((texto, i) => {
                const w = ancho * columnas[i][1];
                doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(negrita ? 7.5 : 9.5).fillColor(negrita ? '#667' : '#111')
                    .text(texto, x + (i === 0 ? 18 : 6), y + 4, { width: w - 10, lineBreak: false, ellipsis: true });
                x += w;
            });
            y += altoFila;
        };

        doc.rect(izq, y, ancho, altoFila).fillColor('#f3f6f9').fill();
        fila(columnas.map(c => c[0].toUpperCase()), true);

        ensayos.forEach((e, i) => {
            const re = e.resumen;
            doc.rect(izq + 6, y + 4, 8, 8).fillColor(colores[i % colores.length]).fill();
            fila([
                `N° ${e.id}${i === 0 ? ' (principal)' : ''}`,
                re ? fechaLarga(re.inicio) : fechaLarga(e.fechaEnsayo),
                re ? `${re.inicio.slice(11, 19)} – ${re.fin.slice(11, 19)}` : '—',
                re ? mmss(re.duracionSeg) : '—',
                re ? `${num(re.pico.p)} ${u}  (${re.pico.t.slice(11, 19)})` : '—',
                re && re.segSobreMin !== null ? mmss(re.segSobreMin) : '—'
            ], false);
            doc.moveTo(izq, y).lineTo(izq + ancho, y).lineWidth(0.5).strokeColor('#e4e4e4').stroke();
        });

        yGrafico = y + 8;
    }

    // Gráfico
    const altoDisponible = doc.page.height - yGrafico - 50;
    doc.image(imagen, izq, yGrafico, { fit: [ancho, altoDisponible], align: 'center' });

    // Pie (sin margen inferior: si no, pdfkit lo manda a una hoja nueva)
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor('#888')
        .text(
            `Generado el ${ahoraTexto()}${usuario ? ` por ${usuario}` : ''} · curado-fibra · Datos: ${ensayo.maquina} (SQL Automatizacion)`,
            izq, doc.page.height - 44, { width: ancho, align: 'center', lineBreak: false }
        );

    doc.end();

    return terminado;
}

module.exports = { generarPdfEnsayo, nombreArchivoPdf };
