
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ---------- Boot ----------
console.log('--- BOOT ---');
console.log('PORT =', process.env.PORT);
console.log('OPENAI key loaded?', !!process.env.OPENAI_API_KEY);

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- AI endpoint ----------
app.post('/ai/interpret', async (req, res) => {
  try {
    const { persistent = '', adhoc = '', context = {} } = req.body || {};

    if (!process.env.OPENAI_API_KEY) {
      console.error('[AI ERROR] Missing OPENAI_API_KEY env var');
      return res.status(500).json({ error: 'Server missing OpenAI API key' });
    }

    const systemPrompt = `You are a routing policy interpreter. Output STRICT JSON only.
Allowed keys:
- priority: "urgent" | "timewindow" | "balanced"
- avoid_road_names: string[]
- urgent_weight, lateness_weight, wait_weight, avoid_road_penalty: numbers >= 0`;

    const userPrompt = `PERSISTENT RULES:\n${persistent}\n\nAD-HOC RULES:\n${adhoc}\n\nCONTEXT:\n${JSON.stringify(context)}`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error(`[AI ERROR] OpenAI API ${r.status}:`, errText);
      return res.status(500).json({ error: `OpenAI API error ${r.status}`, details: errText });
    }

    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '{}';
    const start = text.indexOf('{'); const end = text.lastIndexOf('}');
    const obj = (start !== -1 && end !== -1) ? JSON.parse(text.slice(start, end + 1)) : {};
    res.json(obj);
  } catch (err) {
    console.error('[AI ERROR] Unexpected', err);
    res.status(500).json({ error: 'Unexpected AI server error', details: err.message || String(err) });
  }
});

// ---------- Start ----------
const port = process.env.PORT || 5175;
app.listen(port, () => console.log(`Server running on ${port}`));
