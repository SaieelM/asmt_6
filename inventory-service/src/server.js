const express = require('express');
const cors = require('cors');
const db = require('./db');
const { generateEventId, isEventProcessed, recordSyncEvent, broadcastEvent } = require('../../shared/sync-protocol');

const app = express();
const PORT = process.env.PORT || 4003;
const SERVICE_NAME = 'inventory-service';
const VM_NAME = process.env.VM_NAME || 'vm4-inventory-service';
const PRIVATE_IP = process.env.PRIVATE_IP || '10.128.0.8';

// Peer VM endpoints for sync broadcast (GCP internal IPs: 10.128.0.6 & 10.128.0.7)
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://10.128.0.6:4001';
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://10.128.0.7:4002';

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

// Get warehouse inventory list
app.get('/inventory', (req, res) => {
  try {
    const items = db.all('SELECT * FROM warehouse_items ORDER BY id ASC');
    // Calculate live available qty
    const enriched = items.map(it => ({
      ...it,
      available_qty: Math.max(0, it.on_hand_qty - it.allocated_qty)
    }));

    res.json({
      success: true,
      service: SERVICE_NAME,
      vm: VM_NAME,
      data: enriched
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get stock ledger audit trail
app.get('/inventory/ledger', (req, res) => {
  try {
    const ledger = db.all('SELECT * FROM stock_ledger ORDER BY id DESC LIMIT 50');
    res.json({
      success: true,
      service: SERVICE_NAME,
      data: ledger
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * WAREHOUSE RESTOCK & CROSS-DATABASE SYNC BROADCAST
 * Restocks inventory in inventory.db and propagates live stock to products.db!
 */
app.post('/inventory/restock', async (req, res) => {
  try {
    const { sku, quantity, note } = req.body;
    const qty = Number(quantity);

    if (!sku || isNaN(qty) || qty <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid sku and positive quantity required'
      });
    }

    const item = db.get('SELECT * FROM warehouse_items WHERE sku = ?', [sku]);
    if (!item) {
      return res.status(404).json({ success: false, error: `SKU ${sku} not found in warehouse` });
    }

    const now = new Date().toISOString();
    const batchId = `RESTOCK-${Date.now().toString().slice(-6)}`;

    // Update warehouse_items
    db.run(
      `UPDATE warehouse_items 
       SET on_hand_qty = on_hand_qty + ?,
           last_restocked_at = ?
       WHERE sku = ?`,
      [qty, now, sku]
    );

    // Record in stock ledger
    db.run(
      `INSERT INTO stock_ledger (sku, delta, reason, reference_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [sku, qty, 'WAREHOUSE_RESTOCK', `${batchId} (${note || 'Manual Restock'})`, now]
    );

    // Prepare sync event
    const eventId = generateEventId('evt_restock');
    const syncPayload = {
      sku,
      quantity: qty,
      batch_id: batchId,
      restocked_at: now
    };

    recordSyncEvent(db, {
      event_id: eventId,
      source_service: SERVICE_NAME,
      event_type: 'STOCK_RESTOCKED',
      payload: syncPayload,
      status: 'APPLIED'
    });

    console.log(`[RESTOCK] SKU: ${sku} +${qty} units. Broadcasting sync event: ${eventId}`);

    // Broadcast to Product Service (so product catalog updates immediately)
    // and Order Service (for event logging)
    const syncEvent = {
      event_id: eventId,
      source_service: SERVICE_NAME,
      event_type: 'STOCK_RESTOCKED',
      payload: syncPayload
    };

    const broadcastResults = await broadcastEvent(syncEvent, [PRODUCT_SERVICE_URL, ORDER_SERVICE_URL]);

    res.json({
      success: true,
      message: `Warehouse successfully restocked ${qty} units of ${sku}. DB sync broadcast sent.`,
      batch_id: batchId,
      sync_event: {
        event_id: eventId,
        peer_results: broadcastResults
      }
    });
  } catch (err) {
    console.error(`[RESTOCK ERROR] ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * RECEIVE SYNC EVENT FROM ORDER SERVICE
 * When an order is placed, allocate stock in the warehouse.
 */
app.post('/sync/receive', (req, res) => {
  try {
    const { event_id, source_service, event_type, payload } = req.body;

    if (!event_id || !event_type) {
      return res.status(400).json({ success: false, error: 'Invalid sync payload' });
    }

    if (isEventProcessed(db, event_id)) {
      return res.json({ success: true, message: 'Event already synchronized', event_id });
    }

    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const now = new Date().toISOString();

    if (event_type === 'ORDER_CREATED') {
      if (Array.isArray(data.items)) {
        for (const item of data.items) {
          const qty = Number(item.quantity) || 1;
          const sku = item.sku;

          // Increment allocated quantity in warehouse
          db.run(
            `UPDATE warehouse_items 
             SET allocated_qty = allocated_qty + ?
             WHERE sku = ?`,
            [qty, sku]
          );

          // Add to stock audit ledger
          db.run(
            `INSERT INTO stock_ledger (sku, delta, reason, reference_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [sku, -qty, 'ORDER_ALLOCATION', data.order_number || event_id, now]
          );
        }
      }
    }

    recordSyncEvent(db, {
      event_id,
      source_service: source_service || 'peer',
      event_type,
      payload: data,
      status: 'APPLIED',
      received_from: req.ip
    });

    console.log(`[INVENTORY SYNC RECEIVED] ${event_type} applied to inventory.db`);

    res.json({
      success: true,
      message: `Sync event ${event_type} applied to inventory database`,
      event_id
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync status
app.get('/sync/status', (req, res) => {
  try {
    const count = db.get('SELECT COUNT(*) as cnt FROM sync_events');
    const recent = db.all('SELECT * FROM sync_events ORDER BY id DESC LIMIT 20');
    const ledgerCount = db.get('SELECT COUNT(*) as cnt FROM stock_ledger');

    res.json({
      success: true,
      service: SERVICE_NAME,
      vm: VM_NAME,
      database: 'inventory.db',
      ledger_entries: ledgerCount.cnt,
      sync_events_count: count.cnt,
      recent_sync_events: recent
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  try {
    const itemsCount = db.get('SELECT COUNT(*) as cnt FROM warehouse_items');
    const syncCount = db.get('SELECT COUNT(*) as cnt FROM sync_events');
    res.json({
      status: 'UP',
      service: SERVICE_NAME,
      vm: VM_NAME,
      private_ip: PRIVATE_IP,
      port: PORT,
      database: 'inventory.db (SQLite)',
      items_tracked: itemsCount.cnt,
      sync_events_logged: syncCount.cnt,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ status: 'DEGRADED', error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] Microservice running on port ${PORT} (VM: ${VM_NAME}, IP: ${PRIVATE_IP})`);
});
