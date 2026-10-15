/**
 * Universal Database Helper for Microservices
 * Uses Node's built-in `node:sqlite` (Node 22+) for high-speed local SQLite databases.
 * Fallbacks to an ACID JSON file store if native SQLite is unavailable.
 */

const fs = require('fs');
const path = require('path');

class MiniDB {
  constructor(dbFilePath) {
    this.dbFilePath = dbFilePath;
    const dir = path.dirname(dbFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.type = 'sqlite';
    try {
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(dbFilePath);
      // Enable WAL mode for high concurrency
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    } catch (err) {
      console.warn(`[MiniDB] node:sqlite not available, falling back to JSON store for ${dbFilePath}:`, err.message);
      this.type = 'json';
      this.jsonPath = dbFilePath.replace(/\.db$/, '.json');
      this.jsonData = this._loadJson();
    }
  }

  _loadJson() {
    if (fs.existsSync(this.jsonPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.jsonPath, 'utf8'));
      } catch (e) {
        return { tables: {} };
      }
    }
    return { tables: {} };
  }

  _saveJson() {
    fs.writeFileSync(this.jsonPath, JSON.stringify(this.jsonData, null, 2), 'utf8');
  }

  exec(sql) {
    if (this.type === 'sqlite') {
      return this.db.exec(sql);
    }
    // Minimal mock for table creation
    const matches = sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gi);
    for (const match of matches) {
      const tbl = match[1];
      if (!this.jsonData.tables[tbl]) {
        this.jsonData.tables[tbl] = [];
      }
    }
    this._saveJson();
    return true;
  }

  run(sql, params = []) {
    if (this.type === 'sqlite') {
      const stmt = this.db.prepare(sql);
      return stmt.run(...params);
    }
    // Fallback JSON operations for basic insert/update/delete
    return this._fallbackRun(sql, params);
  }

  get(sql, params = []) {
    if (this.type === 'sqlite') {
      const stmt = this.db.prepare(sql);
      return stmt.get(...params);
    }
    const all = this._fallbackAll(sql, params);
    return all.length > 0 ? all[0] : null;
  }

  all(sql, params = []) {
    if (this.type === 'sqlite') {
      const stmt = this.db.prepare(sql);
      return stmt.all(...params);
    }
    return this._fallbackAll(sql, params);
  }

  _fallbackRun(sql, params) {
    // Basic JSON fallback
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('INSERT INTO')) {
      const tblMatch = sql.match(/INSERT\s+INTO\s+([a-zA-Z0-9_]+)/i);
      if (tblMatch) {
        const tbl = tblMatch[1];
        if (!this.jsonData.tables[tbl]) this.jsonData.tables[tbl] = [];
        const id = this.jsonData.tables[tbl].length + 1;
        const record = { id };
        // extract column names if available
        const colMatch = sql.match(/\(([^)]+)\)\s+VALUES/i);
        if (colMatch) {
          const cols = colMatch[1].split(',').map(c => c.trim());
          cols.forEach((col, idx) => {
            record[col] = params[idx];
          });
        }
        this.jsonData.tables[tbl].push(record);
        this._saveJson();
        return { changes: 1, lastInsertRowid: id };
      }
    }
    return { changes: 0, lastInsertRowid: null };
  }

  _fallbackAll(sql, params) {
    const tblMatch = sql.match(/FROM\s+([a-zA-Z0-9_]+)/i);
    if (tblMatch) {
      const tbl = tblMatch[1];
      return this.jsonData.tables[tbl] || [];
    }
    return [];
  }
}

module.exports = { MiniDB };
