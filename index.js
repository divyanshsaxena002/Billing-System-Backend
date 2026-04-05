const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const db = require("./db");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const GST_RATE = 0.18;

/** Advisory lock key for sequential invoice_id generation (must be unique in this app). */
const INVOICE_ID_LOCK_KEY = 928_441_001;

/**
 * Next human-readable invoice id: INVC + 6 digits (INVC000001 … INVC999999).
 * Uses pg_advisory_xact_lock so concurrent creates cannot reuse the same number.
 */
async function generateUniqueInvoiceId(client) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [INVOICE_ID_LOCK_KEY]);

  const maxRes = await client.query(`
    SELECT COALESCE(MAX((SUBSTRING(invoice_id FROM 5))::INTEGER), 0) AS n
    FROM invoices
    WHERE invoice_id ~ '^INVC[0-9]{6}$'
  `);

  let nextNum = Number(maxRes.rows[0].n) + 1;
  if (nextNum > 999_999) {
    throw new Error("Invoice number pool exhausted (max INVC999999)");
  }

  let candidate = `INVC${String(nextNum).padStart(6, "0")}`;

  // Safety: if pattern data is messy, retry with incremented numbers until free or cap
  for (let attempts = 0; attempts < 50; attempts++) {
    const dup = await client.query("SELECT 1 FROM invoices WHERE invoice_id = $1", [candidate]);
    if (dup.rowCount === 0) {
      return candidate;
    }
    nextNum += 1;
    if (nextNum > 999_999) {
      throw new Error("Invoice number pool exhausted");
    }
    candidate = `INVC${String(nextNum).padStart(6, "0")}`;
  }

  throw new Error("Could not allocate unique invoice_id");
}

/**
 * GST: if customer has GST number AND is_active = 'Y' → no GST.
 * Otherwise → apply 18%.
 * Returns subtotal, gst line amount, final total, and gst_applied flag.
 */
function computeInvoiceTotals(subtotal, customerRow) {
  if (!customerRow) {
    const gstAmount = subtotal * GST_RATE;
    return {
      subtotal,
      gstAmount,
      totalAmount: subtotal + gstAmount,
      gstApplied: true,
    };
  }
  const hasGst = String(customerRow.cust_gst ?? "").trim() !== "";
  const activeY = String(customerRow.is_active ?? "").trim().toUpperCase() === "Y";
  const gstExempt = hasGst && activeY;
  if (gstExempt) {
    return {
      subtotal,
      gstAmount: 0,
      totalAmount: subtotal,
      gstApplied: false,
    };
  }
  const gstAmount = subtotal * GST_RATE;
  return {
    subtotal,
    gstAmount,
    totalAmount: subtotal + gstAmount,
    gstApplied: true,
  };
}

async function ensureInvoiceGstColumn() {
  await db.query(`
    ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS gst_applied BOOLEAN NOT NULL DEFAULT false
  `);
}

// Test route
app.get("/", (req, res) => {
  res.send("Server running 🚀");
});

// ===================== CUSTOMERS =====================

app.get("/customers", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM customers ORDER BY cust_id");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching customers");
  }
});

app.post("/customers", async (req, res) => {
  try {
    const { cust_name, cust_address, cust_pan, cust_gst, is_active } = req.body;

    if (!cust_name) {
      return res.status(400).json({ error: "Customer name required" });
    }

    const result = await db.query(
      `INSERT INTO customers
      (cust_name, cust_address, cust_pan, cust_gst, is_active)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *`,
      [cust_name, cust_address || "", cust_pan || "", cust_gst || "", is_active || "Y"]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creating customer" });
  }
});

// ===================== ITEMS =====================

app.get("/items", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM items ORDER BY item_id");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching items");
  }
});

app.post("/items", async (req, res) => {
  try {
    const { item_name, price, is_active } = req.body;

    if (!item_name) {
      return res.status(400).json({ error: "Item name required" });
    }

    const result = await db.query(
      `INSERT INTO items (item_name, price, is_active)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [item_name, price || 0, is_active || "Y"]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creating item" });
  }
});

// ===================== INVOICES =====================

app.get("/invoice/all", async (req, res) => {
  try {
    const result = await db.query(`
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
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error fetching invoices" });
  }
});

app.get("/invoice/:id", async (req, res) => {
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
      invoice = await db.query(`${baseSelect} WHERE i.id = $1`, [asInt]);
    }
    if (!invoice || invoice.rows.length === 0) {
      invoice = await db.query(`${baseSelect} WHERE i.invoice_id = $1`, [raw]);
    }

    if (invoice.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    const row = invoice.rows[0];

    const items = await db.query(
      `
      SELECT ii.item_id, ii.quantity, ii.price, i.item_name
      FROM invoice_items ii
      LEFT JOIN items i ON i.item_id = ii.item_id
      WHERE ii.invoice_id = $1
      ORDER BY ii.id
    `,
      [row.id]
    );

    res.json({
      ...row,
      lines: items.rows,
      items: items.rows,
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
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const customerRes = await client.query(
      "SELECT cust_id, cust_gst, is_active FROM customers WHERE cust_id = $1",
      [custKey]
    );
    const customer = customerRes.rows[0];
    if (!customer) {
      throw new Error("Customer not found");
    }

    let subtotal = 0;
    const lineRows = [];

    for (const line of items) {
      const itemKey = String(line.item_id).trim();
      const qty = Math.max(1, parseInt(line.quantity, 10) || 0);
      if (!itemKey || qty < 1) {
        throw new Error("Each line needs item_id and quantity");
      }

      const itemRes = await client.query("SELECT price FROM items WHERE item_id = $1", [itemKey]);
      if (itemRes.rows.length === 0) {
        throw new Error(`Item not found: ${itemKey}`);
      }
      const unit = Number(itemRes.rows[0].price);
      const lineTotal = unit * qty;
      subtotal += lineTotal;
      lineRows.push({ item_id: itemKey, quantity: qty, price: unit });
    }

    const totals = computeInvoiceTotals(subtotal, customer);
    const totalRounded = parseFloat(totals.totalAmount.toFixed(2));
    const subRounded = parseFloat(subtotal.toFixed(2));
    const gstRounded = parseFloat(totals.gstAmount.toFixed(2));

    const invoiceId = await generateUniqueInvoiceId(client);

    const invoiceRes = await client.query(
      `INSERT INTO invoices (invoice_id, cust_id, total_amount, gst_applied)
       VALUES ($1, $2, $3, $4)
       RETURNING id, invoice_id, total_amount, gst_applied`,
      [invoiceId, custKey, totalRounded, totals.gstApplied]
    );

    const dbInvoicePk = invoiceRes.rows[0].id;

    for (const L of lineRows) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, item_id, quantity, price)
         VALUES ($1, $2, $3, $4)`,
        [dbInvoicePk, L.item_id, L.quantity, L.price]
      );
    }

    await client.query("COMMIT");

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
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message || "Error creating invoice" });
  } finally {
    client.release();
  }
});

// ===================== SERVER =====================

ensureInvoiceGstColumn()
  .catch((e) => console.warn("Could not ensure invoices.gst_applied:", e.message))
  .finally(() => {
    app.listen(5000, () => {
      console.log("✅ Server running on port 5000");
    });
  });
