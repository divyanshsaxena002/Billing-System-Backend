-- Reference schema for billing (run manually if tables are missing or misaligned).
-- Adjust only if your database differs.

-- GST flag (also attempted automatically on server start via ALTER ... IF NOT EXISTS)
-- ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gst_applied BOOLEAN NOT NULL DEFAULT false;

-- invoices.human-readable id must be UNIQUE for INVC###### generation
-- ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_id VARCHAR(32) UNIQUE;
-- ALTER TABLE invoices ADD COLUMN IF NOT EXISTS total_amount NUMERIC(14,2);
-- ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cust_id VARCHAR(64) REFERENCES customers(cust_id);

-- invoice_items.invoice_id = invoices.id (integer PK)
-- CREATE TABLE IF NOT EXISTS invoice_items (
--   id SERIAL PRIMARY KEY,
--   invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
--   item_id VARCHAR(64) NOT NULL REFERENCES items(item_id),
--   quantity INTEGER NOT NULL CHECK (quantity > 0),
--   price NUMERIC(14,2) NOT NULL
-- );
