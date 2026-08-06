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
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
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

function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) return text || '';
  const trimmed = text.slice(0, maxLength + 1);
  const lastSpace = trimmed.lastIndexOf(' ');
  const safeCut = lastSpace > maxLength * 0.65 ? trimmed.slice(0, lastSpace) : trimmed.slice(0, maxLength);
  return `${safeCut.trim()}...`;
}

function sanitizeGeneratedHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .trim();
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function getPriceLine(snapshot, id, label) {
  const item = snapshot.prices?.[id];
  if (!item) return `${label} data is currently unavailable`;
  return `${label} trades around ${formatUsd(item.usd)} with a ${formatPercent(item.usd_24h_change)} 24-hour move`;
}

function summarizeMarketTone(snapshot) {
  const btcChange = snapshot.prices?.bitcoin?.usd_24h_change;
  const ethChange = snapshot.prices?.ethereum?.usd_24h_change;
  const fearGreed = snapshot.fearGreed;

  if (fearGreed?.value_classification) {
    return `${fearGreed.value_classification.toLowerCase()} sentiment`;
  }
  if (Number.isFinite(btcChange) && Number.isFinite(ethChange)) {
    if (btcChange > 1 && ethChange > 1) return 'cautious recovery';
    if (btcChange < -1 && ethChange < -1) return 'risk-off caution';
  }
  return 'mixed trading conditions';
}

function pickHeadlineItems(items, limit = 4) {
  const seen = new Set();
  const selected = [];

  for (const item of items) {
    const title = cleanText(item.title);
    if (!title) continue;
    const key = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({
      title,
      description: cleanText(item.description)
    });
    if (selected.length >= limit) break;
  }

  while (selected.length < limit) {
    selected.push({
      title: ['Bitcoin Market Watch', 'Ethereum and Altcoins', 'Macro and Liquidity', 'Institutional Crypto Flows'][selected.length],
      description: 'Market participants continue to watch liquidity, ETF demand, macro signals, and regulatory headlines for the next clear move.'
    });
  }

  return selected;
}

function buildHeadlineSentence(item, snapshot, index) {
  const desc = item.description || 'The story adds another detail to the day\'s market picture.';
  const trimmed = truncateText(desc, 180);
  const openings = [
    'The detail worth noting is',
    'The practical takeaway is',
    'For market watchers, the important part is',
    'This matters because'
  ];
  const opening = openings[index % openings.length];
  return `${opening}: ${trimmed}`;
}

function findRegulatoryItems(items) {
  const regulatoryPattern = /\b(sec|cftc|regulat|congress|senate|court|lawsuit|mifid|mica|european union|eu |stablecoin|custody|compliance|policy|license|licence|treasury)\b/i;
  return items
    .filter(item => regulatoryPattern.test(`${item.title} ${item.description}`))
    .slice(0, 3);
}

function buildDeterministicUpdate(items, snapshot, currentDateStr) {
  const headlines = pickHeadlineItems(items);
  const global = snapshot.global || {};
  const fearGreed = snapshot.fearGreed;
  const regulatoryItems = findRegulatoryItems(items);
  const marketTone = summarizeMarketTone(snapshot);

  const headlineHtml = headlines.map((item, index) =>
    `-> <b>${escapeHtml(item.title)}:</b> ${escapeHtml(buildHeadlineSentence(item, snapshot, index))}<br>`
  ).join('\n');

  const marketOverview = [
    `As of ${currentDateStr}, the crypto market is showing ${marketTone}.`,
    `Total crypto market capitalization is ${formatUsd(global.marketCapUsd)}, while 24-hour trading volume is around ${formatUsd(global.volumeUsd)}.`,
    `${getPriceLine(snapshot, 'bitcoin', 'Bitcoin')}, and ${getPriceLine(snapshot, 'ethereum', 'Ethereum')}.`,
    `BTC dominance stands near ${formatPercent(global.btcDominance)}, keeping Bitcoin at the center of market direction even as major altcoins react to headline flow.`,
    `The latest news mix points to a market that is still data-sensitive: traders are watching ETF demand, exchange activity, macro liquidity, and regulatory developments before making a stronger directional call.`
  ].join(' ');

  const sentimentText = fearGreed
    ? `The Crypto Fear & Greed Index is at ${fearGreed.value} (${fearGreed.value_classification}), which suggests ${fearGreed.value_classification.toLowerCase()} is shaping short-term behavior.`
    : 'The Crypto Fear & Greed Index is unavailable for this run, so sentiment is inferred from price action and headline flow.';
  const marketSentiment = [
    sentimentText,
    `Bitcoin and Ethereum price changes suggest ${marketTone}, with traders balancing fresh headlines against broader liquidity conditions.`,
    `When dominance stays elevated, capital often remains concentrated in the largest assets instead of rotating aggressively into smaller altcoins.`,
    `That keeps the tone selective rather than broadly euphoric, and it makes sudden moves possible if macro data, ETF flows, or regulatory updates surprise the market.`
  ].join(' ');

  const regulatoryRoundup = regulatoryItems.length
    ? `Regulatory attention remains active in the latest news flow. ${regulatoryItems.map(item => {
        const description = cleanText(item.description || 'This item adds to the compliance and policy backdrop for digital assets.');
        const trimmed = truncateText(description, 220);
        return `${cleanText(item.title)}: ${trimmed}`;
      }).join(' ')} Overall, the tone remains constructive for long-term legitimacy but still important for traders to monitor because policy shifts can quickly affect liquidity, listings, custody, and institutional participation.`
    : 'No major fresh regulatory item appeared in the fetched headlines for this run. The broader regulatory tone remains focused on exchange compliance, custody standards, stablecoin oversight, token classification, and institutional market structure. That backdrop is generally constructive for long-term legitimacy, but it still creates friction for firms that must adapt to stricter licensing, disclosure, and consumer-protection expectations.';

  return `<b>Headlines:</b><br>
${headlineHtml}
<br>
<b>Market Overview:</b><br>
${escapeHtml(marketOverview)}

<br><br>
<b>Market Sentiment:</b><br>
${escapeHtml(marketSentiment)}

<br><br>
<b>Regulatory Roundup:</b><br>
${escapeHtml(regulatoryRoundup)}
<br><br>`;
}

// Core execution
async function main() {
  console.log('Starting Daily Crypto Bites update process...');

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
  let generatedHtml = buildDeterministicUpdate(aggregatedNews, marketSnapshot, currentDateStr);

  if (!generatedHtml) {
    console.error('ERROR: Generated empty daily update HTML.');
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
