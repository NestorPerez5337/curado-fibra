/* ============================================================================
   DIAGNÓSTICO DEL SQL SERVER: ¿por qué a veces tarda o no responde?
   ============================================================================
   Para quien administra el servidor (instancia AUTOMATIZACION, SQL Server 2022).
   Se ejecuta en SSMS con una cuenta con permisos de administrador (sysadmin).
   SOLO LEE: no cambia nada. Cada bloque es independiente: si uno falla por
   permisos, seguir con el siguiente.

   Por qué se pide: el programa de curado de fibra mide la conexión con una
   consulta mínima (SELECT 1) cada 15 s, aunque nadie lo use. Esas mediciones
   mostraron que, de noche, la consulta mínima tardó de 2 a 9 s o no respondió,
   en las dos cuentas a la vez (la de lectura y la de ensayos). Eso apunta al
   servidor o a la red hasta él, no al uso del programa.

   Horas con problemas (hora de la planta). Comparar contra los resultados:
     05/10  13:42 a 13:51   no respondió
     05/10  21:51 a 21:59   respuestas lentas (3 a 8 s)
     05/10  23:50 a 23:54   respuestas lentas y un corte (23:52:58 a 23:53:04)
     06/10  00:05           respuesta lenta
     06/10  05:43 a 05:45   corte de aprox. 1 min 30 s y luego lento
   ============================================================================ */


/* 1) ¿Se reinició el servicio de SQL Server? (cuándo arrancó) */
SELECT sqlserver_start_time AS arranco_el_servicio, cpu_count AS cpus,
       CAST(physical_memory_kb / 1024 AS int) AS ram_total_mb,
       CAST(committed_kb / 1024 AS int) AS ram_usada_por_sql_mb,
       CAST(committed_target_kb / 1024 AS int) AS ram_objetivo_sql_mb
FROM sys.dm_os_sys_info;
GO


/* 2) Backups de los últimos 3 días: ¿coinciden con las horas con problemas?
      (con recuperación FULL tiene que haber backups del log periódicos) */
SELECT bs.database_name AS base,
       CASE bs.type WHEN 'D' THEN 'Completo' WHEN 'I' THEN 'Diferencial' WHEN 'L' THEN 'Log' ELSE bs.type END AS tipo,
       bs.backup_start_date AS inicio, bs.backup_finish_date AS fin,
       DATEDIFF(second, bs.backup_start_date, bs.backup_finish_date) AS segundos,
       CAST(bs.backup_size / 1048576.0 AS decimal(14, 1)) AS mb
FROM msdb.dbo.backupset AS bs
WHERE bs.backup_start_date >= DATEADD(day, -3, GETDATE())
ORDER BY bs.backup_start_date DESC;
GO


/* 3) Trabajos del SQL Server Agent ejecutados en los últimos 3 días
      (mantenimiento, reindexado, limpieza, etc.) con hora y duración */
SELECT j.name AS trabajo,
       msdb.dbo.agent_datetime(h.run_date, h.run_time) AS inicio,
       (h.run_duration / 10000) * 3600 + ((h.run_duration / 100) % 100) * 60 + (h.run_duration % 100) AS segundos,
       CASE h.run_status WHEN 1 THEN 'OK' WHEN 0 THEN 'FALLÓ' WHEN 2 THEN 'Reintento' WHEN 3 THEN 'Cancelado' ELSE 'Otro' END AS estado
FROM msdb.dbo.sysjobhistory AS h
JOIN msdb.dbo.sysjobs AS j ON j.job_id = h.job_id
WHERE h.step_id = 0
  AND msdb.dbo.agent_datetime(h.run_date, h.run_time) >= DATEADD(day, -3, GETDATE())
ORDER BY inicio DESC;
GO


/* 4) Crecimientos automáticos de archivos (últimos 3 días). Cada vez que el
      archivo de datos o el de log crece (256 MB cada vez), la base puede
      quedar sin responder unos segundos. "ms" es lo que duró. */
