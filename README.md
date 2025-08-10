
# Route Optimizer — Two‑Flow v3 (Render Ready)

Changes in this build:
- Adds **AI order list** (under the Ad Hoc section) showing the stop sequence after AI re‑arrange.
- Keeps the two-button top bar (Optimize, Clear).
- Optimize flow: heuristic → if no prompts, draw as-is; otherwise apply persistent + ad‑hoc rules to re‑order **only affected stops**, then draw.
- Final route is drawn in that order (no Leaflet optimization).

## Local
```
cp .env.example .env   # add OPENAI_API_KEY
npm install
npm start
# open http://localhost:5175
```

## Render
Build: `npm install`  
Start: `node server.js`  
Env var: `OPENAI_API_KEY`
