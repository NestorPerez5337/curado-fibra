// ======================================================
// CONSUMOS DE ENERGÍA: RUTAS
// ======================================================
//
// Se monta desde server.js con:
//   require('./energia/rutas')(app, { requierePermiso, requierePermisoPagina });
//
// Usa el permiso 'energia' y la misma conexión de SOLO LECTURA al SQL Server
// que el Visor PH (ph/sql.js).

const path = require('path');
const consultas = require('./consultas');
const { escribirExcel, nombreArchivo } = require('./excel');
const { estaConfigurado, esErrorDeConexion } = require('../ph/sql');

// Selector de fecha propio: el <input type="datetime-local"> nativo muestra
// el formato del navegador (en Edge en inglés, mes/día y AM/PM), que se
// confunde con el día/mes de la app. Se sirve desde node_modules porque
// las PCs de planta pueden no tener internet.
const FLATPICKR = path.join(path.dirname(require.resolve('flatpickr')), '..', 'dist');
const ARCHIVOS_ESTATICOS = {
    'flatpickr.min.js': path.join(FLATPICKR, 'flatpickr.min.js'),
    'flatpickr-dark.css': path.join(FLATPICKR, 'themes', 'dark.css'),
    'flatpickr-es.js': path.join(FLATPICKR, 'l10n', 'es.js')
};

const POR_PAGINA = 500;
const MAXIMO_DIAS = 400;
const FECHA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const SECTOR = /^[A-Za-z0-9_-]{1,20}$/;

// Una lectura cada ~10 min: más de 15 sin lecturas al final del período = faltan.
const HUECO_MIN = 15;

// 'YYYY-MM-DDTHH:MM' o 'YYYY-MM-DD HH:MM' -> minutos (sin zona horaria:
// solo se usan para restar entre sí).
const minutosDe = t => Date.parse(`${t.slice(0, 10)}T${t.slice(11, 16)}:00Z`) / 60000;

function ahoraLocal() {
    const d = new Date();
    const dos = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}T${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

// Devuelve { filtros } o { error }.
function leerFiltros(q) {

    const desde = typeof q.desde === 'string' ? q.desde : '';
    const hasta = typeof q.hasta === 'string' ? q.hasta : '';
    const sector = typeof q.sector === 'string' && q.sector.trim() ? q.sector.trim() : null;

    if (!FECHA_HORA.test(desde) || !FECHA_HORA.test(hasta) || isNaN(minutosDe(desde)) || isNaN(minutosDe(hasta))) {
        return { error: 'Fechas inválidas' };
    }
    if (minutosDe(hasta) <= minutosDe(desde)) {
        return { error: '"Hasta" tiene que ser posterior a "desde"' };
    }
    if (minutosDe(hasta) - minutosDe(desde) > MAXIMO_DIAS * 1440) {
        return { error: `El rango máximo es de ${MAXIMO_DIAS} días` };
    }
    if (sector && !SECTOR.test(sector)) {
        return { error: 'Sector inválido' };
    }

    return { filtros: { desde, hasta, sector } };
}

// Suma al resumen la advertencia de un corte al final del período (no se
// ve como hueco entre lecturas porque no hay lectura posterior).
function agregarHuecoFinal(sectores, filtros) {

    const fin = Math.min(minutosDe(filtros.hasta), minutosDe(ahoraLocal()));

    sectores.forEach(s => {
        const sinLecturas = fin - minutosDe(s.ultima);
        if (sinLecturas > HUECO_MIN) {
            s.advertencias.push(
                `sin lecturas desde las ${s.ultima.slice(11)} del ${s.ultima.slice(8, 10)}/${s.ultima.slice(5, 7)} ` +
                'hasta el final del período: ese consumo no está incluido'
            );
        }
    });

    return sectores;
}

function responderError(res, err) {

    console.error('Consumos de energía:', err.message);

    if (!estaConfigurado() || err.code === 'ELOGIN' || esErrorDeConexion(err)) {
        return res.status(503).json({ error: 'Sin conexión con la base de datos. Probá de nuevo en un minuto.' });
    }

    res.status(500).json({ error: 'Error consultando los consumos' });
}

module.exports = function montarEnergia(app, { requierePermiso, requierePermisoPagina }) {

    const permiso = requierePermiso('energia');

    app.get('/energia', requierePermisoPagina('energia'), (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'protegido', 'energia.html'));
    });

    app.get('/energia-assets/:archivo', permiso, (req, res) => {
        const archivo = ARCHIVOS_ESTATICOS[req.params.archivo];
        if (!archivo) return res.status(404).send('No existe');
        res.sendFile(archivo, { maxAge: '1d' });
    });

    app.get('/api/energia/sectores', permiso, async (req, res) => {
        try {
            res.json(await consultas.listarSectores());
        } catch (err) {
            responderError(res, err);
        }
    });

    app.get('/api/energia/resumen', permiso, async (req, res) => {

        const { filtros, error } = leerFiltros(req.query);
        if (error) return res.status(400).json({ error });

        try {
            const sectores = agregarHuecoFinal(await consultas.resumen(filtros), filtros);
            res.json({ filtros, sectores, porPagina: POR_PAGINA });
        } catch (err) {
            responderError(res, err);
        }
    });

    app.get('/api/energia/detalle', permiso, async (req, res) => {

        const { filtros, error } = leerFiltros(req.query);
        if (error) return res.status(400).json({ error });

        const pagina = /^\d{1,6}$/.test(String(req.query.pagina || '0')) ? parseInt(req.query.pagina || '0', 10) : 0;

        try {
            res.json(await consultas.detalle(filtros, pagina * POR_PAGINA, POR_PAGINA));
        } catch (err) {
            responderError(res, err);
        }
    });

    app.get('/api/energia/excel', permiso, async (req, res) => {

        const { filtros, error } = leerFiltros(req.query);
        if (error) return res.status(400).json({ error });

        let resumen;

        try {
            resumen = agregarHuecoFinal(await consultas.resumen(filtros), filtros);
        } catch (err) {
            return responderError(res, err);
        }

        if (!resumen.length) return res.status(404).json({ error: 'No hay lecturas en ese período' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo(filtros)}"`);

        try {
            await escribirExcel(res, { filtros, resumen, usuario: req.usuario.usuario },
                alLeer => consultas.recorrerDetalle(filtros, alLeer));
        } catch (err) {
            // El archivo ya se empezó a mandar: solo queda cortar la descarga.
            console.error('Consumos de energía: error generando el Excel:', err.message);
            res.destroy(err);
        }
    });
};
