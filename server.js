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
console.log('ALLOWED_ORIGIN =', process.env.ALLOWED_ORIGIN || 'http://localhost:5173');
console.log('PORT (env) =', process.env.PORT);
console.log('OPENAI key loaded?', !!process.env.OPENAI_API_KEY);

// Safety
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));

// ---------- CORS ----------
app.use((req, res, next) => {
  const cfg = process.env.ALLOWED_ORIGIN || '*';
  const origin = req.headers.origin || '';
  const allowOrigin = cfg === '*' ? origin : cfg;
  const allowCreds = cfg !== '*';

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', allowOrigin || '*');
  if (allowCreds) res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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

    const systemPrompt = `You are a routing policy interpreter.
You will receive persistent rules, ad-hoc rules, and current route context.
Output JSON with routing priorities, constraints, and penalties.`;

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
      const errData = await r.text();
      console.error(`[AI ERROR] OpenAI API responded with status ${r.status}`, errData);
      return res.status(500).json({ error: `OpenAI API error ${r.status}`, details: errData });
    }

    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    res.json({ ok: true, content });

  } catch (err) {
    console.error('[AI ERROR] Unexpected', err);
    res.status(500).json({ error: 'Unexpected AI server error', details: err.message || err });
  }
});

// ---------- Start ----------
const port = process.env.PORT || 5175;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
