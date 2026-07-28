const fs = require('fs');
const path = require('path');

// Target file
const INDEX_HTML_PATH = path.join(__dirname, '..', 'index.html');

// RSS Feeds to fetch news from
const FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://news.bitcoin.com/feed/',
  'https://cointelegraph.com/rss'
];

const MARKET_DATA_URLS = {
  global: 'https://api.coingecko.com/api/v3/global',
  prices: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin,ripple&vs_currencies=usd&include_24hr_change=true',
  fearGreed: 'https://api.alternative.me/fng/?limit=1'
};

// Helper to fetch content from URL (HTTP/HTTPS) using native fetch
async function fetchUrl(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Response body: ${errorBody}`);
    throw new Error(`Failed to fetch ${url}: Status ${response.status}`);
  }
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchUrl(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'TopCryptosNewsBot/1.0'
    }
  }));
}

// Clean helper to strip HTML tags and CDATA wrappers
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function formatUsd(value, digits = 2) {
  if (!Number.isFinite(value)) return 'unavailable';
  if (value >= 1e12) return `$${(value / 1e12).toFixed(digits)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(digits)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(digits)}M`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: digits })}`;
}

function formatPercent(value, digits = 2) {
  if (!Number.isFinite(value)) return 'unavailable';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function sanitizeGeneratedHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .trim();
}

// Simple XML RSS Parser using Regex
function parseRSS(xmlText, maxItems = 4) {
  const items = [];
  const itemMatches = xmlText.match(/<item>[\s\S]*?<\/item>/gi) || [];
  
  for (const item of itemMatches) {
    if (items.length >= maxItems) break;
    
    const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/i);
    const descMatch = item.match(/<description>([\s\S]*?)<\/description>/i);
    
    if (titleMatch) {
      const title = cleanText(titleMatch[1]);
      const description = descMatch ? cleanText(descMatch[1]) : '';
      items.push({ title, description });
    }
  }
  return items;
}

async function fetchMarketSnapshot() {
  const snapshot = {
    generatedAt: new Date().toISOString(),
    global: null,
    prices: null,
    fearGreed: null
  };

  try {
    const global = await fetchJson(MARKET_DATA_URLS.global);
    const data = global.data || {};
    snapshot.global = {
      marketCapUsd: data.total_market_cap?.usd,
      volumeUsd: data.total_volume?.usd,
      btcDominance: data.market_cap_percentage?.btc,
      ethDominance: data.market_cap_percentage?.eth,
      activeCryptocurrencies: data.active_cryptocurrencies,
      markets: data.markets
    };
  } catch (err) {
    console.warn('Warning: Failed to fetch CoinGecko global market data:', err.message);
  }

  try {
    snapshot.prices = await fetchJson(MARKET_DATA_URLS.prices);
  } catch (err) {
    console.warn('Warning: Failed to fetch CoinGecko price data:', err.message);
  }

  try {
    const fearGreed = await fetchJson(MARKET_DATA_URLS.fearGreed);
    snapshot.fearGreed = fearGreed.data?.[0] || null;
  } catch (err) {
    console.warn('Warning: Failed to fetch Fear & Greed data:', err.message);
  }

  return snapshot;
}

function buildMarketContext(snapshot) {
  const lines = [];

  if (snapshot.global) {
    lines.push(`Total market cap: ${formatUsd(snapshot.global.marketCapUsd)}`);
    lines.push(`24h market volume: ${formatUsd(snapshot.global.volumeUsd)}`);
    lines.push(`BTC dominance: ${formatPercent(snapshot.global.btcDominance)}`);
    lines.push(`ETH dominance: ${formatPercent(snapshot.global.ethDominance)}`);
    lines.push(`Tracked crypto assets: ${snapshot.global.activeCryptocurrencies || 'unavailable'}`);
    lines.push(`Tracked markets: ${snapshot.global.markets || 'unavailable'}`);
  }

  if (snapshot.prices) {
    const labels = {
      bitcoin: 'BTC',
      ethereum: 'ETH',
      solana: 'SOL',
      binancecoin: 'BNB',
      ripple: 'XRP'
    };
    for (const [id, label] of Object.entries(labels)) {
      const item = snapshot.prices[id];
      if (!item) continue;
      lines.push(`${label}: ${formatUsd(item.usd)} (${formatPercent(item.usd_24h_change)} 24h)`);
    }
  }

  if (snapshot.fearGreed) {
    lines.push(`Crypto Fear & Greed Index: ${snapshot.fearGreed.value} (${snapshot.fearGreed.value_classification})`);
  }

  return lines.length ? lines.join('\n') : 'Market data unavailable. Use only the RSS news context and avoid precise unsupported numbers.';
}

