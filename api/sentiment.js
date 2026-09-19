// /api/sentiment.js — PulseStock Sentiment Engine
// Fetches StockTwits stream, calculates 4 signals, caches to Supabase

const SUPA_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const ANT_KEY  = process.env.ANTHROPIC_API_KEY;

async function fetchStockTwits(symbol, limit = 30) {
  const url = `https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json?limit=${limit}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'PulseStock/1.0' } });
  if (!r.ok) return null;
  return r.json();
}

function calcSentiment(messages) {
  // Weighted sentiment — likes + reshares as engagement weight
  let weightedSum = 0, totalWeight = 0;
  let bull = 0, bear = 0, neutral = 0;
  let tradeIntent = 0;
  const authorSet = new Set();
  const textSamples = [];

  for (const m of messages) {
    const eng = 1 + (m.likes?.total || 0) * 2 + (m.reshares?.reshared_count || 0) * 3;
    const sent = m.entities?.sentiment?.basic;
    authorSet.add(m.user?.username);
    if (textSamples.length < 20) textSamples.push(m.body);

    // Trade intent detection
    const body = (m.body || '').toLowerCase();
    if (/\b(bought|buying|selling|sold|calls|puts|position|entry|target|stop|long|short)\b/.test(body)) {
      tradeIntent++;
    }

    if (sent === 'Bullish') {
      bull++; weightedSum += eng; totalWeight += eng;
    } else if (sent === 'Bearish') {
      bear++; weightedSum -= eng; totalWeight += eng;
    } else {
      neutral++; totalWeight += eng * 0.3;
    }
  }

  const total = bull + bear + neutral || 1;
  // Blend: 60% raw percentage, 40% engagement-weighted score
  const rawPctScore = (bull - bear) / total; // -1 to +1
  const rawEngScore = totalWeight > 0 ? (weightedSum / totalWeight) : 0;
  const blended = rawPctScore * 0.6 + rawEngScore * 0.4;
  const sentimentScore = Math.round(50 + blended * 50);
  const conviction = Math.round((tradeIntent / total) * 100);

  return {
    score: Math.max(0, Math.min(100, sentimentScore)),
    bullPct: Math.round(bull / total * 100),
    bearPct: Math.round(bear / total * 100),
    neutralPct: Math.round(neutral / total * 100),
    totalMessages: messages.length,
    uniqueAuthors: authorSet.size,
    conviction: Math.min(100, conviction * 2),
    textSamples
  };
}

function calcAttention(current, baseline) {
  if (!baseline || baseline === 0) return 50;
  const velocity = current / baseline;
  if (velocity >= 5) return 100;
  if (velocity >= 3) return 90;
  if (velocity >= 2) return 75;
  if (velocity >= 1.5) return 60;
  if (velocity >= 0.5) return 40;
  return 20;
}

function calcMomentum(currentScore, previousScore) {
  if (previousScore === null || previousScore === undefined) return 0;
  return Math.round(currentScore - previousScore);
}

function detectManipulation(messages) {
  const total = messages.length || 1;
  const newAccounts = messages.filter(m => {
    const created = new Date(m.user?.created_at || Date.now());
    const daysSince = (Date.now() - created) / 86400000;
    return daysSince < 30;
  }).length;

  const lowFollowers = messages.filter(m => (m.user?.followers || 0) < 10).length;

  // Check for repeated phrases
  const bodies = messages.map(m => (m.body || '').toLowerCase().trim());
  const unique = new Set(bodies);
  const dupRatio = 1 - (unique.size / bodies.length);

  const newAcctRatio = newAccounts / total;
  const lowFollowRatio = lowFollowers / total;

  let risk = 0;
  if (newAcctRatio > 0.3) risk += 30;
  if (lowFollowRatio > 0.5) risk += 20;
  if (dupRatio > 0.2) risk += 30;

  return {
    risk: Math.min(100, risk),
    newAccountPct: Math.round(newAcctRatio * 100),
    dupMessagePct: Math.round(dupRatio * 100),
    flag: risk >= 40
  };
}

async function getAISummary(symbol, sentiment, textSamples) {
  // Rule-based fallback summary — always works
  const fallback = {
    summary: `${symbol} sentiment is ${sentiment.score >= 60 ? 'bullish' : sentiment.score <= 40 ? 'bearish' : 'mixed'} on StockTwits with ${sentiment.bullPct}% of tagged messages bullish and ${sentiment.bearPct}% bearish. ${sentiment.uniqueAuthors} unique authors contributed to this reading.`,
    bullThemes: sentiment.bullPct > 20 ? ['Price momentum', 'Community interest'] : [],
    bearThemes: sentiment.bearPct > 20 ? ['Caution', 'Profit taking'] : [],
    catalysts: []
  };

  if (!ANT_KEY || !textSamples.length) return fallback;
  try {
    const sample = textSamples.slice(0, 10).join('\n');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANT_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: `Analyze StockTwits sentiment for ${symbol}. Score: ${sentiment.score}/100 (${sentiment.bullPct}% bull, ${sentiment.bearPct}% bear). Sample messages:\n${sample}\n\nReturn ONLY valid JSON: {"summary":"2 sentences","bullThemes":["theme1","theme2"],"bearThemes":["theme1"],"catalysts":["catalyst1"]}` }]
      })
    });
    clearTimeout(timeout);
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return parsed.summary ? parsed : fallback;
  } catch(e) { return fallback; }
}

async function getCachedBaseline(symbol) {
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/sentiment_scores?symbol=eq.${symbol}&order=created_at.desc&limit=48&select=total_messages,score,created_at`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    return r.ok ? r.json() : [];
  } catch(e) { return []; }
}

