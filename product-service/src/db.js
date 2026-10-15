const path = require('path');
const { MiniDB } = require('../../shared/db-helper');
const { initSyncTable } = require('../../shared/sync-protocol');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/products.db');
const db = new MiniDB(dbPath);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    category TEXT NOT NULL,
    badge TEXT,
    specs TEXT,
    available_stock INTEGER NOT NULL DEFAULT 0,
    reserved_stock INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`);

initSyncTable(db);

// Seed if empty
const count = db.get('SELECT COUNT(*) as cnt FROM products');
if (!count || count.cnt === 0) {
  const seedProducts = [
    {
      sku: 'SKU-MAC-M3',
      title: 'Titan Pro 16" Workstation',
      description: 'Next-gen silicon workstation with 32-core neural engine, 64GB unified memory, and liquid retina XDR.',
      price: 2499.00,
      category: 'Workstations',
      badge: 'Bestseller',
      specs: 'M3 Max • 64GB RAM • 1TB NVMe',
      available_stock: 14,
      reserved_stock: 0
    },
    {
      sku: 'SKU-ANC-HEADSET',
      title: 'Aura Studio ANC Headphones',
      description: 'Spatial audio with custom graphene dynamic drivers, active noise cancellation, and 48hr battery life.',
      price: 349.00,
      category: 'Audio',
      badge: 'Popular',
      specs: 'Lossless Audio • 48h Battery • Low Latency',
      available_stock: 28,
      reserved_stock: 0
    },
    {
      sku: 'SKU-CURVED-MONITOR',
      title: 'UltraWide 38" Curved 4K HDR',
      description: '144Hz curved IPS display with 99% DCI-P3 color gamut, USB-C 90W power delivery, and ultra-thin bezels.',
      price: 899.00,
      category: 'Displays',
      badge: 'Editor Choice',
      specs: '3840x1600 • 144Hz • HDR600',
      available_stock: 9,
      reserved_stock: 0
    },
    {
      sku: 'SKU-MECH-KEYBOARD',
      title: 'Apex Custom Mechanical Keyboard',
      description: 'Hot-swappable lubricated switches, CNC anodized aluminum frame, RGB backlighting, and gasket mount.',
      price: 189.00,
      category: 'Peripherals',
      badge: 'New',
      specs: 'Gasket Mount • Gateron Oil Kings • Wireless',
      available_stock: 35,
      reserved_stock: 0
    },
    {
      sku: 'SKU-SMART-WATCH',
      title: 'Vanguard Chrono Smartwatch',
      description: 'Titanium aerospace casing, sapphire glass, ECG monitoring, dual-band GPS, and 100m water resistance.',
      price: 499.00,
      category: 'Wearables',
      badge: 'Featured',
      specs: 'Dual GPS • Sapphire • Titanium',
      available_stock: 19,
      reserved_stock: 0
    },
    {
      sku: 'SKU-ERGONOMIC-MOUSE',
      title: 'Precision Master Wireless Mouse',
      description: 'Ergonomic 8K DPI darkfield sensor, magnetic hyper-scroll wheel, and multi-device Bluetooth switching.',
      price: 119.00,
      category: 'Peripherals',
      badge: 'Essential',
      specs: '8000 DPI • MagSpeed • Quiet Click',
      available_stock: 42,
      reserved_stock: 0
    }
  ];

  const now = new Date().toISOString();
  const insertStmt = `
    INSERT INTO products (sku, title, description, price, category, badge, specs, available_stock, reserved_stock, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  for (const p of seedProducts) {
    db.run(insertStmt, [
      p.sku,
      p.title,
      p.description,
      p.price,
      p.category,
      p.badge,
      p.specs,
      p.available_stock,
      p.reserved_stock,
      now
    ]);
  }
  console.log(`[Product DB] Seeded ${seedProducts.length} initial products.`);
}

module.exports = db;
