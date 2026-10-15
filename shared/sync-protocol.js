/**
 * Distributed Database Synchronization Protocol
 * Facilitates event-driven real-time replication and periodic reconciliation
 * across separate microservice databases hosted on different VMs.
 */

const crypto = require('crypto');

function generateEventId(prefix = 'evt') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Creates the standard sync_events table in any microservice's database.
 */
function initSyncTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      source_service TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT DEFAULT 'APPLIED',
      received_from TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

/**
 * Checks if an event has already been processed (idempotency).
 */
function isEventProcessed(db, eventId) {
  const row = db.get('SELECT id FROM sync_events WHERE event_id = ?', [eventId]);
  return !!row;
}

/**
 * Records a sync event in the local database.
 */
function recordSyncEvent(db, { event_id, source_service, event_type, payload, status = 'APPLIED', received_from = null }) {
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO sync_events (event_id, source_service, event_type, payload, status, received_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [event_id, source_service, event_type, payloadStr, status, received_from, now]
  );
  return { event_id, event_type, created_at: now };
}

/**
 * Broadcasts an event to peer microservices via their private VM endpoints.
 */
async function broadcastEvent(event, targetUrls) {
  const results = [];
  for (const url of targetUrls) {
    if (!url) continue;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      const resp = await fetch(`${url.replace(/\/$/, '')}/sync/receive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sync-Source': event.source_service
        },
        body: JSON.stringify(event),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await resp.json().catch(() => ({}));
      results.push({
        targetUrl: url,
        success: resp.ok,
        status: resp.status,
        data
      });
    } catch (err) {
      results.push({
        targetUrl: url,
        success: false,
        error: err.message
      });
    }
  }
  return results;
}

module.exports = {
  generateEventId,
  initSyncTable,
  isEventProcessed,
  recordSyncEvent,
  broadcastEvent
};
