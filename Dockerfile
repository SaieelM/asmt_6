FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests
COPY package.json ./
COPY shared ./shared

# Copy all services
COPY gateway ./gateway
COPY product-service ./product-service
COPY order-service ./order-service
COPY inventory-service ./inventory-service

# Install dependencies
RUN npm install --omit=dev

EXPOSE 3000 4001 4002 4003

# Default entrypoint (overridden by docker-compose)
CMD ["node", "run-all.js"]
