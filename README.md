
# Route Optimizer — Two-Flow (Render Ready)

Top buttons (only):
- **Optimize** — Heuristic first; if the *persistent prompt* is empty, draw heuristic. If not empty, re-order stops by AI rules, then draw.
- **Clear** — Clears stops and route.

Ad Hoc section:
- One prompt box + **Optimize with Ad Hoc** button. This runs the same flow but uses persistent + ad hoc together for re-ordering.

Final map:
- Draws the route strictly in the computed order. No in-map optimization is used.

## Local
```
cp .env.example .env   # add your OPENAI_API_KEY
npm install
npm start
# open http://localhost:5175
```

## Render
- Push this folder to GitHub
- New Web Service
  - Build: `npm install`
  - Start: `node server.js`
  - Env var: `OPENAI_API_KEY`
