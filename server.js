require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const Modbus = require('jsmodbus');
const net = require('net');
const sqlite3 = require('sqlite3').verbose();

const fs = require('fs');
const PDFDocument = require('pdfkit');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

const app = express();

const PORT = process.env.PORT || 3000;


app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use(
    '/pdfs',
    express.static(
        path.join(__dirname, 'pdfs')
    )
);

app.set('trust proxy', 1);

// ======================================================
// MANEJO GLOBAL DE ERRORES
// ======================================================

process.on('uncaughtException', err => {
    console.error('ERROR GLOBAL:', err);
});

process.on('unhandledRejection', err => {
    console.error('PROMESA FALLIDA:', err);
});

// ======================================================
// SESIONES
// ======================================================

app.use(session({
    secret: process.env.SESSION_SECRET || 'curado_fibra_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 3600000,
        secure: false,
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// ======================================================
// CONFIGURACIÓN PLCs
// ======================================================

const CONFIG_PLCS = {
    1: {
        ip: '10.10.104.46',
        puerto: 502,
        mapa: {
            canal1: { t1: 904, t2: 905, t3: 906, t4: 907, t5: 908, t6: 909, t7: 970, t8: 911, t9: 912, t10: 913, t11: 914, t12: 915, t13: 916, ti: 944, tp: 945, td: 946, pot_macho: 919, pot_hembra: 920, te: 972 },
            canal2: { t1: 921, t2: 922, t3: 923, t4: 924, t5: 925, t6: 926, t7: 927, t8: 928, t9: 929, t10: 930, t11: 931, t12: 932, t13: 933, ti: 947, tp: 948, td: 949, pot_macho: 936, pot_hembra: 937, te: 973 }
        }
    },

    2: {
        ip: '10.10.104.47',
        puerto: 502,
        mapa: {
            canal1: { t1: 904, t2: 905, t3: 906, t4: 907, t5: 908, t6: 909, t7: 970, t8: 911, t9: 912, t10: 913, t11: 914, t12: 915, t13: 916, ti: 944, tp: 945, td: 946, pot_macho: 919, pot_hembra: 920, te: 70 },
            canal2: { t1: 921, t2: 922, t3: 923, t4: 924, t5: 925, t6: 926, t7: 927, t8: 928, t9: 929, t10: 930, t11: 931, t12: 932, t13: 933, ti: 947, tp: 948, td: 949, pot_macho: 936, pot_hembra: 937, te: 71 }
        }
    },

    3: {
        ip: '10.10.104.47',
        puerto: 502,
        mapa: {
            canal1: { t1: 5010, t2: 5011, t3: 5012, t4: 5013, t5: 5014, t6: 5015, t7: 5016, t8: 5017, t9: 5018, t10: 5019, t11: 5020, t12: 5021, t13: 5022, ti: 5350, tp: 5351, td: 5352, pot_macho: 2216, pot_hembra: 2217, te: 72 },
            canal2: { t1: 5030, t2: 5031, t3: 5032, t4: 5033, t5: 5034, t6: 5035, t7: 5036, t8: 5037, t9: 5038, t10: 5039, t11: 5040, t12: 5041, t13: 5042, ti: 5353, tp: 5354, td: 5355, pot_macho: 2237, pot_hembra: 2236, te: 73 }
        }
    },

    4: {
        ip: '10.10.104.47',
        puerto: 502,
        mapa: {
            canal1: { t1: 10, t2: 11, t3: 12, t4: 13, t5: 14, t6: 15, t7: 16, t8: 17, t9: 18, t10: 19, t11: 20, t12: 21, t13: 22, ti: 350, tp: 351, td: 352, pot_macho: 29, pot_hembra: 28, te: 74 },
            canal2: { t1: 30, t2: 31, t3: 32, t4: 33, t5: 34, t6: 35, t7: 36, t8: 37, t9: 38, t10: 39, t11: 40, t12: 41, t13: 42, ti: 353, tp: 354, td: 355, pot_macho: 46, pot_hembra: 45, te: 75 }
        }
    },

    5: {
        ip: '10.10.104.47',
        puerto: 502,
        mapa: {
            canal1: { t1: 90, t2: 91, t3: 92, t4: 93, t5: 94, t6: 95, t7: 96, t8: 97, t9: 98, t10: 99, t11: 100, t12: 101, t13: 102, ti: 364, tp: 365, td: 366, pot_macho: 107, pot_hembra: 106, te: 76 },
            canal2: { t1: 110, t2: 111, t3: 112, t4: 113, t5: 114, t6: 115, t7: 116, t8: 117, t9: 118, t10: 119, t11: 120, t12: 121, t13: 122, ti: 367, tp: 368, td: 369, pot_macho: 127, pot_hembra: 126, te: 77 }
        }
    },

    6: {
        ip: '10.10.104.48',
        puerto: 502,
        mapa: {
            canal1: { t1: 1512, t2: 1513, t3: 1514, t4: 1515, t5: 1516, t6: 1517, t7: 1518, t8: 1519, t9: 1520, t10: 1521, t11: 1522, t12: 1523, t13: 1524, ti: 1526, tp: 1527, td: 1528, pot_macho: 1530, pot_hembra: 1529, te: 50 },
            canal2: { t1: 1531, t2: 1532, t3: 1533, t4: 1534, t5: 1535, t6: 1536, t7: 1537, t8: 1538, t9: 1539, t10: 1540, t11: 1541, t12: 1542, t13: 1543, ti: 1545, tp: 1546, td: 1547, pot_macho: 1549, pot_hembra: 1548, te: 51 }
        }
    }
};

// ======================================================
// SQLITE
// ======================================================

if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data');
}
if (!fs.existsSync('./pdfs')) {
    fs.mkdirSync('./pdfs');
}
const db = new sqlite3.Database('./data/recetas.db');

db.serialize(() => {

    db.run(`
        CREATE TABLE IF NOT EXISTS recetas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT,
            valores TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS ensayos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            op TEXT,
            cano TEXT,
            archivo TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

});

// ======================================================
// AUTH
// ======================================================

const asegurarAuth = (req, res, next) => {

    if (req.session.autenticado) {
        return next();
    }

    res.status(401).send("No auth");
};
const asegurarVisor = (req, res, next) => {

    if (req.session.autenticadoVisor) {
        return next();
    }

    res.status(401).send("No auth");
};

// ======================================================
// LOGIN
// ======================================================

app.post('/api/login', (req, res) => {

    if (
        req.body.user === (process.env.ADMIN_USER || 'admin') &&
        req.body.pass === (process.env.ADMIN_PASS || '1234')
    ) {

        req.session.autenticado = true;

        return res.json({
            status: 'ok'
        });
    }

    res.status(401).send("Error");
});
app.post('/api/login-visor', (req, res) => {

    if (
        req.body.user === (process.env.VIEW_USER || 'visor') &&
        req.body.pass === (process.env.VIEW_PASS || '1234')
    ) {

        req.session.autenticadoVisor = true;

        return res.json({
            status: 'ok'
        });
    }

    res.status(401).send("Error");
});

// ======================================================
// FUNCION MODBUS SEGURA
// ======================================================

function crearClienteModbus(ip, puerto) {

    return new Promise((resolve, reject) => {

        const socket = new net.Socket();

        const client = new Modbus.client.TCP(socket);

        socket.setTimeout(3000);

        socket.on('timeout', () => {

            socket.destroy();

            reject(new Error('Timeout PLC'));
        });

        socket.on('error', err => {

            socket.destroy();

            reject(err);
        });

        socket.connect({
            host: ip,
            port: puerto
        }, () => {

            resolve({
                socket,
                client
            });
        });
    });
}

// ======================================================
// LEER PLC
// ======================================================

app.get('/api/leer-plc', asegurarAuth, async (req, res) => {

    let socket = null;

    try {

        const { dev, canal } = req.query;

        const config = CONFIG_PLCS[dev];

        if (!config) {
            return res.status(404).send("PLC no encontrado");
        }

        const conexion = await crearClienteModbus(
            config.ip,
            config.puerto
        );

        socket = conexion.socket;

        const client = conexion.client;

        const mapa =
            canal == 1
                ? config.mapa.canal1
                : config.mapa.canal2;

        let resultados = {};

        for (const key in mapa) {

            const data =
                await client.readHoldingRegisters(
                    mapa[key],
                    1
                );

            resultados[key] =
                data.response.body.values[0];
        }

        socket.end();
        socket.destroy();

        res.json(resultados);

    } catch (e) {

        console.error(e);

        if (socket) {
            socket.destroy();
        }

        res.status(500).send("Error");
    }
});

// ======================================================
// ESCRIBIR PLC
// ======================================================

app.post('/api/setear-plc', asegurarAuth, async (req, res) => {

    let socket = null;

    try {

        const { dev, canal, valores } = req.body;

        const config = CONFIG_PLCS[dev];

        const conexion =
            await crearClienteModbus(
                config.ip,
                config.puerto
            );

        socket = conexion.socket;

        const client = conexion.client;

        const mapa =
            canal == 1
                ? config.mapa.canal1
                : config.mapa.canal2;

        for (const key in valores) {

            await client.writeSingleRegister(
                mapa[key],
                parseInt(valores[key])
            );
        }

        socket.end();
        socket.destroy();

        res.json({
            status: 'ok'
        });

    } catch (e) {

        console.error(e);

        if (socket) {
            socket.destroy();
        }

        res.status(500).send("Error");
    }
});

// ======================================================
// ESCRIBIR EN TODAS LAS MÁQUINAS (PROCESO MASIVO)
// ======================================================
// ======================================================
// ESCRIBIR EN TODOS LOS CANALES DE TODAS LAS MÁQUINAS (12 CANALES EN TOTAL)
// ======================================================
app.post('/api/setear-todas', asegurarAuth, async (req, res) => {
    try {
        const { valores } = req.body;

        console.log(`🚀 Iniciando seteo masivo total: Escribiendo receta en Canal 1 y Canal 2 de las 6 máquinas...`);

        // Recorremos los 6 PLCs declarados en tu CONFIG_PLCS
        for (let dev = 1; dev <= 6; dev++) {
            const config = CONFIG_PLCS[dev];
            if (!config) continue;

            let socket = null;
            try {
                // Conexión Modbus individual a cada PLC
                const conexion = await crearClienteModbus(config.ip, config.puerto);
                socket = conexion.socket;
                const client = conexion.client;

                // 1. ESCRIBIR EN EL CANAL 1 DE ESTA MÁQUINA
                const mapaCanal1 = config.mapa.canal1;
                for (const key in valores) {
                    if (mapaCanal1[key] !== undefined) {
                        await client.writeSingleRegister(mapaCanal1[key], parseInt(valores[key]));
                    }
                }
                console.log(`✅ PLC DEV ${dev} - Canal 1: Configurado.`);

                // 2. ESCRIBIR EN EL CANAL 2 DE ESTA MÁQUINA
                const mapaCanal2 = config.mapa.canal2;
                for (const key in valores) {
                    if (mapaCanal2[key] !== undefined) {
                        await client.writeSingleRegister(mapaCanal2[key], parseInt(valores[key]));
                    }
                }
                console.log(`✅ PLC DEV ${dev} - Canal 2: Configurado.`);

                // Cerramos la conexión de forma limpia antes de pasar al siguiente PLC
                socket.end();
                socket.destroy();

            } catch (errPlc) {
                // Si una máquina falla o está apagada, reporta el error pero sigue con las otras
                console.error(`❌ Error al escribir en el PLC DEV ${dev} (${config.ip}):`, errPlc.message);
                if (socket) socket.destroy();
            }
        }

        res.json({ status: 'ok' });

    } catch (e) {
        console.error("Error general en el proceso masivo total:", e);
        res.status(500).send("Error interno en seteo masivo total");
    }
});
// ======================================================
// RECETAS SQLITE
// ======================================================

app.get('/api/recetas', asegurarAuth, (req, res) => {

    db.all(
        `SELECT * FROM recetas ORDER BY fecha DESC`,
        [],
        (err, rows) => {

            if (err) {

                console.error(err);

                return res.status(500).send("Error");
            }

            const recetas = rows.map(r => {

                let valoresParseados = {};

                try {

                    valoresParseados =
                        typeof r.valores === 'string'
                            ? JSON.parse(r.valores)
                            : r.valores;

                } catch (e) {

                    valoresParseados = {};
                }

                return {
                    ...r,
                    valores: valoresParseados
                };
            });

            res.json(recetas);
        }
    );
});

app.post('/api/recetas', asegurarAuth, (req, res) => {

    const { nombre, valores } = req.body;

    db.run(
        `INSERT INTO recetas (nombre, valores)
         VALUES (?, ?)`,
        [
            nombre,
            JSON.stringify(valores)
        ],
        err => {

            if (err) {

                console.error(err);

                return res.status(500).send("Error");
            }

            res.json({
                status: 'ok'
            });
        }
    );
});
// ======================================================
// ELIMINAR RECETA
// ======================================================

app.delete('/api/recetas/:id', asegurarAuth, (req, res) => {

    db.run(
        `DELETE FROM recetas WHERE id = ?`,
        [req.params.id],
        err => {

            if (err) {

                console.error(err);

                return res.status(500).send("Error");
            }

            res.json({
                status: 'ok'
            });
        }
    );
});

// ======================================================
// HEALTHCHECK
// ======================================================

app.get('/health', (req, res) => {

    res.json({
        status: 'ok',
        uptime: process.uptime()
    });
});

// ======================================================
// ENSAYO PRESIÓN
// ======================================================

const ChartDataLabels = require('chartjs-plugin-datalabels');

const chartCanvas = new ChartJSNodeCanvas({
    width: 1200,
    height: 600,
    chartCallback: (ChartJS) => {
        ChartJS.register(ChartDataLabels);
    }
});
const ENSAYO_IP = '10.10.104.37';
const ENSAYO_PUERTO = 502;

let ensayoActivo = false;
let datosEnsayo = [];
let opActual = '';
let canoActual = '';

let lecturaEnCurso = false;

// ======================================================
// MODBUS ENSAYO
// ======================================================

async function crearClienteEnsayo() {

    return new Promise((resolve, reject) => {

        const socket = new net.Socket();

        const client = new Modbus.client.TCP(socket);

        let cerrado = false;

        socket.setTimeout(2000);

        socket.on('timeout', () => {

            if (!cerrado) {

                cerrado = true;

                socket.destroy();

                reject(new Error('Timeout PLC ensayo'));
            }
        });

        socket.on('error', err => {

            if (!cerrado) {

                cerrado = true;

                socket.destroy();

                reject(err);
            }
        });

        socket.connect({
            host: ENSAYO_IP,
            port: ENSAYO_PUERTO
        }, () => {

            resolve({
                socket,
                client
            });
        });
    });
}

// ======================================================
// PDF ENSAYO
// ======================================================

async function generarPDFEnsayo() {

    try {

        if (datosEnsayo.length <= 0) {

            console.log('Sin datos para PDF');

            return;
        }

const ahora = new Date();

const fechaArchivo =
    ahora.getFullYear() +
    String(ahora.getMonth() + 1).padStart(2, '0') +
    String(ahora.getDate()).padStart(2, '0') +
    '_' +
    String(ahora.getHours()).padStart(2, '0') +
    String(ahora.getMinutes()).padStart(2, '0') +
    String(ahora.getSeconds()).padStart(2, '0');

const nombreArchivo =
    `OP_${opActual}_CANO_${canoActual}_${fechaArchivo}.pdf`;

const rutaArchivo =
    path.join(__dirname, 'pdfs', nombreArchivo);

        const labels =
            datosEnsayo.map((_, i) =>
                (i * 0.5).toFixed(1)
            );

       const configuration = {
    type: 'line',

    data: {
        labels,

        datasets: [{
            label: 'Presión',
            data: datosEnsayo,

            borderWidth: 2,
            fill: false,
            tension: 0.1,

            pointRadius: 5,
            pointHoverRadius: 5
        }]
    },

    options: {

        responsive: false,

        plugins: {

            title: {
                display: true,
                text: `Ensayo OP ${opActual} - Caño ${canoActual}`
            },

            datalabels: {

                color: 'black',

                anchor: 'end',

                align: 'top',

                offset: 4,

                font: {
                    size: 10,
                    weight: 'bold'
                },

                formatter: value => value
            }
        },

        scales: {

            x: {
                title: {
                    display: true,
                    text: 'Tiempo (s)'
                }
            },

            y: {
                title: {
                    display: true,
                    text: 'Presión'
                }
            }
        }
    },

    plugins: [ChartDataLabels]
};

        const imageBuffer =
            await chartCanvas.renderToBuffer(configuration);

        const doc =
            new PDFDocument({
                margin: 30
            });

        const stream =
            fs.createWriteStream(rutaArchivo);

        doc.pipe(stream);

        doc.fontSize(22)
            .text('ENSAYO DE PRESIÓN', {
                align: 'center'
            });

        doc.moveDown();

        doc.fontSize(14)
            .text(`OP: ${opActual}`);

        doc.text(`Caño: ${canoActual}`);

        doc.text(`Fecha: ${new Date().toLocaleString()}`);

        doc.text(`Muestras: ${datosEnsayo.length}`);

        doc.moveDown();

        doc.image(imageBuffer, {
            fit: [520, 320],
            align: 'center'
        });

        doc.end();

        stream.on('finish', () => {

            console.log(
                `PDF generado: ${nombreArchivo}`
            );
        });

    } catch (err) {

        console.error(
            'Error generando PDF:',
            err
        );
    }
}

// ======================================================
// LOOP ENSAYO
// ======================================================

setInterval(async () => {

    if (lecturaEnCurso) {
        return;
    }

    lecturaEnCurso = true;

    let socket = null;

    try {

        const conexion =
            await crearClienteEnsayo();

        socket = conexion.socket;

        const client = conexion.client;

        // ==========================================
        // LEER M12
        // ==========================================

        const estado =
            await client.readCoils(12, 1);

        const ensayando =
            estado.response.body.values[0];

        // ==========================================
        // INICIO ENSAYO
        // ==========================================

        if (ensayando && !ensayoActivo) {

            ensayoActivo = true;

            datosEnsayo = [];

            console.log('INICIO ENSAYO');

            const opData =
                await client.readHoldingRegisters(150, 1);

            const canoData =
                await client.readHoldingRegisters(152, 1);

            opActual =
                opData.response.body.values[0];

            canoActual =
                canoData.response.body.values[0];

            console.log(
                `OP ${opActual} | Caño ${canoActual}`
            );
        }

        // ==========================================
        // MUESTRA
        // ==========================================

        if (ensayando && ensayoActivo) {

            const presionData =
                await client.readHoldingRegisters(361, 1);

            const presion =
                presionData.response.body.values[0];

            datosEnsayo.push(presion);

            console.log(
                `Muestra ${datosEnsayo.length}: ${presion}`
            );
        }

        // ==========================================
        // FIN ENSAYO
        // ==========================================

        if (!ensayando && ensayoActivo) {

            console.log('FIN ENSAYO');

            ensayoActivo = false;

            await generarPDFEnsayo();

            datosEnsayo = [];
        }

        if (socket) {

            socket.end();

            socket.destroy();
        }

    } catch (err) {

        console.error(
            'Error monitor ensayo:',
            err.message
        );

        if (socket) {

            try {
                socket.destroy();
            } catch {}
        }

    } finally {

        lecturaEnCurso = false;
    }

}, 1000);
app.get('/api/pdfs', asegurarVisor, (req, res) => {

    fs.readdir('./pdfs', (err, archivos) => {

        if (err) {
            return res.status(500).send("Error");
        }

        const pdfs =
            archivos
                .filter(a => a.endsWith('.pdf'))
                .sort()
                .reverse();

        res.json(pdfs);
    });
});
// ======================================================
// LISTADO DE ENSAYOS
// ======================================================

// ======================================================
// LISTADO DE ENSAYOS
// ======================================================

app.get('/api/ensayos', (req, res) => {
    // IMPORTANTE: Asegurate de que aquí diga 'pdfs' como arreglamos antes
    const carpeta = path.join(__dirname, 'pdfs');

    if (!fs.existsSync(carpeta)) {
        return res.json([]);
    }

    const archivos = fs.readdirSync(carpeta);
    const ensayos = [];

    archivos.forEach(nombreArchivo => {
        if (!nombreArchivo.endsWith('.pdf')) {
            return;
        }

        // Dividimos el nombre por los guiones bajos "_"
        // Ejemplo: OP_1234_CANO_5_2026...pdf
        const partes = nombreArchivo.replace('.pdf', '').split('_');

        // Como sabemos el formato exacto, tomamos las posiciones correspondientes:
        // partes[0] = "OP", partes[1] = "1234", partes[2] = "CANO", partes[3] = "5"
        let op = partes.length > 1 ? partes[1] : '';
        let cano = partes.length > 3 ? partes[3] : '';

        const stats = fs.statSync(path.join(carpeta, nombreArchivo));

        ensayos.push({
            op: op,
            cano: cano,
            fecha: stats.mtime.toISOString().slice(0, 19).replace('T', ' '),
            archivo: nombreArchivo
        });
    });

    // Ordenamos del más nuevo al más viejo
    ensayos.sort((a, b) => b.fecha.localeCompare(a.fecha));

    res.json(ensayos);
});
// ======================================================
// SERVER
// ======================================================
app.get('/api/pdf/:nombre', asegurarVisor, (req, res) => {

    const archivo =
        path.join(
            __dirname,
            'pdfs',
            req.params.nombre
        );

    if (!fs.existsSync(archivo)) {

        return res.status(404)
            .send("No existe");
    }

    res.download(archivo);
});
// ======================================================
// CONTROL DE HORÓMETROS VIA MQTT Y SQLITE (OBJETO JSON)
// ======================================================
const mqtt = require('mqtt');

// Conexión a tu servidor Mosquitto específico
const clienteMqtt = mqtt.connect('mqtt://10.106.100.50:1883');

// Estructura en memoria para guardar el último valor de cada máquina
let ultimosHorometros = {}; 

// Creamos la tabla 'horometros' en tu base de datos SQLite si no existe
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS horometros (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        maquina TEXT,
        horas REAL,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Al conectarse al broker, nos suscribimos al tópico
clienteMqtt.on('connect', () => {
    console.log('📡 Conectado exitosamente al Mosquitto en 10.106.100.50');
    clienteMqtt.subscribe('horometros2');
});

// Al recibir un mensaje, procesamos el objeto JSON completo
clienteMqtt.on('message', (topic, message) => {
    try {
        if (topic === 'horometros2') {
            // Parseamos el mensaje completo como un objeto JSON
            const payload = JSON.parse(message.toString());
            
            // Recorremos cada par clave/valor del objeto (Ej: clave = "TM6", valor = 15806)
            for (const [maquina, horas] of Object.entries(payload)) {
                const valorHoras = parseFloat(horas);
                
                if (maquina && !isNaN(valorHoras)) {
                    // Guardamos o actualizamos el valor más fresco en memoria
                    ultimosHorometros[maquina] = valorHoras;
                }
            }
        }
    } catch (err) {
        console.error('Error al procesar el JSON de Node-RED:', err.message);
    }
});


// INTERVALO: Cada 30 minutos guarda los datos acumulados en la Base de Datos
setInterval(() => {
    // Formato de fecha para SQLite: YYYY-MM-DD HH:MM:SS
    const ahora = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    // Verificamos si hay datos cargados en memoria para no insertar vacíos
    const maquinasParaGuardar = Object.entries(ultimosHorometros);
    
    if (maquinasParaGuardar.length > 0) {
        for (const [maquina, horas] of maquinasParaGuardar) {
            db.run(
                `INSERT INTO horometros (maquina, horas, fecha) VALUES (?, ?, ?)`,
                [maquina, horas, ahora],
                (err) => {
                    if (err) console.error(`Error al insertar en DB para la máquina ${maquina}:`, err);
                }
            );
        }
        console.log(`💾 Volcado de horómetros completado a las ${ahora}`);
    }
}, 30*60 * 1000); // Cada 30 minutos

// ======================================================
// ENDPOINTS PARA LA PÁGINA DE GRÁFICOS
// ======================================================

// 1. Obtener lista de máquinas únicas para los filtros de la pantalla
app.get('/api/horometros/maquinas', (req, res) => {
    db.all(`SELECT DISTINCT maquina FROM horometros ORDER BY maquina ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => r.maquina));
    });
});

// 2. Obtener los datos filtrados por máquina y fecha
app.get('/api/horometros/datos', (req, res) => {
    const { maquinas, desde, hasta } = req.query;
    
    if (!maquinas || !desde || !hasta) {
        return res.status(400).json({ error: 'Faltan parámetros de filtro.' });
    }

    const listaMaquinas = maquinas.split(',');
    const placeholders = listaMaquinas.map(() => '?').join(',');

    const sql = `
        SELECT maquina, horas, fecha 
        FROM horometros 
        WHERE maquina IN (${placeholders}) 
          AND date(fecha) >= date(?)
          AND date(fecha) <= date(?)
        ORDER BY fecha ASC
    `;

    db.all(sql, [...listaMaquinas, desde, hasta], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 3. Ruta para que Express sirva la nueva interfaz gráfica
app.get('/horometros', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'horometros.html'));
});
app.listen(PORT, '0.0.0.0', () => {

    console.log(
        `Servidor iniciado en puerto ${PORT}`
    );
});