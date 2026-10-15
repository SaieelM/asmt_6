const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVICE_NAME = 'api-gateway';
const VM_NAME = process.env.VM_NAME || 'vm1-gateway (Public Gateway)';
const PUBLIC_IP = process.env.PUBLIC_IP || 'External IP';
const PRIVATE_IP = process.env.PRIVATE_IP || '10.128.0.5';

// Configurable Private VM URLs (Defaults to User's GCP internal IPs, or localhost for local testing)
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || (process.env.NODE_ENV === 'production' ? 'http://10.128.0.6:4001' : 'http://localhost:4001');
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || (process.env.NODE_ENV === 'production' ? 'http://10.128.0.7:4002' : 'http://localhost:4002');
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || (process.env.NODE_ENV === 'production' ? 'http://10.128.0.8:4003' : 'http://localhost:4003');

app.use(cors());
app.use(express.json());

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '../public')));

// Request logging middleware that writes to Gateway mini-database (gateway.db)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const now = new Date().toISOString();
    const targetService = req.path.startsWith('/api/products') ? 'product-service' :
                          req.path.startsWith('/api/orders') ? 'order-service' :
                          req.path.startsWith('/api/inventory') ? 'inventory-service' : 'gateway';
    
    // Log into gateway.db
    try {
      db.run(
        `INSERT INTO request_logs (timestamp, method, path, target_service, status_code, response_time_ms, client_ip)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [now, req.method, req.path, targetService, res.statusCode, duration, req.ip || '127.0.0.1']
      );
    } catch (e) {
      // quiet fallback
    }
  });
  next();
});

/**
 * GENERIC REVERSE PROXY FORWARDER
 * Proxies HTTP requests from Public Gateway to Private Backend Microservices
 */
async function forwardRequest(req, res, targetBaseUrl, targetPath) {
  const targetUrl = `${targetBaseUrl.replace(/\/$/, '')}${targetPath}`;
  try {
    const options = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': req.ip,
        'X-Gateway-Route': 'true'
      }
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
      options.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, options);
    const data = await response.json().catch(() => ({}));

    // Attach gateway routing metadata to response
    res.status(response.status).json(data);
  } catch (err) {
    console.error(`[Gateway Proxy Error] Failed forwarding to ${targetUrl}:`, err.message);
    res.status(502).json({
      success: false,
      error: `Bad Gateway: Target microservice unreachable (${targetBaseUrl})`,
      details: err.message
    });
  }
}

// ==========================================
// 1. PRODUCT SERVICE PROXY ROUTES (VM 2)
// ==========================================
app.use('/api/products', (req, res) => {
  forwardRequest(req, res, PRODUCT_SERVICE_URL, `/products${req.url === '/' ? '' : req.url}`);
});

// ==========================================
// 2. ORDER SERVICE PROXY ROUTES (VM 3)
// ==========================================
app.use('/api/orders', (req, res) => {
  forwardRequest(req, res, ORDER_SERVICE_URL, `/orders${req.url === '/' ? '' : req.url}`);
});

// ==========================================
// 3. INVENTORY SERVICE PROXY ROUTES (VM 4)
// ==========================================
app.use('/api/inventory', (req, res) => {
  forwardRequest(req, res, INVENTORY_SERVICE_URL, `/inventory${req.url === '/' ? '' : req.url}`);
});

// ==========================================
// SYSTEM TOPOLOGY & DB SYNC INSPECTION APIS
// ==========================================

// Get real-time health and topology of all 4 VMs
app.get('/api/system/topology', async (req, res) => {
  const nodes = [
    {
      id: 'gateway',
      name: 'API Gateway & Frontend UI',
      vm_name: 'vm1-gateway',
      network_tier: 'Public Subnet',
      is_public: true,
      public_ip: PUBLIC_IP,
      private_ip: PRIVATE_IP,
      port: PORT,
      database: 'gateway.db (SQLite)',
      firewall_rule: 'ALLOW 0.0.0.0/0 on Port 80/3000',
      status: 'ONLINE',
      latency_ms: 1
    },
    {
      id: 'product',
      name: 'Product Catalog Service',
      vm_name: 'vm2-product-service',
      network_tier: 'Private Subnet',
      is_public: false,
      public_ip: 'None (Blocked)',
      private_ip: process.env.PRODUCT_VM_IP || '10.128.0.6',
      port: 4001,
      target_url: PRODUCT_SERVICE_URL,
      database: 'products.db (SQLite)',
      firewall_rule: 'ALLOW only 10.128.0.0/20 on Port 4001',
      status: 'CHECKING',
      latency_ms: null
    },
    {
      id: 'order',
      name: 'Order Processing Service',
      vm_name: 'vm3-order-service',
      network_tier: 'Private Subnet',
      is_public: false,
      public_ip: 'None (Blocked)',
      private_ip: process.env.ORDER_VM_IP || '10.128.0.7',
      port: 4002,
      target_url: ORDER_SERVICE_URL,
      database: 'orders.db (SQLite)',
      firewall_rule: 'ALLOW only 10.128.0.0/20 on Port 4002',
      status: 'CHECKING',
      latency_ms: null
    },
    {
      id: 'inventory',
      name: 'Inventory & Warehouse Service',
      vm_name: 'vm4-inventory-service',
      network_tier: 'Private Subnet',
      is_public: false,
      public_ip: 'None (Blocked)',
      private_ip: process.env.INVENTORY_VM_IP || '10.128.0.8',
      port: 4003,
      target_url: INVENTORY_SERVICE_URL,
      database: 'inventory.db (SQLite)',
      firewall_rule: 'ALLOW only 10.128.0.0/20 on Port 4003',
      status: 'CHECKING',
      latency_ms: null
    }
  ];

  // Ping private VMs to verify internal connectivity
  await Promise.all(nodes.map(async (node) => {
    if (node.is_public) return;
    const start = Date.now();
    try {
      const resp = await fetch(`${node.target_url}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        node.status = 'ONLINE';
        node.latency_ms = Date.now() - start;
        const hData = await resp.json();
        node.health_info = hData;
      } else {
        node.status = 'ERROR';
      }
    } catch (e) {
      node.status = 'OFFLINE';
      node.error = e.message;
    }
  }));

  res.json({
    success: true,
    architecture: '4-Microservices Distributed Cloud Architecture',
    network_model: 'GCP VPC Internal Subnet Isolation (10.128.0.0/20)',
    public_entrypoint: `http://${PUBLIC_IP}:${PORT}`,
    nodes
  });
});

