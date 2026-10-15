const path = require('path');
const { MiniDB } = require('../../shared/db-helper');
const { initSyncTable } = require('../../shared/sync-protocol');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/orders.db');
const db = new MiniDB(dbPath);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_address TEXT,
    total_amount REAL NOT NULL,
    status TEXT DEFAULT 'CONFIRMED',
    created_at TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    sku TEXT NOT NULL,
    title TEXT NOT NULL,
    price REAL NOT NULL,
    quantity INTEGER NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  );
`);

initSyncTable(db);

// Seed a sample order for demonstration if empty
const count = db.get('SELECT COUNT(*) as cnt FROM orders');
if (!count || count.cnt === 0) {
  const sampleOrderNumber = 'ORD-2026-8801';
  const now = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
  const orderRes = db.run(
    `INSERT INTO orders (order_number, customer_name, customer_email, customer_address, total_amount, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sampleOrderNumber, 'Sarah Connor', 'sarah.c@cloudtech.org', '742 Evergreen Terrace, Cyber City', 2499.00, 'CONFIRMED', now]
  );

  const orderId = orderRes.lastInsertRowid || 1;
  db.run(
    `INSERT INTO order_items (order_id, sku, title, price, quantity)
     VALUES (?, ?, ?, ?, ?)`,
    [orderId, 'SKU-MAC-M3', 'Titan Pro 16" Workstation', 2499.00, 1]
  );

  console.log(`[Order DB] Seeded demo order: ${sampleOrderNumber}`);
}

module.exports = db;
