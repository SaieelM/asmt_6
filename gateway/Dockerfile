FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY shared ./shared
COPY gateway ./gateway

RUN npm install --omit=dev

EXPOSE 3000

CMD ["node", "gateway/src/server.js"]
