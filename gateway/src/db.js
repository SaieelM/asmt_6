const path = require('path');
const { MiniDB } = require('../../shared/db-helper');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/gateway.db');
const db = new MiniDB(dbPath);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    target_service TEXT,
    status_code INTEGER,
    response_time_ms INTEGER,
    client_ip TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS service_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT UNIQUE NOT NULL,
    service_name TEXT NOT NULL,
    vm_name TEXT NOT NULL,
    network_tier TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    port INTEGER NOT NULL,
    status TEXT DEFAULT 'ONLINE',
    last_check TEXT NOT NULL
  );
`);

// Reset and seed registered microservices in gateway registry with user's GCP IPs
db.exec('DELETE FROM service_nodes;');
const now = new Date().toISOString();
const nodes = [
  { id: 'gateway', name: 'API Gateway & Frontend', vm: 'vm1-gateway', tier: 'Public Subnet', ip: 'External IP / 10.128.0.5', port: 3000 },
  { id: 'product', name: 'Product Catalog Service', vm: 'vm2-product-service', tier: 'Private Subnet', ip: '10.128.0.6', port: 4001 },
  { id: 'order', name: 'Order Processing Service', vm: 'vm3-order-service', tier: 'Private Subnet', ip: '10.128.0.7', port: 4002 },
  { id: 'inventory', name: 'Inventory & Warehouse Service', vm: 'vm4-inventory-service', tier: 'Private Subnet', ip: '10.128.0.8', port: 4003 }
];

for (const n of nodes) {
  db.run(
    `INSERT INTO service_nodes (service_id, service_name, vm_name, network_tier, ip_address, port, status, last_check)
     VALUES (?, ?, ?, ?, ?, ?, 'ONLINE', ?)`,
    [n.id, n.name, n.vm, n.tier, n.ip, n.port, now]
  );
}
console.log('[Gateway DB] Seeded microservice topology registry with GCP IPs (10.128.0.5 - 10.128.0.8).');

module.exports = db;
