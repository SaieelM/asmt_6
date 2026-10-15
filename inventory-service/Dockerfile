FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY shared ./shared
COPY inventory-service ./inventory-service

RUN npm install --omit=dev

EXPOSE 4003

CMD ["node", "inventory-service/src/server.js"]
