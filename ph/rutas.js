// ======================================================
// VISOR DE ENSAYOS PH: RUTAS
// ======================================================
//
// Se monta desde server.js con:
//   require('./ph/rutas')(app, { requierePermiso, requierePermisoPagina });
//
// Todo usa el permiso 'visor', el mismo del Visor de Ensayos actual.

const path = require('path');
const { obtenerMaquina, listarMaquinas } = require('./maquinas');
const consultas = require('./consultas');
const { generarPdfEnsayo, nombreArchivoPdf } = require('./pdf');
const { estaConfigurado, esErrorDeConexion } = require('./sql');
const lote = require('./lote');

// Librerías del gráfico servidas desde node_modules y no desde internet:
// las PCs de planta pueden no tener salida a internet.
function carpetaPaquete(nombre) {

    // Algunos paquetes no exportan su package.json: en ese caso subimos
    // desde su archivo principal hasta la carpeta del paquete.
    let carpeta = path.dirname(require.resolve(nombre));

    while (path.basename(carpeta) !== nombre && path.dirname(carpeta) !== carpeta) {
        carpeta = path.dirname(carpeta);
    }

    return carpeta;
}

const ARCHIVOS_ESTATICOS = {
    'chart.min.js': path.join(carpetaPaquete('chart.js'), 'dist', 'chart.min.js'),
    'hammer.min.js': path.join(carpetaPaquete('hammerjs'), 'hammer.min.js'),
    'chartjs-plugin-zoom.min.js': path.join(carpetaPaquete('chartjs-plugin-zoom'), 'dist', 'chartjs-plugin-zoom.min.js'),
    'chartjs-plugin-annotation.min.js': path.join(carpetaPaquete('chartjs-plugin-annotation'), 'dist', 'chartjs-plugin-annotation.min.js'),
    'grafico.js': path.join(__dirname, 'grafico.js')
};

// OP y caño son nvarchar(25) en la base.
function textoValido(valor) {
    const v = typeof valor === 'string' ? valor.trim() : '';
    return v.length > 0 && v.length <= 25 ? v : null;
}

// Filtros de la descarga masiva. Devuelve { filtros } o { error }.
function leerFiltrosLote(body) {

    const b = body || {};
    const fecha = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
    const numero = v => /^\d{1,6}$/.test(String(v === undefined || v === null ? '' : v).trim())
        ? parseInt(String(v).trim(), 10) : null;

    const filtros = {
        op: textoValido(b.op),
        desde: fecha(b.desde),
        hasta: fecha(b.hasta),
        canoDesde: numero(b.canoDesde),
        canoHasta: numero(b.canoHasta)
    };

    if (!filtros.op && !filtros.desde && !filtros.hasta && filtros.canoDesde === null && filtros.canoHasta === null) {
        return { error: 'Completá al menos un filtro' };
    }
    if (filtros.desde && filtros.hasta && filtros.desde > filtros.hasta) {
        return { error: 'La fecha "desde" es posterior a la fecha "hasta"' };
    }
    if (filtros.canoDesde !== null && filtros.canoHasta !== null && filtros.canoDesde > filtros.canoHasta) {
        return { error: 'El caño "desde" es mayor que el caño "hasta"' };
    }

    return { filtros };
}

// Texto legible y nombre de ZIP a partir de los filtros.
function describirFiltros(maquinaNombre, f) {

    const ddmmaaaa = t => `${t.slice(8, 10)}/${t.slice(5, 7)}/${t.slice(0, 4)}`;
    const texto = [];
    const nombre = [maquinaNombre];

    if (f.op) {
        texto.push(`OP ${f.op}`);
        nombre.push(`OP${f.op.replace(/[^A-Za-z0-9-]+/g, '-')}`);
    }
    if (f.canoDesde !== null || f.canoHasta !== null) {
        const d = f.canoDesde === null ? 'inicio' : f.canoDesde;
        const h = f.canoHasta === null ? 'fin' : f.canoHasta;
        texto.push(`caños ${d} a ${h}`);
        nombre.push(`C${d}-${h}`);
    }
    if (f.desde || f.hasta) {
        texto.push(`fechas ${f.desde ? ddmmaaaa(f.desde) : 'inicio'} a ${f.hasta ? ddmmaaaa(f.hasta) : 'hoy'}`);
        nombre.push(`${f.desde || 'inicio'}_a_${f.hasta || 'hoy'}`);
    }

    return { texto: texto.join(' · '), nombreZip: `${nombre.join('_')}.zip` };
}

function responderError(res, err) {

    console.error('Visor PH:', err.message);

    // ELOGIN = usuario o contraseña incorrectos (para el usuario, también es "sin conexión").
    if (!estaConfigurado() || err.code === 'ELOGIN' || esErrorDeConexion(err)) {
        return res.status(503).json({ error: 'Sin conexión con la base de ensayos. Avisá al administrador.' });
    }

    res.status(500).json({ error: 'Error consultando los ensayos' });
}

