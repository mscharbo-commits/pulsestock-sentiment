// /api/summary.js — AI summary endpoint called separately after main data loads
const ANT_KEY = process.env.ANTHROPIC_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, score, bullPct, bearPct, messages } = req.body || {};
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  if (!ANT_KEY) {
    return res.status(200).json({
      summary: `${symbol} has ${bullPct}% bullish and ${bearPct}% bearish sentiment on StockTwits.`,
      bullThemes: [], bearThemes: [], catalysts: [], hasAI: false
    });
  }

  try {
    const sample = (messages || []).slice(0, 12).join('\n');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANT_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: `You are analyzing StockTwits social sentiment for $${symbol}.

Sentiment score: ${score}/100 (${bullPct}% bullish, ${bearPct}% bearish)

Recent StockTwits messages:
${sample}

Return ONLY valid JSON with no other text:
{
  "summary": "2 concise sentences describing what the community is saying and the dominant theme",
  "bullThemes": ["up to 3 bullish themes mentioned"],
  "bearThemes": ["up to 2 bearish themes mentioned"],
  "catalysts": ["any specific events/catalysts mentioned like earnings, FDA, guidance, etc"]
}` }]
      })
    });

    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return res.status(200).json({ ...parsed, hasAI: true });
  } catch(e) {
    return res.status(200).json({
      summary: `${symbol} community shows ${score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'mixed'} sentiment at ${score}/100 with ${bullPct}% bullish messages.`,
      bullThemes: bullPct > bearPct ? ['Price action', 'Momentum'] : [],
      bearThemes: bearPct > bullPct ? ['Caution', 'Risk'] : [],
      catalysts: [],
      hasAI: false
    });
  }
}
