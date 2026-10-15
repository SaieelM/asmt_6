const express = require('express');
const cors = require('cors');
const db = require('./db');
const { isEventProcessed, recordSyncEvent, broadcastEvent } = require('../../shared/sync-protocol');

const app = express();
const PORT = process.env.PORT || 4001;
const SERVICE_NAME = 'product-service';
const VM_NAME = process.env.VM_NAME || 'vm2-product-service';
const PRIVATE_IP = process.env.PRIVATE_IP || '10.128.0.6';

// Peer VM endpoints for sync broadcast (GCP internal IPs: 10.128.0.7 & 10.128.0.8)
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || (process.env.NODE_ENV === 'production' ? 'http://10.128.0.7:4002' : 'http://localhost:4002');
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || (process.env.NODE_ENV === 'production' ? 'http://10.128.0.8:4003' : 'http://localhost:4003');

app.use(cors());
app.use(express.json());

// Log incoming requests
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${SERVICE_NAME}@${VM_NAME}] ${req.method} ${req.originalUrl} - ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// List all products
app.get('/products', (req, res) => {
  try {
    const products = db.all('SELECT * FROM products ORDER BY id ASC');
    res.json({
      success: true,
      service: SERVICE_NAME,
      vm: VM_NAME,
      data: products
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get product by ID or SKU
app.get('/products/:idOrSku', (req, res) => {
  try {
    const param = req.params.idOrSku;
    let product;
    if (/^\d+$/.test(param)) {
      product = db.get('SELECT * FROM products WHERE id = ?', [Number(param)]);
    } else {
      product = db.get('SELECT * FROM products WHERE sku = ?', [param]);
    }
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    res.json({ success: true, service: SERVICE_NAME, data: product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DATABASE SYNC RECEIVER ENDPOINT
 * Receives synchronization events from Order Service and Inventory Service
 */
app.post('/sync/receive', (req, res) => {
  try {
    const { event_id, source_service, event_type, payload } = req.body;

    if (!event_id || !event_type) {
      return res.status(400).json({ success: false, error: 'Invalid sync event payload' });
    }

    // Check for idempotency
    if (isEventProcessed(db, event_id)) {
      return res.json({
        success: true,
        message: 'Event already synchronized (idempotent skip)',
        event_id
      });
    }

    console.log(`[DB SYNC RECEIVED] ${event_type} from ${source_service} (Event ID: ${event_id})`);

    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const now = new Date().toISOString();

    if (event_type === 'ORDER_CREATED') {
      // Order placed -> decrement available stock, increment reserved stock
      if (Array.isArray(data.items)) {
        for (const item of data.items) {
          const qty = Number(item.quantity) || 1;
          const sku = item.sku;
          db.run(
            `UPDATE products 
             SET available_stock = MAX(0, available_stock - ?),
                 reserved_stock = reserved_stock + ?,
                 updated_at = ?
             WHERE sku = ?`,
            [qty, qty, now, sku]
          );
        }
      }
    } else if (event_type === 'STOCK_RESTOCKED') {
      // Warehouse restocked -> increase available stock
      const qty = Number(data.quantity) || 0;
      const sku = data.sku;
      db.run(
        `UPDATE products 
         SET available_stock = available_stock + ?,
             updated_at = ?
         WHERE sku = ?`,
        [qty, now, sku]
      );
    } else if (event_type === 'ORDER_CANCELLED') {
      // Order cancelled -> revert reserved stock back to available
      if (Array.isArray(data.items)) {
        for (const item of data.items) {
          const qty = Number(item.quantity) || 1;
          const sku = item.sku;
          db.run(
            `UPDATE products 
             SET available_stock = available_stock + ?,
                 reserved_stock = MAX(0, reserved_stock - ?),
                 updated_at = ?
             WHERE sku = ?`,
            [qty, qty, now, sku]
          );
        }
      }
    }

    // Record the event into local sync ledger
    recordSyncEvent(db, {
      event_id,
      source_service: source_service || 'unknown',
      event_type,
      payload: data,
      status: 'APPLIED',
      received_from: req.ip
    });

    res.json({
      success: true,
      message: `Database synchronized successfully with event ${event_type}`,
      event_id,
      applied_at: now
    });
  } catch (err) {
    console.error(`[DB SYNC ERROR] ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync status and history
app.get('/sync/status', (req, res) => {
  try {
    const totalEvents = db.get('SELECT COUNT(*) as count FROM sync_events');
    const recentEvents = db.all('SELECT * FROM sync_events ORDER BY id DESC LIMIT 20');
    const stockSummary = db.all('SELECT sku, title, available_stock, reserved_stock FROM products');

    res.json({
      success: true,
      service: SERVICE_NAME,
      vm: VM_NAME,
      database: 'products.db',
      sync_event_count: totalEvents.count,
      recent_sync_events: recentEvents,
      stock_summary: stockSummary
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Periodic or manual DB reconciliation endpoint
app.post('/sync/reconcile', async (req, res) => {
  try {
    // Queries inventory service to ensure stock numbers match
    let reconciledItems = 0;
    try {
      const resp = await fetch(`${INVENTORY_SERVICE_URL}/inventory`);
      if (resp.ok) {
        const invData = await resp.json();
        const now = new Date().toISOString();
        if (Array.isArray(invData.data)) {
          for (const item of invData.data) {
            // align available stock with inventory (on_hand - allocated)
            const available = Math.max(0, item.on_hand_qty - item.allocated_qty);
            db.run(
              `UPDATE products SET available_stock = ?, reserved_stock = ?, updated_at = ? WHERE sku = ?`,
              [available, item.allocated_qty, now, item.sku]
            );
            reconciledItems++;
          }
        }
      }
    } catch (fetchErr) {
      console.warn(`[Sync Reconcile] Peer Inventory Service not reachable: ${fetchErr.message}`);
    }

    res.json({
      success: true,
      message: `Reconciliation cycle completed`,
      reconciled_items_count: reconciledItems
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  try {
    const pCount = db.get('SELECT COUNT(*) as cnt FROM products');
    const sCount = db.get('SELECT COUNT(*) as cnt FROM sync_events');
    res.json({
      status: 'UP',
      service: SERVICE_NAME,
      vm: VM_NAME,
      private_ip: PRIVATE_IP,
      port: PORT,
      database: 'products.db (SQLite)',
      product_count: pCount.cnt,
      sync_events_logged: sCount.cnt,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ status: 'DEGRADED', error: err.message });
  }
});

// Start service
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] Microservice running on port ${PORT} (VM: ${VM_NAME}, IP: ${PRIVATE_IP})`);
});
