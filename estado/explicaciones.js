// ======================================================
// ERRORES EXPLICADOS EN PALABRAS SIMPLES
// ======================================================
//
// Traduce los mensajes que el programa escribe como error o advertencia
// (la lista "Últimos errores del programa" del panel de Estado) a dos cosas:
//
//   queSignifica   qué pasó, dicho sin términos técnicos
//   queHacer       qué conviene hacer (o "nada, se resuelve solo")
//
// Es una lista de reglas: gana la primera que coincide, por eso van de las
// más específicas a las más generales. Si ninguna coincide se devuelve null y
// la pantalla muestra el mensaje solo, sin inventar una explicación.
//
// Para agregar un mensaje nuevo: sumar una regla con su patrón (sobre el texto
// completo del mensaje) y una función explicar(coincidencia) que devuelva
// { queSignifica, queHacer }.

// «mirar los cortes»: se usa al principio de una frase (mayúscula) y en medio de otra (minúscula)
const VER_CORTES_SQL = 'Abrir «Cortes y demoras del SQL Server» (más arriba en esta pantalla): ahí se ve si el problema fue la red o el servidor SQL.';
const ver_cortes_sql = VER_CORTES_SQL.charAt(0).toLowerCase() + VER_CORTES_SQL.slice(1);

const AVISAR_ADMIN_SQL = 'Si el corte dura más de unos minutos o se repite seguido, avisar a quien administra el servidor SQL.';

// Qué deja de funcionar según la cuenta de SQL que falló (ver sql-pool.js)
const CONSECUENCIA_SQL = {
    PH: 'Mientras dure, el Visor PH y Consumos de Energía muestran error.',
    ensayos: 'Mientras dure, los ensayos terminados se guardan solo en la base local y se suben solos cuando vuelve.'
};

const VARIABLE_CLAVE = {
    PH: 'PH_SQL_PASSWORD',
    ensayos: 'ENSAYOS_SQL_PASSWORD'
};

const consecuenciaSql = nombre => CONSECUENCIA_SQL[nombre] || '';

const esCredenciales = texto => /Login failed|ELOGIN|\b18456\b/i.test(texto);
const esReinicioOPuerto = texto => /ECONNREFUSED|Could not connect|ESOCKET|Failed to connect/i.test(texto);
const esCorteDeConexion = texto => /aborted|ECONNRESET/i.test(texto);
const esSinRespuesta = texto => /ETIMEOUT|timed out|No respondió/i.test(texto);

function explicarCredencialesSql(nombre) {

    return {
        queSignifica: 'El servidor SQL rechazó el usuario o la contraseña de la cuenta que usa el programa. ' + consecuenciaSql(nombre),
        queHacer: `Revisar que la contraseña cargada en Portainer (${VARIABLE_CLAVE[nombre] || 'PH_SQL_PASSWORD / ENSAYOS_SQL_PASSWORD'}) sea la vigente y que la cuenta no se haya cambiado ni bloqueado en el servidor. Si alguien cambió la contraseña, hay que actualizarla en Portainer y redesplegar.`
    };
}

