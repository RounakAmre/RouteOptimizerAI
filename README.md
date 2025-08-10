
# Route Optimizer — Two‑Flow (Render‑ready)

**Flow**
- Top buttons: **Optimize** and **Clear** only.
- Optimize:
  1. Run heuristic (OSRM matrix; greedy NN).
  2. If persistent prompt is empty and no ad‑hoc → draw heuristic order.
     Otherwise call `/ai/interpret` with persistent (+ ad‑hoc if used), minimally reorder (urgent first, local swaps to avoid named roads).
  3. Draw route exactly in that final order (Leaflet polyline; no optimization).
- **Ad Hoc** section: one prompt box + **Optimize with Ad Hoc** which runs the same flow using persistent + ad‑hoc.

Prompts are saved in `localStorage`.

## Local
```
cp .env.example .env   # add OPENAI_API_KEY
npm install
npm start
# open http://localhost:5175
```

## Render
- Push to GitHub
- New Web Service
  - Build: `npm install`
  - Start: `node server.js`
  - Env var: `OPENAI_API_KEY`
