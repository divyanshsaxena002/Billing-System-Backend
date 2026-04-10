const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { open, query, connect } = require("./db");
const initDb = require("./init_db");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const GST_RATE = 0.18;

/**
 * Simple in-process mutex so concurrent POST /invoice/create requests
 * cannot race and reuse the same invoice number.
 * (sql.js is single-threaded, but async routes can interleave.)
 */
let invoiceLock = Promise.resolve();

/**
 * Next human-readable invoice id: INVC + 6 digits (INVC000001 … INVC999999).
 */
function generateUniqueInvoiceId(client) {
  // GLOB pattern for INVC followed by exactly 6 digits
  const maxRes = client.query(`
    SELECT COALESCE(MAX(CAST(SUBSTR(invoice_id, 5) AS INTEGER)), 0) AS n
    FROM invoices
    WHERE invoice_id GLOB 'INVC[0-9][0-9][0-9][0-9][0-9][0-9]'
  `);

  let nextNum = Number(maxRes.rows[0].n) + 1;
  if (nextNum > 999_999) {
    throw new Error("Invoice number pool exhausted (max INVC999999)");
  }

  let candidate = `INVC${String(nextNum).padStart(6, "0")}`;

  for (let attempts = 0; attempts < 50; attempts++) {
    const dup = client.query("SELECT 1 FROM invoices WHERE invoice_id = ?", [candidate]);
    if (dup.rowCount === 0) return candidate;
    nextNum += 1;
    if (nextNum > 999_999) throw new Error("Invoice number pool exhausted");
    candidate = `INVC${String(nextNum).padStart(6, "0")}`;
  }

  throw new Error("Could not allocate unique invoice_id");
}

/**
 * GST: if customer has a GST number AND is_active = 'Y' → no GST (exempt).
 * Otherwise → apply 18 %.
 */
function computeInvoiceTotals(subtotal, customerRow) {
  if (!customerRow) {
    const gstAmount = subtotal * GST_RATE;
    return { subtotal, gstAmount, totalAmount: subtotal + gstAmount, gstApplied: true };
  }
  const hasGst = String(customerRow.cust_gst ?? "").trim() !== "";
  const activeY = String(customerRow.is_active ?? "").trim().toUpperCase() === "Y";
  const gstExempt = hasGst && activeY;
  if (gstExempt) {
    return { subtotal, gstAmount: 0, totalAmount: subtotal, gstApplied: false };
  }
  const gstAmount = subtotal * GST_RATE;
  return { subtotal, gstAmount, totalAmount: subtotal + gstAmount, gstApplied: true };
}

// ─── Health check ────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send("Server running 🚀");
});

// ===================== CUSTOMERS =====================

app.get("/customers", (req, res) => {
  try {
    const result = query("SELECT * FROM customers ORDER BY cust_id");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching customers");
  }
});