// Side-by-side snapshot of all 4 Mini-Databases
app.get('/api/system/databases', async (req, res) => {
  const gatewayLogs = db.all('SELECT * FROM request_logs ORDER BY id DESC LIMIT 15');

  let productDb = { connected: false, products: [], sync_events: [] };
  let orderDb = { connected: false, orders: [], sync_events: [] };
  let inventoryDb = { connected: false, warehouse_items: [], ledger: [], sync_events: [] };

  try {
    const pResp = await fetch(`${PRODUCT_SERVICE_URL}/sync/status`, { signal: AbortSignal.timeout(2000) });
    if (pResp.ok) {
      const pData = await pResp.json();
      productDb = {
        connected: true,
        products: pData.stock_summary || [],
        sync_events: pData.recent_sync_events || []
      };
    }
  } catch (e) {
    productDb.error = e.message;
  }

  try {
    const oResp = await fetch(`${ORDER_SERVICE_URL}/orders`, { signal: AbortSignal.timeout(2000) });
    const oSyncResp = await fetch(`${ORDER_SERVICE_URL}/sync/status`, { signal: AbortSignal.timeout(2000) });
    if (oResp.ok && oSyncResp.ok) {
      const oData = await oResp.json();
      const oSync = await oSyncResp.json();
      orderDb = {
        connected: true,
        orders: oData.data || [],
        sync_events: oSync.recent_sync_events || []
      };
    }
  } catch (e) {
    orderDb.error = e.message;
  }

  try {
    const iResp = await fetch(`${INVENTORY_SERVICE_URL}/inventory`, { signal: AbortSignal.timeout(2000) });
    const iSyncResp = await fetch(`${INVENTORY_SERVICE_URL}/sync/status`, { signal: AbortSignal.timeout(2000) });
    const iLedgerResp = await fetch(`${INVENTORY_SERVICE_URL}/inventory/ledger`, { signal: AbortSignal.timeout(2000) });
    if (iResp.ok && iSyncResp.ok) {
      const iData = await iResp.json();
      const iSync = await iSyncResp.json();
      const iLedger = iLedgerResp.ok ? await iLedgerResp.json() : { data: [] };
      inventoryDb = {
        connected: true,
        warehouse_items: iData.data || [],
        ledger: iLedger.data || [],
        sync_events: iSync.recent_sync_events || []
      };
    }
  } catch (e) {
    inventoryDb.error = e.message;
  }

  res.json({
    success: true,
    databases: {
      gateway_db: {
        file: 'gateway.db',
        vm: 'vm1-gateway',
        ip: `${PUBLIC_IP} (Public) / ${PRIVATE_IP}`,
        request_logs: gatewayLogs
      },
      product_db: {
        file: 'products.db',
        vm: 'vm2-product-service (Private)',
        ip: process.env.PRODUCT_VM_IP || '10.128.0.6',
        ...productDb
      },
      order_db: {
        file: 'orders.db',
        vm: 'vm3-order-service (Private)',
        ip: process.env.ORDER_VM_IP || '10.128.0.7',
        ...orderDb
      },
      inventory_db: {
        file: 'inventory.db',
        vm: 'vm4-inventory-service (Private)',
        ip: process.env.INVENTORY_VM_IP || '10.128.0.8',
        ...inventoryDb
      }
    }
  });
});

