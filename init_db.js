/**
 * init_db.js — Creates tables and seeds initial data.
 * Called once (awaited) before the server starts listening.
 *
 * SQLite (file-based database) is used to comply with the restriction on
 * cloud databases.
 */

const { exec, query } = require("./db");

function initDb() {
  // ── Schema ────────────────────────────────────────────────────────────────

  exec(`
    CREATE TABLE IF NOT EXISTS customers (
      cust_id      TEXT PRIMARY KEY,
      cust_name    TEXT NOT NULL,
      cust_address TEXT,
      cust_pan     TEXT,
      cust_gst     TEXT,
      is_active    TEXT CHECK (is_active IN ('Y', 'N'))
    )
  `);

  exec(`
    CREATE TABLE IF NOT EXISTS items (
      item_id   TEXT PRIMARY KEY,
      item_name TEXT NOT NULL,
      price     REAL NOT NULL,
      is_active TEXT CHECK (is_active IN ('Y', 'N'))
    )
  `);

  exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id   TEXT UNIQUE NOT NULL,
      cust_id      TEXT,
      total_amount REAL,
      gst_applied  INTEGER DEFAULT 0,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cust_id) REFERENCES customers(cust_id)
    )
  `);

  exec(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER,
      item_id    TEXT,
      quantity   INTEGER NOT NULL,
      price      REAL    NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (item_id)    REFERENCES items(item_id)
    )
  `);

  // ── Seed customers (INSERT OR IGNORE so re-runs are idempotent) ───────────

  const customers = [
    ["C00001", "Gupta Enterprize Pvt. Ltd.",    "Gurgaon, Haryana",          "BCNSG1234H", "06BCNSG1234H1Z5", "Y"],
    ["C00002", "Mahesh Industries Pvt. Ltd.",   "Delhi, Delhi",              "AMNSM1234U", "07AMNSM1234U1Z5", "Y"],
    ["C00003", "Omkar and Brothers Pvt. Ltd.",  "Uttrakhand, Uttar Pradesh", "CNBSO1234S", "05CNBSO1234S1Z5", "N"],
    ["C00004", "Bhuwan Infotech.",              "Alwar, Rajasthan",          "CMNSB1234A", "08CMNSB1234A1Z5", "Y"],
    ["C00005", "Swastik Software Pvt. Ltd.",    "Gurgaon, Haryana",          "AGBCS1234B", "06AGBCS1234B1Z5", "Y"],
  ];

  for (const c of customers) {
    query(
      `INSERT OR IGNORE INTO customers
         (cust_id, cust_name, cust_address, cust_pan, cust_gst, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      c
    );
  }

  // ── Seed items ─────────────────────────────────────────────────────────────

  const items = [
    ["IT00001", "Laptop",      85000, "Y"],
    ["IT00002", "LED Monitor", 13450, "Y"],
    ["IT00003", "Pen Drive",     980, "Y"],
    ["IT00004", "Mobile",      18900, "Y"],
    ["IT00005", "Headphone",    2350, "N"],
    ["IT00006", "Bagpack",      1200, "Y"],
    ["IT00007", "Powerbank",    1400, "Y"],
  ];

  for (const i of items) {
    query(
      `INSERT OR IGNORE INTO items (item_id, item_name, price, is_active)
       VALUES (?, ?, ?, ?)`,
      i
    );
  }

  console.log("✅ Database initialised (tables ready, seed data loaded).");
}

module.exports = initDb;
