/**
 * Local Orchestrator Runner
 * Spawns the 4 separate microservices as isolated processes with their respective mini databases.
 * Configured with GCP internal IPs:
 *  - VM-1: Gateway & Frontend (Port 3000) [Public entrypoint - 10.128.0.5]
 *  - VM-2: Product Catalog Service (Port 4001) [Private - 10.128.0.6]
 *  - VM-3: Order Service (Port 4002) [Private - 10.128.0.7]
 *  - VM-4: Inventory Service (Port 4003) [Private - 10.128.0.8]
 */

const { spawn } = require('child_process');
const path = require('path');

const services = [
  {
    name: 'VM-2:ProductCatalog',
    dir: path.join(__dirname, 'product-service'),
    script: 'src/server.js',
    color: '\x1b[36m', // Cyan
    env: {
      PORT: '4001',
      VM_NAME: 'VM-2 (Product Catalog)',
      PRIVATE_IP: '10.128.0.6',
      ORDER_SERVICE_URL: 'http://localhost:4002',
      INVENTORY_SERVICE_URL: 'http://localhost:4003'
    }
  },
  {
    name: 'VM-3:OrderService',
    dir: path.join(__dirname, 'order-service'),
    script: 'src/server.js',
    color: '\x1b[33m', // Yellow
    env: {
      PORT: '4002',
      VM_NAME: 'VM-3 (Order Service)',
      PRIVATE_IP: '10.128.0.7',
      PRODUCT_SERVICE_URL: 'http://localhost:4001',
      INVENTORY_SERVICE_URL: 'http://localhost:4003'
    }
  },
  {
    name: 'VM-4:InventoryService',
    dir: path.join(__dirname, 'inventory-service'),
    script: 'src/server.js',
    color: '\x1b[32m', // Green
    env: {
      PORT: '4003',
      VM_NAME: 'VM-4 (Inventory Service)',
      PRIVATE_IP: '10.128.0.8',
      PRODUCT_SERVICE_URL: 'http://localhost:4001',
      ORDER_SERVICE_URL: 'http://localhost:4002'
    }
  },
  {
    name: 'VM-1:PublicGateway',
    dir: path.join(__dirname, 'gateway'),
    script: 'src/server.js',
    color: '\x1b[35m', // Magenta
    env: {
      PORT: '3000',
      VM_NAME: 'VM-1 (Public Gateway)',
      PUBLIC_IP: '127.0.0.1',
      PRIVATE_IP: '10.128.0.5',
      PRODUCT_SERVICE_URL: 'http://localhost:4001',
      ORDER_SERVICE_URL: 'http://localhost:4002',
      INVENTORY_SERVICE_URL: 'http://localhost:4003'
    }
  }
];

const processes = [];

console.log('\x1b[1m\x1b[34m===============================================================');
console.log('   LAUNCHING 4 DISTRIBUTED MICROSERVICES & MINI-DATABASES   ');
console.log('===============================================================\x1b[0m');

services.forEach(srv => {
  const env = { ...process.env, ...srv.env };
  const child = spawn(process.execPath, [srv.script], {
    cwd: srv.dir,
    env,
    stdio: ['inherit', 'pipe', 'pipe']
  });

  child.stdout.on('data', data => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => {
      console.log(`${srv.color}[${srv.name}]\x1b[0m ${line}`);
    });
  });

  child.stderr.on('data', data => {
    console.error(`${srv.color}[${srv.name} ERROR]\x1b[0m ${data.toString().trim()}`);
  });

  child.on('close', code => {
    console.log(`${srv.color}[${srv.name}]\x1b[0m Exited with code ${code}`);
  });

  processes.push(child);
});

// Graceful cleanup on termination
process.on('SIGINT', () => {
  console.log('\n\x1b[33mStopping all 4 microservices...\x1b[0m');
  processes.forEach(p => p.kill('SIGINT'));
  process.exit();
});

process.on('SIGTERM', () => {
  processes.forEach(p => p.kill('SIGTERM'));
  process.exit();
});
