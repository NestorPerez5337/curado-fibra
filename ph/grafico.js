// ======================================================
// CONFIGURACIÓN DEL GRÁFICO DE ENSAYO PH (Chart.js 3)
// ======================================================
//
// Un único lugar donde se arma el gráfico, usado tanto por la pantalla
// (navegador, tema oscuro, con zoom) como por el PDF (servidor, tema
// claro): así los dos muestran exactamente lo mismo.
//
// El eje X es "segundos desde el inicio del ensayo". Con un solo ensayo
// las marcas se muestran como hora del día; al superponer repeticiones,
// como mm:ss transcurridos, para que todas arranquen juntas.

(function (raiz, fabrica) {
    if (typeof module === 'object' && module.exports) module.exports = fabrica();
    else raiz.GraficoPH = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {

    const TEMAS = {
        oscuro: {
            texto: '#bbb', grilla: '#2c2c2c',
            curvas: ['#00bfff', '#ffb347', '#c77dff', '#80ed99'],
            relleno: 'rgba(0,191,255,0.13)',
            min: '#3ecf6e', max: '#ff7a45', banda: 'rgba(62,207,110,0.08)',
            etiquetaFondo: 'rgba(0,0,0,0.6)', etiquetaTexto: '#fff',
            guia: 'rgba(255,255,255,0.35)', pico: '#fff'
        },
        claro: {
            texto: '#333', grilla: '#e4e4e4',
            curvas: ['#0077b6', '#e07a00', '#7b2cbf', '#2b9348'],
            relleno: 'rgba(0,119,182,0.10)',
            min: '#2b9348', max: '#d9480f', banda: 'rgba(43,147,72,0.09)',
            etiquetaFondo: 'rgba(255,255,255,0.92)', etiquetaTexto: '#111',
            guia: 'rgba(0,0,0,0.35)', pico: '#fff'
        }
    };

    function segundos(t) {
        return Date.parse(t.replace(' ', 'T') + 'Z') / 1000;
    }

    function dos(n) {
        return String(n).padStart(2, '0');
    }

    function mmss(s) {
        s = Math.max(0, Math.round(s));
        return dos(Math.floor(s / 60)) + ':' + dos(s % 60);
    }

    function horaDesde(t0, s) {
        const d = new Date((t0 + Math.round(s)) * 1000);
        return dos(d.getUTCHours()) + ':' + dos(d.getUTCMinutes()) + ':' + dos(d.getUTCSeconds());
    }

    // 'YYYY-MM-DD HH:MM:SS' -> 'DD/MM'
    function diaMes(t) {
        return t.slice(8, 10) + '/' + t.slice(5, 7);
    }

    function presion(v) {
        return String(Math.round(v));
    }

    function etiquetaEnsayo(e) {
        const r = e.resumen;
        return r
            ? `Ensayo ${e.id} (${diaMes(r.inicio)} ${r.inicio.slice(11, 16)} a ${r.fin.slice(11, 16)})`
            : `Ensayo ${e.id}`;
    }

    // ensayos: el primero es el principal; si hay más, se superponen.
    // opciones: { tema: 'oscuro' | 'claro', responsive: bool }
    function construir(ensayos, opciones) {

        opciones = opciones || {};

        const tema = TEMAS[opciones.tema] || TEMAS.oscuro;
        const f = opciones.escalaFuente || 1;
        const fuente = (size, weight) => ({ size: Math.round(size * f), weight });
        const comparar = ensayos.length > 1;
        const principal = ensayos[0];
        const { min, max, unidad } = principal;
        const t0 = principal.puntos.length ? segundos(principal.puntos[0].t) : 0;
        const formatoX = s => comparar ? mmss(s) : horaDesde(t0, s);

        const datasets = ensayos.map((e, i) => {

            const inicio = e.puntos.length ? segundos(e.puntos[0].t) : 0;
            const color = tema.curvas[i % tema.curvas.length];

            return {
                label: etiquetaEnsayo(e),
                data: e.puntos.map(pt => ({ x: segundos(pt.t) - inicio, y: pt.p })),
                borderColor: color,
                backgroundColor: comparar ? color : tema.relleno,
                fill: comparar ? false : 'origin',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.15
            };
        });

        const anotaciones = {};

        if (min !== null && max !== null) {
            anotaciones.banda = {
                type: 'box', yMin: min, yMax: max,
                backgroundColor: tema.banda, borderWidth: 0
            };
        }

        const lineaLimite = (valor, color, texto) => ({
            type: 'line', yMin: valor, yMax: valor,
            borderColor: color, borderWidth: 1.5, borderDash: [6, 4],
            label: {
                display: true, content: `${texto} ${presion(valor)} ${unidad}`, position: 'start',
                backgroundColor: color, color: '#111', font: fuente(11, 'bold')
            }
        });

        if (max !== null) anotaciones.max = lineaLimite(max, tema.max, 'Máx');
        if (min !== null) anotaciones.min = lineaLimite(min, tema.min, 'Mín');

        const r = principal.resumen;

        if (!comparar && r) {

            const xPico = segundos(r.pico.t) - t0;

            anotaciones.pico = {
                type: 'point', xValue: xPico, yValue: r.pico.p, radius: 6,
                backgroundColor: tema.pico, borderColor: tema.curvas[0], borderWidth: 2
            };

            anotaciones.picoTexto = {
                type: 'label', xValue: xPico, yValue: r.pico.p, yAdjust: -24 * f,
                content: `Pico ${presion(r.pico.p)} ${unidad}`,
                color: tema.etiquetaTexto, backgroundColor: tema.etiquetaFondo,
                font: fuente(12, 'bold'), padding: 5
            };

            if (r.cruceMin) {
                const xCruce = segundos(r.cruceMin.t) - t0;
                anotaciones.cruce = {
                    type: 'line', xMin: xCruce, xMax: xCruce,
                    borderColor: tema.guia, borderWidth: 1, borderDash: [3, 3],
                    label: {
                        display: true, content: `Supera mínima ${r.cruceMin.t.slice(11, 19)}`, position: 'end',
                        backgroundColor: tema.etiquetaFondo, color: tema.etiquetaTexto, font: fuente(11, 'bold')
                    }
                };
            }
        }

        const duracion = Math.max(0, ...datasets.map(d => d.data.length ? d.data[d.data.length - 1].x : 0));
        const techo =Math.max(max || 0, ...ensayos.map(e => e.resumen ? e.resumen.pico.p : 0));

        return {
            type: 'line',
            data: { datasets },
            options: {
                responsive: !!opciones.responsive,
                maintainAspectRatio: false,
                animation: false,
                parsing: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: {
                        type: 'linear',
                        min: 0,
                        max: duracion || undefined,
                        title: { display: true, text: comparar ? 'Tiempo desde inicio (mm:ss)' : 'Hora', color: tema.texto },
                        ticks: { color: tema.texto, maxTicksLimit: 16, maxRotation: 0, callback: v => formatoX(v) },
                        grid: { color: tema.grilla }
                    },
                    y: {
                        min: 0,
                        suggestedMax: techo ? Math.ceil(techo * 1.08 / 250) * 250 : undefined,
                        title: { display: true, text: `Presión (${unidad})`, color: tema.texto },
                        ticks: { color: tema.texto, callback: v => String(v) },
                        grid: { color: tema.grilla }
                    }
                },
                plugins: {
                    legend: { labels: { color: tema.texto, usePointStyle: true, boxHeight: 6 } },
                    tooltip: {
                        callbacks: {
                            title: items => items.length ? formatoX(items[0].parsed.x) : '',
                            label: c => ` ${c.dataset.label.split(' (')[0]}: ${presion(c.parsed.y)} ${unidad}`
                        }
                    },
                    annotation: { annotations: anotaciones }
                }
            }
        };
    }

    return { construir, mmss, segundos };
});
