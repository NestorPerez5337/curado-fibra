/*
  ENSAYOS DE PRESIÓN - tablas Maestro / Detalle
  Base: Automatizacion (misma estructura que PH1_*, PH2_* y PH9_*).

  Requiere permiso CREATE TABLE. Crea Bursting_Maestro y Bursting_Detalle.
*/

USE Automatizacion;
GO

DECLARE @Maquina sysname = N'Bursting';

IF OBJECT_ID(N'dbo.' + QUOTENAME(@Maquina + N'_Maestro'), N'U') IS NOT NULL
    THROW 50001, 'Ya existe la tabla Maestro de esa maquina.', 1;

DECLARE @sql nvarchar(max) = N'
CREATE TABLE dbo.[{M}_Maestro] (
    Id             INT IDENTITY(1,1) NOT NULL,
    NumeroOP       NVARCHAR(25)  NULL,
    NumeroCano     NVARCHAR(25)  NULL,
    NumeroCano2    NVARCHAR(25)  NULL,
    CodigoProducto NVARCHAR(250) NULL,
    PresionMin     DECIMAL(10,2) NULL,
    PresionMax     DECIMAL(10,2) NULL,
    UnidadPresion  NVARCHAR(25)  NULL,
    FechaEnsayo    DATETIME      NOT NULL,
    CONSTRAINT [PK_{M}_Maestro] PRIMARY KEY CLUSTERED (Id)
);

CREATE TABLE dbo.[{M}_Detalle] (
    Id         INT IDENTITY(1,1) NOT NULL,
    Id_Maestro INT NOT NULL,
    Presion    DECIMAL(18,2) NULL,
    FechaHora  DATETIME NULL,
    CONSTRAINT [PK_{M}_Detalle] PRIMARY KEY CLUSTERED (Id),
    CONSTRAINT [FK_{M}_Detalle_Maestro] FOREIGN KEY (Id_Maestro) REFERENCES dbo.[{M}_Maestro] (Id)
);

CREATE NONCLUSTERED INDEX [IX_{M}_Detalle_IdMaestro_FechaHora]
    ON dbo.[{M}_Detalle] (Id_Maestro, FechaHora);
';

SET @sql = REPLACE(@sql, N'{M}', @Maquina);

EXEC sys.sp_executesql @sql;
GO

/*
  Usuario de la aplicación (opcional, recomendado): en vez de usar la cuenta
  de Node-RED (que escribe en todas las tablas), crear un usuario propio con
  permiso solo sobre estas dos tablas:

  GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.<MAQUINA>_Maestro TO <usuario>;
  GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.<MAQUINA>_Detalle TO <usuario>;
*/
