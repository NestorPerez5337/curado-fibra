// ======================================================
// MONITOR DE VARIABLES: MOTOR
// ======================================================
//
// Lee las variables Modbus (una conexión por equipo, reutilizada) y escucha
// los tópicos MQTT, y deja registrado en el log cada cambio de valor y cada
// vez que un equipo deja de responder o vuelve.
//
// Estados de una variable: ok | sin_conexion | sin_datos | error | desconocido.
// Cada paso entre estados genera un evento; el valor genera un evento
// 'cambio' cuando cambia (más que la banda configurada).

const net = require('net');
const Modbus = require('jsmodbus');
const mqtt = require('mqtt');

// Lecturas fallidas seguidas para dar por caído a un equipo Modbus.
const FALLOS_PARA_CAIDA = 2;
const TIMEOUT_CONEXION_MS = 3000;
const TIMEOUT_PETICION_MS = 2000;
const INTERVALO_MINIMO_MS = 200;
const LARGO_MAXIMO_TEXTO = 200;

const LECTORES = {
    coil: (cliente, direccion) => cliente.readCoils(direccion, 1),
    discreta: (cliente, direccion) => cliente.readDiscreteInputs(direccion, 1),
    holding: (cliente, direccion) => cliente.readHoldingRegisters(direccion, 1),
    input: (cliente, direccion) => cliente.readInputRegisters(direccion, 1)
};

const TIPO_EVENTO_FALLA = {
    sin_conexion: 'conexion_perdida',
    sin_datos: 'sin_datos',
    error: 'error_lectura'
};

const TEXTO_FALLA = {
    sin_conexion: 'sin conexión',
    sin_datos: 'sin datos',
    error: 'con error de lectura'
};

const MOTIVOS_RED = {
    ECONNREFUSED: 'Conexión rechazada',
    EHOSTUNREACH: 'Equipo inalcanzable',
    ENETUNREACH: 'Red inalcanzable',
    ETIMEDOUT: 'Tiempo de espera agotado',
    ECONNRESET: 'Conexión reiniciada por el equipo',
    EPIPE: 'Conexión cortada',
    ENOTFOUND: 'No se encontró el equipo'
};

function describirError(err) {

    if (!err) {
        return 'Error desconocido';
    }

    if (err.err === 'Timeout') {
        return 'El equipo no respondió (timeout)';
    }

    if (err.err === 'Offline') {
        return 'Sin conexión con el equipo';
    }

    if (err.err === 'OutOfSync') {
        return 'Respuesta fuera de sincronía';
    }

    const codigo = err.code || (err.errors && err.errors[0] && err.errors[0].code);

    if (codigo) {
        return MOTIVOS_RED[codigo] ? `${MOTIVOS_RED[codigo]} (${codigo})` : codigo;
    }

    return err.message || String(err);
}

function formatearDuracion(ms) {

    const total = Math.max(0, Math.round(ms / 1000));
    const horas = Math.floor(total / 3600);
    const minutos = Math.floor((total % 3600) / 60);
    const segundos = total % 60;

    if (horas > 0) {
        return `${horas} h ${String(minutos).padStart(2, '0')} min ${String(segundos).padStart(2, '0')} s`;
    }

    if (minutos > 0) {
        return `${minutos} min ${String(segundos).padStart(2, '0')} s`;
    }

    return `${segundos} s`;
}

function dateDesdeFechaLocal(texto) {
    return new Date(texto.replace(' ', 'T'));
}

function recortar(texto) {
    return texto.length > LARGO_MAXIMO_TEXTO ? texto.slice(0, LARGO_MAXIMO_TEXTO) + '…' : texto;
}

// Con banda > 0 los valores numéricos solo cuentan como cambio si se
// movieron al menos esa cantidad respecto del último valor registrado.
function cambiaSignificativamente(anterior, nuevo, banda) {

    if (anterior === null || anterior === undefined) {
        return true;
    }

    if (anterior === nuevo) {
        return false;
    }

    const a = Number(anterior);
    const b = Number(nuevo);

    if (banda > 0 && Number.isFinite(a) && Number.isFinite(b) && anterior !== '' && nuevo !== '') {
        return Math.abs(b - a) >= banda;
    }

    return true;
}

function formatearValorModbus(cfg, respuesta) {

    const valor = respuesta.response.body.values[0];

    if (cfg.funcion === 'coil' || cfg.funcion === 'discreta') {
        return valor ? 'ON' : 'OFF';
    }

    let numero = Number(valor);

    if (cfg.formato === 'int16' && numero > 32767) {
        numero -= 65536;
    }

    return String(numero);
}