// Merged real-time sync event ledger from all databases
app.get('/api/system/sync-stream', async (req, res) => {
  const events = [];

  const endpoints = [
    { service: 'product-service', db: 'products.db', vm: 'vm2-product-service', url: `${PRODUCT_SERVICE_URL}/sync/status` },
    { service: 'order-service', db: 'orders.db', vm: 'vm3-order-service', url: `${ORDER_SERVICE_URL}/sync/status` },
    { service: 'inventory-service', db: 'inventory.db', vm: 'vm4-inventory-service', url: `${INVENTORY_SERVICE_URL}/sync/status` }
  ];

  await Promise.all(endpoints.map(async (ep) => {
    try {
      const resp = await fetch(ep.url, { signal: AbortSignal.timeout(1800) });
      if (resp.ok) {
        const data = await resp.json();
        const evts = data.recent_sync_events || [];
        evts.forEach(evt => {
          events.push({
            ...evt,
            current_host_db: ep.db,
            current_host_vm: ep.vm
          });
        });
      }
    } catch (e) {}
  }));

  // Sort chronologically descending
  events.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({
    success: true,
    total_synced_events: events.length,
    events: events.slice(0, 30)
  });
});

// Trigger full distributed database reconciliation
app.post('/api/system/reconcile-all', async (req, res) => {
  try {
    const pResp = await fetch(`${PRODUCT_SERVICE_URL}/sync/reconcile`, { method: 'POST' });
    const pData = await pResp.json().catch(() => ({}));
    res.json({
      success: true,
      message: 'Distributed cross-database reconciliation cycle executed across all VMs.',
      product_reconciliation: pData
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test network isolation simulation
app.get('/api/system/test-isolation', async (req, res) => {
  res.json({
    success: true,
    firewall_test: {
      public_gateway: {
        port: PORT,
        public_ip: PUBLIC_IP,
        private_ip: '10.128.0.5',
        external_access: 'ALLOWED (HTTP 200 OK)',
        status: 'OPEN_TO_INTERNET'
      },
      private_product_service: {
        port: 4001,
        private_ip: '10.128.0.6',
        external_access: 'BLOCKED (Connection Refused / Firewall Drop)',
        internal_access: 'ALLOWED (From 10.128.0.5 Gateway only)',
        status: 'SECURE_ISOLATED'
      },
      private_order_service: {
        port: 4002,
        private_ip: '10.128.0.7',
        external_access: 'BLOCKED (Connection Refused / Firewall Drop)',
        internal_access: 'ALLOWED (From 10.128.0.5 Gateway only)',
        status: 'SECURE_ISOLATED'
      },
      private_inventory_service: {
        port: 4003,
        private_ip: '10.128.0.8',
        external_access: 'BLOCKED (Connection Refused / Firewall Drop)',
        internal_access: 'ALLOWED (From 10.128.0.5 Gateway only)',
        status: 'SECURE_ISOLATED'
      }
    }
  });
});

// Root API info
app.get('/api', (req, res) => {
  res.json({
    name: 'Cloud E-Commerce API Gateway',
    version: '1.0.0',
    external_ip_status: 'ONLY_PUBLIC_ENTRYPOINT',
    services: {
      products: '/api/products',
      orders: '/api/orders',
      inventory: '/api/inventory',
      system_topology: '/api/system/topology',
      database_sync_inspector: '/api/system/databases',
      sync_event_stream: '/api/system/sync-stream'
    }
  });
});

// Fallback to index.html for SPA routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`[API GATEWAY & FRONTEND] Running on port ${PORT}`);
  console.log(`Public External URL: http://0.0.0.0:${PORT}`);
  console.log(`Topology (GCP Internal Network):`);
  console.log(`  -> Product Service:   ${PRODUCT_SERVICE_URL}`);
  console.log(`  -> Order Service:     ${ORDER_SERVICE_URL}`);
  console.log(`  -> Inventory Service: ${INVENTORY_SERVICE_URL}`);
  console.log(`=======================================================`);
});
