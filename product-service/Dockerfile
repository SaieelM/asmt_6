FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY shared ./shared
COPY product-service ./product-service

RUN npm install --omit=dev

EXPOSE 4001

CMD ["node", "product-service/src/server.js"]
