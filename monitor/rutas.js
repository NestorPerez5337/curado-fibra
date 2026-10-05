// ======================================================
// MONITOR DE VARIABLES: RUTAS (solo administradores)
// ======================================================
//
// Se monta desde server.js con:
//   require('./monitor/rutas')(app, { requiereAdmin, requiereAdminPagina, registrarLog });

const path = require('path');
const almacen = require('./almacen');
const crearMotor = require('./motor');

const FUNCIONES = ['coil', 'discreta', 'holding', 'input'];
const FORMATOS = ['uint16', 'int16'];
const TIPOS_EVENTO = ['cambio', 'conexion_perdida', 'sin_datos', 'error_lectura', 'restablecida'];

const RETENCION_DIAS = 90;
const LIMITE_EVENTOS_DEFECTO = 500;
const LIMITE_EVENTOS_MAXIMO = 2000;

const REGEX_HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,98}[A-Za-z0-9])?$/;
const REGEX_BROKER = /^mqtts?:\/\/[A-Za-z0-9][A-Za-z0-9.-]{0,98}(:\d{1,5})?$/;
const REGEX_CAMPO = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function entero(valor, minimo, maximo) {

    if (valor === '' || valor === null || valor === undefined) {
        return null;
    }

    const n = Number(valor);

    return Number.isInteger(n) && n >= minimo && n <= maximo ? n : null;
}

