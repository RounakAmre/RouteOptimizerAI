import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// --- helpers ---
function pick(obj, snake, camel, defVal) {
  if (obj && Object.prototype.hasOwnProperty.call(obj, snake)) return obj[snake];
  if (obj && Object.prototype.hasOwnProperty.call(obj, camel)) return obj[camel];
  return defVal;
}
function toNumber(x, defVal) {
  const n = Number(x);
  return Number.isFinite(n) ? n : defVal;
}
function normalizeRules(raw) {
  // 1) read from snake or camel
  const priority = String(pick(raw, 'priority', 'priority', 'balanced') || 'balanced').toLowerCase();

  const avoidListRaw = pick(raw, 'avoid_road_names', 'avoidRoadNames', []);
  const avoid_road_names = Array.isArray(avoidListRaw) ? avoidListRaw.map(String) : [];

  // weights (read both, clamp sensible minimums)
  let urgent_weight       = toNumber(pick(raw, 'urgent_weight',       'urgent',            1.0), 1.0);
  let lateness_weight     = toNumber(pick(raw, 'lateness_weight',     'lateness',          1.0), 1.0);
  let wait_weight         = toNumber(pick(raw, 'wait_weight',         'wait',              0.1), 0.1);
  let avoid_road_penalty  = toNumber(pick(raw, 'avoid_road_penalty',  'avoidRoadPenalty', 300 ), 300);

  // 2) clamp minimums so the AI has real impact
  if (!Number.isFinite(urgent_weight)      || urgent_weight <= 0) urgent_weight = 1.0;
  if (!Number.isFinite(lateness_weight)    || lateness_weight <= 0) lateness_weight = 1.0;
  if (!Number.isFinite(wait_weight)        || wait_weight <  0.05) wait_weight = 0.1;
  if (!Number.isFinite(avoid_road_penalty) || avoid_road_penalty < 300) avoid_road_penalty = 1200; // ~20 min

  // 3) return BOTH shapes (snake + camel) so client can read either
  const out = {
    priority,
    avoid_road_names,
    urgent_weight,
    lateness_weight,
    wait_weight,
    avoid_road_penalty,

    // camelCase mirrors
    avoidRoadNames: avoid_road_names,
    weights: {
      urgent: urgent_weight,
      lateness: lateness_weight,
      wait: wait_weight,
      avoidRoadPenalty: avoid_road_penalty,
    },

    // for client-side cache invalidation of pair checks
    cache_buster: Date.now(),
    normalized: true
  };
  return out;
}

app.post('/ai/interpret', async (req, res) => {
  try {
    const { persistent = '', adhoc = '', context = {} } = req.body || {};
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
    }

    const system = `You are a routing policy interpreter. Output STRICT JSON only.
Allowed keys:
- priority: "urgent" | "timewindow" | "balanced"
- avoid_road_names: string[]
- urgent_weight, lateness_weight, wait_weight, avoid_road_penalty: numbers >= 0`;

    const user = `PERSISTENT RULES:\n${persistent}\n\nAD HOC PROMPT:\n${adhoc}\n\nCONTEXT:\n${JSON.stringify(context)}`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error('[OpenAI error]', r.status, txt);
      return res.status(500).json({ error: `OpenAI ${r.status}`, details: txt });
    }

    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const s = content.indexOf('{'), e = content.lastIndexOf('}');
    const obj = (s !== -1 && e !== -1) ? JSON.parse(content.slice(s, e + 1)) : {};

    // --- normalize + clamp + add cache_buster ---
    const normalized = normalizeRules(obj);

    // IMPORTANT: tell client to clear its pair cache when rules change.
    // The client should reset its `pairMetaCache` when it sees a new cache_buster.
    return res.json(normalized);

  } catch (err) {
    console.error('[AI ERROR]', err);
    res.status(500).json({ error: 'AI server error', details: err.message || String(err) });
  }
});

const port = process.env.PORT || 5175;
app.listen(port, () => console.log('Server on', port));
