
// Minimal local proxy for GPT‑3.5 to interpret routing rules.
// Usage: set OPENAI_API_KEY in .env, then `npm install` && `npm start`.
// Serves / (static files under /public) and POST /ai/interpret.
import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

app.post('/ai/interpret', async (req, res) => {
  try {
    const { persistent = '', adhoc = '', context = {} } = req.body || {};
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'Missing OPENAI_API_KEY' });

    const system = `You are a routing policy interpreter. Output STRICT JSON only.
Allowed keys:
- priority: one of "urgent", "timewindow", "balanced"
- avoid_road_names: array of road names to avoid exactly as strings
- urgent_weight: number (>=0), higher prioritizes urgent stops more
- lateness_weight: number (>=0), penalty per second late beyond window
- wait_weight: number (>=0), penalty per second of waiting before a window
- avoid_road_penalty: number (>=0), extra seconds added if a leg uses an avoided road

Guidelines:
- If the persistent rules say "if urgent delivery and timed delivery exist around same time, prioritize urgent", set priority="urgent".
- If the ad hoc prompt says "avoid <road>", put the road name(s) in avoid_road_names.
- Keep numbers small and practical; defaults: urgent_weight=1.0, lateness_weight=1.0, wait_weight=0.1, avoid_road_penalty=300.`;

    const user = {
      role: 'user',
      content: [
        { type: 'text', text: `PERSISTENT RULES:\n${persistent}` },
        { type: 'text', text: `AD HOC PROMPT:\n${adhoc}` },
        { type: 'text', text: `CONTEXT (stops):\n${JSON.stringify(context, null, 2)}` },
        { type: 'text', text: 'Return JSON only.' }
      ]
    };

    // Use Chat Completions for GPT‑3.5
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          user
        ]
      })
    });

    if (!resp.ok) {
      const t = await resp.text();
      return res.status(500).json({ error: 'OpenAI error', detail: t });
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '{}';

    // Extract JSON
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return res.status(200).json({ priority: 'balanced' });
    const obj = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    return res.json(obj);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 5175;
app.listen(port, () => console.log(`[AI Proxy] http://localhost:${port}`));