// Devuelve { datos } listos para guardar, o { error } con el motivo.
function validar(body) {

    const b = body || {};

    const nombre = typeof b.nombre === 'string' ? b.nombre.trim() : '';

    if (!nombre || nombre.length > 60) {
        return { error: 'El nombre es obligatorio (máximo 60 caracteres)' };
    }

    const activo = b.activo === false || b.activo === 0 ? 0 : 1;

    const banda = b.banda === '' || b.banda === undefined || b.banda === null ? 0 : Number(b.banda);

    if (!Number.isFinite(banda) || banda < 0) {
        return { error: 'La banda debe ser un número mayor o igual a 0' };
    }

    if (b.tipo === 'modbus') {

        const ip = typeof b.ip === 'string' ? b.ip.trim() : '';
        const puerto = entero(b.puerto === '' || b.puerto === undefined ? 502 : b.puerto, 1, 65535);
        const unitId = entero(b.unit_id === '' || b.unit_id === undefined ? 1 : b.unit_id, 0, 247);
        const direccion = entero(b.direccion, 0, 65535);
        const intervalo = entero(b.intervalo_ms === '' || b.intervalo_ms === undefined ? 1000 : b.intervalo_ms, 200, 60000);

        if (!REGEX_HOST.test(ip)) return { error: 'La IP o nombre del equipo no es válido' };
        if (puerto === null) return { error: 'El puerto debe estar entre 1 y 65535' };
        if (unitId === null) return { error: 'El Unit ID debe estar entre 0 y 247' };
        if (!FUNCIONES.includes(b.funcion)) return { error: 'El tipo de dato Modbus no es válido' };
        if (direccion === null) return { error: 'La dirección debe estar entre 0 y 65535' };
        if (intervalo === null) return { error: 'El intervalo debe estar entre 200 y 60000 ms' };

        const esRegistro = b.funcion === 'holding' || b.funcion === 'input';

        if (esRegistro && b.formato && !FORMATOS.includes(b.formato)) {
            return { error: 'El formato del registro no es válido' };
        }

        return {
            datos: {
                nombre,
                tipo: 'modbus',
                activo,
                ip,
                puerto,
                unit_id: unitId,
                funcion: b.funcion,
                direccion,
                formato: esRegistro ? (b.formato || 'uint16') : null,
                broker: null,
                topico: null,
                campo: null,
                intervalo_ms: intervalo,
                banda: esRegistro ? banda : 0,
                timeout_s: 0
            }
        };
    }

    if (b.tipo === 'mqtt') {

        const broker = typeof b.broker === 'string' ? b.broker.trim() : '';
        const topico = typeof b.topico === 'string' ? b.topico.trim() : '';
        const campo = typeof b.campo === 'string' ? b.campo.trim() : '';
        const timeout = entero(b.timeout_s === '' || b.timeout_s === undefined ? 0 : b.timeout_s, 0, 86400);

        if (!REGEX_BROKER.test(broker)) return { error: 'El broker debe ser del estilo mqtt://IP:1883' };
        if (!topico || topico.length > 200 || /[+#]/.test(topico)) {
            return { error: 'El tópico es obligatorio y no puede tener comodines (+ ni #)' };
        }
        if (campo && !REGEX_CAMPO.test(campo)) return { error: 'El campo JSON no es válido (ej.: maquina1 o datos.temp)' };
        if (timeout === null) return { error: 'El tiempo sin datos debe estar entre 0 y 86400 segundos' };

        return {
            datos: {
                nombre,
                tipo: 'mqtt',
                activo,
                ip: null,
                puerto: null,
                unit_id: null,
                funcion: null,
                direccion: null,
                formato: null,
                broker,
                topico,
                campo: campo || null,
                intervalo_ms: 1000,
                banda,
                timeout_s: timeout
            }
        };
    }

    return { error: 'El tipo de variable debe ser Modbus o MQTT' };
}

module.exports = function montarMonitor(app, { requiereAdmin, requiereAdminPagina, registrarLog }) {

    const motor = crearMotor(almacen);

    almacen.listarVariables()
        .then(lista => motor.iniciar(lista))
        .catch(err => console.error('Monitor: no se pudo iniciar el monitoreo:', err));

    const purgar = () => almacen.purgarEventosViejos(RETENCION_DIAS)
        .then(borrados => {
            if (borrados > 0) {
                console.log(`Monitor: se borraron ${borrados} eventos de más de ${RETENCION_DIAS} días.`);
            }
        })
        .catch(err => console.error('Monitor: error purgando eventos viejos:', err.message));

    purgar();
    setInterval(purgar, 24 * 60 * 60 * 1000).unref();

    const leerId = req => /^\d{1,9}$/.test(req.params.id) ? parseInt(req.params.id, 10) : null;

    app.get('/monitor', requiereAdminPagina, (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'protegido', 'monitor.html'));
    });

    app.get('/api/monitor/variables', requiereAdmin, async (req, res) => {

        try {

            const variables = await almacen.listarVariables();
            const vivo = motor.instantanea();

            res.json(variables.map(v => {

                const actual = vivo[v.id] || {};

                return {
                    id: v.id,
                    nombre: v.nombre,
                    tipo: v.tipo,
                    activo: !!v.activo,
                    ip: v.ip,
                    puerto: v.puerto,
                    unit_id: v.unit_id,
                    funcion: v.funcion,
                    direccion: v.direccion,
                    formato: v.formato,
                    broker: v.broker,
                    topico: v.topico,
                    campo: v.campo,
                    intervalo_ms: v.intervalo_ms,
                    banda: v.banda,
                    timeout_s: v.timeout_s,
                    estado: v.activo ? (actual.estado || 'desconocido') : 'pausada',
                    valor: actual.valor === undefined ? null : actual.valor,
                    ultimo_dato: actual.ultimo_dato || null,
                    estado_desde: actual.estado_desde || v.estado_desde || null,
                    ultimo_cambio: actual.ultimo_cambio || v.ultimo_cambio || null,
                    detalle: actual.detalle || null
                };
            }));

        } catch (err) {
            console.error('Monitor: error listando variables:', err);
            res.status(500).send('Error');
        }
    });

    app.post('/api/monitor/variables', requiereAdmin, async (req, res) => {

        const { datos, error } = validar(req.body);

        if (error) {
            return res.status(400).send(error);
        }

        try {

            const id = await almacen.crearVariable(datos);

            motor.agregar(await almacen.obtenerVariable(id));

            registrarLog(req, 'monitor', `Agregó la variable "${datos.nombre}" al monitor`, datos);

            res.json({ id });

        } catch (err) {
            console.error('Monitor: error creando variable:', err);
            res.status(500).send('Error');
        }
    });

    app.put('/api/monitor/variables/:id', requiereAdmin, async (req, res) => {

        const id = leerId(req);

        if (id === null) {
            return res.status(400).send('Id inválido');
        }

        const { datos, error } = validar(req.body);

        if (error) {
            return res.status(400).send(error);
        }

        try {

            if (!(await almacen.obtenerVariable(id))) {
                return res.status(404).send('Variable no encontrada');
            }

            await almacen.actualizarVariable(id, datos);

            motor.agregar(await almacen.obtenerVariable(id));

            registrarLog(req, 'monitor', `Editó la variable "${datos.nombre}" del monitor`, datos);

            res.json({ status: 'ok' });

        } catch (err) {
            console.error('Monitor: error editando variable:', err);
            res.status(500).send('Error');
        }
    });

    app.put('/api/monitor/variables/:id/activo', requiereAdmin, async (req, res) => {

        const id = leerId(req);

        if (id === null) {
            return res.status(400).send('Id inválido');
        }

        try {

            if (!(await almacen.obtenerVariable(id))) {
                return res.status(404).send('Variable no encontrada');
            }

            const activo = !!(req.body && req.body.activo);

            await almacen.cambiarActiva(id, activo);

            const variable = await almacen.obtenerVariable(id);

            motor.agregar(variable);

            registrarLog(req, 'monitor', `${activo ? 'Reanudó' : 'Pausó'} la variable "${variable.nombre}" del monitor`);

            res.json({ status: 'ok' });

        } catch (err) {
            console.error('Monitor: error pausando/reanudando variable:', err);
            res.status(500).send('Error');
        }
    });

    app.delete('/api/monitor/variables/:id', requiereAdmin, async (req, res) => {

        const id = leerId(req);

        if (id === null) {
            return res.status(400).send('Id inválido');
        }

        try {

            const variable = await almacen.obtenerVariable(id);

            if (!variable) {
                return res.status(404).send('Variable no encontrada');
            }

            const borrarEventos = req.query.borrarEventos === '1';

            motor.quitar(id);

            await almacen.borrarVariable(id, borrarEventos);

            registrarLog(
                req,
                'monitor',
                `Eliminó la variable "${variable.nombre}" del monitor${borrarEventos ? ' junto con su historial' : ''}`
            );

            res.json({ status: 'ok' });

        } catch (err) {
            console.error('Monitor: error eliminando variable:', err);
            res.status(500).send('Error');
        }
    });

    // Resumen para el panel de Estado del Sistema: cuántas variables están
    // bien, cuáles tienen problemas y cuántas novedades hubo en las últimas 24 h.
    async function resumen() {

        const variables = await almacen.listarVariables();
        const vivo = motor.instantanea();

        const activas = variables.filter(v => v.activo);
        const porEstado = {};
        const conProblema = [];

        for (const v of activas) {

            const actual = vivo[v.id] || {};
            const estado = actual.estado || 'desconocido';

            porEstado[estado] = (porEstado[estado] || 0) + 1;

            if (estado !== 'ok' && estado !== 'desconocido') {
                conProblema.push({
                    nombre: v.nombre,
                    estado,
                    desde: actual.estado_desde || null,
                    detalle: actual.detalle || null
                });
            }
        }

        const hace24h = almacen.fechaLocal(new Date(Date.now() - 24 * 60 * 60 * 1000));
        const eventos24h = {};

        for (const fila of await almacen.contarEventosDesde(hace24h)) {
            eventos24h[fila.tipo] = fila.cantidad;
        }

        return {
            total: variables.length,
            activas: activas.length,
            porEstado,
            conProblema,
            eventos24h,
            totalEventos: await almacen.totalEventos()
        };
    }

    app.get('/api/monitor/eventos', requiereAdmin, async (req, res) => {

        const q = req.query;

        const variableId = q.variable ? entero(q.variable, 1, 999999999) : null;
        const tipo = TIPOS_EVENTO.includes(q.tipo) ? q.tipo : null;
        const desde = REGEX_FECHA.test(q.desde || '') ? q.desde : null;
        const hasta = REGEX_FECHA.test(q.hasta || '') ? q.hasta : null;
        const limite = entero(q.limite, 1, LIMITE_EVENTOS_MAXIMO) || LIMITE_EVENTOS_DEFECTO;

        try {

            res.json(await almacen.listarEventos({ variableId, tipo, desde, hasta, limite }));

        } catch (err) {
            console.error('Monitor: error listando eventos:', err);
            res.status(500).send('Error');
        }
    });

    return { resumen };
};
