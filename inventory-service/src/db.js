const path = require('path');
const { MiniDB } = require('../../shared/db-helper');
const { initSyncTable } = require('../../shared/sync-protocol');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/inventory.db');
const db = new MiniDB(dbPath);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS warehouse_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    warehouse_zone TEXT NOT NULL,
    on_hand_qty INTEGER NOT NULL,
    allocated_qty INTEGER NOT NULL DEFAULT 0,
    reorder_point INTEGER NOT NULL DEFAULT 5,
    last_restocked_at TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS stock_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    reference_id TEXT,
    created_at TEXT NOT NULL
  );
`);

initSyncTable(db);

// Seed if empty
const count = db.get('SELECT COUNT(*) as cnt FROM warehouse_items');
if (!count || count.cnt === 0) {
  const now = new Date().toISOString();
  const seedItems = [
    { sku: 'SKU-MAC-M3', title: 'Titan Pro 16" Workstation', zone: 'Zone-A (Bay-02)', on_hand: 15, allocated: 1, reorder: 3 },
    { sku: 'SKU-ANC-HEADSET', title: 'Aura Studio ANC Headphones', zone: 'Zone-A (Bay-09)', on_hand: 28, allocated: 0, reorder: 5 },
    { sku: 'SKU-CURVED-MONITOR', title: 'UltraWide 38" Curved 4K HDR', zone: 'Zone-B (Bay-01)', on_hand: 9, allocated: 0, reorder: 2 },
    { sku: 'SKU-MECH-KEYBOARD', title: 'Apex Custom Mechanical Keyboard', zone: 'Zone-B (Bay-06)', on_hand: 35, allocated: 0, reorder: 8 },
    { sku: 'SKU-SMART-WATCH', title: 'Vanguard Chrono Smartwatch', zone: 'Zone-C (Bay-03)', on_hand: 19, allocated: 0, reorder: 4 },
    { sku: 'SKU-ERGONOMIC-MOUSE', title: 'Precision Master Wireless Mouse', zone: 'Zone-C (Bay-08)', on_hand: 42, allocated: 0, reorder: 10 }
  ];

  for (const item of seedItems) {
    db.run(
      `INSERT INTO warehouse_items (sku, title, warehouse_zone, on_hand_qty, allocated_qty, reorder_point, last_restocked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [item.sku, item.title, item.zone, item.on_hand, item.allocated, item.reorder, now]
    );

    db.run(
      `INSERT INTO stock_ledger (sku, delta, reason, reference_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [item.sku, item.on_hand, 'INITIAL_INVENTORY_SYNC', 'SYSTEM_BOOT', now]
    );
  }
  console.log(`[Inventory DB] Seeded ${seedItems.length} warehouse items and stock ledger.`);
}

module.exports = db;
