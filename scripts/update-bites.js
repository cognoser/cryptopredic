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

// Helper to fetch content from URL (HTTP/HTTPS) using native fetch (Node 18+)
async function fetchUrl(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: Status ${response.status}`);
  }
  return response.text();
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

// Simple XML RSS Parser using Regex (zero-dependency)
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

// Fetch prices from Binance
async function fetchCryptoPrices() {
  try {
    const url = 'https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22,%22XRPUSDT%22,%22BNBUSDT%22,%22SOLUSDT%22%5D';
    const rawData = await fetchUrl(url);
    const parsed = JSON.parse(rawData);
    if (!Array.isArray(parsed)) return [];
    
    const nameMap = {
      'BTCUSDT': { name: 'Bitcoin', symbol: 'BTC' },
      'ETHUSDT': { name: 'Ethereum', symbol: 'ETH' },
      'BNBUSDT': { name: 'Binance Coin', symbol: 'BNB' },
      'XRPUSDT': { name: 'Ripple', symbol: 'XRP' },
      'SOLUSDT': { name: 'Solana', symbol: 'SOL' }
    };
    
    return parsed.map(coin => {
      const info = nameMap[coin.symbol] || { name: coin.symbol, symbol: coin.symbol.replace('USDT', '') };
      return {
        name: info.name,
        symbol: info.symbol,
        price: parseFloat(coin.lastPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        change: parseFloat(coin.priceChangePercent).toFixed(2)
      };
    });
  } catch (error) {
    console.error('Error fetching crypto prices:', error.message);
    return [];
  }
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

  // 2. Fetch current prices
  console.log('Fetching live crypto prices...');
  const prices = await fetchCryptoPrices();
  console.log(`Fetched prices for ${prices.length} assets.`);

  // 3. Format context for Gemini
  const currentDateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  }) + ' (UTC)';

  const pricesContext = prices.map(p => `${p.name} (${p.symbol}): $${p.price} (${p.change}% last 24h)`).join('\n');
  const newsContext = aggregatedNews.map((n, idx) => `Article ${idx+1}:\nTitle: ${n.title}\nDescription: ${n.description}`).join('\n\n');

  console.log('Formulating prompt for Google Gemini...');
  const prompt = `
Context Date: ${currentDateStr}

Live Crypto Prices:
${pricesContext}

Recent News Stories:
${newsContext}

Generate the daily update HTML content. Follow these exact instructions:
- Output should start directly with the Headlines. Do NOT wrap in markdown code blocks like \`\`\`html.
- Output ONLY the HTML content.
- Do NOT output any preamble, markdown formatting, or postamble.
- Format strictly as follows:
  <b>Headlines:</b><br>
  -> <b>[Headline Topic 1]:</b> [1-2 sentences of professional context summarizing the news].<br>
  -> <b>[Headline Topic 2]:</b> [1-2 sentences of professional context summarizing the news].<br>
  -> <b>[Headline Topic 3]:</b> [1-2 sentences of professional context summarizing the news].<br>
  -> <b>[Headline Topic 4]:</b> [1-2 sentences of professional context summarizing the news].<br>
  <br><br>
  <b>Market Overview:</b><br>
  [Write a paragraph summarizing the current market conditions, referencing the live prices above. Format as a single paragraph without any subheaders].
  <br><br>
  <b>Market Sentiment:</b><br>
  [Write a paragraph summarizing current market sentiment based on recent news stories. Mention if fear, greed, caution, or optimism is dominating. Format as a single paragraph].
  <br><br>
  <b>Regulatory Roundup:</b><br>
  [Write a paragraph summarizing any regulatory mentions or the general regulatory tone in the news. If none, write about general regulatory status of crypto. Format as a single paragraph].
  <br><br>
  Check charts powered by Trading view for quick glance. Also do not forget to try the predictor/analyzer tool 📊 which analyze candle stick pattern to predict price movement🚦<br><br>
`;

  // 4. Send request to Gemini API
  // Using gemini-1.5-flash for reliability and speed
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
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

  let generatedHtml = '';
  if (process.env.MOCK === 'true') {
    console.log('MOCK MODE ENABLED: Generating mock update HTML...');
    const btcPrice = prices.find(p => p.symbol === 'BTC')?.price || '64,800';
    const ethPrice = prices.find(p => p.symbol === 'ETH')?.price || '1,760';
    const firstHeadline = aggregatedNews[0]?.title || 'Market Consolidation Continues';
    generatedHtml = `<b>Headlines:</b><br>
  -> <b>Bitcoin Holds Steady:</b> BTC is currently trading near $${btcPrice} amid mixed spot ETF flow signals.<br>
  -> <b>Ethereum Strength:</b> ETH shows stability around $${ethPrice} with positive on-chain activity.<br>
  -> <b>Solana Leads Recovery:</b> SOL shows strong relative performance following network upgrades.<br>
  -> <b>Latest Market Digest:</b> ${firstHeadline}.<br>
  <br><br>
  <b>Market Overview:</b><br>
  As of ${currentDateStr}, the crypto market shows modest consolidation. Bitcoin is trading near $${btcPrice} and Ethereum is hovering around $${ethPrice}. The overall volume remains healthy with selective rotation into top-tier altcoins.
  <br><br>
  <b>Market Sentiment:</b><br>
  Market sentiment is currently cautious to neutral. Traders are closely watching ETF volumes and macroeconomic updates. There is selective optimism surrounding layer-2 scalability and DeFi ecosystems.
  <br><br>
  <b>Regulatory Roundup:</b><br>
  Regulatory discussions remain focused on stablecoin frameworks and clarity for digital commodities. Major jurisdictions are actively working on standardizing compliance rules for digital assets.
  <br><br>
  Check charts powered by Trading view for quick glance. Also do not forget to try the predictor/analyzer tool 📊 which analyze candle stick pattern to predict price movement🚦<br><br>`;
  } else {
    console.log('Sending request to Gemini API...');
    try {
      const rawResponse = await fetchUrl(geminiUrl, {
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
      } else {
        throw new Error(`Unexpected API response structure: ${JSON.stringify(responseJson)}`);
      }
    } catch (apiErr) {
      console.error('Error calling Gemini API:', apiErr.message);
      process.exit(1);
    }
  }

  // Double check that we didn't get a markdown wrapped block
  if (generatedHtml.startsWith('```html')) {
    generatedHtml = generatedHtml.replace(/^```html\s*/, '').replace(/\s*```$/, '');
  } else if (generatedHtml.startsWith('```')) {
    generatedHtml = generatedHtml.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  if (!generatedHtml) {
    console.error('ERROR: Received empty text from Gemini.');
    process.exit(1);
  }

  // 5. Read index.html and replace placeholders
  console.log(`Reading index.html from: ${INDEX_HTML_PATH}`);
  let indexContent = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  // Verify daily update placeholders exist
  if (!indexContent.includes('<!-- DAILY_UPDATE_START -->') || !indexContent.includes('<!-- DAILY_UPDATE_END -->')) {
    console.error('ERROR: Could not find DAILY_UPDATE placeholders in index.html.');
    process.exit(1);
  }

  // Verify timestamp placeholders exist
  if (!indexContent.includes('<!-- TIMESTAMP_START -->') || !indexContent.includes('<!-- TIMESTAMP_END -->')) {
    console.error('ERROR: Could not find TIMESTAMP placeholders in index.html.');
    process.exit(1);
  }

  // Replace bites content
  const bitesReplacement = `<!-- DAILY_UPDATE_START -->\n            ${generatedHtml}\n            <!-- DAILY_UPDATE_END -->`;
  indexContent = indexContent.replace(
    /<!-- DAILY_UPDATE_START -->[\s\S]*?<!-- DAILY_UPDATE_END -->/,
    bitesReplacement
  );

  // Replace timestamp
  const dateFormatted = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC'
  }) + ' UTC';
  
  const timestampReplacement = `<!-- TIMESTAMP_START -->Last Updated: ${dateFormatted}<!-- TIMESTAMP_END -->`;
  indexContent = indexContent.replace(
    /<!-- TIMESTAMP_START -->[\s\S]*?<!-- TIMESTAMP_END -->/,
    timestampReplacement
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
