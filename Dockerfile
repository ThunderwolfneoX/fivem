# Stage 1: Build Stage
FROM node:20-alpine AS builder

# Atur direktori kerja di dalam container
WORKDIR /app

# Salin file package.json dan package-lock.json (jika ada) ke dalam container
COPY package*.json ./

# Instal dependensi aplikasi secara production (tanpa devDependencies)
RUN npm install --production

# Salin semua file aplikasi ke dalam container
COPY . .

# Stage 2: Production Stage
FROM node:20-alpine

# Atur direktori kerja di dalam container
WORKDIR /app

# Salin folder node_modules yang sudah ter-install dari stage builder
COPY --from=builder /app/node_modules ./node_modules

# Salin semua file aplikasi dari stage builder
COPY --from=builder /app ./

# Ekspose port yang digunakan aplikasi
EXPOSE 8080

# Perintah untuk menjalankan aplikasi
CMD [ "npm", "start" ]