async function saveScore(symbol, data) {
  try {
    await fetch(`${SUPA_URL}/rest/v1/sentiment_scores`, {
      method: 'POST',
      headers: {
        apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        symbol,
        score: data.score,
        bull_pct: data.bullPct,
        bear_pct: data.bearPct,
        neutral_pct: data.neutralPct,
        total_messages: data.totalMessages,
        unique_authors: data.uniqueAuthors,
        attention: data.attention,
        momentum: data.momentum,
        conviction: data.conviction,
        manipulation_risk: data.manipulation?.risk || 0,
        manipulation_flag: data.manipulation?.flag || false,
        bull_themes: data.aiSummary?.bullThemes || [],
        bear_themes: data.aiSummary?.bearThemes || [],
        catalysts: data.aiSummary?.catalysts || [],
        summary: data.aiSummary?.summary || '',
        created_at: new Date().toISOString()
      })
    });
  } catch(e) {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const symbol = (req.query.symbol || '').toUpperCase().trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  // Check cache — return if < 15 min old
  try {
    const cached = await fetch(`${SUPA_URL}/rest/v1/sentiment_scores?symbol=eq.${symbol}&order=created_at.desc&limit=1`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    const rows = await cached.json();
    if (rows?.[0]) {
      const age = Date.now() - new Date(rows[0].created_at).getTime();
      if (age < 15 * 60 * 1000) {
        const row = rows[0];
        // Normalize snake_case DB fields to camelCase for frontend
        return res.status(200).json({
          symbol: row.symbol,
          score: row.score,
          bullPct: row.bull_pct,
          bearPct: row.bear_pct,
          neutralPct: row.neutral_pct,
          totalMessages: row.total_messages,
          uniqueAuthors: row.unique_authors,
          attention: row.attention,
          momentum: row.momentum,
          conviction: row.conviction,
          manipulation: {
            risk: row.manipulation_risk,
            flag: row.manipulation_flag
          },
          aiSummary: row.summary ? {
            summary: row.summary,
            bullThemes: row.bull_themes || [],
            bearThemes: row.bear_themes || [],
            catalysts: row.catalysts || []
          } : null,
          cached: true,
          updatedAt: row.created_at
        });
      }
    }
  } catch(e) {}

  // Fetch fresh data
  const data = await fetchStockTwits(symbol);
  if (!data?.messages?.length) {
    return res.status(404).json({ error: `No StockTwits data for ${symbol}` });
  }

  const messages = data.messages;
  const sent = calcSentiment(messages);
  const manipulation = detectManipulation(messages);

  // Get baseline from history for attention/momentum
  const history = await getCachedBaseline(symbol);
  const baseline30d = history.length >= 10
    ? history.reduce((s, h) => s + (h.total_messages || 0), 0) / history.length
    : messages.length;
  const prev6hScore = history[0]?.score ?? null;

  const attention = calcAttention(messages.length, baseline30d);
  const momentum  = calcMomentum(sent.score, prev6hScore);

  // Rule-based summary — instant, no API call
  const aiSummary = {
    summary: `${symbol} sentiment is ${sent.score >= 60 ? 'bullish' : sent.score <= 40 ? 'bearish' : 'mixed'} on StockTwits. ${sent.bullPct}% bullish, ${sent.bearPct}% bearish across ${sent.totalMessages} recent messages from ${sent.uniqueAuthors} unique authors.`,
    bullThemes: sent.bullPct > sent.bearPct ? ['Price momentum', 'Community interest'] : [],
    bearThemes: sent.bearPct > sent.bullPct ? ['Caution', 'Selling pressure'] : [],
    catalysts: [],
    textSamples: sent.textSamples,
    hasAI: false
  };

  const result = {
    symbol,
    score: sent.score,
    bullPct: sent.bullPct,
    bearPct: sent.bearPct,
    neutralPct: sent.neutralPct,
    totalMessages: sent.totalMessages,
    uniqueAuthors: sent.uniqueAuthors,
    attention,
    momentum,
    conviction: sent.conviction,
    manipulation,
    aiSummary,
    cached: false,
    updatedAt: new Date().toISOString()
  };

  // Save to Supabase (don't await)
  saveScore(symbol, result);

  return res.status(200).json(result);
}