DECLARE @ruta nvarchar(260) =
    (SELECT REVERSE(SUBSTRING(REVERSE(path), CHARINDEX('\', REVERSE(path)), 260)) + N'log.trc'
     FROM sys.traces WHERE is_default = 1);

SELECT t.StartTime AS inicio, t.DatabaseName AS base, t.FileName AS archivo,
       CASE t.EventClass WHEN 92 THEN 'Crece archivo de DATOS' WHEN 93 THEN 'Crece archivo de LOG' END AS evento,
       t.Duration / 1000 AS ms, (t.IntegerData * 8) / 1024 AS crecimiento_mb
FROM sys.fn_trace_gettable(@ruta, DEFAULT) AS t
WHERE t.EventClass IN (92, 93) AND t.StartTime >= DATEADD(day, -3, GETDATE())
ORDER BY t.StartTime DESC;
GO


/* 5) Registro de errores de SQL Server: avisos de discos lentos.
      El mensaje "I/O requests taking longer than 15 seconds" indica que el
      almacenamiento (disco, SAN o virtualización) se quedó sin responder. */
EXEC sys.xp_readerrorlog 0, 1, N'longer than 15 seconds';
EXEC sys.xp_readerrorlog 1, 1, N'longer than 15 seconds';
GO


/* 6) Uso de CPU por minuto en las últimas ~4 horas. Sirve para ver si en las
      horas con problemas el procesador estaba saturado, por SQL Server
      ("sql_cpu") o por otros programas del servidor ("otros_procesos"). */
DECLARE @ms bigint = (SELECT ms_ticks FROM sys.dm_os_sys_info);

SELECT TOP (240)
       DATEADD(ms, -1 * (@ms - x.[timestamp]), GETDATE()) AS momento,
       x.sql_cpu, x.inactivo, 100 - x.inactivo - x.sql_cpu AS otros_procesos
FROM (
    SELECT r.[timestamp],
           r.rec.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]', 'int') AS sql_cpu,
           r.rec.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]', 'int') AS inactivo
    FROM (
        SELECT [timestamp], CONVERT(xml, record) AS rec
        FROM sys.dm_os_ring_buffers
        WHERE ring_buffer_type = N'RING_BUFFER_SCHEDULER_MONITOR' AND record LIKE N'%<SystemHealth>%'
    ) AS r
) AS x
ORDER BY x.[timestamp] DESC;
GO


/* 7) Memoria: ¿el servidor (o la máquina virtual) está justo de RAM? */
SELECT CAST(available_physical_memory_kb / 1024 AS int) AS ram_libre_mb,
       CAST(total_physical_memory_kb / 1024 AS int) AS ram_total_mb,
       system_memory_state_desc AS estado_memoria
FROM sys.dm_os_sys_memory;

SELECT CAST(physical_memory_in_use_kb / 1024 AS int) AS sql_en_uso_mb,
       process_physical_memory_low AS sql_con_poca_ram, process_virtual_memory_low AS sql_con_poca_memoria_virtual
FROM sys.dm_os_process_memory;
GO


/* 8) En qué espera más el servidor desde que arrancó (qué lo frena) */
SELECT TOP (15) wait_type AS tipo_de_espera, waiting_tasks_count AS veces,
       CAST(wait_time_ms / 1000.0 AS decimal(16, 1)) AS segundos_totales,
       CAST(max_wait_time_ms / 1000.0 AS decimal(16, 1)) AS espera_maxima_seg
FROM sys.dm_os_wait_stats
WHERE wait_type NOT LIKE N'%SLEEP%' AND wait_type NOT LIKE N'XE_%' AND wait_type NOT LIKE N'HADR_%'
  AND wait_type NOT LIKE N'BROKER_%' AND wait_type NOT LIKE N'SQLTRACE_%' AND wait_type NOT LIKE N'QDS_%'
  AND wait_type NOT IN (N'LAZYWRITER_SLEEP', N'CHECKPOINT_QUEUE', N'REQUEST_FOR_DEADLOCK_SEARCH', N'DIRTY_PAGE_POLL',
                        N'LOGMGR_QUEUE', N'ONDEMAND_TASK_QUEUE', N'WAITFOR', N'CLR_AUTO_EVENT', N'CLR_MANUAL_EVENT',
                        N'FT_IFTS_SCHEDULER_IDLE_WAIT', N'DISPATCHER_QUEUE_SEMAPHORE', N'SP_SERVER_DIAGNOSTICS_SLEEP',
                        N'PREEMPTIVE_OS_GETPROCADDRESS', N'PWAIT_ALL_COMPONENTS_INITIALIZED', N'DIRTY_PAGE_POLL')
ORDER BY wait_time_ms DESC;
GO


/* 9) ¿Quién está conectado? Cantidad de sesiones por equipo y programa
      (Node-RED, el programa de curado, otros). Muchas sesiones de un mismo
      origen pueden indicar conexiones que se acumulan. */
SELECT s.host_name AS equipo, s.program_name AS programa, s.login_name AS cuenta, COUNT(*) AS sesiones,
       MAX(s.last_request_end_time) AS ultima_actividad
FROM sys.dm_exec_sessions AS s
WHERE s.is_user_process = 1
GROUP BY s.host_name, s.program_name, s.login_name
ORDER BY COUNT(*) DESC;
GO


/* 10) Las consultas más lentas registradas (desde que arrancó el servicio o
       desde que se limpió la caché de planes). Muestra si alguna consulta de
       las aplicaciones (Node-RED, Consumos de Energía, Visor PH) es pesada. */
SELECT TOP (15)
       qs.execution_count AS ejecuciones,
       CAST(qs.total_elapsed_time / 1000.0 / qs.execution_count AS decimal(14, 1)) AS ms_promedio,
       CAST(qs.max_elapsed_time / 1000.0 AS decimal(14, 1)) AS ms_maximo,
       qs.total_logical_reads / qs.execution_count AS lecturas_promedio,
       qs.last_execution_time AS ultima_vez,
       SUBSTRING(st.text, (qs.statement_start_offset / 2) + 1,
                 ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) ELSE qs.statement_end_offset END
                   - qs.statement_start_offset) / 2) + 1) AS consulta
FROM sys.dm_exec_query_stats AS qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) AS st
ORDER BY qs.max_elapsed_time DESC;
GO


/* 11) Tablas más grandes de la base Automatizacion (cantidad de filas) */
USE Automatizacion;
GO
SELECT TOP (15) t.name AS tabla, SUM(p.rows) AS filas
FROM sys.tables AS t
JOIN sys.partitions AS p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY t.name
ORDER BY SUM(p.rows) DESC;
GO
