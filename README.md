
# Route Optimizer + AI (Persistent + Ad Hoc saved)

- Save buttons overwrite previous prompts in **localStorage**:
  - `persistentPrompt`
  - `adHocPrompt`
- AI normalization accepts `avoid_road_names` and `avoidRoadNames`.
- Urgent priority is stronger, and avoided-road penalties apply.
- Render-ready: uses `render.yaml` and `/ai/interpret` server.

## Run locally
```
cp .env.example .env   # set OPENAI_API_KEY
npm install
npm start
# open http://localhost:5175
```

## Deploy to Render
- New Web Service → repo root
- Build: `npm install` • Start: `node server.js`
- Env var: `OPENAI_API_KEY`
