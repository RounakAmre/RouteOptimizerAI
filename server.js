
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// Helpers to normalize/clamp AI output
function pick(o, snake, camel, d){ if (o && (snake in o)) return o[snake]; if (o && (camel in o)) return o[camel]; return d; }
function num(x, d){ const n = Number(x); return Number.isFinite(n) ? n : d; }
function normalizeRules(raw){
  const priority = String(pick(raw,'priority','priority','balanced')||'balanced').toLowerCase();
  const avoidRaw = pick(raw,'avoid_road_names','avoidRoadNames',[]);
  const avoid_road_names = Array.isArray(avoidRaw) ? avoidRaw.map(String) : [];
  let urgent_weight = num(pick(raw,'urgent_weight','urgent',1.0),1.0);
  let lateness_weight = num(pick(raw,'lateness_weight','lateness',1.0),1.0);
  let wait_weight = num(pick(raw,'wait_weight','wait',0.1),0.1);
  let avoid_road_penalty = num(pick(raw,'avoid_road_penalty','avoidRoadPenalty',1200),1200);
  if (!Number.isFinite(urgent_weight) || urgent_weight <= 0) urgent_weight = 1.0;
  if (!Number.isFinite(lateness_weight) || lateness_weight <= 0) lateness_weight = 1.0;
  if (!Number.isFinite(wait_weight) || wait_weight < 0.05) wait_weight = 0.1;
  if (!Number.isFinite(avoid_road_penalty) || avoid_road_penalty < 300) avoid_road_penalty = 1200;
  return {
    priority,
    avoid_road_names,
    urgent_weight, lateness_weight, wait_weight, avoid_road_penalty,
    avoidRoadNames: avoid_road_names,
    weights: { urgent: urgent_weight, lateness: lateness_weight, wait: wait_weight, avoidRoadPenalty: avoid_road_penalty },
    cache_buster: Date.now(),
    normalized: true
  };
}

app.post('/ai/interpret', async (req, res) => {
  try{
    const { persistent = '', adhoc = '', context = {} } = req.body || {};
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });

    const system = `You are a routing policy interpreter. Output STRICT JSON only.
Allowed keys:
- priority: "urgent" | "timewindow" | "balanced"
- avoid_road_names: string[]
- urgent_weight, lateness_weight, wait_weight, avoid_road_penalty: numbers >= 0`;

    const user = `PERSISTENT RULES:\n${persistent}\n\nAD HOC PROMPT:\n${adhoc}\n\nCONTEXT:\n${JSON.stringify(context)}`;

    const r = await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{ 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ model:'gpt-3.5-turbo', temperature:0, messages:[
        { role:'system', content: system },
        { role:'user', content: user }
      ]})
    });
    if (!r.ok){
      const t = await r.text();
      console.error('[OpenAI error]', r.status, t);
      return res.status(500).json({ error:`OpenAI ${r.status}`, details:t });
    }
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '{}';
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    const obj = (s!==-1 && e!==-1) ? JSON.parse(text.slice(s,e+1)) : {};
    return res.json(normalizeRules(obj));
  }catch(err){
    console.error('[AI ERROR]', err);
    return res.status(500).json({ error:'AI server error', details: err.message || String(err) });
  }
});

const port = process.env.PORT || 5175;
app.listen(port, () => console.log('Server running on', port));
