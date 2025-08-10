
# Route Optimizer — AI Prompts (Persistent + Ad Hoc) with GPT‑3.5

**What you get**
- Clean Leaflet app: add stops, name them, service minutes, urgent flag, time windows
- Heuristic optimizer (no AI) **and** AI‑assisted optimizer using GPT‑3.5
- Persistent rules (always applied) + Ad hoc prompt (one‑off)
- Ad hoc supports things like **“Avoid I‑35E”**; the optimizer penalizes legs that use those road names
- Numbered markers after optimization, GPX export, Google Maps link

## Run (no AI)
Just open the UI and use the heuristic optimizer:
1. `cd route-optimizer-ai`
2. `python -m http.server 5500` (or any static server)
3. Visit http://localhost:5500/public/

You can still type ad hoc rules — a fallback parser handles patterns like **avoid &lt;road&gt;** and **prioritize urgent**.

## Run with AI (GPT‑3.5)
1. `cd route-optimizer-ai`
2. `cp .env.example .env` and set `OPENAI_API_KEY`
3. `npm install`
4. `npm start`
5. Visit **http://localhost:5175/**
   - The app is served from the same server. Use **AI Optimize** or **Use AI + Optimize**.

## How AI is used
- The server calls **OpenAI gpt-3.5-turbo** to turn your natural language into structured rules:
  ```json
  {
    "priority": "urgent|timewindow|balanced",
    "avoid_road_names": ["I-35E", "Main St"],
    "urgent_weight": 1.0,
    "lateness_weight": 1.0,
    "wait_weight": 0.1,
    "avoid_road_penalty": 300
  }
  ```
- On the client, those rules tweak the scoring function and add a penalty if a candidate leg uses an **avoided road** (detected via OSRM `steps=true`).

## Notes
- This is still a greedy heuristic, not an exact VRP solver.
- The OSRM demo server is free but rate‑limited; keep #stops reasonable.
- Your persistent prompt is saved in `localStorage`.
- If the AI server is unavailable, the app falls back to a simple parser for common intents.

## Security
For demos, the key lives in `.env` and never ships to the browser — the browser calls the local proxy at `/ai/interpret`.

---

## Deploy to Render (Free)
1) Push this folder to GitHub.
2) On Render: **New + → Web Service** → connect the repo.
3) It will auto-detect `render.yaml`. Review settings:
   - Build: `npm install`
   - Start: `node server.js`
   - Env var: **OPENAI_API_KEY** (add in Render → Environment).
4) Deploy. Your app (frontend + /ai/interpret) will be served from one URL.
