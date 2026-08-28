require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const Modbus = require('jsmodbus');
const net = require('net');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const fs = require('fs');
const PDFDocument = require('pdfkit');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

const app = express();

const PORT = process.env.PORT || 3000;


app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

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

// La sesión dura como máximo 2 horas desde que se inicia sesión
// (no se renueva con la actividad: pasadas las 2hs hay que volver a
// loguearse aunque se haya estado usando el sistema todo ese tiempo).
const SESION_DURACION_MS = 2 * 60 * 60 * 1000;

app.use(session({
    secret: process.env.SESSION_SECRET || 'curado_fibra_secret_2026',
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: {
        maxAge: SESION_DURACION_MS,
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
if (!fs.existsSync('./backups')) {
    fs.mkdirSync('./backups');
}
if (!fs.existsSync('./backups/pdfs')) {
    fs.mkdirSync('./backups/pdfs');
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

    db.run(`
        CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario TEXT UNIQUE NOT NULL,
            salt TEXT NOT NULL,
            hash TEXT NOT NULL,
            es_admin INTEGER NOT NULL DEFAULT 0,
            perm_devanadoras INTEGER NOT NULL DEFAULT 0,
            perm_horometros INTEGER NOT NULL DEFAULT 0,
            perm_visor INTEGER NOT NULL DEFAULT 0,
            perm_compresores INTEGER NOT NULL DEFAULT 0,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Migración: si la tabla usuarios ya existía de una versión anterior
    // (sin la columna perm_compresores), la agregamos ahora.
    db.all(`PRAGMA table_info(usuarios)`, [], (err, columnas) => {

        if (err) {
            console.error('Error leyendo esquema de usuarios:', err);
            return;
        }

        const tieneColumna =
            columnas.some(c => c.name === 'perm_compresores');

        if (!tieneColumna) {

            db.run(
                `ALTER TABLE usuarios ADD COLUMN perm_compresores INTEGER NOT NULL DEFAULT 0`,
                err2 => {

                    if (err2) {
                        console.error('Error migrando columna perm_compresores:', err2);
                        return;
                    }

                    console.log('Columna perm_compresores agregada a usuarios.');

                    // Los administradores ya existentes quedan con el permiso
                    // marcado (igual tienen acceso total por ser admin, esto
                    // es solo para que se vea consistente en la pantalla).
                    db.run(`UPDATE usuarios SET perm_compresores = 1 WHERE es_admin = 1`);
                }
            );
        }
    });

    // Si todavía no existe ningún administrador, creamos uno inicial
    // con las credenciales de .env (o admin/1234 por defecto).
    db.get(
        `SELECT COUNT(*) AS total FROM usuarios WHERE es_admin = 1`,
        [],
        (err, row) => {

            if (err) {
                console.error('Error verificando administrador:', err);
                return;
            }

            if (row.total > 0) {
                return;
            }

            const usuarioAdmin = process.env.ADMIN_USER || 'admin';
            const passAdmin = process.env.ADMIN_PASS || '1234';
            const { salt, hash } = hashearPassword(passAdmin);

            db.run(
                `INSERT INTO usuarios
                    (usuario, salt, hash, es_admin, perm_devanadoras, perm_horometros, perm_visor, perm_compresores)
                 VALUES (?, ?, ?, 1, 1, 1, 1, 1)`,
                [usuarioAdmin, salt, hash],
                err2 => {

                    if (err2) {
                        console.error('Error creando administrador inicial:', err2);
                        return;
                    }

                    console.log(`Usuario administrador inicial creado: ${usuarioAdmin}`);
                }
            );
        }
    );

    // ======================================================
    // TABLAS: PROGRAMACIÓN DE COMPRESORES
    // ======================================================

    db.run(`
        CREATE TABLE IF NOT EXISTS compresores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            ip TEXT,
            puerto INTEGER DEFAULT 502,
            marca TEXT,
            hora_apagado TEXT,
            hora_encendido TEXT,
            coil_marcha INTEGER,
            coil_estado INTEGER,
            activo INTEGER NOT NULL DEFAULT 1,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Migración: agregar a compresores las columnas de encendido programado,
    // dirección del coil Modbus de comando (marcha/paro) y dirección del
    // coil de estado (lectura del contacto de "marcha" real del compresor,
    // para mostrar en pantalla si está encendido) si la tabla ya existía
    // de una versión anterior sin ellas.
    db.all(`PRAGMA table_info(compresores)`, [], (err, columnas) => {

        if (err) {
            console.error('Error leyendo esquema de compresores:', err);
            return;
        }

        if (!columnas.some(c => c.name === 'hora_encendido')) {
            db.run(`ALTER TABLE compresores ADD COLUMN hora_encendido TEXT`, err2 => {
                if (err2) console.error('Error migrando columna hora_encendido:', err2);
                else console.log('Columna hora_encendido agregada a compresores.');
            });
        }

        if (!columnas.some(c => c.name === 'coil_marcha')) {
            db.run(`ALTER TABLE compresores ADD COLUMN coil_marcha INTEGER`, err2 => {
                if (err2) console.error('Error migrando columna coil_marcha:', err2);
                else console.log('Columna coil_marcha agregada a compresores.');
            });
        }

        if (!columnas.some(c => c.name === 'coil_estado')) {
            db.run(`ALTER TABLE compresores ADD COLUMN coil_estado INTEGER`, err2 => {
                if (err2) console.error('Error migrando columna coil_estado:', err2);
                else console.log('Columna coil_estado agregada a compresores.');
            });
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS compresores_config (
            clave TEXT PRIMARY KEY,
            valor TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS compresores_excepciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            compresor_id INTEGER NOT NULL,
            fecha TEXT NOT NULL,
            hora_apagado TEXT,
            hora_encendido TEXT,
            UNIQUE(compresor_id, fecha)
        )
    `);

    // Migración: agregar hora_encendido a las excepciones de calendario
    // si la tabla ya existía de una versión anterior sin esa columna.
    db.all(`PRAGMA table_info(compresores_excepciones)`, [], (err, columnas) => {

        if (err) {
            console.error('Error leyendo esquema de compresores_excepciones:', err);
            return;
        }

        if (!columnas.some(c => c.name === 'hora_encendido')) {
            db.run(`ALTER TABLE compresores_excepciones ADD COLUMN hora_encendido TEXT`, err2 => {
                if (err2) console.error('Error migrando columna hora_encendido en excepciones:', err2);
                else console.log('Columna hora_encendido agregada a compresores_excepciones.');
            });
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS compresores_eventos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            compresor_id INTEGER NOT NULL,
            tipo TEXT NOT NULL,
            origen TEXT NOT NULL,
            fecha_hora DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ======================================================
    // TABLA: LOG DE CAMBIOS (auditoría)
    // ======================================================

    db.run(`
        CREATE TABLE IF NOT EXISTS log_cambios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER,
            usuario TEXT NOT NULL,
            modulo TEXT NOT NULL,
            accion TEXT NOT NULL,
            detalle TEXT,
            fecha_hora DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

});

// ======================================================
// BACKUPS AUTOMÁTICOS
// ======================================================
// Guardan una copia de la base y de los PDFs en un volumen aparte
// (backups_curado_fibra) para que, aunque algo le pase a los volumes
// principales en una actualización, haya de dónde recuperar los datos.
// Se generan solos cada 6 horas y también se pueden disparar a mano
// (y descargar) desde la pantalla de Administración.

const BACKUPS_A_CONSERVAR = 28; // ~7 días si corre cada 6hs

function timestampBackup() {

    const d = new Date();

    return (
        d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0') +
        '_' +
        String(d.getHours()).padStart(2, '0') +
        String(d.getMinutes()).padStart(2, '0') +
        String(d.getSeconds()).padStart(2, '0')
    );
}

function hacerBackup() {

    return new Promise((resolve, reject) => {

        const nombreDb = `recetas_${timestampBackup()}.db`;
        const rutaDb = path.join(__dirname, 'backups', nombreDb);

        // VACUUM INTO genera una copia consistente de la base aunque
        // esté siendo usada en simultáneo, a diferencia de copiar el
        // archivo .db directamente.
        db.run(`VACUUM INTO ?`, [rutaDb], err => {

            if (err) {
                console.error('Error haciendo backup de la base:', err);
                return reject(err);
            }

            // Copiamos al backup los PDFs que todavía no estén ahí
            // (los PDFs no cambian una vez generados, así que no hace
            // falta volver a copiar los que ya están).
            try {

                const origen = path.join(__dirname, 'pdfs');
                const destino = path.join(__dirname, 'backups', 'pdfs');

                const archivos = fs.readdirSync(origen);
                let copiados = 0;

                archivos.forEach(nombre => {

                    const rutaDestino = path.join(destino, nombre);

                    if (!fs.existsSync(rutaDestino)) {
                        fs.copyFileSync(path.join(origen, nombre), rutaDestino);
                        copiados++;
                    }
                });

                // Rotación: nos quedamos solo con los últimos N backups de la base
                const backupsDb = fs.readdirSync(path.join(__dirname, 'backups'))
                    .filter(n => n.startsWith('recetas_') && n.endsWith('.db'))
                    .sort();

                while (backupsDb.length > BACKUPS_A_CONSERVAR) {
                    const viejo = backupsDb.shift();
                    fs.unlinkSync(path.join(__dirname, 'backups', viejo));
                }

                console.log(`Backup generado: ${nombreDb} (${copiados} PDF nuevos copiados)`);

                resolve({ nombreDb, pdfsCopiados: copiados });

            } catch (err2) {

                console.error('Error copiando PDFs al backup:', err2);
                reject(err2);
            }
        });
    });
}

// Primer backup a los 30s de arrancar (para no competir con el arranque),
// y después cada 6 horas.
setTimeout(() => hacerBackup().catch(() => {}), 30 * 1000);
setInterval(() => hacerBackup().catch(() => {}), 6 * 60 * 60 * 1000);

// ======================================================
// AUTH
// ======================================================

function hashearPassword(password) {

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');

    return { salt, hash };
}

function verificarPassword(password, salt, hash) {

    try {

        const hashIntentado =
            crypto.scryptSync(password, salt, 64).toString('hex');

        return crypto.timingSafeEqual(
            Buffer.from(hash, 'hex'),
            Buffer.from(hashIntentado, 'hex')
        );

    } catch {

        return false;
    }
}

// Registra en el log de auditoría una acción que CAMBIÓ algo (crear,
// editar, eliminar, setear un PLC, etc). Las acciones de solo lectura
// (ver un gráfico, listar algo) nunca deben llamar a esto.
function registrarLog(req, modulo, accion, detalle) {

    const usuario = req.usuario ? req.usuario.usuario : 'desconocido';
    const usuarioId = req.usuario ? req.usuario.id : null;

    db.run(
        `INSERT INTO log_cambios (usuario_id, usuario, modulo, accion, detalle)
         VALUES (?, ?, ?, ?, ?)`,
        [
            usuarioId,
            usuario,
            modulo,
            accion,
            detalle ? JSON.stringify(detalle) : null
        ],
        err => {

            if (err) {
                console.error('Error registrando log de cambios:', err);
            }
        }
    );
}

function usuarioDesdeFila(fila) {

    return {
        id: fila.id,
        usuario: fila.usuario,
        esAdmin: !!fila.es_admin,
        permisos: {
            devanadoras: !!fila.perm_devanadoras,
            horometros: !!fila.perm_horometros,
            visor: !!fila.perm_visor,
            compresores: !!fila.perm_compresores
        }
    };
}

// Buscamos el usuario en la base en cada request (en vez de confiar en un
// snapshot guardado en la sesión) para que si un admin le quita permisos
// a alguien, el cambio se aplique de inmediato aunque esa persona ya
// tenga una sesión abierta.
const requiereLogin = (req, res, next) => {

    if (!req.session.usuarioId) {
        return res.status(401).json({ error: 'No autenticado' });
    }

    db.get(
        `SELECT * FROM usuarios WHERE id = ?`,
        [req.session.usuarioId],
        (err, fila) => {

            if (err) {
                console.error(err);
                return res.status(500).send('Error');
            }

            if (!fila) {
                return res.status(401).json({ error: 'No autenticado' });
            }

            req.usuario = usuarioDesdeFila(fila);
            next();
        }
    );
};

const requierePermiso = (permiso) => (req, res, next) => {

    requiereLogin(req, res, () => {

        if (req.usuario.esAdmin || req.usuario.permisos[permiso]) {
            return next();
        }

        res.status(403).json({ error: 'Sin permiso para esta sección' });
    });
};

const requiereAdmin = (req, res, next) => {

    requiereLogin(req, res, () => {

        if (req.usuario.esAdmin) {
            return next();
        }

        res.status(403).json({ error: 'Solo administrador' });
    });
};

// Variantes para rutas de PÁGINA (no de API): si no hay sesión válida
// o falta el permiso, en vez de devolver un JSON de error mandan
// directo al login. Es lo que corresponde cuando alguien navega o
// recarga una URL protegida con la sesión ya vencida (las rutas de
// API siguen devolviendo JSON, que es lo que necesita el fetch()
// del navegador para saber que tiene que redirigir).
function paginaProtegida(chequeoApi) {

    return (req, res, next) => {

        const resFalso = {
            status: () => resFalso,
            json: () => res.redirect('/')
        };

        chequeoApi(req, resFalso, next);
    };
}

const requierePermisoPagina = (permiso) => paginaProtegida(requierePermiso(permiso));
const requiereAdminPagina = paginaProtegida(requiereAdmin);

// ======================================================
// LOGIN
// ======================================================

app.post('/api/login', (req, res) => {

    const { user, pass } = req.body;

    db.get(
        `SELECT * FROM usuarios WHERE usuario = ?`,
        [user],
        (err, fila) => {

            if (err) {
                console.error(err);
                return res.status(500).send('Error');
            }

            if (!fila || !verificarPassword(pass || '', fila.salt, fila.hash)) {
                return res.status(401).send('Error');
            }

            req.session.usuarioId = fila.id;

            res.json({ status: 'ok' });
        }
    );
});

app.post('/api/logout', (req, res) => {

    req.session.destroy(() => {
        res.json({ status: 'ok' });
    });
});

app.get('/api/me', requiereLogin, (req, res) => {

    res.json(req.usuario);
});

// ======================================================
// ADMINISTRACIÓN DE USUARIOS (solo admin)
// ======================================================

app.get('/api/usuarios', requiereAdmin, (req, res) => {

    db.all(
        `SELECT id, usuario, es_admin, perm_devanadoras, perm_horometros, perm_visor, perm_compresores, fecha
         FROM usuarios ORDER BY usuario ASC`,
        [],
        (err, filas) => {

            if (err) {
                console.error(err);
                return res.status(500).send('Error');
            }

            res.json(filas.map(f => ({
                id: f.id,
                usuario: f.usuario,
                esAdmin: !!f.es_admin,
                permisos: {
                    devanadoras: !!f.perm_devanadoras,
                    horometros: !!f.perm_horometros,
                    visor: !!f.perm_visor,
                    compresores: !!f.perm_compresores
                },
                fecha: f.fecha
            })));
        }
    );
});

app.post('/api/usuarios', requiereAdmin, (req, res) => {

    const { usuario, pass, esAdmin, permisos } = req.body;

    if (!usuario || !pass) {
        return res.status(400).send('Usuario y contraseña son obligatorios');
    }

    const { salt, hash } = hashearPassword(pass);

    db.run(
        `INSERT INTO usuarios
            (usuario, salt, hash, es_admin, perm_devanadoras, perm_horometros, perm_visor, perm_compresores)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            usuario,
            salt,
            hash,
            esAdmin ? 1 : 0,
            permisos && permisos.devanadoras ? 1 : 0,
            permisos && permisos.horometros ? 1 : 0,
            permisos && permisos.visor ? 1 : 0,
            permisos && permisos.compresores ? 1 : 0
        ],
        function (err) {

            if (err) {

                if (String(err.message).includes('UNIQUE')) {
                    return res.status(409).send('Ese usuario ya existe');
                }

                console.error(err);
                return res.status(500).send('Error');
            }

            registrarLog(req, 'usuarios', `Creó el usuario "${usuario}"`, {
                esAdmin: !!esAdmin,
                permisos
            });

            res.json({ status: 'ok', id: this.lastID });
        }
    );
});

app.put('/api/usuarios/:id', requiereAdmin, (req, res) => {

    const { pass, esAdmin, permisos } = req.body;
    const id = req.params.id;

    const aplicarCampos = (nombreUsuario, salt, hash) => {

        const campos = [
            'es_admin = ?',
            'perm_devanadoras = ?',
            'perm_horometros = ?',
            'perm_visor = ?',
            'perm_compresores = ?'
        ];

        const valores = [
            esAdmin ? 1 : 0,
            permisos && permisos.devanadoras ? 1 : 0,
            permisos && permisos.horometros ? 1 : 0,
            permisos && permisos.visor ? 1 : 0,
            permisos && permisos.compresores ? 1 : 0
        ];

        if (salt && hash) {
            campos.push('salt = ?', 'hash = ?');
            valores.push(salt, hash);
        }

        valores.push(id);

        db.run(
            `UPDATE usuarios SET ${campos.join(', ')} WHERE id = ?`,
            valores,
            err => {

                if (err) {
                    console.error(err);
                    return res.status(500).send('Error');
                }

                registrarLog(req, 'usuarios', `Editó el usuario "${nombreUsuario}"`, {
                    esAdmin: !!esAdmin,
                    permisos,
                    contraseñaCambiada: !!(salt && hash)
                });

                res.json({ status: 'ok' });
            }
        );
    };

    db.get(`SELECT usuario FROM usuarios WHERE id = ?`, [id], (errNombre, filaNombre) => {

        const nombreUsuario = filaNombre ? filaNombre.usuario : `id ${id}`;

        if (pass) {

            const { salt, hash } = hashearPassword(pass);

            aplicarCampos(nombreUsuario, salt, hash);

        } else {

            aplicarCampos(nombreUsuario, null, null);
        }
    });
});

app.delete('/api/usuarios/:id', requiereAdmin, (req, res) => {

    const id = req.params.id;

    db.get(
        `SELECT usuario, es_admin FROM usuarios WHERE id = ?`,
        [id],
        (err, fila) => {

            if (err) {
                console.error(err);
                return res.status(500).send('Error');
            }

            if (!fila) {
                return res.status(404).send('No existe');
            }

            const eliminar = () => {

                db.run(
                    `DELETE FROM usuarios WHERE id = ?`,
                    [id],
                    err2 => {

                        if (err2) {
                            console.error(err2);
                            return res.status(500).send('Error');
                        }

                        registrarLog(req, 'usuarios', `Eliminó el usuario "${fila.usuario}"`);

                        res.json({ status: 'ok' });
                    }
                );
            };

            if (!fila.es_admin) {
                return eliminar();
            }

            // Evitamos quedarnos sin administradores
            db.get(
                `SELECT COUNT(*) AS total FROM usuarios WHERE es_admin = 1`,
                [],
                (err3, row) => {

                    if (err3) {
                        console.error(err3);
                        return res.status(500).send('Error');
                    }

                    if (row.total <= 1) {
                        return res.status(400).send('No se puede eliminar al último administrador');
                    }

                    eliminar();
                }
            );
        }
    );
});

// ======================================================
// LOG DE CAMBIOS (auditoría, solo admin)
// ======================================================

app.get('/api/log', requiereAdmin, (req, res) => {

    const { usuario, modulo, desde, hasta } = req.query;

    let sql = `SELECT * FROM log_cambios WHERE 1 = 1`;
    const params = [];

    if (usuario) {
        sql += ` AND usuario = ?`;
        params.push(usuario);
    }

    if (modulo) {
        sql += ` AND modulo = ?`;
        params.push(modulo);
    }

    if (desde) {
        sql += ` AND date(fecha_hora) >= date(?)`;
        params.push(desde);
    }

    if (hasta) {
        sql += ` AND date(fecha_hora) <= date(?)`;
        params.push(hasta);
    }

    sql += ` ORDER BY fecha_hora DESC LIMIT 1000`;

    db.all(sql, params, (err, filas) => {

        if (err) {
            console.error(err);
            return res.status(500).send('Error');
        }

        res.json(filas.map(f => ({
            id: f.id,
            usuario: f.usuario,
            modulo: f.modulo,
            accion: f.accion,
            detalle: f.detalle ? JSON.parse(f.detalle) : null,
            fechaHora: f.fecha_hora
        })));
    });
});

// ======================================================
// BACKUPS (solo admin)
// ======================================================

app.get('/api/backups', requiereAdmin, (req, res) => {

    const carpeta = path.join(__dirname, 'backups');

    fs.readdir(carpeta, (err, archivos) => {

        if (err) {
            console.error(err);
            return res.status(500).send('Error');
        }

        const backups = archivos
            .filter(a => a.startsWith('recetas_') && a.endsWith('.db'))
            .map(a => {

                const stats = fs.statSync(path.join(carpeta, a));

                return {
                    archivo: a,
                    tamanioKb: Math.round(stats.size / 1024),
                    fecha: stats.mtime.toISOString().slice(0, 19).replace('T', ' ')
                };
            })
            .sort((a, b) => b.fecha.localeCompare(a.fecha));

        res.json(backups);
    });
});

app.post('/api/backups', requiereAdmin, async (req, res) => {

    try {

        const resultado = await hacerBackup();

        registrarLog(req, 'sistema', 'Generó un backup manual de la base de datos');

        res.json({ status: 'ok', archivo: resultado.nombreDb });

    } catch (err) {

        console.error(err);
        res.status(500).send('Error generando el backup');
    }
});

app.get('/api/backups/:archivo', requiereAdmin, (req, res) => {

    const archivo = path.basename(req.params.archivo);
    const ruta = path.join(__dirname, 'backups', archivo);

    if (!fs.existsSync(ruta)) {
        return res.status(404).send('No existe');
    }

    res.download(ruta);
});

// ======================================================
// COMPRESORES: CRUD
// ======================================================
// NOTA: todavía no tenemos la IP ni el mapeo Modbus real de cada
// compresor (depende de la marca del PLC). Por eso "ip", "puerto" y
// "marca" son opcionales por ahora: se puede cargar y programar el
// horario de cada compresor sin esos datos, y cuando se agreguen el
// apagado programado pasará de "simulado" (solo registra el evento)
// a mandar la orden real por Modbus.

app.get('/api/compresores', requierePermiso('compresores'), (req, res) => {

    db.all(
        `SELECT * FROM compresores ORDER BY nombre ASC`,
        [],
        (err, filas) => {

            if (err) {
                console.error(err);
                return res.status(500).send('Error');
            }

            // La IP/puerto/marca del PLC solo se exponen al administrador:
            // el resto de los usuarios únicamente programa horarios, así
            // que ni siquiera reciben esos datos en la respuesta.
            res.json(filas.map(f => {

                const compresor = {
                    id: f.id,
                    nombre: f.nombre,
                    horaApagado: f.hora_apagado,
                    horaEncendido: f.hora_encendido,
                    activo: !!f.activo
                };

                if (req.usuario.esAdmin) {
                    compresor.ip = f.ip;
                    compresor.puerto = f.puerto;
                    compresor.marca = f.marca;
                    compresor.coilMarcha = f.coil_marcha;
                    compresor.coilEstado = f.coil_estado;
                }

                return compresor;
            }));
        }
    );
});

app.post('/api/compresores', requiereAdmin, (req, res) => {

    const { nombre, ip, puerto, marca, coilMarcha, coilEstado } = req.body;

    if (!nombre) {
        return res.status(400).send('El nombre es obligatorio');
    }

    const aEntero = v => (v === '' || v == null ? null : parseInt(v));

    db.run(
        `INSERT INTO compresores (nombre, ip, puerto, marca, coil_marcha, coil_estado)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [nombre, ip || null, puerto || 502, marca || null, aEntero(coilMarcha), aEntero(coilEstado)],
        function (err) {

            if (err) {
                console.error(err);
                return res.status(500).send('Error');
            }

            registrarLog(req, 'compresores', `Creó el compresor "${nombre}"`, { ip, puerto, marca, coilMarcha, coilEstado });

            res.json({ status: 'ok', id: this.lastID });
        }
    );
});

// ======================================================
// COMPRESORES: HORARIO GLOBAL
// ======================================================
// (Registradas antes de las rutas con "/:id" para que Express no
// confunda "config"/"excepciones"/"eventos" con un id de compresor.)

app.get('/api/compresores/config', requierePermiso('compresores'), (req, res) => {

    db.all(
        `SELECT clave, valor FROM compresores_config
         WHERE clave IN ('hora_apagado_global', 'hora_encendido_global', 'modo_prueba')`,
        [],
        (err, filas) => {

            if (err) {
                console.error(err);
                return res.status(500).send('Error');
            }

            const porClave = {};
            filas.forEach(f => { porClave[f.clave] = f.valor; });

            res.json({
                horaApagadoGlobal: porClave.hora_apagado_global || null,
                horaEncendidoGlobal: porClave.hora_encendido_global || null,
                modoPrueba: porClave.modo_prueba === '1'
            });
        }
    );
});

app.put('/api/compresores/config', requierePermiso('compresores'), (req, res) => {

    const { horaApagadoGlobal, horaEncendidoGlobal, modoPrueba } = req.body;

    // Cada valor de config se guarda por separado, y solo se toca el que
    // realmente vino en el pedido (si no vino, queda como estaba) — así
    // guardar el modo prueba desde Administración no pisa con NULL el
    // horario global que se guarda desde la pantalla de Compresores, y
    // viceversa.
    const tareas = [];

    if (horaApagadoGlobal !== undefined) {
        tareas.push(next => db.run(
            `INSERT INTO compresores_config (clave, valor) VALUES ('hora_apagado_global', ?)
             ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`,
            [horaApagadoGlobal || null],
            next
        ));
    }

    if (horaEncendidoGlobal !== undefined) {
        tareas.push(next => db.run(
            `INSERT INTO compresores_config (clave, valor) VALUES ('hora_encendido_global', ?)
             ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`,
            [horaEncendidoGlobal || null],
            next
        ));
    }

    // El modo prueba saca el límite de "una vez por día" del programador
    // automático. Es peligroso dejarlo prendido en producción (podría
    // repetir encendido/apagado cada vez que el reloj vuelva a coincidir
    // con el horario), así que solo el administrador lo puede tocar; si
    // lo manda alguien sin ese permiso, se ignora en silencio.
    if (modoPrueba !== undefined && req.usuario.esAdmin) {
        tareas.push(next => db.run(
            `INSERT INTO compresores_config (clave, valor) VALUES ('modo_prueba', ?)
             ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`,
            [modoPrueba ? '1' : '0'],
            next
        ));
    }

    let pendientes = tareas.length;
    let huboError = false;

    if (pendientes === 0) {
        return res.json({ status: 'ok' });
    }

    tareas.forEach(tarea => tarea(err => {

        if (err && !huboError) {
            huboError = true;
            console.error(err);
            return res.status(500).send('Error');
        }

        pendientes--;

        if (pendientes === 0 && !huboError) {

            const detalles = [];
            if (horaApagadoGlobal !== undefined) detalles.push(`apagado "${horaApagadoGlobal || 'sin definir'}"`);
            if (horaEncendidoGlobal !== undefined) detalles.push(`encendido "${horaEncendidoGlobal || 'sin definir'}"`);
            if (modoPrueba !== undefined && req.usuario.esAdmin) detalles.push(`modo prueba ${modoPrueba ? 'activado' : 'desactivado'}`);

            registrarLog(req, 'compresores', `Cambió la configuración de compresores (${detalles.join(', ')})`);

            res.json({ status: 'ok' });
        }
    }));
});

// ======================================================
// COMPRESORES: ESTADO EN VIVO (¿está encendido ahora?)
// ======================================================
// Lee el contacto de "marcha" real de cada compresor (no lo que le
// ordenamos, sino lo que el compresor informa). Es aparte del resto del
// CRUD para que la pantalla lo pueda pedir sola, cada tantos segundos,
// sin frenar la carga del resto de la página si el PLC de algún
// compresor está lento o desconectado.
app.get('/api/compresores/estado', requierePermiso('compresores'), (req, res) => {

    db.all(`SELECT * FROM compresores`, [], async (err, filas) => {

        if (err) {
            console.error(err);
            return res.status(500).send('Error');
        }

        const estados = await Promise.all(filas.map(async f => {

            const resultado = await leerEstadoCompresor(f);

            return {
                id: f.id,
                disponible: resultado.disponible,
                encendido: resultado.disponible ? resultado.encendido : null
            };
        }));

        res.json(estados);
    });
});

app.put('/api/compresores/:id', requierePermiso('compresores'), (req, res) => {

    const { nombre, ip, puerto, marca, coilMarcha, coilEstado, horaApagado, horaEncendido, activo } = req.body;
    const id = req.params.id;

    // Solo el administrador puede tocar los datos de configuración del
    // PLC (nombre, ip, puerto, marca, coils), y solo cuando los manda de
    // verdad (formulario de Administración): el resto de los usuarios con
    // permiso de compresores, e incluso un admin editando desde la
    // pantalla de Compresores, únicamente programan los horarios propios
    // y activan/desactivan el compresor, sin tocar esos campos de
    // configuración (si no vienen en el body, no se pisan).
    if (req.usuario.esAdmin && nombre !== undefined) {

        const aEntero = v => (v === '' || v == null ? null : parseInt(v));

        db.run(
            `UPDATE compresores
             SET nombre = ?, ip = ?, puerto = ?, marca = ?, coil_marcha = ?, coil_estado = ?,
                 hora_apagado = ?, hora_encendido = ?, activo = ?
             WHERE id = ?`,
            [
                nombre,
                ip || null,
                puerto || 502,
                marca || null,
                aEntero(coilMarcha),
                aEntero(coilEstado),
                horaApagado || null,
                horaEncendido || null,
                activo === false ? 0 : 1,
                id
            ],
            err => {

                if (err) {
                    console.error(err);
                    return res.status(500).send('Error');
                }

                registrarLog(req, 'compresores', `Editó el compresor "${nombre}"`, {
                    ip, puerto, marca, coilMarcha, coilEstado, horaApagado, horaEncendido, activo
                });

                res.json({ status: 'ok' });
            }
        );

    } else {

        db.get(`SELECT nombre FROM compresores WHERE id = ?`, [id], (errNombre, filaNombre) => {

            const nombreCompresor = filaNombre ? filaNombre.nombre : `id ${id}`;

            db.run(
                `UPDATE compresores SET hora_apagado = ?, hora_encendido = ?, activo = ? WHERE id = ?`,
                [horaApagado || null, horaEncendido || null, activo === false ? 0 : 1, id],
                err => {

                    if (err) {
                        console.error(err);
                        return res.status(500).send('Error');
                    }

                    registrarLog(req, 'compresores', `Editó el horario del compresor "${nombreCompresor}"`, {
                        horaApagado, horaEncendido, activo
                    });

                    res.json({ status: 'ok' });
                }
            );
        });
    }
});

app.delete('/api/compresores/:id', requiereAdmin, (req, res) => {

    db.get(`SELECT nombre FROM compresores WHERE id = ?`, [req.params.id], (errNombre, filaNombre) => {

        const nombreCompresor = filaNombre ? filaNombre.nombre : `id ${req.params.id}`;

        db.run(
            `DELETE FROM compresores WHERE id = ?`,
            [req.params.id],
            err => {

                if (err) {
                    console.error(err);
                    return res.status(500).send('Error');
                }

                db.run(`DELETE FROM compresores_excepciones WHERE compresor_id = ?`, [req.params.id]);
                db.run(`DELETE FROM compresores_eventos WHERE compresor_id = ?`, [req.params.id]);

                registrarLog(req, 'compresores', `Eliminó el compresor "${nombreCompresor}"`);

                res.json({ status: 'ok' });
            }
        );
    });
});

// Botón manual de Encendido/Apagado: manda la orden real por Modbus al
// PLC del compresor (a través del relé auxiliar cableado en el borne de
// marcha/paro) y, si se pudo mandar, registra el evento en el historial.
app.post('/api/compresores/:id/evento', requierePermiso('compresores'), async (req, res) => {

    const { tipo } = req.body;

    if (tipo !== 'encendido' && tipo !== 'apagado') {
        return res.status(400).send('Tipo inválido');
    }

    db.get(`SELECT * FROM compresores WHERE id = ?`, [req.params.id], async (errCompresor, compresor) => {

        if (errCompresor) {
            console.error(errCompresor);
            return res.status(500).send('Error');
        }

        if (!compresor) {
            return res.status(404).send('Compresor no encontrado');
        }

        const resultado = await escribirOrdenCompresor(compresor, tipo === 'encendido');

        if (!resultado.ok) {
            return res.status(502).json({
                error: resultado.motivo === 'sin_configurar'
                    ? 'Este compresor todavía no tiene IP/coil configurados por el administrador.'
                    : 'No se pudo comunicar con el PLC del compresor.'
            });
        }

        db.run(
            `INSERT INTO compresores_eventos (compresor_id, tipo, origen)
             VALUES (?, ?, 'manual')`,
            [compresor.id, tipo],
            err => {

                if (err) {
                    console.error(err);
                    return res.status(500).send('Error');
                }

                registrarLog(req, 'compresores', `Comandó "${tipo}" manualmente en el compresor "${compresor.nombre}"`);

                res.json({ status: 'ok' });
            }
        );
    });
});

// ======================================================
// COMPRESORES: EXCEPCIONES POR CALENDARIO
// ======================================================

app.get('/api/compresores/excepciones', requierePermiso('compresores'), (req, res) => {

    const { desde, hasta } = req.query;

    let sql = `SELECT * FROM compresores_excepciones`;
    const params = [];

    if (desde && hasta) {
        sql += ` WHERE fecha >= ? AND fecha <= ?`;
        params.push(desde, hasta);
    }

    sql += ` ORDER BY fecha ASC`;

    db.all(sql, params, (err, filas) => {

        if (err) {
            console.error(err);
            return res.status(500).send('Error');
        }

        res.json(filas.map(f => ({
            id: f.id,
            compresorId: f.compresor_id,
            fecha: f.fecha,
            horaApagado: f.hora_apagado,
            horaEncendido: f.hora_encendido
        })));
    });
});

app.post('/api/compresores/excepciones', requierePermiso('compresores'), (req, res) => {

    const { compresorId, fecha, horaApagado, horaEncendido } = req.body;

    if (!compresorId || !fecha) {
        return res.status(400).send('Falta compresor o fecha');
    }

    db.run(
        `INSERT INTO compresores_excepciones (compresor_id, fecha, hora_apagado, hora_encendido)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(compresor_id, fecha) DO UPDATE SET
            hora_apagado = excluded.hora_apagado,
            hora_encendido = excluded.hora_encendido`,
        [compresorId, fecha, horaApagado || null, horaEncendido || null],
        function (err) {

            if (err) {
                console.error(err);
                return res.status(500).send('Error');
            }

            db.get(`SELECT nombre FROM compresores WHERE id = ?`, [compresorId], (errNombre, filaNombre) => {

                const nombreCompresor = filaNombre ? filaNombre.nombre : `id ${compresorId}`;

                registrarLog(
                    req,
                    'compresores',
                    `Programó una excepción de calendario para "${nombreCompresor}" el ${fecha} ` +
                    `(${horaApagado ? 'apaga a las ' + horaApagado : 'no apaga ese día'}, ` +
                    `${horaEncendido ? 'enciende a las ' + horaEncendido : 'no enciende ese día'})`
                );
            });

            res.json({ status: 'ok' });
        }
    );
});

app.delete('/api/compresores/excepciones/:id', requierePermiso('compresores'), (req, res) => {

    db.get(`SELECT * FROM compresores_excepciones WHERE id = ?`, [req.params.id], (errPrev, filaPrev) => {

        db.run(
            `DELETE FROM compresores_excepciones WHERE id = ?`,
            [req.params.id],
            err => {

                if (err) {
                    console.error(err);
                    return res.status(500).send('Error');
                }

                if (filaPrev) {

                    db.get(`SELECT nombre FROM compresores WHERE id = ?`, [filaPrev.compresor_id], (errNombre, filaNombre) => {

                        const nombreCompresor = filaNombre ? filaNombre.nombre : `id ${filaPrev.compresor_id}`;

                        registrarLog(
                            req,
                            'compresores',
                            `Eliminó la excepción de calendario del ${filaPrev.fecha} para "${nombreCompresor}"`
                        );
                    });
                }

                res.json({ status: 'ok' });
            }
        );
    });
});

// ======================================================
// COMPRESORES: HISTORIAL DE EVENTOS
// ======================================================

app.get('/api/compresores/eventos', requierePermiso('compresores'), (req, res) => {

    const { compresorId, desde, hasta } = req.query;

    let sql = `
        SELECT e.*, c.nombre AS compresor_nombre
        FROM compresores_eventos e
        JOIN compresores c ON c.id = e.compresor_id
        WHERE 1 = 1
    `;
    const params = [];

    if (compresorId) {
        sql += ` AND e.compresor_id = ?`;
        params.push(compresorId);
    }

    if (desde) {
        sql += ` AND date(e.fecha_hora) >= date(?)`;
        params.push(desde);
    }

    if (hasta) {
        sql += ` AND date(e.fecha_hora) <= date(?)`;
        params.push(hasta);
    }

    sql += ` ORDER BY e.fecha_hora DESC LIMIT 500`;

    db.all(sql, params, (err, filas) => {

        if (err) {
            console.error(err);
            return res.status(500).send('Error');
        }

        res.json(filas.map(f => ({
            id: f.id,
            compresorId: f.compresor_id,
            compresor: f.compresor_nombre,
            tipo: f.tipo,
            origen: f.origen,
            fechaHora: f.fecha_hora
        })));
    });
});

// ======================================================
// COMPRESORES: ORDEN REAL POR MODBUS (marcha/paro)
// ======================================================
// El compresor NO habla Modbus directamente: lo que hay cableado en su
// borne de marcha/paro es el contacto seco de un relé auxiliar, y ese
// relé lo comanda un coil del PLC (contacto cerrado = marcha, abierto =
// parada). "ip"/"puerto" son los del PLC que tiene ese coil, y
// "coil_marcha" es la dirección de ese coil — los tres los carga el
// administrador. Mientras algún compresor no los tenga cargados, la
// orden queda registrada como "no se pudo enviar" en vez de fallar en
// silencio.
async function escribirOrdenCompresor(compresor, encender) {

    if (!compresor.ip || compresor.coil_marcha === null || compresor.coil_marcha === undefined) {

        console.log(
            `⚠️ Compresor "${compresor.nombre}": falta IP o coil de marcha configurado por el ` +
            `administrador, no se pudo enviar la orden de ${encender ? 'encendido' : 'apagado'}.`
        );

        return { ok: false, motivo: 'sin_configurar' };
    }

    let socket = null;

    try {

        const conexion = await crearClienteModbus(compresor.ip, compresor.puerto || 502);

        socket = conexion.socket;

        await conexion.client.writeSingleCoil(compresor.coil_marcha, encender);

        console.log(
            `Compresor "${compresor.nombre}": orden de ${encender ? 'encendido' : 'apagado'} ` +
            `enviada por Modbus (coil ${compresor.coil_marcha} en ${compresor.ip}:${compresor.puerto || 502}).`
        );

        return { ok: true };

    } catch (err) {

        console.error(
            `Error enviando orden de ${encender ? 'encendido' : 'apagado'} al compresor "${compresor.nombre}":`,
            err.message
        );

        return { ok: false, motivo: 'error_modbus', error: err.message };

    } finally {

        if (socket) socket.destroy();
    }
}

// Lee el estado real del compresor (no lo que le ordenamos, sino lo que
// el propio compresor informa que está haciendo) a través del contacto
// seco de "marcha" que ya identificamos en cada tablero (por ejemplo,
// X117 100-101 en el Atlas Copco o J1 4-5 en el Sullair), cableado a un
// coil del PLC aparte del que usamos para comandar. Se usa solo para
// mostrar en pantalla, nunca para decidir si mandar una orden.
async function leerEstadoCompresor(compresor) {

    if (!compresor.ip || compresor.coil_estado === null || compresor.coil_estado === undefined) {
        return { disponible: false };
    }

    let socket = null;

    try {

        const conexion = await crearClienteModbus(compresor.ip, compresor.puerto || 502);

        socket = conexion.socket;

        const respuesta = await conexion.client.readCoils(compresor.coil_estado, 1);

        return { disponible: true, encendido: !!respuesta.response.body.values[0] };

    } catch (err) {

        console.error(`Error leyendo el estado del compresor "${compresor.nombre}":`, err.message);

        return { disponible: false };

    } finally {

        if (socket) socket.destroy();
    }
}

// ======================================================
// COMPRESORES: PROGRAMADOR AUTOMÁTICO (apagado y encendido)
// ======================================================

const ultimoApagadoPorCompresor = {};
const ultimoEncendidoPorCompresor = {};

async function ejecutarApagadoCompresor(compresor) {

    await escribirOrdenCompresor(compresor, false);

    db.run(
        `INSERT INTO compresores_eventos (compresor_id, tipo, origen)
         VALUES (?, 'apagado', 'programado')`,
        [compresor.id]
    );
}

async function ejecutarEncendidoCompresor(compresor) {

    await escribirOrdenCompresor(compresor, true);

    db.run(
        `INSERT INTO compresores_eventos (compresor_id, tipo, origen)
         VALUES (?, 'encendido', 'programado')`,
        [compresor.id]
    );
}

setInterval(() => {

    const ahora = new Date();
    const hoy = ahora.toISOString().slice(0, 10);

    const horaActual =
        String(ahora.getHours()).padStart(2, '0') + ':' +
        String(ahora.getMinutes()).padStart(2, '0');

    db.all(
        `SELECT clave, valor FROM compresores_config
         WHERE clave IN ('hora_apagado_global', 'hora_encendido_global', 'modo_prueba')`,
        [],
        (err, filasGlobal) => {

            if (err) {
                console.error('Error leyendo horario global de compresores:', err);
                return;
            }

            const globales = {};
            filasGlobal.forEach(f => { globales[f.clave] = f.valor; });

            const horaApagadoGlobal = globales.hora_apagado_global || null;
            const horaEncendidoGlobal = globales.hora_encendido_global || null;

            // En modo prueba no se aplica el límite de "una vez por día":
            // sirve para poder probar el horario varias veces seguidas sin
            // esperar al día siguiente. Se activa/desactiva solo desde
            // Administración (ver /api/compresores/config) y no debería
            // quedar prendido en uso normal, porque si el reloj vuelve a
            // coincidir con el mismo horario (por ejemplo al otro día,
            // dado que el horario queda guardado) va a repetir la orden
            // sin ningún límite.
            const modoPrueba = globales.modo_prueba === '1';

            db.all(
                `SELECT * FROM compresores WHERE activo = 1`,
                [],
                (err2, compresores) => {

                    if (err2) {
                        console.error('Error leyendo compresores:', err2);
                        return;
                    }

                    compresores.forEach(c => {

                        const faltaApagado = modoPrueba || ultimoApagadoPorCompresor[c.id] !== hoy;
                        const faltaEncendido = modoPrueba || ultimoEncendidoPorCompresor[c.id] !== hoy;

                        if (!faltaApagado && !faltaEncendido) {
                            return;
                        }

                        db.get(
                            `SELECT hora_apagado, hora_encendido FROM compresores_excepciones
                             WHERE compresor_id = ? AND fecha = ?`,
                            [c.id, hoy],
                            (err3, excepcion) => {

                                if (err3) {
                                    console.error('Error leyendo excepción de compresor:', err3);
                                    return;
                                }

                                const apagadoObjetivo =
                                    excepcion
                                        ? excepcion.hora_apagado
                                        : (c.hora_apagado || horaApagadoGlobal);

                                const encendidoObjetivo =
                                    excepcion
                                        ? excepcion.hora_encendido
                                        : (c.hora_encendido || horaEncendidoGlobal);

                                if (faltaApagado && apagadoObjetivo && horaActual === apagadoObjetivo) {
                                    if (!modoPrueba) ultimoApagadoPorCompresor[c.id] = hoy;
                                    ejecutarApagadoCompresor(c);
                                }

                                if (faltaEncendido && encendidoObjetivo && horaActual === encendidoObjetivo) {
                                    if (!modoPrueba) ultimoEncendidoPorCompresor[c.id] = hoy;
                                    ejecutarEncendidoCompresor(c);
                                }
                            }
                        );
                    });
                }
            );
        }
    );

}, 60 * 1000);

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

app.get('/api/leer-plc', requierePermiso('devanadoras'), async (req, res) => {

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

app.post('/api/setear-plc', requierePermiso('devanadoras'), async (req, res) => {

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

        registrarLog(req, 'devanadoras', `Seteó DEV ${dev} - CANAL ${canal}`, valores);

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
app.post('/api/setear-todas', requierePermiso('devanadoras'), async (req, res) => {
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

        registrarLog(req, 'devanadoras', 'Seteó una receta en TODAS las máquinas (canal 1 y 2, las 6)', valores);

        res.json({ status: 'ok' });

    } catch (e) {
        console.error("Error general en el proceso masivo total:", e);
        res.status(500).send("Error interno en seteo masivo total");
    }
});
// ======================================================
// RECETAS SQLITE
// ======================================================

app.get('/api/recetas', requierePermiso('devanadoras'), (req, res) => {

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

app.post('/api/recetas', requierePermiso('devanadoras'), (req, res) => {

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

            registrarLog(req, 'devanadoras', `Guardó la receta "${nombre}"`, valores);

            res.json({
                status: 'ok'
            });
        }
    );
});
// ======================================================
// ELIMINAR RECETA
// ======================================================

app.delete('/api/recetas/:id', requierePermiso('devanadoras'), (req, res) => {

    db.get(`SELECT nombre FROM recetas WHERE id = ?`, [req.params.id], (errNombre, filaNombre) => {

        const nombreReceta = filaNombre ? filaNombre.nombre : `id ${req.params.id}`;

        db.run(
            `DELETE FROM recetas WHERE id = ?`,
            [req.params.id],
            err => {

                if (err) {

                    console.error(err);

                    return res.status(500).send("Error");
                }

                registrarLog(req, 'devanadoras', `Eliminó la receta "${nombreReceta}"`);

                res.json({
                    status: 'ok'
                });
            }
        );
    });
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

// Al apagarse la variable del PLC, seguimos tomando muestras
// durante este tiempo extra antes de cerrar el ensayo y generar el PDF.
const GRACIA_FIN_ENSAYO_MS = 2000;

let enGracia = false;
let tiempoApagado = null;

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
                (i ).toFixed(1)
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

                offset: 8, // Subimos un poquito el offset para que al estar vertical no toque el punto

                rotation: -90, // 👈 ¡ESTA ES LA LÍNEA MÁGICA! Pone los números verticales

                font: {
                    size: 8, // Achicamos un pelín el texto para que entre impecable
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

            enGracia = false;

            tiempoApagado = null;

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
        // VARIABLE APAGADA: inicia/cancela la gracia
        // ==========================================

        if (ensayoActivo && !ensayando && !enGracia) {

            enGracia = true;

            tiempoApagado = Date.now();

            console.log(
                `Variable apagada, tomando muestras ${GRACIA_FIN_ENSAYO_MS / 1000}s más...`
            );

        } else if (ensayoActivo && ensayando && enGracia) {

            enGracia = false;

            tiempoApagado = null;

            console.log('Variable volvió a activarse, ensayo continúa');
        }

        const dentroDeGracia =
            enGracia &&
            (Date.now() - tiempoApagado < GRACIA_FIN_ENSAYO_MS);

        // ==========================================
        // MUESTRA
        // ==========================================

        if (ensayoActivo && (ensayando || dentroDeGracia)) {

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

        if (ensayoActivo && enGracia && !dentroDeGracia) {

            console.log('FIN ENSAYO');

            ensayoActivo = false;

            enGracia = false;

            tiempoApagado = null;

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
app.get('/api/pdfs', requierePermiso('visor'), (req, res) => {

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

app.get('/api/ensayos', requierePermiso('visor'), (req, res) => {
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
app.get('/api/pdf/:nombre', requierePermiso('visor'), (req, res) => {

    const archivo =
        path.join(
            __dirname,
            'pdfs',
            path.basename(req.params.nombre)
        );

    if (!fs.existsSync(archivo)) {

        return res.status(404)
            .send("No existe");
    }

    res.download(archivo);
});

// Descarga/visualización directa de un PDF (usada por el enlace del Visor de Ensayos)
app.get('/pdfs/:archivo', requierePermiso('visor'), (req, res) => {

    const ruta =
        path.join(
            __dirname,
            'pdfs',
            path.basename(req.params.archivo)
        );

    if (!fs.existsSync(ruta)) {

        return res.status(404)
            .send("No existe");
    }

    res.sendFile(ruta);
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
app.get('/api/horometros/maquinas', requierePermiso('horometros'), (req, res) => {
    db.all(`SELECT DISTINCT maquina FROM horometros ORDER BY maquina ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => r.maquina));
    });
});

// 2. Obtener los datos filtrados por máquina y fecha
app.get('/api/horometros/datos', requierePermiso('horometros'), (req, res) => {
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
app.get('/horometros', requierePermisoPagina('horometros'), (req, res) => {
    res.sendFile(path.join(__dirname, 'protegido', 'horometros.html'));
});

// ======================================================
// PÁGINAS PROTEGIDAS: VISOR Y ADMINISTRADOR
// ======================================================

app.get('/visor', requierePermisoPagina('visor'), (req, res) => {
    res.sendFile(path.join(__dirname, 'protegido', 'visor.html'));
});

app.get('/admin', requiereAdminPagina, (req, res) => {
    res.sendFile(path.join(__dirname, 'protegido', 'admin.html'));
});

app.get('/log', requiereAdminPagina, (req, res) => {
    res.sendFile(path.join(__dirname, 'protegido', 'log.html'));
});

app.get('/compresores', requierePermisoPagina('compresores'), (req, res) => {
    res.sendFile(path.join(__dirname, 'protegido', 'compresores.html'));
});

app.get('/compresores/historial', requierePermisoPagina('compresores'), (req, res) => {
    res.sendFile(path.join(__dirname, 'protegido', 'compresores-historial.html'));
});

app.listen(PORT, '0.0.0.0', () => {

    console.log(
        `Servidor iniciado en puerto ${PORT}`
    );
});
