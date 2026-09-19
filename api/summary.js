export const config = { api: { bodyParser: true } };
const ANT_KEY = process.env.ANTHROPIC_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }
  const { symbol, score, bullPct, bearPct, neutralPct, totalMessages, uniqueAuthors, messages } = body;

  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const fallback = {
    summary: '$' + symbol + ' shows ' + (score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'mixed') + ' community sentiment at ' + score + '/100. ' + bullPct + '% of tagged messages are bullish vs ' + bearPct + '% bearish across ' + totalMessages + ' recent posts from ' + uniqueAuthors + ' unique authors.',
    bullThemes: bullPct > bearPct ? ['Price momentum', 'Community interest'] : [],
    bearThemes: bearPct > bullPct ? ['Selling pressure', 'Caution'] : [],
    catalysts: [],
    hasAI: false
  };

  if (!ANT_KEY) return res.status(200).json(fallback);

  try {
    const sample = (messages || []).slice(0, 10).join('\n');
    const prompt = 'Analyze StockTwits for $' + symbol + '. Score: ' + score + '/100 (' + bullPct + '% bull, ' + bearPct + '% bear, ' + neutralPct + '% neutral). ' + totalMessages + ' messages from ' + uniqueAuthors + ' authors.\n\nMessages:\n' + sample + '\n\nReturn ONLY this JSON object, nothing else:\n{"summary":"2 sentences about sentiment","bullThemes":["theme1","theme2"],"bearThemes":["theme1"],"catalysts":[]}';

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANT_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!r.ok) {
      console.error('Anthropic error:', r.status, await r.text());
      return res.status(200).json(fallback);
    }

    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(200).json(fallback);
    const parsed = JSON.parse(match[0]);
    return res.status(200).json({ ...parsed, hasAI: true });
  } catch(e) {
    console.error('Summary error:', e.message);
    return res.status(200).json(fallback);
  }
}
