// ======================================================
// MÁQUINAS DE ENSAYO PH
// ======================================================
//
// Lista de máquinas que muestra el Visor de Ensayos PH. Todas guardan sus
// ensayos en la base Automatizacion con el mismo esquema maestro/detalle:
//
//   <maestro>: una fila por ensayo (Id, NumeroOP, NumeroCano, NumeroCano2,
//              CodigoProducto, PresionMin, PresionMax, UnidadPresion,
//              FechaEnsayo). Node-RED la escribe al TERMINAR el ensayo.
//   <detalle>: una lectura de presión por segundo (Id, Id_Maestro,
//              Presion, FechaHora).
//
// Los nombres de tabla quedan fijos acá a propósito: en SQL no se pueden
// pasar como parámetro, así que el usuario solo elige una clave de esta
// lista y nunca escribe un nombre de tabla.
//
// Para sumar una máquina nueva alcanza con agregar su línea. Si no tiene
// la columna NumeroCano2, poner tieneCano2: false.

const MAQUINAS = {
    ph9: { nombre: 'PH9', maestro: 'ph9_maestro', detalle: 'ph9_detalle', tieneCano2: true },
};

function obtenerMaquina(clave) {
    return Object.prototype.hasOwnProperty.call(MAQUINAS, clave) ? MAQUINAS[clave] : null;
}

function listarMaquinas() {
    return Object.entries(MAQUINAS).map(([clave, m]) => ({ clave, nombre: m.nombre }));
}

module.exports = { obtenerMaquina, listarMaquinas };
