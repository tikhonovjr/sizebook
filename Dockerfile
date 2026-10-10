FROM node:22-slim

# Шрифты нужны для картинки-превью ссылки (sharp рисует SVG через librsvg)
RUN apt-get update && apt-get install -y fonts-dejavu-core --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
