// ======================================================
// REINICIOS DEL SQL SERVER
// ======================================================
//
// sql-pool.js lee cada minuto cuándo arrancó el servicio de SQL Server (la
// fecha de creación de tempdb) y lo informa. Acá se decide qué hacer con esa
// lectura: si es la primera, se guarda como punto de partida; si coincide con
// la última guardada no pasa nada; y si el servicio arrancó DESPUÉS de lo que
// teníamos guardado, hubo un reinicio: se guarda y se avisa.
//
// Las dos cuentas del programa (lectura y ensayos) leen lo mismo, y varias
// lecturas pueden llegar a la vez: por eso se procesan de a una, para no
// guardar dos veces el mismo reinicio.

// Dos lecturas del mismo arranque pueden diferir unos segundos (se calcula a
// partir de los segundos que lleva encendido): menos que esto es el mismo.
const TOLERANCIA_ARRANQUE_MS = 60 * 1000;

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

// ultimo: la última lectura guardada ({ arranque } en ms) o null/undefined si no hay ninguna.
function evaluarArranque(ultimo, arranque) {

    if (!ultimo) {
        return { accion: 'inicial' };
    }

    const diferencia = arranque - ultimo.arranque;

    if (Math.abs(diferencia) <= TOLERANCIA_ARRANQUE_MS) {
        return { accion: 'igual' };
    }

    if (diferencia > 0) {
        return { accion: 'reinicio', previo: ultimo.arranque };
    }

    // un arranque anterior al que ya teníamos: lectura atrasada o reloj raro, se ignora
    return { accion: 'ignorar' };
}

// ultimoGuardado() -> { arranque } | null
// guardar({ arranque, detectado, servicio, reinicio, previo })
// alReiniciar({ arranque, previo, servicio, detectado })
function crearRegistroArranques({ ultimoGuardado, guardar, alReiniciar }) {

    let cola = Promise.resolve();

    function registrar(servicio, lectura) {

        const tarea = cola.then(async () => {

            const ultimo = await ultimoGuardado();
            const resultado = evaluarArranque(ultimo, lectura.arranque);

            if (resultado.accion === 'igual' || resultado.accion === 'ignorar') {
                return resultado;
            }

            const reinicio = resultado.accion === 'reinicio';

            await guardar({
                arranque: lectura.arranque,
                detectado: lectura.t,
                servicio,
                reinicio,
                previo: resultado.previo || null
            });

            if (reinicio) {

                try {
                    alReiniciar({ arranque: lectura.arranque, previo: resultado.previo, servicio, detectado: lectura.t });
                } catch {
                    // el aviso no puede impedir que se siga registrando
                }
            }

            return resultado;
        });

        // un error de una lectura no frena las siguientes
        cola = tarea.catch(() => {});

        return tarea;
    }

    return { registrar };
}

// "21 días 4 h", "3 h 20 min", "12 min", "40 s"
function textoTiempoEncendido(ms) {

    if (ms < MIN) {
        return `${Math.max(0, Math.floor(ms / 1000))} s`;
    }

    // Se redondea una sola vez (a minutos, y a horas desde un día) y recién después se
    // reparte en unidades: así nunca queda "2 h 60 min" ni "1 día 24 h".
    const minutos = Math.round(ms / MIN);

    if (minutos < 60) {
        return `${minutos} min`;
    }

    if (minutos < 24 * 60) {

        const horas = Math.floor(minutos / 60);
        const resto = minutos % 60;

        return resto ? `${horas} h ${resto} min` : `${horas} h`;
    }

    const horasTotales = Math.round(minutos / 60);
    const dias = Math.floor(horasTotales / 24);
    const horas = horasTotales % 24;

    return `${dias} ${dias === 1 ? 'día' : 'días'}${horas ? ` ${horas} h` : ''}`;
}

// Mensaje para el registro de errores del programa (se ve en "Últimos errores")
function mensajeDeReinicio({ arranque, previo }) {

    const llevaba = previo ? ` Llevaba ${textoTiempoEncendido(arranque - previo)} encendido sin reiniciarse.` : '';

    return `SQL Server: se reinició el servicio.${llevaba}`;
}

module.exports = {
    evaluarArranque,
    crearRegistroArranques,
    textoTiempoEncendido,
    mensajeDeReinicio,
    TOLERANCIA_ARRANQUE_MS
};
