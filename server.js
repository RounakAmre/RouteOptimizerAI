
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
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-3.5-turbo', temperature: 0, messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ] })
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error('[OpenAI error]', r.status, txt);
      return res.status(500).json({ error: `OpenAI ${r.status}`, details: txt });
    }
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const s = content.indexOf('{'), e = content.lastIndexOf('}');
    const obj = (s !== -1 && e !== -1) ? JSON.parse(content.slice(s, e+1)) : {};
    res.json(obj);
  } catch (err) {
    console.error('[AI ERROR]', err);
    res.status(500).json({ error: 'AI server error', details: err.message || String(err) });
  }
});

const port = process.env.PORT || 5175;
app.listen(port, () => console.log('Server on', port));
