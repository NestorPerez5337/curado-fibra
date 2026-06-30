# Pasamos a la versión estándar de Node 20 (Debian) para máxima compatibilidad gráfica
FROM node:20

# 1. Instalamos las dependencias nativas del sistema operativo que necesita 'canvas'
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# 2. Definimos el directorio de trabajo dentro del contenedor
WORKDIR /app

# 3. Copiamos los archivos de configuración de paquetes
COPY package*.json ./

# 4. Instalamos las dependencias de producción
# Nota: En Node 20 se recomienda usar --omit=dev en lugar de --production
RUN npm install --omit=dev

# 5. Copiamos el resto del código de tu SCADA
COPY . .

# 6. Exponemos el puerto de comunicación
EXPOSE 3000

# 7. Comando de arranque
CMD ["node", "server.js"]