function extraerValorMqtt(textoMensaje, campo) {

    if (!campo) {
        return recortar(textoMensaje.trim());
    }

    let objeto;

    try {
        objeto = JSON.parse(textoMensaje);
    } catch {
        throw new Error('El mensaje no es un JSON válido');
    }

    const valor = campo.split('.').reduce(
        (actual, clave) => (actual !== null && actual !== undefined ? actual[clave] : undefined),
        objeto
    );

    if (valor === undefined) {
        throw new Error(`El campo "${campo}" no está en el mensaje`);
    }

    return recortar(typeof valor === 'object' ? JSON.stringify(valor) : String(valor));
}

module.exports = function crearMotor(almacen) {

    const variables = new Map();
    const dispositivos = new Map();
    const brokers = new Map();

    let timerSinDatos = null;

    const guardar = (promesa, que) => {
        promesa.catch(err => console.error(`Monitor: error guardando ${que}:`, err.message));
    };

    function persistir(rt) {

        guardar(almacen.guardarEstado(rt.cfg.id, {
            estado: rt.estado,
            estado_desde: rt.estadoDesde ? almacen.fechaLocal(rt.estadoDesde) : null,
            ultimo_valor: rt.valorRegistrado,
            ultimo_cambio: rt.ultimoCambio
        }), 'el estado');
    }

    function evento(rt, tipo, { anterior, nuevo, detalle } = {}) {

        rt.ultimoCambio = almacen.fechaLocal();

        guardar(almacen.registrarEvento({
            variable_id: rt.cfg.id,
            variable_nombre: rt.cfg.nombre,
            fecha_hora: rt.ultimoCambio,
            tipo,
            valor_anterior: anterior,
            valor_nuevo: nuevo,
            detalle
        }), 'un evento');

        persistir(rt);
    }

    function cambiarEstado(rt, nuevo, detalle) {

        if (rt.estado === nuevo) {

            if (nuevo !== 'ok' && detalle) {
                rt.detalle = detalle;
            }

            return;
        }

        const antes = rt.estado;
        const desde = rt.estadoDesde;

        rt.estado = nuevo;
        rt.estadoDesde = new Date();
        rt.detalle = nuevo === 'ok' ? null : (detalle || null);

        if (nuevo === 'ok') {

            if (TIPO_EVENTO_FALLA[antes]) {

                const duracion = desde
                    ? ` Estuvo ${TEXTO_FALLA[antes]} ${formatearDuracion(Date.now() - desde.getTime())}.`
                    : '';

                evento(rt, 'restablecida', { detalle: `Volvió a responder.${duracion}` });

            } else {

                persistir(rt);
            }

            return;
        }

        evento(rt, TIPO_EVENTO_FALLA[nuevo], { detalle });
    }

    function procesarValor(rt, texto) {

        rt.valorActual = texto;
        rt.ultimoDato = new Date();

        cambiarEstado(rt, 'ok');

        if (!cambiaSignificativamente(rt.valorRegistrado, texto, rt.cfg.banda)) {
            return;
        }

        const anterior = rt.valorRegistrado;

        rt.valorRegistrado = texto;

        evento(rt, 'cambio', {
            anterior,
            nuevo: texto,
            detalle: anterior === null ? 'Valor inicial' : null
        });
    }

    function crearEstadoVariable(cfg) {

        return {
            cfg,
            estado: cfg.estado || 'desconocido',
            estadoDesde: cfg.estado_desde ? dateDesdeFechaLocal(cfg.estado_desde) : null,
            valorActual: null,
            valorRegistrado: cfg.ultimo_valor === undefined ? null : cfg.ultimo_valor,
            // Arranca "ahora" para que el aviso de "sin datos" espere el tiempo completo.
            ultimoDato: new Date(),
            ultimoCambio: cfg.ultimo_cambio || null,
            detalle: null,
            dispositivo: null,
            broker: null
        };
    }

    // ==================================================
    // MODBUS
    // ==================================================

    const claveDispositivo = cfg => `${cfg.ip}:${cfg.puerto}/${cfg.unit_id}`;

    function cerrarSocket(d) {

        d.conectado = false;

        if (d.socket) {

            try {
                d.socket.destroy();
            } catch {
                // ya estaba cerrado
            }
        }

        d.socket = null;
        d.cliente = null;
    }

    function conectar(d) {

        cerrarSocket(d);

        return new Promise((resolve, reject) => {

            const socket = new net.Socket();

            // El cliente tiene que existir antes de conectar: se entera de que
            // el socket quedó en línea escuchando su evento 'connect'.
            const cliente = new Modbus.client.TCP(socket, d.unitId, TIMEOUT_PETICION_MS);

            let terminado = false;

            const fallar = err => {

                if (terminado) {
                    return;
                }

                terminado = true;
                clearTimeout(temporizador);
                socket.destroy();
                reject(err);
            };

            const temporizador = setTimeout(() => {
                fallar(Object.assign(new Error('Sin respuesta al conectar'), { code: 'ETIMEDOUT' }));
            }, TIMEOUT_CONEXION_MS);

            socket.once('error', fallar);

            socket.connect({ host: d.ip, port: d.puerto }, () => {

                if (terminado) {
                    return;
                }

                terminado = true;
                clearTimeout(temporizador);

                socket.removeListener('error', fallar);
                socket.on('error', () => { d.conectado = false; });
                socket.on('close', () => {
                    if (d.socket === socket) {
                        d.conectado = false;
                    }
                });

                socket.setKeepAlive(true, 10000);

                d.socket = socket;
                d.cliente = cliente;
                d.conectado = true;

                resolve();
            });
        });
    }

    async function leerVariable(d, rt) {

        try {

            const respuesta = await LECTORES[rt.cfg.funcion](d.cliente, rt.cfg.direccion);

            // Si mientras se leía la borraron o la editaron, esta lectura ya no vale.
            if (variables.get(rt.cfg.id) !== rt) {
                return;
            }

            procesarValor(rt, formatearValorModbus(rt.cfg, respuesta));

        } catch (err) {

            // La excepción Modbus es una respuesta del equipo (dirección
            // inexistente, etc.): la conexión está bien, la variable no.
            if (err && err.err === 'ModbusException') {

                const motivo = err.response && err.response.body && err.response.body.message;

                cambiarEstado(rt, 'error', `El equipo rechazó la lectura${motivo ? ': ' + motivo : ''}`);

                return;
            }

            throw err;
        }
    }

    async function cicloDispositivo(d) {

        if (!d.activo) {
            return;
        }

        try {

            if (!d.conectado) {
                await conectar(d);
            }

            for (const rt of [...d.variables]) {

                if (!d.activo) {
                    break;
                }

                if (variables.get(rt.cfg.id) !== rt) {
                    continue;
                }

                await leerVariable(d, rt);
            }

            d.fallos = 0;

        } catch (err) {

            cerrarSocket(d);

            d.fallos++;

            if (d.fallos >= FALLOS_PARA_CAIDA) {

                const motivo = describirError(err);

                for (const rt of d.variables) {
                    cambiarEstado(rt, 'sin_conexion', motivo);
                }
            }
        }

        programarCiclo(d);
    }

    function programarCiclo(d) {

        if (!d.activo) {
            return;
        }

        const intervalos = [...d.variables].map(rt => rt.cfg.intervalo_ms);
        const espera = Math.max(INTERVALO_MINIMO_MS, Math.min(...intervalos));

        d.temporizador = setTimeout(() => cicloDispositivo(d), espera);
    }

    function agregarModbus(rt) {

        const clave = claveDispositivo(rt.cfg);

        let d = dispositivos.get(clave);

        if (!d) {

            d = {
                clave,
                ip: rt.cfg.ip,
                puerto: rt.cfg.puerto,
                unitId: rt.cfg.unit_id,
                variables: new Set(),
                socket: null,
                cliente: null,
                conectado: false,
                fallos: 0,
                activo: true,
                temporizador: null
            };

            dispositivos.set(clave, d);

            d.variables.add(rt);
            rt.dispositivo = d;

            d.temporizador = setTimeout(() => cicloDispositivo(d), 0);

            return;
        }

        d.variables.add(rt);
        rt.dispositivo = d;
    }

    function quitarModbus(rt) {

        const d = rt.dispositivo;

        if (!d) {
            return;
        }

        d.variables.delete(rt);

        if (d.variables.size === 0) {

            d.activo = false;
            clearTimeout(d.temporizador);
            cerrarSocket(d);
            dispositivos.delete(d.clave);
        }
    }

    // ==================================================
    // MQTT
    // ==================================================

    function suscribir(b, rt) {

        b.cliente.subscribe(rt.cfg.topico, err => {

            if (err) {
                cambiarEstado(rt, 'error', `No se pudo suscribir al tópico: ${err.message}`);
            }
        });
    }

    function crearBroker(url) {

        const b = {
            url,
            variables: new Set(),
            conectado: false,
            ultimoError: null,
            cliente: null
        };

        b.cliente = mqtt.connect(url, {
            reconnectPeriod: 3000,
            connectTimeout: 5000,
            clientId: 'monitor_' + Math.random().toString(16).slice(2, 10)
        });

        b.cliente.on('connect', () => {

            b.conectado = true;
            b.ultimoError = null;

            for (const rt of b.variables) {

                suscribir(b, rt);

                rt.ultimoDato = new Date();

                if (rt.estado === 'sin_conexion') {
                    cambiarEstado(rt, 'ok');
                }
            }
        });

        b.cliente.on('error', err => {
            b.ultimoError = describirError(err);
        });

        b.cliente.on('close', () => {

            b.conectado = false;

            for (const rt of b.variables) {
                cambiarEstado(rt, 'sin_conexion', b.ultimoError || 'Conexión con el broker cerrada');
            }
        });

        b.cliente.on('message', (topico, mensaje) => {

            for (const rt of b.variables) {

                if (rt.cfg.topico !== topico) {
                    continue;
                }

                try {

                    procesarValor(rt, extraerValorMqtt(mensaje.toString(), rt.cfg.campo));

                } catch (err) {

                    rt.ultimoDato = new Date();

                    cambiarEstado(rt, 'error', err.message);
                }
            }
        });

        return b;
    }

    function agregarMqtt(rt) {

        let b = brokers.get(rt.cfg.broker);

        if (!b) {
            b = crearBroker(rt.cfg.broker);
            brokers.set(rt.cfg.broker, b);
        }

        b.variables.add(rt);
        rt.broker = b;

        if (b.conectado) {
            suscribir(b, rt);
        }
    }

    function quitarMqtt(rt) {

        const b = rt.broker;

        if (!b) {
            return;
        }

        b.variables.delete(rt);

        const topicoCompartido = [...b.variables].some(otra => otra.cfg.topico === rt.cfg.topico);

        if (b.conectado && !topicoCompartido) {
            b.cliente.unsubscribe(rt.cfg.topico, () => {});
        }

        if (b.variables.size === 0) {
            b.cliente.end(true);
            brokers.delete(b.url);
        }
    }

    function revisarSinDatos() {

        const ahora = Date.now();

        for (const rt of variables.values()) {

            const limite = rt.cfg.timeout_s;

            if (rt.cfg.tipo !== 'mqtt' || !(limite > 0) || rt.estado !== 'ok') {
                continue;
            }

            const segundos = Math.round((ahora - rt.ultimoDato.getTime()) / 1000);

            if (segundos > limite) {
                cambiarEstado(rt, 'sin_datos', `No llegaron mensajes hace ${formatearDuracion(segundos * 1000)}`);
            }
        }
    }

    // ==================================================
    // API DEL MOTOR
    // ==================================================

    function quitar(id) {

        const rt = variables.get(id);

        if (!rt) {
            return;
        }

        quitarModbus(rt);
        quitarMqtt(rt);

        variables.delete(id);
    }

    // Arranca (o reinicia con la configuración nueva) el monitoreo de una variable.
    function agregar(cfg) {

        quitar(cfg.id);

        if (!cfg.activo) {
            return;
        }

        const rt = crearEstadoVariable(cfg);

        variables.set(cfg.id, rt);

        try {

            if (cfg.tipo === 'modbus') {
                agregarModbus(rt);
            } else {
                agregarMqtt(rt);
            }

        } catch (err) {

            console.error(`Monitor: no se pudo iniciar la variable "${cfg.nombre}":`, err.message);
        }
    }

    function iniciar(configuraciones) {

        configuraciones.forEach(agregar);

        timerSinDatos = setInterval(revisarSinDatos, 2000);
        timerSinDatos.unref();
    }

    function instantanea() {

        const resultado = {};

        for (const [id, rt] of variables) {

            resultado[id] = {
                estado: rt.estado,
                valor: rt.valorActual,
                ultimo_dato: rt.valorActual !== null ? almacen.fechaLocal(rt.ultimoDato) : null,
                estado_desde: rt.estadoDesde ? almacen.fechaLocal(rt.estadoDesde) : null,
                ultimo_cambio: rt.ultimoCambio,
                detalle: rt.detalle
            };
        }

        return resultado;
    }

    function detener() {

        clearInterval(timerSinDatos);

        for (const id of [...variables.keys()]) {
            quitar(id);
        }
    }

    return { iniciar, agregar, quitar, instantanea, detener };
};