module.exports = function montarVisorPH(app, { requierePermiso, requierePermisoPagina }) {

    const permiso = requierePermiso('visor');

    // Resuelve :maquina contra la lista fija de maquinas.js
    const conMaquina = (req, res, next) => {
        req.maquina = obtenerMaquina(req.params.maquina);
        if (!req.maquina) return res.status(404).json({ error: 'Máquina desconocida' });
        next();
    };

    app.get('/visor-ph', requierePermisoPagina('visor'), (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'protegido', 'visor-ph.html'));
    });

    app.get('/ph-assets/:archivo', permiso, (req, res) => {
        const archivo = ARCHIVOS_ESTATICOS[req.params.archivo];
        if (!archivo) return res.status(404).send('No existe');
        res.sendFile(archivo, { maxAge: '1d' });
    });

    app.get('/api/ph/maquinas', permiso, (req, res) => {
        res.json(listarMaquinas());
    });

    app.get('/api/ph/:maquina/ops', permiso, conMaquina, async (req, res) => {
        try {
            res.json(await consultas.listarOps(req.maquina));
        } catch (err) {
            responderError(res, err);
        }
    });

    app.get('/api/ph/:maquina/canos', permiso, conMaquina, async (req, res) => {

        const op = textoValido(req.query.op);
        if (!op) return res.status(400).json({ error: 'Falta la OP' });

        try {
            res.json(await consultas.listarCanos(req.maquina, op));
        } catch (err) {
            responderError(res, err);
        }
    });

    app.get('/api/ph/:maquina/ensayos', permiso, conMaquina, async (req, res) => {

        const op = textoValido(req.query.op);
        const cano = textoValido(req.query.cano);
        if (!op || !cano) return res.status(400).json({ error: 'Faltan la OP o el caño' });

        try {
            res.json(await consultas.listarEnsayos(req.maquina, op, cano));
        } catch (err) {
            responderError(res, err);
        }
    });

    // ---------------- Descarga masiva ----------------

    app.post('/api/ph/:maquina/lote/contar', permiso, conMaquina, async (req, res) => {

        const { filtros, error } = leerFiltrosLote(req.body);
        if (error) return res.status(400).json({ error });

        try {
            const ids = await consultas.listarIdsLote(req.maquina, filtros);
            res.json({ total: ids.length, maximo: lote.MAXIMO_ENSAYOS });
        } catch (err) {
            responderError(res, err);
        }
    });

    app.post('/api/ph/:maquina/lote', permiso, conMaquina, async (req, res) => {

        const { filtros, error } = leerFiltrosLote(req.body);
        if (error) return res.status(400).json({ error });

        // Rechazo rápido; lote.iniciar() lo vuelve a verificar después de
        // la consulta, por si dos pedidos llegan casi juntos.
        if (lote.estado().estado === 'generando') {
            return res.status(409).json({ error: 'Ya hay una descarga masiva en curso', lote: lote.estado(req.usuario.usuario) });
        }

        try {
            const ids = await consultas.listarIdsLote(req.maquina, filtros);

            if (!ids.length) return res.status(400).json({ error: 'No hay ensayos con esos filtros' });
            if (ids.length > lote.MAXIMO_ENSAYOS) {
                return res.status(400).json({ error: `Son ${ids.length} ensayos; el máximo por descarga es ${lote.MAXIMO_ENSAYOS}. Achicá los filtros.` });
            }

            const { texto, nombreZip } = describirFiltros(req.maquina.nombre, filtros);

            lote.iniciar({
                maquinaClave: req.params.maquina,
                maquinaNombre: req.maquina.nombre,
                ids,
                filtros: texto,
                nombreZip,
                usuario: req.usuario.usuario
            });

            res.status(202).json(lote.estado(req.usuario.usuario));

        } catch (err) {
            if (err.status === 409) {
                return res.status(409).json({ error: err.message, lote: lote.estado(req.usuario.usuario) });
            }
            responderError(res, err);
        }
    });

    app.get('/api/ph/lote', permiso, (req, res) => {
        res.json(lote.estado(req.usuario.usuario));
    });

    app.post('/api/ph/lote/cancelar', permiso, (req, res) => {
        const r = lote.cancelar(req.usuario.usuario, req.usuario.esAdmin);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        res.json(lote.estado(req.usuario.usuario));
    });

    app.get('/api/ph/lote/zip', permiso, (req, res) => {
        const listo = lote.archivoListo();
        if (!listo) return res.status(404).json({ error: 'No hay ningún ZIP listo para descargar' });
        res.download(listo.archivo, listo.nombre);
    });

    // ---------------- Ensayo individual ----------------

    async function cargarEnsayo(req, res) {

        if (!/^\d{1,9}$/.test(req.params.id)) {
            res.status(400).json({ error: 'Ensayo inválido' });
            return null;
        }

        const ensayo = await consultas.obtenerEnsayo(req.maquina, parseInt(req.params.id, 10));

        if (!ensayo) {
            res.status(404).json({ error: 'No existe ese ensayo' });
            return null;
        }

        return ensayo;
    }

    app.get('/api/ph/:maquina/ensayos/:id', permiso, conMaquina, async (req, res) => {
        try {
            const ensayo = await cargarEnsayo(req, res);
            if (ensayo) res.json(ensayo);
        } catch (err) {
            responderError(res, err);
        }
    });

    app.get('/api/ph/:maquina/ensayos/:id/pdf', permiso, conMaquina, async (req, res) => {
        try {
            const ensayo = await cargarEnsayo(req, res);
            if (!ensayo) return;

            // ?superponer=116,117 -> mismas repeticiones que se ven en pantalla
            const otrosIds = String(req.query.superponer || '')
                .split(',')
                .filter(id => /^\d{1,9}$/.test(id) && id !== String(ensayo.id))
                .slice(0, 3);

            const otros = [];
            for (const id of otrosIds) {
                const otro = await consultas.obtenerEnsayo(req.maquina, parseInt(id, 10));
                if (otro) otros.push(otro);
            }

            const ensayos = [ensayo, ...otros];
            const pdf = await generarPdfEnsayo(ensayos, req.usuario.usuario);

            // "inline": se abre en el visor de PDF del navegador. Una descarga
            // forzada ("attachment") la bloquean Chrome/Edge/Brave porque la
            // app corre en http://. El nombre igual se usa al guardarlo.
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `inline; filename="${nombreArchivoPdf(ensayos)}"`);
            res.send(pdf);
        } catch (err) {
            responderError(res, err);
        }
    });
};
