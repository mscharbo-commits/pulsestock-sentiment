// /api/batch.js — batch sentiment for multiple tickers
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const symbols = (req.query.symbols || '').toUpperCase().split(',').filter(Boolean).slice(0, 10);
  if (!symbols.length) return res.status(400).json({ error: 'symbols required' });

  const results = await Promise.all(symbols.map(async sym => {
    try {
      const r = await fetch(`${process.env.VERCEL_URL || 'https://pulsestock-sentiment.vercel.app'}/api/sentiment?symbol=${sym}`);
      return r.ok ? r.json() : { symbol: sym, error: 'failed' };
    } catch(e) { return { symbol: sym, error: e.message }; }
  }));

  return res.status(200).json(results);
}
