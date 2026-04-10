/**
 * db.js — SQLite wrapper using sql.js (pure WebAssembly, zero native build).
 *
 * sql.js keeps the database in-memory. We load from `database.db` on startup
 * and write back to disk after every COMMIT (or standalone write).
 *
 * SQLite (file-based database) is used to comply with the restriction on
 * cloud databases.
 */

const path = require("path");
const fs = require("fs");
const initSqlJs = require("sql.js");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "database.db");

let _db = null; // in-memory sql.js Database instance
let _inTransaction = false; // tracks manual BEGIN/COMMIT state

/** Load (or create) the SQLite file and return the sql.js db object. */
async function _loadDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    return new SQL.Database(fileBuffer);
  }
  return new SQL.Database(); // brand-new empty database
}

/** Persist the in-memory database to the .db file. */
function _save() {
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

/** Initialise — must be awaited once before any other calls. */
async function open() {
  if (!_db) {
    _db = await _loadDb();
  }
}

/**
 * Run a SELECT (or WITH/PRAGMA) and return { rows: [...], rowCount: n }.
 * @internal
 */
function _runSelect(sql, params) {
  const result = _db.exec(sql, params);
  if (!result || result.length === 0) return { rows: [], rowCount: 0 };
  const { columns, values } = result[0];
  const rows = values.map((row) =>
    Object.fromEntries(columns.map((col, i) => [col, row[i]]))
  );
  return { rows, rowCount: rows.length };
}

/**
 * Run a write statement (INSERT/UPDATE/DELETE/DDL) and return
 * { rows: [], rowCount: changes, lastInsertRowid }.
 * Does NOT save to disk — caller is responsible.
 * @internal
 */
function _runWrite(sql, params) {
  _db.run(sql, params);
  const meta = _runSelect("SELECT changes() AS c, last_insert_rowid() AS r");
  return {
    rows: [],
    rowCount: meta.rows[0].c,
    lastInsertRowid: meta.rows[0].r,
  };
}

/**
 * Execute a SQL statement (outside a transaction) and return a pg-style result.
 * Automatically saves to disk after writes.
 */
function query(sql, params = []) {
  if (!_db) throw new Error("db.open() has not been called");

  const trimmed = sql.trimStart().toUpperCase();
  if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH") || trimmed.startsWith("PRAGMA")) {
    return _runSelect(sql, params);
  }

  const res = _runWrite(sql, params);
  if (!_inTransaction) _save(); // only auto-save outside transactions
  return res;
}

/**
 * Execute multiple DDL statements at once (used by init_db.js).
 * Saves to disk afterwards.
 */
function exec(sql) {
  if (!_db) throw new Error("db.open() has not been called");
  _db.run(sql);
  if (!_inTransaction) _save();
}

/**
 * Returns a transaction client.
 *   client.begin()    — START a transaction
 *   client.query()    — run SQL within the transaction
 *   client.commit()   — commit + save to disk
 *   client.rollback() — roll back
 *   client.release()  — no-op (API parity)
 */
function connect() {
  return {
    begin() {
      if (!_db) throw new Error("db.open() has not been called");
      _db.run("BEGIN");
      _inTransaction = true;
    },

    query(sql, params = []) {
      if (!_db) throw new Error("db.open() has not been called");
      const trimmed = sql.trimStart().toUpperCase();
      if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH") || trimmed.startsWith("PRAGMA")) {
        return _runSelect(sql, params);
      }
      return _runWrite(sql, params);
    },

    commit() {
      if (!_db) throw new Error("db.open() has not been called");
      _db.run("COMMIT");
      _inTransaction = false;
      _save();
    },

    rollback() {
      try {
        if (_db && _inTransaction) {
          _db.run("ROLLBACK");
          _inTransaction = false;
        }
      } catch (_) {
        _inTransaction = false;
      }
    },

    release() {
      // No pooled connections — nothing to do.
    },
  };
}

module.exports = { open, query, exec, connect };