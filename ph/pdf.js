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

function nombreArchivoPdf(ensayo) {
    const limpio = v => String(v || '').replace(/[^A-Za-z0-9-]+/g, '-');
    const ref = ensayo.resumen ? ensayo.resumen.inicio : ensayo.fechaEnsayo;
    const fecha = ref.slice(0, 10);
    const hora = ref.slice(11, 13) + ref.slice(14, 16);
    const canos = ensayo.cano2 ? `${limpio(ensayo.cano)}y${limpio(ensayo.cano2)}` : limpio(ensayo.cano);
    return `${limpio(ensayo.maquina)}_OP${limpio(ensayo.op)}_CANO${canos}_${fecha}_${hora}_E${ensayo.id}.pdf`;
}

async function generarPdfEnsayo(ensayo, usuario) {

    const imagen = await lienzo.renderToBuffer(GraficoPH.construir([ensayo], { tema: 'claro', escalaFuente: 1.4 }));

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

    // Encabezado
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#111')
        .text('INFORME DE ENSAYO HIDRÁULICO', izq, 36, { width: ancho, align: 'left' });
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0077b6')
        .text(`${ensayo.maquina}  ·  Ensayo N° ${ensayo.id}`, izq, 40, { width: ancho, align: 'right' });

    doc.moveTo(izq, 62).lineTo(izq + ancho, 62).lineWidth(1).strokeColor('#0077b6').stroke();

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111')
        .text(ensayo.producto || '', izq, 72, { width: ancho });

    // Grilla de datos: 4 columnas x 2 filas
    const datos = [
        ['OP', ensayo.op],
        [ensayo.cano2 ? 'Caños' : 'Caño', ensayo.cano2 ? `${ensayo.cano} y ${ensayo.cano2}` : ensayo.cano],
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

    // Gráfico
    const yGrafico = yGrilla + 2 * filaAlto + 8;
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
