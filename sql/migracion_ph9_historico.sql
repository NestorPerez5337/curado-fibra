-- ======================================================
-- MIGRACIÓN PH9: HISTÓRICO DEL SCADA -> TABLAS REALES
-- ======================================================
--
-- Suma a PH9_Maestro / PH9_Detalle (las que lee el Visor PH, máquina "PH9")
-- los ensayos del SCADA (scada-1, base Scada, PH9_TMC_Resumen /
-- PH9_TMC_Detalle) que Node-RED NO tiene. Los ensayos de Node-RED no se
-- tocan: tienen la curva completa, el SCADA solo los últimos 3 minutos.
--
-- Se corre en SSMS conectado al servidor nuevo (10.106.100.15\automatizacion)
-- como sa. Usa los servidores vinculados SCADA1 (scada-1, solo lectura) y RN
-- (título del producto).
--
-- PRIMERO correrlo con @soloMirar = 1 (viene así): no escribe nada, solo
-- muestra cuántos ensayos copiaría. Si está todo bien, cambiar a 0 y correr
-- de nuevo. Conviene hacerlo cuando no haya un ensayo terminando (tarda
-- unos segundos y mientras tanto Node-RED espera para grabar).
--
-- Se puede volver a correr: nunca copia un ensayo que ya esté (por Id) ni
-- uno que Node-RED tenga.
--
-- Reglas (acordadas con Dario, 13 y 14/10/2026):
--  * Duplicados del SCADA (grababa casi todo dos veces hasta el 13/10/2026):
--    mismo Op + Cano1 grabados con menos de 60 s = un ensayo; queda la fila
--    con horas (si hay varias, la última grabada).
--  * Se copia un ensayo del SCADA si Node-RED no tiene uno de la misma OP
--    grabado a ±30 s (sin mirar el caño: el SCADA a veces lo grabó en 0).
--    En la práctica: todo lo anterior al 24/09/2026 15:32 (arranque de
--    Node-RED) y los pocos que Node-RED no llegó a grabar.
--  * Se conservan los Id del SCADA (el contador de PH9_Maestro salta a ese
--    número y Node-RED sigue numerando desde ahí).
--  * Título = IDDiseno + ' ' + Nombre de RN.RN.dbo.OPsShared (igual que
--    Node-RED); si la OP no está, el código de DatosOp. Unidad: PSI.
--  * No se copian ensayos de los últimos 10 minutos (Node-RED puede estar
--    por grabarlos).

USE Automatizacion;
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @soloMirar bit = 1;   -- 1 = solo mostrar; 0 = copiar de verdad

-- ------------------------------------------------------
-- 1) Traer del SCADA y de RN a tablas temporales (fuera de la transacción:
--    leer de un servidor vinculado dentro de una transacción la convierte
--    en distribuida)
-- ------------------------------------------------------

IF OBJECT_ID('tempdb..#r') IS NOT NULL DROP TABLE #r;
IF OBJECT_ID('tempdb..#ops') IS NOT NULL DROP TABLE #ops;
IF OBJECT_ID('tempdb..#quedan') IS NOT NULL DROP TABLE #quedan;
IF OBJECT_ID('tempdb..#copiar') IS NOT NULL DROP TABLE #copiar;
IF OBJECT_ID('tempdb..#d') IS NOT NULL DROP TABLE #d;

SELECT Id, Op, Cano1, Cano2,
       DatosOp COLLATE DATABASE_DEFAULT AS DatosOp,
       LimiteInf, LimiteSup, Hora1, DateAdd
INTO #r
FROM SCADA1.Scada.dbo.PH9_TMC_Resumen;

SELECT OP, (IDDiseno + ' ' + Nombre) COLLATE DATABASE_DEFAULT AS titulo
INTO #ops
FROM RN.RN.dbo.OPsShared;

DECLARE @filasScada int = (SELECT COUNT(*) FROM #r);
PRINT CONCAT('Filas en el SCADA: ', @filasScada);

-- ------------------------------------------------------
-- 2) Sacar los duplicados del SCADA
-- ------------------------------------------------------

WITH ordenadas AS (
    SELECT *,
           CASE WHEN DATEDIFF(second,
                         LAG(DateAdd) OVER (PARTITION BY Op, Cano1 ORDER BY DateAdd, Id),
                         DateAdd) < 60
                THEN 0 ELSE 1 END AS nuevo
    FROM #r
),
grupos AS (
    SELECT *, SUM(nuevo) OVER (PARTITION BY Op, Cano1 ORDER BY DateAdd, Id ROWS UNBOUNDED PRECEDING) AS grupo
    FROM ordenadas
),
elegidas AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY Op, Cano1, grupo
                                 ORDER BY CASE WHEN Hora1 = '00:00:00' THEN 1 ELSE 0 END,
                                          DateAdd DESC, Id DESC) AS orden
    FROM grupos
)
SELECT Id, Op, Cano1, Cano2, DatosOp, LimiteInf, LimiteSup, DateAdd
INTO #quedan
FROM elegidas
WHERE orden = 1;

DECLARE @ensayosScada int = (SELECT COUNT(*) FROM #quedan);
PRINT CONCAT('Ensayos del SCADA sin duplicados: ', @ensayosScada);

-- ------------------------------------------------------
-- 3) Cuáles faltan en PH9_Maestro
-- ------------------------------------------------------

SELECT q.*
INTO #copiar
FROM #quedan q
WHERE q.DateAdd < DATEADD(minute, -10, GETDATE())
  AND NOT EXISTS (SELECT 1 FROM dbo.PH9_Maestro m WHERE m.Id = q.Id)
  AND NOT EXISTS (SELECT 1 FROM dbo.PH9_Maestro m
                  WHERE m.NumeroOP = LTRIM(RTRIM(CAST(q.Op AS nvarchar(25))))
                    AND ABS(DATEDIFF(second, m.FechaEnsayo, q.DateAdd)) <= 30);

