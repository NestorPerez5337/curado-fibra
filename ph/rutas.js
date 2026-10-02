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
const { estaConfigurado } = require('./sql');

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

const ERRORES_CONEXION = ['ELOGIN', 'ESOCKET', 'ETIMEOUT', 'ECONNCLOSED', 'EINSTLOOKUP', 'ENOTOPEN'];

function responderError(res, err) {

    console.error('Visor PH:', err.message);

    if (!estaConfigurado() || ERRORES_CONEXION.includes(err.code)) {
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

            const pdf = await generarPdfEnsayo(ensayo, req.usuario.usuario);

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoPdf(ensayo)}"`);
            res.send(pdf);
        } catch (err) {
            responderError(res, err);
        }
    });
};