const REGLAS = [

    // ---------- SQL Server (los mensajes de sql-pool.js)

    {
        id: 'sql-reinicio',
        area: 'SQL Server',
        patron: /^SQL Server: se reinició el servicio/,
        explicar: () => ({
            queSignifica: 'El servicio SQL Server arrancó de nuevo: el servidor volvió a crear su base temporal, algo que solo ocurre cuando el servicio se reinicia (por una actualización, un reinicio del servidor, un mantenimiento o una falla). Mientras arrancaba no aceptó conexiones, por eso pudieron aparecer errores de conexión justo antes de este aviso.',
            queHacer: 'Si fue un reinicio planificado no hay nada que hacer: el programa se reconectó solo. Si nadie lo hizo a propósito, preguntar a quien administra el servidor qué lo causó (el registro de errores de SQL Server y el visor de eventos de Windows indican el motivo). En «Cortes y demoras del SQL Server» se ve el episodio que provocó.'
        })
    },

    {
        id: 'sql-sin-respuesta',
        area: 'SQL Server',
        patron: /^SQL (\w+): sin respuesta \(([\s\S]*)\)\. Los pedidos fallan/,
        explicar: m => {

            const nombre = m[1];
            const detalle = m[2];

            if (esCredenciales(detalle)) {
                return explicarCredencialesSql(nombre);
            }

            let causa = 'El SQL Server dejó de responder.';

            if (esReinicioOPuerto(detalle)) {
                causa = 'No se pudo abrir la conexión con el SQL Server (el puerto no respondió). Si dura menos de un minuto suele ser un reinicio del servicio; si dura más, el servidor o la red hasta él están caídos.';
            } else if (esCorteDeConexion(detalle)) {
                causa = 'El SQL Server cortó las conexiones que estaban abiertas, y el programa no pudo volver a conectarse enseguida.';
            } else if (esSinRespuesta(detalle)) {
                causa = 'La red llegó al servidor, pero el SQL Server no contestó a tiempo (está ocupado o trabado).';
            }

            return {
                queSignifica: `${causa} El programa lo marcó como caído: los pedidos a SQL fallan al instante hasta que vuelva. ${consecuenciaSql(nombre)}`.trim(),
                queHacer: `${VER_CORTES_SQL} ${AVISAR_ADMIN_SQL} Cuando vuelve, el programa se reconecta solo, no hay que reiniciar nada.`
            };
        }
    },

    {
        id: 'sql-lenta',
        area: 'SQL Server',
        patron: /^SQL (\w+): respuesta lenta \((\d+) ms\)/,
        explicar: m => ({
            queSignifica: `El SQL Server contestó, pero tardó ${(parseInt(m[2], 10) / 1000).toFixed(1).replace('.', ',')} segundos (lo normal es menos de 1 segundo). Es una demora, no un corte.`,
            queHacer: `Si pasa de vez en cuando no hace falta hacer nada. Si se repite, ${ver_cortes_sql} ${AVISAR_ADMIN_SQL}`
        })
    },

    {
        id: 'sql-conexion',
        area: 'SQL Server',
        patron: /^SQL (\w+): error en la conexión: ([\s\S]*)$/,
        explicar: m => {

            const nombre = m[1];
            const detalle = m[2];

            if (esCredenciales(detalle)) {
                return explicarCredencialesSql(nombre);
            }

            let causa = 'Falló la conexión con el SQL Server.';

            if (esReinicioOPuerto(detalle)) {
                causa = 'No se pudo abrir la conexión con el SQL Server (el puerto no respondió): suele ser un reinicio del servicio o el servidor caído.';
            } else if (esCorteDeConexion(detalle)) {
                causa = 'El SQL Server cerró o cortó una conexión que estaba abierta. Suele aparecer durante o justo después de un corte del servidor.';
            } else if (esSinRespuesta(detalle)) {
                causa = 'Una conexión con el SQL Server dejó de responder: no contestó a tiempo.';
            }

            return {
                queSignifica: causa,
                queHacer: `El programa vuelve a conectarse solo. Si se repite seguido, ${ver_cortes_sql}`
            };
        }
    },

    {
        id: 'sql-historial',
        area: 'SQL Server',
        patron: /No se pudo guardar la medición de SQL|Error purgando el historial de SQL/,
        explicar: () => ({
            queSignifica: 'No se pudo guardar o limpiar el historial de mediciones de la conexión al SQL Server (se guarda en la base local del Monitor). No afecta al funcionamiento, solo a ese historial.',
            queHacer: 'Revisar el espacio en disco (panel «Disco», más arriba). Si se repite, avisar a soporte.'
        })
    },

    // ---------- Ensayos de Bursting

    {
        id: 'ensayo-no-guardado',
        area: 'Ensayo de Bursting',
        patron: /ENSAYO NO GUARDADO/,
        explicar: () => ({
            queSignifica: 'Un ensayo terminó pero no se pudo guardar ni siquiera en la base local, después de varios intentos. Es lo más grave de esta lista: esas muestras pueden perderse.',
            queHacer: 'Avisar a soporte de inmediato y no borrar nada: este mismo mensaje, en los registros del contenedor, trae las muestras completas. Revisar el espacio en disco y el estado de la base local.'
        })
    },

    {
        id: 'ensayo-guardado-sql-pendiente',
        area: 'Ensayo de Bursting',
        patron: /No se pudo guardar el ensayo en SQL Server \(se reintenta solo\)/,
        explicar: () => ({
            queSignifica: 'El ensayo quedó guardado en la base local, pero todavía no pudo subirse al SQL Server. Los datos no se perdieron.',
            queHacer: 'No hace falta hacer nada: se reintenta solo cada 5 minutos. En el Visor de Ensayos se ve cuáles esperan y hay un botón «Subir pendientes ahora». Si el SQL sigue caído, mirar «Cortes y demoras del SQL Server».'
        })
    },

    {
        id: 'ensayo-intento',
        area: 'Ensayo de Bursting',
        patron: /No se pudo guardar el ensayo \(intento (\d+) de (\d+)\)/,
        explicar: m => ({
            queSignifica: `Falló el intento ${m[1]} de ${m[2]} de guardar un ensayo recién terminado en la base local. El programa lo vuelve a intentar.`,
            queHacer: 'Si después aparece «ENSAYO NO GUARDADO» es grave (ver ese mensaje). Si no aparece, el ensayo se guardó en un intento posterior y no hay que hacer nada.'
        })
    },

    {
        id: 'ensayo-rescatado',
        area: 'Ensayo de Bursting',
        patron: /Se rescató un ensayo que quedó a medias/,
        explicar: () => ({
            queSignifica: 'El programa se reinició (o se cayó) en pleno ensayo. Lo que se había tomado hasta ese momento se guardó como ensayo «Interrumpido»; no se sube a SQL Server porque está incompleto.',
            queHacer: 'Mirar en el Visor de Ensayos el ensayo marcado «Interrumpido» y decidir si hay que repetirlo. Conviene evitar actualizar el programa mientras hay un ensayo en curso.'
        })
    },

    {
        id: 'ensayo-tope',
        area: 'Ensayo de Bursting',
        patron: /Ensayo cortado por seguridad/,
        explicar: () => ({
            queSignifica: 'El ensayo llegó al máximo de muestras sin que el PLC avisara que terminó, y el programa lo cortó por seguridad.',
            queHacer: 'Revisar en el PLC del ensayo que la señal de «ensayando» no haya quedado pegada en encendido, y repetir el ensayo si hace falta.'
        })
    },

    {
        id: 'ensayo-avance',
        area: 'Ensayo de Bursting',
        patron: /No se pudo (guardar el avance del ensayo en curso|preparar el guardado progresivo del ensayo|rescatar el ensayo que había quedado en curso|borrar el avance del ensayo en curso)|El avance del ensayo en curso estaba dañado/,
        explicar: m => ({
            queSignifica: /dañado/.test(m[0])
                ? 'Al arrancar, el registro del ensayo que estaba en curso estaba dañado y no se pudo recuperar.'
                : 'No se pudo guardar en la base local el avance del ensayo en curso. Si el programa se reinicia justo ahora, ese ensayo podría perderse.',
            queHacer: 'Revisar el espacio en disco (panel «Disco») y el estado de la base local. Si se repite, avisar a soporte antes de actualizar o reiniciar el programa.'
        })
    },

    {
        id: 'ensayo-plc',
        area: 'Ensayo de Bursting',
        patron: /Error monitor ensayo:/,
        explicar: () => ({
            queSignifica: 'El programa no pudo leer el PLC del ensayo de Bursting. Mientras no responda no se toman muestras.',
            queHacer: 'Verificar en «Conexiones» (más arriba) el estado del PLC del ensayo y que el equipo esté encendido y en la red. El programa reintenta solo cada segundo.'
        })
    },

    {
        id: 'ensayo-tablas',
        area: 'Ensayo de Bursting',
        patron: /^Error creando las tablas de ensayos/,
        explicar: () => ({
            queSignifica: 'Al arrancar, el programa no pudo crear o revisar las tablas donde guarda los ensayos en la base local. El guardado de ensayos puede fallar.',
            queHacer: 'Avisar a soporte antes de hacer un ensayo. Revisar el espacio en disco (panel «Disco»).'
        })
    },

    {
        id: 'ensayo-lectura',
        area: 'Ensayo de Bursting',
        patron: /^Error (listando ensayos guardados|leyendo el estado de los ensayos|leyendo ensayo guardado)/,
        explicar: () => ({
            queSignifica: 'No se pudo leer de la base local la lista o el detalle de los ensayos. Este error no borra nada, pero mientras dure el Visor de Ensayos puede verse vacío o incompleto.',
            queHacer: 'Actualizar la pantalla. Si se repite, revisar el espacio en disco y avisar a soporte antes de reiniciar el programa.'
        })
    },

    {
        id: 'ensayo-subida-manual',
        area: 'Ensayo de Bursting',
        patron: /^Error subiendo ensayos pendientes/,
        explicar: () => ({
            queSignifica: 'Falló un intento de subir los ensayos pendientes al SQL Server. Los ensayos siguen guardados en la base local y el programa reintenta solo cada 5 minutos.',
            queHacer: `No hace falta repetirlo a mano si el SQL Server está caído. ${VER_CORTES_SQL}`
        })
    },

    {
        id: 'ensayo-pdf',
        area: 'Ensayo de Bursting',
        patron: /^Error generando el PDF del ensayo guardado/,
        explicar: () => ({
            queSignifica: 'No se pudo generar el PDF de un ensayo. El ensayo y sus muestras siguen guardados.',
            queHacer: 'Volver a pedir el PDF. Si se repite con el mismo ensayo, avisar a soporte con el mensaje completo.'
        })
    },

    // ---------- PLC: compresores y devanadoras

    {
        id: 'compresor',
        area: 'Compresores',
        patron: /^Error (enviando orden de (encendido|apagado) al compresor|leyendo el estado del compresor) "([^"]*)"/,
        explicar: m => ({
            queSignifica: m[2]
                ? `No se pudo enviar la orden de ${m[2]} al compresor «${m[3]}»: el PLC no respondió. La orden no se aplicó.`
                : `No se pudo leer el estado del compresor «${m[3]}»: el PLC no respondió, así que el estado que se muestra puede no ser el real.`,
            queHacer: 'Verificar en «Conexiones» (más arriba) el estado del PLC de ese compresor, que esté encendido y en la red. Si era una orden de encendido o apagado, confirmar en el equipo que haya quedado como se esperaba y repetirla.'
        })
    },

    {
        id: 'devanadora-escritura',
        area: 'Devanadoras',
        patron: /Error al escribir en el PLC DEV/,
        explicar: () => ({
            queSignifica: 'No se pudo escribir la receta en el PLC de una devanadora. Ese cambio no se aplicó en esa máquina.',
            queHacer: 'Verificar en «Conexiones» que la devanadora responda y repetir el seteo. Revisar en el log de cambios qué se aplicó y qué no.'
        })
    },

    {
        id: 'devanadora-masivo',
        area: 'Devanadoras',
        patron: /Error general en el proceso masivo total/,
        explicar: () => ({
            queSignifica: 'Falló el seteo masivo de recetas (SETEAR EN TODAS): puede haberse aplicado solo en algunas devanadoras.',
            queHacer: 'No dar por aplicado el cambio. Revisar devanadora por devanadora que tenga la receta correcta y repetir el seteo en las que falten.'
        })
    },

    {
        id: 'compresores-lectura',
        area: 'Compresores',
        patron: /^Error leyendo (horario global de compresores|compresores|excepción de compresor)/,
        explicar: () => ({
            queSignifica: 'No se pudo leer de la base local la configuración de los compresores (horarios o excepciones). La pantalla de compresores puede verse vacía o incompleta, y los horarios automáticos podrían no aplicarse.',
            queHacer: 'Actualizar la pantalla. Si se repite, revisar el espacio en disco (panel «Disco») y avisar a soporte.'
        })
    },

    // ---------- Horómetros (MQTT / Node-RED)

    {
        id: 'mqtt-conexion',
        area: 'Horómetros (MQTT)',
        patron: /Error en la conexión MQTT/,
        explicar: () => ({
            queSignifica: 'Se perdió la conexión con el broker MQTT (Mosquitto), que trae los horómetros de las máquinas. Los horómetros no se actualizan hasta que vuelva.',
            queHacer: 'El programa reintenta solo. Verificar en «Conexiones» el estado del broker MQTT; si sigue caído, revisar que el Mosquitto esté encendido.'
        })
    },

    {
        id: 'mqtt-json',
        area: 'Horómetros (MQTT)',
        patron: /Error al procesar el JSON de Node-RED/,
        explicar: () => ({
            queSignifica: 'Llegó un mensaje de horómetros con un formato que el programa no entiende, y se descartó.',
            queHacer: 'Si se repite, revisar en Node-RED el flujo que publica los horómetros.'
        })
    },

    {
        id: 'mqtt-maquina-nueva',
        area: 'Horómetros (MQTT)',
        patron: /Se ignoró la máquina nueva "([^"]*)" por MQTT/,
        explicar: m => ({
            queSignifica: `Llegaron datos de una máquina nueva («${m[1]}»), pero ya se alcanzó el máximo de máquinas permitido y se ignoró.`,
            queHacer: 'Si es una máquina real, avisar a soporte para ampliar el máximo. Si no, revisar quién está publicando con ese nombre.'
        })
    },

    {
        id: 'mqtt-base',
        area: 'Horómetros (MQTT)',
        patron: /Error al insertar en DB para la máquina/,
        explicar: () => ({
            queSignifica: 'No se pudo guardar en la base local un dato de horómetro.',
            queHacer: 'Revisar el espacio en disco (panel «Disco»). Si se repite, avisar a soporte.'
        })
    },

    // ---------- Backups

    {
        id: 'backup',
        area: 'Backups',
        patron: /^Error (haciendo backup de la base|haciendo backup de la base del monitor|copiando PDFs al backup)/,
        explicar: () => ({
            queSignifica: 'Falló un backup automático. Los datos siguen en uso normal, pero hasta que el siguiente backup salga bien hay menos respaldo.',
            queHacer: 'Revisar el espacio en disco (panel «Disco»). Probar un backup manual desde Administración; si también falla, avisar a soporte.'
        })
    },

    // ---------- Base de datos local y disco

    {
        id: 'base-danada',
        area: 'Base local',
        patron: /SQLITE_CORRUPT|database disk image is malformed/i,
        explicar: () => ({
            queSignifica: 'La base de datos local parece dañada.',
            queHacer: 'Avisar a soporte de inmediato. No seguir cargando datos: hay que restaurar el último backup (Administración → backups).'
        })
    },

    {
        id: 'disco-lleno',
        area: 'Disco',
        patron: /SQLITE_FULL|ENOSPC|no space left/i,
        explicar: () => ({
            queSignifica: 'El disco donde corre el programa se quedó sin espacio y no se pudo guardar un dato.',
            queHacer: 'Liberar espacio cuanto antes (ver el panel «Disco» y los backups viejos) o ampliar el volumen. Mientras no haya lugar, los datos nuevos pueden perderse.'
        })
    },

    {
        id: 'base-restriccion',
        area: 'Base local',
        patron: /SQLITE_CONSTRAINT|UNIQUE constraint failed/,
        explicar: () => ({
            queSignifica: 'La base local rechazó un dato porque ya existe o no cumple una regla (por ejemplo un nombre repetido). Ese dato no se guardó.',
            queHacer: 'Si alguien estaba cargando algo (usuario, receta, máquina), revisar que no exista ya con ese nombre. Si se repite sin que nadie esté cargando nada, avisar a soporte.'
        })
    },

    {
        id: 'base-ocupada',
        area: 'Base local',
        patron: /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i,
        explicar: () => ({
            queSignifica: 'La base local estaba ocupada con otra operación un instante y no pudo atender el pedido.',
            queHacer: 'Suele resolverse solo. Si aparece muchas veces seguidas, avisar a soporte.'
        })
    },

    {
        id: 'sin-permiso',
        area: 'Disco',
        patron: /SQLITE_READONLY|EACCES|EPERM/,
        explicar: () => ({
            queSignifica: 'El programa no tiene permiso para escribir en un archivo o carpeta.',
            queHacer: 'Revisar los permisos del volumen de datos en Portainer. Avisar a soporte.'
        })
    },

    {
        id: 'arranque-base',
        area: 'Base local',
        patron: /^Error (leyendo esquema de|migrando columna|verificando administrador|creando administrador inicial)/,
        explicar: () => ({
            queSignifica: 'Al arrancar, el programa no pudo preparar o revisar una tabla de la base local.',
            queHacer: 'Si el programa funciona con normalidad, avisar a soporte igual para revisarlo. Si no funciona bien, restaurar el último backup y avisar.'
        })
    },

    {
        id: 'log-cambios',
        area: 'Base local',
        patron: /Error registrando log de cambios/,
        explicar: () => ({
            queSignifica: 'No se pudo guardar un renglón del log de cambios (el registro de quién cambió qué).',
            queHacer: 'Revisar el espacio en disco (panel «Disco»). Si se repite, avisar a soporte.'
        })
    },

    // ---------- Pantallas y módulos

    {
        id: 'monitor-variable',
        area: 'Monitor de Variables',
        patron: /^Monitor: no se pudo iniciar la variable "([^"]*)"/,
        explicar: m => ({
            queSignifica: `La variable «${m[1]}» del Monitor no pudo empezar a monitorearse (configuración incorrecta o PLC inalcanzable).`,
            queHacer: 'Abrir el Monitor de Variables, revisar la dirección y el tipo de esa variable, y verificar que el PLC responda.'
        })
    },

    {
        id: 'monitor',
        area: 'Monitor de Variables',
        patron: /^Monitor:/,
        explicar: () => ({
            queSignifica: 'El Monitor de Variables tuvo un problema al guardar o consultar datos de sus variables.',
            queHacer: 'Abrir el Monitor de Variables y verificar que las variables sigan registrando. Si se repite, avisar a soporte.'
        })
    },

    {
        id: 'energia',
        area: 'Consumos de Energía',
        patron: /^Consumos de energía:/,
        explicar: () => ({
            queSignifica: 'No se pudieron consultar los datos de energía o generar el Excel. Casi siempre es porque el SQL Server no respondió.',
            queHacer: `Reintentar en un rato. Si sigue fallando, ${ver_cortes_sql}`
        })
    },

    {
        id: 'visor-ph',
        area: 'Visor PH',
        patron: /^Visor PH:/,
        explicar: () => ({
            queSignifica: 'No se pudieron consultar los datos del Visor PH. Casi siempre es porque el SQL Server no respondió.',
            queHacer: `Reintentar en un rato. Si sigue fallando, ${ver_cortes_sql}`
        })
    },

    {
        id: 'lote-ph',
        area: 'Visor PH',
        patron: /^Lote PH/,
        explicar: () => ({
            queSignifica: 'Falló la generación de PDFs en lote del Visor PH (o una parte de ella).',
            queHacer: 'Volver a generar el lote. Si se repite con el mismo ensayo, avisar a soporte con el mensaje completo.'
        })
    },

    {
        id: 'estado',
        area: 'Panel de Estado',
        patron: /^Estado:/,
        explicar: () => ({
            queSignifica: 'El panel de Estado no pudo leer una parte de la información (por ejemplo una conexión o el historial). El resto de la pantalla sigue funcionando.',
            queHacer: 'Suele ser pasajero: actualizar la pantalla. Si se repite, avisar a soporte.'
        })
    },

    // ---------- El programa en general

    {
        id: 'error-global',
        area: 'Programa',
        patron: /ERROR GLOBAL|PROMESA FALLIDA/,
        explicar: () => ({
            queSignifica: 'Se produjo un error que ninguna parte del programa estaba esperando. El programa siguió funcionando, pero algo no terminó de hacerse.',
            queHacer: 'Si se repite o notás algo raro en las pantallas, copiar el mensaje completo desde los registros del contenedor y pasarlo a soporte.'
        })
    },

    {
        id: 'session-secret',
        area: 'Programa',
        patron: /SESSION_SECRET/,
        explicar: () => ({
            queSignifica: 'Falta la variable SESSION_SECRET. Las sesiones de los usuarios se cierran cada vez que el programa se reinicia.',
            queHacer: 'Cargar la variable SESSION_SECRET en Portainer (variables de entorno del contenedor) y redesplegar.'
        })
    },

    // ---------- Último recurso: errores de red genéricos de cualquier módulo

    {
        id: 'red-generica',
        area: 'Red',
        patron: /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ECONNRESET|Timed out/i,
        explicar: () => ({
            queSignifica: 'Un equipo de la red no respondió o rechazó la conexión (apagado, sin red o con otra dirección).',
            queHacer: 'Mirar en «Conexiones» (más arriba) cuál equipo figura en rojo y verificar que esté encendido y en la red.'
        })
    }
];

// Devuelve { id, area, queSignifica, queHacer }, o null si no hay explicación para ese mensaje.
function explicarError(mensaje) {

    if (typeof mensaje !== 'string') {
        return null;
    }

    try {

        for (const regla of REGLAS) {

            const coincidencia = mensaje.match(regla.patron);

            if (coincidencia) {

                const { queSignifica, queHacer } = regla.explicar(coincidencia);

                return { id: regla.id, area: regla.area, queSignifica, queHacer };
            }
        }

    } catch {
        // una explicación mal armada nunca debe romper el panel
    }

    return null;
}

module.exports = { explicarError, REGLAS };