CREATE UNIQUE CLUSTERED INDEX ix_copiar ON #copiar (Id);

DECLARE @aCopiar int = (SELECT COUNT(*) FROM #copiar);
PRINT CONCAT('Ensayos a copiar: ', @aCopiar, '  |  ya están (Node-RED u otra corrida): ', @ensayosScada - @aCopiar);

-- Resumen de lo que se copiaría
SELECT YEAR(DateAdd) AS anio, COUNT(*) AS ensayos_a_copiar,
       MIN(DateAdd) AS desde, MAX(DateAdd) AS hasta
FROM #copiar GROUP BY YEAR(DateAdd) ORDER BY anio;

-- Los que son posteriores al arranque de Node-RED (deberían ser muy pocos)
SELECT c.Id, c.Op, c.Cano1, c.DateAdd AS grabado_scada
FROM #copiar c
WHERE c.DateAdd >= (SELECT MIN(FechaEnsayo) FROM dbo.PH9_Maestro)
ORDER BY c.DateAdd;

-- Choque de Id con un ensayo de Node-RED (debería ser vacío)
SELECT c.Id AS id_choca FROM #copiar c JOIN dbo.PH9_Maestro m ON m.Id = c.Id;

IF @soloMirar = 1
BEGIN
    PRINT '';
    PRINT '*** Modo SOLO MIRAR: no se copió nada. Para copiar, poner @soloMirar = 0 y correr de nuevo. ***';
    RETURN;
END

IF @aCopiar = 0
BEGIN
    PRINT 'No hay nada para copiar.';
    RETURN;
END

-- ------------------------------------------------------
-- 4) Muestras de los ensayos a copiar (a tabla temporal, por tandas)
-- ------------------------------------------------------

CREATE TABLE #d (Id_Maestro int NOT NULL, Presion decimal(18,2) NULL, FechaHora datetime NULL);

DECLARE @desde int, @hasta int, @paso int = 100000, @leidas int = 0;

SELECT @desde = MIN(Id), @hasta = MAX(Id) FROM SCADA1.Scada.dbo.PH9_TMC_Detalle;

WHILE @desde <= @hasta
BEGIN
    INSERT INTO #d (Id_Maestro, Presion, FechaHora)
    SELECT d.Id_Resumen, d.Valor, d.Fecha
    FROM SCADA1.Scada.dbo.PH9_TMC_Detalle d
    JOIN #copiar c ON c.Id = d.Id_Resumen
    WHERE d.Id >= @desde AND d.Id < @desde + @paso;

    SET @leidas += @@ROWCOUNT;
    RAISERROR('  muestras leídas del SCADA: %d (tanda desde Id %d)', 0, 1, @leidas, @desde) WITH NOWAIT;
    SET @desde += @paso;
END

-- ------------------------------------------------------
-- 5) Copiar a las tablas reales, todo o nada
-- ------------------------------------------------------

BEGIN TRANSACTION;

    SET IDENTITY_INSERT dbo.PH9_Maestro ON;

    INSERT INTO dbo.PH9_Maestro
           (Id, NumeroOP, NumeroCano, NumeroCano2, CodigoProducto, PresionMin, PresionMax, UnidadPresion, FechaEnsayo)
    SELECT c.Id,
           LTRIM(RTRIM(CAST(c.Op AS nvarchar(25)))),
           LTRIM(RTRIM(CAST(c.Cano1 AS nvarchar(25)))),
           LTRIM(RTRIM(CAST(c.Cano2 AS nvarchar(25)))),
           LEFT(COALESCE(o.titulo, NULLIF(LTRIM(RTRIM(c.DatosOp)), '')), 250),
           c.LimiteInf,
           c.LimiteSup,
           N'PSI',
           c.DateAdd
    FROM #copiar c
    LEFT JOIN #ops o ON o.OP = TRY_CAST(c.Op AS int);

    SET IDENTITY_INSERT dbo.PH9_Maestro OFF;

    INSERT INTO dbo.PH9_Detalle (Id_Maestro, Presion, FechaHora)
    SELECT Id_Maestro, Presion, FechaHora
    FROM #d
    ORDER BY Id_Maestro, FechaHora;

COMMIT TRANSACTION;

PRINT CONCAT('Copiados: ', @aCopiar, ' ensayos y ', @leidas, ' muestras');

-- ------------------------------------------------------
-- 6) Controles
-- ------------------------------------------------------

-- Totales de PH9 (histórico + Node-RED)
SELECT COUNT(*) AS ensayos_total,
       COUNT(c.Id) AS del_scada_recien_copiados,
       MIN(m.FechaEnsayo) AS desde, MAX(m.FechaEnsayo) AS hasta,
       IDENT_CURRENT('dbo.PH9_Maestro') AS contador_id_ahora
FROM dbo.PH9_Maestro m
LEFT JOIN #copiar c ON c.Id = m.Id;

-- Muestras por ensayo de lo copiado (esperado: todos 180)
SELECT muestras, COUNT(*) AS ensayos
FROM (SELECT c.Id, COUNT(d.Id) AS muestras
      FROM #copiar c
      LEFT JOIN dbo.PH9_Detalle d ON d.Id_Maestro = c.Id
      GROUP BY c.Id) x
GROUP BY muestras ORDER BY muestras;

-- Ensayos por año en PH9
SELECT YEAR(FechaEnsayo) AS anio, COUNT(*) AS ensayos
FROM dbo.PH9_Maestro
GROUP BY YEAR(FechaEnsayo) ORDER BY anio;
