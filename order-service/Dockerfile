FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY shared ./shared
COPY order-service ./order-service

RUN npm install --omit=dev

EXPOSE 4002

CMD ["node", "order-service/src/server.js"]