// Core execution
async function main() {
  console.log('Starting Daily Crypto Bites update process...');

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && process.env.MOCK !== 'true') {
    console.error('CRITICAL ERROR: GEMINI_API_KEY environment variable is not set (and MOCK mode is not enabled).');
    process.exit(1);
  }

  // 1. Fetch news articles from RSS feeds
  const aggregatedNews = [];
  for (const feed of FEEDS) {
    try {
      console.log(`Fetching feed: ${feed}`);
      const xml = await fetchUrl(feed);
      const items = parseRSS(xml, 4);
      console.log(`Parsed ${items.length} items from feed.`);
      aggregatedNews.push(...items);
    } catch (err) {
      console.warn(`Warning: Failed to fetch feed ${feed}:`, err.message);
    }
  }

  const currentDateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  }) + ' (UTC)';

  const marketSnapshot = await fetchMarketSnapshot();
  const marketContext = buildMarketContext(marketSnapshot);
  const newsContext = aggregatedNews.map((n, idx) => `Article ${idx+1}:\nTitle: ${n.title}\nDescription: ${n.description}`).join('\n\n');

  console.log('Formulating prompt for Google Gemini...');
  const prompt = `
Context Date: ${currentDateStr}

Recent News Stories:
${newsContext}

Live Market Snapshot:
${marketContext}

Generate the daily update HTML content. Follow these exact instructions:
- Output should start directly with the Headlines. Do NOT wrap in markdown code blocks like \`\`\`html.
- Output ONLY the HTML content.
- Do NOT output any preamble, markdown formatting, or postamble.
- Use the live market snapshot when it is available. Do not invent specific prices, ETF flow numbers, legal bill names, or dates that are not supported by the provided context.
- Write in a professional market-news style similar to CoinDesk/CoinTelegraph summaries.
- Format strictly as follows:
  <b>Headlines:</b><br>
  -> <b>[Specific headline 1]:</b> [One detailed sentence tying the headline to market impact].<br>
  -> <b>[Specific headline 2]:</b> [One detailed sentence tying the headline to market impact].<br>
  -> <b>[Specific headline 3]:</b> [One detailed sentence tying the headline to market impact].<br>
  -> <b>[Specific headline 4]:</b> [One detailed sentence tying the headline to market impact].<br>
  <br>
  <b>Market Overview:</b><br>
  [Write one substantial paragraph of 120-170 words. Include total market cap, 24h volume, BTC/ETH prices or 24h changes, BTC dominance, and the broader risk tone when available. Make it readable and avoid bullet points.]
  <br><br>
  <b>Market Sentiment:</b><br>
  [Write one substantial paragraph of 90-140 words. Include Fear & Greed classification/value when available, BTC support/resistance only if supported by news context, and explain whether traders appear fearful, cautious, optimistic, or risk-on.]
  <br><br>
  <b>Regulatory Roundup:</b><br>
  [Write one substantial paragraph of 90-140 words. Summarize regulatory items from the RSS context. If no specific regulatory news appears, say that no major fresh regulatory item was present in the fetched headlines and briefly describe the general compliance tone.]
`;

  let generatedHtml = '';
  if (process.env.MOCK === 'true') {
    console.log('MOCK MODE ENABLED: Generating mock update HTML...');
    const firstHeadline = aggregatedNews[0]?.title || 'Market Consolidation Continues';
    generatedHtml = `<b>Headlines:</b><br>
  -> <b>Bitcoin Stable:</b> BTC continues to show strength as institutional accumulation and spot ETF inflows steady the market.<br>
  -> <b>Layer-2 Scalability:</b> Major Ethereum Layer-2 protocols report significant volume increases and protocol enhancements.<br>
  -> <b>Market Indicators:</b> Analysts watch key technical patterns as the overall market undergoes healthy consolidation.<br>
  -> <b>Latest Market Digest:</b> ${firstHeadline}.<br>
  <br><br>
  <b>Market Overview:</b><br>
  As of ${currentDateStr}, the crypto market shows stability and consolidation. Top-tier altcoins are undergoing healthy corrections, and trading volumes remain elevated across major global exchanges.
  <br><br>
  <b>Market Sentiment:</b><br>
  Market sentiment is currently cautious but constructive. Long-term indicators suggest strong institutional backing, and market participants are showing a balanced approach towards macro announcements.
  <br><br>
  <b>Regulatory Roundup:</b><br>
  Regulatory updates remain centered around compliance, stablecoin frameworks, and institutional participation. Evolving regulatory standards are helping shape a more robust market landscape.
  <br><br>`;
  } else {
    const payload = {
      contents: [
        {
          parts: [
            { text: prompt }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.25
      }
    };

    // We will try different endpoints/models to be extremely resilient
    const attempts = [
      {
        url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        label: 'v1beta/gemini-2.5-flash'
      },
      {
        url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        label: 'v1beta/gemini-2.0-flash'
      },
      {
        url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,
        label: 'v1beta/gemini-2.0-flash-lite'
      }
    ];

    let lastError = null;
    for (const attempt of attempts) {
      try {
        console.log(`Trying Gemini API endpoint: ${attempt.label}...`);
        const rawResponse = await fetchUrl(attempt.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
        
        const responseJson = JSON.parse(rawResponse);
        if (
          responseJson.candidates &&
          responseJson.candidates[0] &&
          responseJson.candidates[0].content &&
          responseJson.candidates[0].content.parts &&
          responseJson.candidates[0].content.parts[0]
        ) {
          generatedHtml = responseJson.candidates[0].content.parts[0].text.trim();
          console.log(`Success using endpoint: ${attempt.label}!`);
          break; // successfully generated
        } else {
          throw new Error(`Unexpected API response structure: ${JSON.stringify(responseJson)}`);
        }
      } catch (err) {
        console.warn(`Attempt with ${attempt.label} failed:`, err.message);
        lastError = err;
      }
    }

    if (!generatedHtml) {
      console.error('\n================================================================');
      console.error('CRITICAL ERROR: All Gemini API endpoints failed.');
      console.error('Last error:', lastError ? lastError.message : 'No error message');
      console.error('\nPOSSIBLE RESOLUTIONS:');
      console.error('1. Check if the "Generative Language API" is enabled in your Google Cloud Project.');
      console.error('2. Ensure your API Key was created from Google AI Studio (https://aistudio.google.com/). API keys created from GCP console directly must have the "Generative Language API" explicitly enabled in the APIs Library.');
      console.error('3. Verify that the GEMINI_API_KEY secret on GitHub has no leading/trailing spaces or quotes.');
      console.error('================================================================\n');
      process.exit(1);
    }
  }

  // Clean markdown wrap if any
  if (generatedHtml.startsWith('```html')) {
    generatedHtml = generatedHtml.replace(/^```html\s*/, '').replace(/\s*```$/, '');
  } else if (generatedHtml.startsWith('```')) {
    generatedHtml = generatedHtml.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  if (!generatedHtml) {
    console.error('ERROR: Received empty text from Gemini.');
    process.exit(1);
  }

  generatedHtml = sanitizeGeneratedHtml(generatedHtml);
  if (!generatedHtml) {
    console.error('ERROR: Generated HTML was empty after sanitization.');
    process.exit(1);
  }

  // Read index.html and replace placeholders
  console.log(`Reading index.html from: ${INDEX_HTML_PATH}`);
  let indexContent = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  // Verify daily update placeholders exist
  if (!indexContent.includes('<!-- DAILY_UPDATE_START -->') || !indexContent.includes('<!-- DAILY_UPDATE_END -->')) {
    console.error('ERROR: Could not find DAILY_UPDATE placeholders in index.html.');
    process.exit(1);
  }

  // Replace bites content
  const bitesReplacement = `<!-- DAILY_UPDATE_START -->\n            ${generatedHtml}\n            <!-- DAILY_UPDATE_END -->`;
  indexContent = indexContent.replace(
    /<!-- DAILY_UPDATE_START -->[\s\S]*?<!-- DAILY_UPDATE_END -->/,
    bitesReplacement
  );

  // Write changes back to index.html
  console.log('Writing updated index.html...');
  fs.writeFileSync(INDEX_HTML_PATH, indexContent, 'utf8');
  console.log('SUCCESS: Website successfully updated!');
}

main().catch(err => {
  console.error('Unhandled process exception:', err);
  process.exit(1);
});
