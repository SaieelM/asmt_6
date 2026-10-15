const express = require('express');
const cors = require('cors');
const db = require('./db');
const { generateEventId, isEventProcessed, recordSyncEvent, broadcastEvent } = require('../../shared/sync-protocol');

const app = express();
const PORT = process.env.PORT || 4002;
const SERVICE_NAME = 'order-service';
const VM_NAME = process.env.VM_NAME || 'vm3-order-service';
const PRIVATE_IP = process.env.PRIVATE_IP || '10.128.0.7';

// Peer VM endpoints for sync broadcast (GCP internal IPs: 10.128.0.6 & 10.128.0.8)
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://10.128.0.6:4001';
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://10.128.0.8:4003';

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

// Helper to attach items to orders
function attachItemsToOrders(orders) {
  if (!orders || orders.length === 0) return [];
  const orderList = Array.isArray(orders) ? orders : [orders];
  return orderList.map(order => {
    const items = db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    return { ...order, items };
  });
}

// Get all orders
app.get('/orders', (req, res) => {
  try {
    const orders = db.all('SELECT * FROM orders ORDER BY id DESC');
    const enriched = attachItemsToOrders(orders);
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

// Get single order
app.get('/orders/:idOrNumber', (req, res) => {
  try {
    const param = req.params.idOrNumber;
    let order;
    if (/^\d+$/.test(param)) {
      order = db.get('SELECT * FROM orders WHERE id = ?', [Number(param)]);
    } else {
      order = db.get('SELECT * FROM orders WHERE order_number = ?', [param]);
    }

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const items = db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    res.json({
      success: true,
      service: SERVICE_NAME,
      data: { ...order, items }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * CREATE ORDER & TRIGGER CROSS-DATABASE SYNCHRONIZATION
 * 1. Writes to local Order DB
 * 2. Emits ORDER_CREATED sync event
 * 3. Broadcasts to Product DB (decrement catalog stock) and Inventory DB (allocate warehouse stock)
 */
app.post('/orders', async (req, res) => {
  try {
    const { customer_name, customer_email, customer_address, items } = req.body;

    if (!customer_name || !customer_email || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid order payload. Requires customer_name, customer_email, and at least 1 item.'
      });
    }

    // Calculate total
    let totalAmount = 0;
    for (const item of items) {
      const price = Number(item.price) || 0;
      const qty = Number(item.quantity) || 1;
      totalAmount += price * qty;
    }

    const orderNumber = `ORD-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
    const now = new Date().toISOString();

    // 1. Insert order into local DB (orders.db)
    const orderInsert = db.run(
      `INSERT INTO orders (order_number, customer_name, customer_email, customer_address, total_amount, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orderNumber, customer_name, customer_email, customer_address || '', totalAmount, 'CONFIRMED', now]
    );

    const orderId = orderInsert.lastInsertRowid;

    // Insert order items
    for (const item of items) {
      db.run(
        `INSERT INTO order_items (order_id, sku, title, price, quantity)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, item.sku, item.title, Number(item.price), Number(item.quantity)]
      );
    }

    // 2. Prepare distributed Sync Event
    const eventId = generateEventId('evt_order');
    const syncPayload = {
      order_id: orderId,
      order_number: orderNumber,
      total_amount: totalAmount,
      items: items.map(it => ({
        sku: it.sku,
        title: it.title,
        quantity: Number(it.quantity)
      }))
    };

    // Record in local sync table
    recordSyncEvent(db, {
      event_id: eventId,
      source_service: SERVICE_NAME,
      event_type: 'ORDER_CREATED',
      payload: syncPayload,
      status: 'APPLIED'
    });

    console.log(`[ORDER CREATED] ${orderNumber} - Broadcasting DB sync event: ${eventId}`);

    // 3. Broadcast sync event to peer microservice DBs (Product VM and Inventory VM)
    const syncEvent = {
      event_id: eventId,
      source_service: SERVICE_NAME,
      event_type: 'ORDER_CREATED',
      payload: syncPayload
    };

    const broadcastTargets = [PRODUCT_SERVICE_URL, INVENTORY_SERVICE_URL];
    const broadcastResults = await broadcastEvent(syncEvent, broadcastTargets);

    const fullOrder = {
      id: orderId,
      order_number: orderNumber,
      customer_name,
      customer_email,
      customer_address,
      total_amount: totalAmount,
      status: 'CONFIRMED',
      items,
      created_at: now
    };

    res.status(201).json({
      success: true,
      message: 'Order created and cross-database sync initiated',
      order: fullOrder,
      sync_event: {
        event_id: eventId,
        event_type: 'ORDER_CREATED',
        peer_sync_results: broadcastResults
      }
    });
  } catch (err) {
    console.error(`[ORDER CREATE ERROR] ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * RECEIVE SYNC EVENT FROM PEER SERVICES
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

    if (event_type === 'ORDER_FULFILLED') {
      if (data.order_number) {
        db.run(`UPDATE orders SET status = 'SHIPPED' WHERE order_number = ?`, [data.order_number]);
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

    res.json({ success: true, message: `Sync event ${event_type} applied`, event_id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync status and history
app.get('/sync/status', (req, res) => {
  try {
    const count = db.get('SELECT COUNT(*) as cnt FROM sync_events');
    const recent = db.all('SELECT * FROM sync_events ORDER BY id DESC LIMIT 20');
    const ordersCount = db.get('SELECT COUNT(*) as cnt FROM orders');

    res.json({
      success: true,
      service: SERVICE_NAME,
      vm: VM_NAME,
      database: 'orders.db',
      total_orders: ordersCount.cnt,
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
    const ordersCount = db.get('SELECT COUNT(*) as cnt FROM orders');
    const syncCount = db.get('SELECT COUNT(*) as cnt FROM sync_events');
    res.json({
      status: 'UP',
      service: SERVICE_NAME,
      vm: VM_NAME,
      private_ip: PRIVATE_IP,
      port: PORT,
      database: 'orders.db (SQLite)',
      orders_count: ordersCount.cnt,
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
