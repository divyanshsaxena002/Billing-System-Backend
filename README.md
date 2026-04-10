# Invoice System — Backend

## Database

> **SQLite (file-based database) is used to comply with the restriction on cloud databases.**  
> Powered by [sql.js](https://github.com/sql-js/sql.js) — a pure WebAssembly port of SQLite that requires **zero native compilation** and works on any Node.js version or OS.  
> No PostgreSQL, no cloud DB, no external connection string required.  
> The database lives in `database.db` next to this file and is created automatically on first run.

---

## Local Development

```bash
# 1. Install dependencies
cd backend
npm install

# 2. Start the server (tables + seed data are created automatically)
npm start
# → ✅ Server running on port 5000
```

Test it:
```
GET  http://localhost:5000/           → "Server running 🚀"
GET  http://localhost:5000/customers  → seeded customer list
GET  http://localhost:5000/items      → seeded item list
```

---

## Deploying to Render (free tier)

### Step 1 — Push your backend to GitHub
Make sure `database.db` is in `.gitignore` (it already is). Commit and push the `backend/` folder (or the whole repo).

### Step 2 — Create a Web Service on Render
1. Go to [render.com](https://render.com) → **New +** → **Web Service**
2. Connect your GitHub repo
3. Set the following:

| Field | Value |
|-------|-------|
| **Root Directory** | `backend` (if the whole monorepo is pushed) |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Environment** | Node |

### Step 3 — Add a Persistent Disk (important!)
By default Render's filesystem is **ephemeral** — it resets on every deploy. The `database.db` file will be wiped.

To keep the database across deploys:
1. In Render → your service → **Disks** → **Add Disk**
2. **Mount Path**: `/var/data`
3. Add this environment variable: `DB_PATH=/var/data/database.db`

The database will now persist on the disk across deployments.

> ⚠️ Free-tier Render services spin down after inactivity. The database file survives spin-down as long as the disk is attached.

### Step 4 — Update the frontend
On Vercel, add/update the environment variable:
```
REACT_APP_API_URL=https://your-render-service-name.onrender.com
```
Then re-deploy the frontend.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5000` | Port the server listens on |
| `DB_PATH` | `./database.db` | Path to the SQLite database file |

Copy `.env.example` to `.env` for local overrides.

---

## Common Errors & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `Cannot find module 'better-sqlite3'` | Packages not installed | Run `npm install` |
| `SQLITE_CONSTRAINT: UNIQUE ...` | Duplicate invoice/customer/item ID | Normal validation error — check your request body |
| `SQLITE_CONSTRAINT: FOREIGN KEY ...` | Referenced row doesn't exist | Make sure `cust_id` / `item_id` exist in master tables |
| Database resets on every Render deploy | No persistent disk | Attach a Render Disk and set `DB_PATH` (see Step 3 above) |
| `Error: SQLITE_CANTOPEN` | Wrong `DB_PATH` or no write permission | Check the path is writable; on Render use the mounted disk path |
| Frontend shows CORS error | Backend URL misconfigured | Set `REACT_APP_API_URL` on Vercel to the exact Render URL |

---

## API Reference

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/` | Health check |
| GET | `/customers` | List all customers |
| POST | `/customers` | Create a customer |
| GET | `/items` | List all items |
| POST | `/items` | Create an item |
| GET | `/invoice/all` | List all invoices |
| GET | `/invoice/:id` | Get invoice by ID or invoice_id |
| POST | `/invoice/create` | Create a new invoice |
