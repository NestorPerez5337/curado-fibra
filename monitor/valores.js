// ======================================================
// MONITOR DE VARIABLES: VALORES
// ======================================================
//
// Cómo se convierte lo que contesta el equipo en el valor que se muestra y se
// registra: formato del registro (16 o 32 bits, decimal, un bit suelto), escala
// (factor y suma), decimales y unidad. Son funciones puras, sin red ni base.
//
// Valor mostrado = valor del equipo × factor + suma.
// Ejemplo: un registro que manda 253 para una temperatura de 25,3 °C se carga
// con factor 0,1 y unidad "°C".

const FORMATOS = ['uint16', 'int16', 'uint32', 'int32', 'float32', 'bit'];
const FORMATOS_32_BITS = ['uint32', 'int32', 'float32'];

// Con dos registros: 'alta' = el primero trae la parte alta del número (lo más
// común); 'baja' = el primero trae la parte baja (algunos equipos, como los
// Modicon de Schneider).
const ORDENES_PALABRAS = ['alta', 'baja'];

const LARGO_MAXIMO_UNIDAD = 12;
const DECIMALES_MAXIMOS = 6;
const LIMITE_FACTOR = 1e9;
const LIMITE_SUMA = 1e12;

const ESCALA_NEUTRA = { factor: 1, desplazamiento: 0, decimales: null, unidad: null };

const registrosQueOcupa = formato => FORMATOS_32_BITS.includes(formato) ? 2 : 1;

function numeroODefecto(valor, defecto) {

    if (valor === null || valor === undefined || valor === '' || !Number.isFinite(Number(valor))) {
        return defecto;
    }

    return Number(valor);
}

function esNumeroTexto(valor) {
    return valor !== '' && valor !== null && valor !== undefined && Number.isFinite(Number(valor));
}

// El decimal más corto que vuelve a dar exactamente el mismo número de 32 bits
// (25.299999237060547 → 25.3).
function redondearFloat32(x) {

    if (!Number.isFinite(x) || x === 0) {
        return x;
    }

    for (let precision = 1; precision <= 9; precision++) {

        const candidato = Number(x.toPrecision(precision));

        if (Math.fround(candidato) === x) {
            return candidato;
        }
    }

    return x;
}

// Palabras de 16 bits que devolvió el equipo → número (o 'ON'/'OFF' si se pidió
// un bit). Si lo que llegó no sirve, tira un Error con el motivo en castellano.
function interpretarRegistros(cfg, palabras) {

    const formato = cfg.formato || 'uint16';
    const necesarias = registrosQueOcupa(formato);

    if (!Array.isArray(palabras) || palabras.length < necesarias) {
        throw new Error(`El equipo devolvió menos registros de los pedidos (se esperaban ${necesarias})`);
    }

    const p0 = Number(palabras[0]) & 0xFFFF;

    if (formato === 'uint16') {
        return p0;
    }

    if (formato === 'int16') {
        return p0 > 32767 ? p0 - 65536 : p0;
    }

    if (formato === 'bit') {
        return ((p0 >> cfg.bit_registro) & 1) ? 'ON' : 'OFF';
    }

    const p1 = Number(palabras[1]) & 0xFFFF;

    const [alta, baja] = cfg.orden_palabras === 'baja' ? [p1, p0] : [p0, p1];

    const bytes = Buffer.alloc(4);
    bytes.writeUInt16BE(alta, 0);
    bytes.writeUInt16BE(baja, 2);

    if (formato === 'uint32') {
        return bytes.readUInt32BE(0);
    }

    if (formato === 'int32') {
        return bytes.readInt32BE(0);
    }

    const decimal = bytes.readFloatBE(0);

    if (!Number.isFinite(decimal)) {
        throw new Error('El equipo devolvió un valor decimal que no es un número (NaN o infinito). Revisá el formato y el orden de los registros');
    }

    return redondearFloat32(decimal);
}

// Aplica factor, suma y decimales y devuelve el texto. Sin decimales
// configurados muestra el número tal cual (sin ceros de más).
function textoDeNumero(numero, cfg = {}) {

    const factor = numeroODefecto(cfg.factor, 1);
    const suma = numeroODefecto(cfg.desplazamiento, 0);

    // toPrecision(12) saca el ruido binario (253 × 0,1 = 25.3, no 25.300000000000004)
    const valor = Number((numero * factor + suma).toPrecision(12));

    if (!Number.isFinite(valor)) {
        throw new Error('El resultado de aplicar la escala no es un número válido');
    }

    const decimales = cfg.decimales === null || cfg.decimales === undefined || cfg.decimales === '' ? null : Number(cfg.decimales);

    const texto = decimales === null ? String(valor) : valor.toFixed(decimales);

    // "-0" y "-0.00" se muestran como "0" y "0.00"
    return texto.replace(/^-(0(?:\.0+)?)$/, '$1');
}