app.post("/customers", (req, res) => {
  try {
    const { cust_name, cust_address, cust_pan, cust_gst, is_active } = req.body;

    if (!cust_name) {
      return res.status(400).json({ error: "Customer name required" });
    }

    // Auto-generate next id: C00001, C00002, …
    const maxRes = query(`
      SELECT COALESCE(MAX(CAST(SUBSTR(cust_id, 2) AS INTEGER)), 0) AS n
      FROM customers
      WHERE cust_id GLOB 'C[0-9][0-9][0-9][0-9][0-9]'
    `);
    const nextId = `C${String(Number(maxRes.rows[0].n) + 1).padStart(5, "0")}`;

    query(
      `INSERT INTO customers (cust_id, cust_name, cust_address, cust_pan, cust_gst, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [nextId, cust_name, cust_address || "", cust_pan || "", cust_gst || "", is_active || "Y"]
    );

    const inserted = query("SELECT * FROM customers WHERE cust_id = ?", [nextId]);
    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creating customer" });
  }
});

// ===================== ITEMS =====================

app.get("/items", (req, res) => {
  try {
    const result = query("SELECT * FROM items ORDER BY item_id");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching items");
  }
});

app.post("/items", (req, res) => {
  try {
    const { item_name, price, is_active } = req.body;

    if (!item_name) {
      return res.status(400).json({ error: "Item name required" });
    }

    // Auto-generate next id: IT00001, IT00002, …
    const maxRes = query(`
      SELECT COALESCE(MAX(CAST(SUBSTR(item_id, 3) AS INTEGER)), 0) AS n
      FROM items
      WHERE item_id GLOB 'IT[0-9][0-9][0-9][0-9][0-9]'
    `);
    const nextId = `IT${String(Number(maxRes.rows[0].n) + 1).padStart(5, "0")}`;

    query(
      `INSERT INTO items (item_id, item_name, price, is_active) VALUES (?, ?, ?, ?)`,
      [nextId, item_name, price || 0, is_active || "Y"]
    );

    const inserted = query("SELECT * FROM items WHERE item_id = ?", [nextId]);
    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creating item" });
  }
});

// ===================== INVOICES =====================

app.get("/invoice/all", (req, res) => {
  try {
    const result = query(`
      SELECT i.invoice_id,
             i.cust_id,
             i.total_amount,
             i.created_at,
             c.cust_name,
             i.id,
             i.total_amount AS final_amount,
             i.gst_applied
      FROM invoices i
      LEFT JOIN customers c ON c.cust_id = i.cust_id
      ORDER BY i.created_at DESC, i.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error fetching invoices" });
  }
});

app.get("/invoice/:id", (req, res) => {
  try {
    const raw = decodeURIComponent(req.params.id);
    const asInt = parseInt(raw, 10);

    const baseSelect = `
      SELECT i.*, c.cust_name
      FROM invoices i
      LEFT JOIN customers c ON c.cust_id = i.cust_id
    `;

    let invoice;
    if (!Number.isNaN(asInt) && String(asInt) === String(raw).trim()) {
      invoice = query(`${baseSelect} WHERE i.id = ?`, [asInt]);
    }
    if (!invoice || invoice.rowCount === 0) {
      invoice = query(`${baseSelect} WHERE i.invoice_id = ?`, [raw]);
    }

    if (invoice.rowCount === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    const row = invoice.rows[0];

    const itemsRes = query(
      `
      SELECT ii.item_id, ii.quantity, ii.price, it.item_name
      FROM invoice_items ii
      LEFT JOIN items it ON it.item_id = ii.item_id
      WHERE ii.invoice_id = ?
      ORDER BY ii.id
    `,
      [row.id]
    );

    res.json({
      ...row,
      lines: itemsRes.rows,
      items: itemsRes.rows,
      final_amount: row.total_amount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error fetching invoice" });
  }
});

// ===================== CREATE INVOICE =====================

app.post("/invoice/create", async (req, res) => {
  const { cust_id, items } = req.body;

  if (cust_id == null || cust_id === "" || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "cust_id and non-empty items array are required" });
  }

  const custKey = String(cust_id).trim();

  // Serialise invoice creation to avoid concurrent id collisions.
  invoiceLock = invoiceLock.then(() => _createInvoice(custKey, items, res));
  await invoiceLock;
});

function _createInvoice(custKey, items, res) {
  const client = connect();
  try {
    client.begin();

    const customerRes = client.query(
      "SELECT cust_id, cust_gst, is_active FROM customers WHERE cust_id = ?",
      [custKey]
    );
    const customer = customerRes.rows[0];
    if (!customer) throw new Error("Customer not found");

    let subtotal = 0;
    const lineRows = [];

    for (const line of items) {
      const itemKey = String(line.item_id).trim();
      const qty = Math.max(1, parseInt(line.quantity, 10) || 0);
      if (!itemKey || qty < 1) throw new Error("Each line needs item_id and quantity");

      const itemRes = client.query("SELECT price FROM items WHERE item_id = ?", [itemKey]);
      if (itemRes.rowCount === 0) throw new Error(`Item not found: ${itemKey}`);

      const unit = Number(itemRes.rows[0].price);
      subtotal += unit * qty;
      lineRows.push({ item_id: itemKey, quantity: qty, price: unit });
    }

    const totals = computeInvoiceTotals(subtotal, customer);
    const totalRounded = parseFloat(totals.totalAmount.toFixed(2));
    const subRounded   = parseFloat(subtotal.toFixed(2));
    const gstRounded   = parseFloat(totals.gstAmount.toFixed(2));

    const invoiceId = generateUniqueInvoiceId(client);

    // Insert invoice; get its auto-generated PK via last_insert_rowid()
    client.query(
      `INSERT INTO invoices (invoice_id, cust_id, total_amount, gst_applied)
       VALUES (?, ?, ?, ?)`,
      [invoiceId, custKey, totalRounded, totals.gstApplied ? 1 : 0]
    );

    // Fetch PK within the same transaction (before commit) 
    const pkRes = client.query("SELECT last_insert_rowid() AS pk");
    const dbInvoicePk = pkRes.rows[0].pk;

    for (const L of lineRows) {
      client.query(
        `INSERT INTO invoice_items (invoice_id, item_id, quantity, price) VALUES (?, ?, ?, ?)`,
        [dbInvoicePk, L.item_id, L.quantity, L.price]
      );
    }

    client.commit(); // also persists to database.db

    res.status(201).json({
      message: "Invoice created",
      id: dbInvoicePk,
      invoice_id: invoiceId,
      invoiceId,
      total: subRounded,
      gst: gstRounded,
      finalAmount: totalRounded,
      final_amount: totalRounded,
      total_amount: totalRounded,
      gst_applied: totals.gstApplied,
    });
  } catch (err) {
    client.rollback();
    console.error(err);
    res.status(500).json({ error: err.message || "Error creating invoice" });
  } finally {
    client.release();
  }
}

// ===================== SERVER =====================

const PORT = process.env.PORT || 5000;

// sql.js initialisation is async — open the DB, init schema, then listen.
open()
  .then(() => {
    initDb(); // create tables + seed data (idempotent)
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to open database:", err);
    process.exit(1);
  });
