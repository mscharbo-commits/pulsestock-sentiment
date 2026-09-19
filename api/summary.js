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

  if (!ANT_KEY) {
    return res.status(200).json(fallback);
  }

  try {
    const sample = (messages || []).slice(0, 10).join('\n');
    const sentLabel = score >= 60 ? 'BULLISH' : score <= 40 ? 'BEARISH' : 'NEUTRAL/MIXED';
    const prompt = 'Analyze StockTwits messages for $' + symbol + '.\n\nSENTIMENT LABELS (user-tagged): ' + bullPct + '% explicitly tagged Bullish, ' + bearPct + '% explicitly tagged Bearish, ' + neutralPct + '% untagged/neutral. Overall score: ' + score + '/100 (' + sentLabel + ').\n\nMESSAGE CONTENT (what people are actually saying):\n' + sample + '\n\nIMPORTANT: The summary must reflect the LABEL data first. If bearPct is 0%, do NOT say sentiment is mixed or bearish in the summary. Bull/bear themes should come from the MESSAGE CONTENT but must not contradict the label data. If bearish themes exist in content but 0% bear labels, note them as "concerns" not bearish sentiment.\n\nReturn ONLY this JSON, no other text:\n{"summary":"2 sentences reflecting the ' + sentLabel + ' label data and key message themes","bullThemes":["specific theme from messages"],"bearThemes":["concern or risk mentioned, NOT contradicting label data"],"catalysts":["specific event or catalyst mentioned"]}';

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

    if (!r.ok) return res.status(200).json(fallback);
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(200).json(fallback);
    const parsed = JSON.parse(match[0]);
    return res.status(200).json({ ...parsed, hasAI: true });
  } catch(e) {
    return res.status(200).json(fallback);
  }
}
