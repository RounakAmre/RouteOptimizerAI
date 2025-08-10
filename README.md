
# Route Optimizer — AI Post-Adjust (Render Ready)

**Flow**
1) **Optimize (Heuristic)**: builds a base order with OSRM matrix (greedy).  
2) **AI Post‑Adjust**: uses GPT‑3.5 rules to minimally rearrange *only affected* stops (urgent first; local swaps to avoid named roads).  
3) **Final map**: Leaflet draws the route *exactly* in that order. For each leg we query OSRM with `alternatives=true` and choose the variant that avoids named roads when practical.

Also shows a list of legs that still hit avoided road names.

## Local
```
cp .env.example .env   # set OPENAI_API_KEY
npm install
npm start
# open http://localhost:5175
```

## Render
- Push this folder to GitHub.
- Create a Web Service with:
  - Build: `npm install`
  - Start: `node server.js`
  - Env var: `OPENAI_API_KEY`
- App serves frontend + `/ai/interpret` at the same URL.