// Valor que se muestra para un registro o bit de un equipo Modbus.
function valorModbus(cfg, palabras) {

    if (cfg.funcion === 'coil' || cfg.funcion === 'discreta') {
        return palabras[0] ? 'ON' : 'OFF';
    }

    const interpretado = interpretarRegistros(cfg, palabras);

    if (typeof interpretado === 'string') {
        return interpretado;
    }

    return textoDeNumero(interpretado, cfg);
}

function tieneEscala(cfg) {

    const hayDecimales = cfg.decimales !== null && cfg.decimales !== undefined && cfg.decimales !== '';

    return numeroODefecto(cfg.factor, 1) !== 1 || numeroODefecto(cfg.desplazamiento, 0) !== 0 || hayDecimales;
}

// Valor de un mensaje MQTT: sin escala configurada queda como llegó (puede ser
// texto); con escala tiene que ser un número.
function valorMqtt(texto, cfg) {

    if (!tieneEscala(cfg)) {
        return texto;
    }

    if (!esNumeroTexto(texto)) {

        const mostrado = String(texto).length > 40 ? String(texto).slice(0, 40) + '…' : String(texto);

        throw new Error(`El valor "${mostrado}" no es un número: no se puede aplicar la escala`);
    }

    return textoDeNumero(Number(texto), cfg);
}

// Texto con la unidad al final, para mostrar y para el registro de eventos. El
// valor que se compara y se guarda como "último" va siempre sin unidad.
function conUnidad(texto, cfg) {

    if (!cfg || !cfg.unidad || texto === null || texto === undefined || texto === '') {
        return texto;
    }

    return `${texto} ${cfg.unidad}`;
}

// ----------------------------------------------------
// Validación de lo que llega del formulario
// ----------------------------------------------------

// Factor, suma, decimales y unidad. Devuelve { datos } o { error }.
function validarEscala(b) {

    const vacio = valor => valor === '' || valor === null || valor === undefined;

    const factor = vacio(b.factor) ? 1 : Number(b.factor);

    if (!Number.isFinite(factor) || factor === 0 || Math.abs(factor) > LIMITE_FACTOR) {
        return { error: 'El factor debe ser un número distinto de 0' };
    }

    const desplazamiento = vacio(b.desplazamiento) ? 0 : Number(b.desplazamiento);

    if (!Number.isFinite(desplazamiento) || Math.abs(desplazamiento) > LIMITE_SUMA) {
        return { error: 'La suma debe ser un número' };
    }

    let decimales = null;

    if (!vacio(b.decimales)) {

        decimales = Number(b.decimales);

        if (!Number.isInteger(decimales) || decimales < 0 || decimales > DECIMALES_MAXIMOS) {
            return { error: `Los decimales deben ser un entero entre 0 y ${DECIMALES_MAXIMOS} (o dejarlos vacíos)` };
        }
    }

    const unidad = typeof b.unidad === 'string' ? b.unidad.trim() : '';

    if (unidad.length > LARGO_MAXIMO_UNIDAD) {
        return { error: `La unidad puede tener hasta ${LARGO_MAXIMO_UNIDAD} caracteres` };
    }

    if (/[\u0000-\u001f\u007f]/.test(unidad)) {
        return { error: 'La unidad tiene caracteres que no se pueden usar' };
    }

    return { datos: { factor, desplazamiento, decimales, unidad: unidad || null } };
}

// Formato de un registro (holding o input). Devuelve { datos } o { error }.
function validarFormatoRegistro(b, direccion) {

    const formato = b.formato || 'uint16';

    if (!FORMATOS.includes(formato)) {
        return { error: 'El formato del registro no es válido' };
    }

    let bitRegistro = null;
    let ordenPalabras = null;

    if (formato === 'bit') {

        const n = b.bit_registro === '' || b.bit_registro === null || b.bit_registro === undefined ? NaN : Number(b.bit_registro);

        if (!Number.isInteger(n) || n < 0 || n > 15) {
            return { error: 'El número de bit debe estar entre 0 y 15' };
        }

        bitRegistro = n;
    }

    if (FORMATOS_32_BITS.includes(formato)) {

        ordenPalabras = b.orden_palabras || 'alta';

        if (!ORDENES_PALABRAS.includes(ordenPalabras)) {
            return { error: 'El orden de los registros no es válido' };
        }

        if (direccion > 65534) {
            return { error: 'Un valor de 32 bits ocupa 2 registros: la dirección máxima es 65534' };
        }
    }

    return { datos: { formato, bit_registro: bitRegistro, orden_palabras: ordenPalabras } };
}

module.exports = {
    FORMATOS,
    FORMATOS_32_BITS,
    ORDENES_PALABRAS,
    ESCALA_NEUTRA,
    LARGO_MAXIMO_UNIDAD,
    registrosQueOcupa,
    interpretarRegistros,
    textoDeNumero,
    valorModbus,
    valorMqtt,
    tieneEscala,
    conUnidad,
    validarEscala,
    validarFormatoRegistro
};
