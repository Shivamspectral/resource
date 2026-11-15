# ReSourceX — full stack

```
frontend/   static site (HTML/CSS/JS)  → deploy to Vercel
backend/    Node API + Socket.IO        → deploy to Render / Railway / Fly / any Node host
```

Real-time (WebSockets) cannot run on Vercel serverless functions, which is why the backend is a separate, always-on Node service.

## Run locally (2 terminals)
```bash
# 1) backend
cd backend && npm install && npm start          # http://localhost:4000
# 2) frontend
cd frontend && npx serve .                        # or: python3 -m http.server 8080
```
Open the frontend, click **Create account**. Open a second browser/incognito window with a second account to see live updates between organizations.
`config.js` already points at `http://localhost:4000`.

## Deploy
**1. Backend (Render example)** — push the repo to GitHub, then *New → Blueprint* and pick `backend/render.yaml`
(or create a Web Service with root dir `backend`, build `npm install --omit=dev`, start `npm start`).
Set env vars: `JWT_SECRET` (long random), `CORS_ORIGIN` (your Vercel URL), `DATA_DIR` (a persistent-disk path).
Check `https://<your-api>/api/health` returns `{"ok":true}`.

**2. Frontend (Vercel)** — edit `frontend/config.js`:
```js
window.RESOURCEX_API = "https://<your-api>.onrender.com";
```
Then import the repo in Vercel with **Root Directory = `frontend`**, Framework Preset **Other**, no build command.
Finally put the final Vercel URL into the backend's `CORS_ORIGIN` and redeploy it.

## What's real now
- Accounts (scrypt-hashed passwords, signed 7-day tokens), per-user data and permissions.
- Listings with server-side validation and a safety scan (prohibited materials / expired / Healthcare needs expiry).
- Requests → owner approves/declines → transfer complete. Only the owner can decide; outsiders can't read conversations.
- Messaging with unread counts, notifications, activity feed, badges.
- Live updates over Socket.IO: new listings, requests, approvals, messages, notifications, online count.
- Impact + circularity score computed from completed exchanges; CSV export.
- Run `cd backend && npm install && npm test` for the 34-check end-to-end test.

## Honest limits (read before launching publicly)
- **Storage is one JSON file** (`DATA_DIR/db.json`) on one server instance. Fine for demos/pilots; on hosts with ephemeral disks (Render free, Heroku) data is lost on redeploy — use a persistent disk or swap the storage in `server.js` for Postgres before real use. Don't run multiple instances.
- **"Verified organization"** currently means "registered with a valid email". Real KYC / document verification is not implemented.
- **"AI" classification and match score are transparent rule-based heuristics** (keywords, category fit, distance from a built-in table of ~30 Indian cities, expiry), not a machine-learning model.
- **Impact numbers are estimates** (units → ~0.2 kg, 2.5 kg CO₂ and ₹55 per kg diverted).
- The map card is decorative; "Open Live Map" shows live counts, not map tiles (needs a map provider key).
- No email/SMS notifications, password reset, or file/document uploads yet.
