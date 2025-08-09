
# Route Optimizer + AI — Render Ready

Includes:
- `server.js` (serves `/public` and `/ai/interpret`)
- `public/` frontend (Leaflet map + AI prompts)
- `package.json` with `node-fetch`, `express`, `dotenv`
- `render.yaml` (auto-detected by Render)
- `.env.example` for local dev

## Deploy on Render (Starter plan OK)
1) Push this folder to GitHub.
2) On Render → **New Web Service** → select the repo (Root: repo root).
3) It will auto-detect `render.yaml`. If not, set:
   - Build: `npm install`
   - Start: `node server.js`
4) Add env var **OPENAI_API_KEY** (Render → Environment).
5) Deploy. The app serves frontend + `/ai/interpret` on one URL.

## Local dev
```
cp .env.example .env   # add your key
npm install
npm start
# open http://localhost:5175
```
