const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARTICLE_TEMPLATE = path.join(ROOT, 'todays-article.html');
const PROMPT_PATH = path.join(ROOT, 'prompts', 'daily-crypto-article.md');
const ARTICLES_DIR = path.join(ROOT, 'articles');
const MANIFEST_PATH = path.join(ARTICLES_DIR, 'index.json');
const { generateWithGroq, researchNotes: providerResearchNotes, searchWeb } = require('./ai-providers');

const FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://news.bitcoin.com/feed/',
  'https://cointelegraph.com/rss',
  'https://decrypt.co/feed',
  'https://www.theblock.co/rss.xml'
];

const MARKET_DATA_URLS = {
  global: 'https://api.coingecko.com/api/v3/global',
  prices: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin,ripple&vs_currencies=usd&include_24hr_change=true',
  fearGreed: 'https://api.alternative.me/fng/?limit=1'
};

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'TopCryptosNewsBot/1.0' } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function cleanText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getTag(item, tag) {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? cleanText(match[1]) : '';
}

function parseFeed(xml, source) {
  return (xml.match(/<item>[\s\S]*?<\/item>/gi) || []).map(item => ({
    title: getTag(item, 'title'),
    description: getTag(item, 'description'),
    link: getTag(item, 'link'),
    pubDate: getTag(item, 'pubDate'),
    source
  })).filter(item => item.title && item.link);
}

function deduplicate(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return 'unavailable';
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : 'unavailable';
}

async function fetchSnapshot() {
  const snapshot = {};
  try {
    const response = await fetchJson(MARKET_DATA_URLS.global);
    snapshot.global = response.data || {};
  } catch (error) {
    console.warn(`Market global data unavailable: ${error.message}`);
  }
  try {
    snapshot.prices = await fetchJson(MARKET_DATA_URLS.prices);
  } catch (error) {
    console.warn(`Market prices unavailable: ${error.message}`);
  }
  try {
    snapshot.fearGreed = (await fetchJson(MARKET_DATA_URLS.fearGreed)).data?.[0] || null;
  } catch (error) {
    console.warn(`Fear and Greed data unavailable: ${error.message}`);
  }
  return snapshot;
}

function snapshotText(snapshot) {
  const global = snapshot.global || {};
  const prices = snapshot.prices || {};
  const line = (id, label) => {
    const coin = prices[id];
    return coin ? `${label}: ${formatUsd(coin.usd)}, 24h change ${formatPercent(coin.usd_24h_change)}` : `${label}: unavailable`;
  };
  return [
    `Total market cap: ${formatUsd(global.total_market_cap?.usd)}`,
    `24-hour volume: ${formatUsd(global.total_volume?.usd)}`,
    `Bitcoin dominance: ${formatPercent(global.market_cap_percentage?.btc)}`,
    line('bitcoin', 'Bitcoin'), line('ethereum', 'Ethereum'), line('solana', 'Solana'),
    `Fear and Greed: ${snapshot.fearGreed ? `${snapshot.fearGreed.value} (${snapshot.fearGreed.value_classification})` : 'unavailable'}`
  ].join('\n');
}

function sourceNotes(items) {
  return items.slice(0, 16).map((item, index) => [
    `${index + 1}. ${item.title}`,
    `Source: ${item.source}`,
    `Published: ${item.pubDate || 'not supplied'}`,
    `URL: ${item.link}`,
    `Notes: ${item.description || 'No description supplied.'}`
  ].join('\n')).join('\n\n');
}

function cleanGeneratedFragment(fragment) {
  let html = String(fragment || '').replace(/```(?:html)?/gi, '').replace(/```/g, '').trim();
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  html = html.replace(/\son\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/<(?!\/?(?:h2|h3|p|ul|ol|li|strong|em)(?:\s[^>]*)?>)[^>]*>/gi, '');
  return html.trim();
}

function fallbackFragment(items, snapshot) {
  const top = items.slice(0, 6);
  const paragraphs = top.map(item => `<p><strong>${escapeHtml(item.title)}.</strong> ${escapeHtml(item.description || 'The report adds another detail to the day\'s market picture.')} Readers should check the original report before treating the headline as a confirmed change in the market.</p>`).join('\n');
  const prices = snapshot.prices || {};
  return `<p class="article-lead">The day\'s crypto news is a mixture of market positioning, fund flows, policy updates, and company decisions. The headlines below are worth reading for the detail behind them, not just the reaction on a price chart.</p>
    <section><h2>What is moving the conversation</h2>${paragraphs}</section>
    <section><h2>Market context</h2><p>Bitcoin is ${prices.bitcoin ? `around ${formatUsd(prices.bitcoin.usd)} with a ${formatPercent(prices.bitcoin.usd_24h_change)} 24-hour move` : 'being watched closely'}, while Ether is ${prices.ethereum ? `around ${formatUsd(prices.ethereum.usd)} with a ${formatPercent(prices.ethereum.usd_24h_change)} move` : 'also being watched closely'}. Those figures are a snapshot, not a forecast. The useful question is whether the move is supported by spot demand, volume, and a clear change in the news.</p><p>When the market is quiet, leverage and liquidity can matter as much as direction. A small headline can move price quickly when traders are positioned too closely on one side.</p></section>
    <section><h2>What to watch next</h2><ul class="article-watchlist"><li>New ETF creations and redemptions.</li><li>Futures open interest and funding rates.</li><li>Fresh regulatory text or official statements.</li><li>Security warnings, outages, or custody changes.</li><li>Whether the reported developments become live products rather than announcements.</li></ul></section>
    <p class="article-closing">The fairest reading today is cautious attention. There are real developments in the industry, but none should be stretched into a guaranteed market direction.</p>`;
}

async function generateWithGithubModel(prompt) {
  if (!process.env.GITHUB_TOKEN) return '';
  const configuredModel = process.env.ARTICLE_MODEL || 'openai/gpt-4.1-mini';
  const models = [...new Set([configuredModel, 'openai/gpt-4.1'])];
  let lastError = 'No model response.';
  for (const model of models) {
    const response = await fetch('https://models.github.ai/inference/chat/completions', {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0.65,
        max_tokens: 3500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (response.ok) {
      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    }
    lastError = `GitHub Models (${model}) returned ${response.status}: ${await response.text()}`;
    console.warn(lastError);
  }
  throw new Error(lastError);
}

function sourceList(items) {
  const uniqueItems = deduplicate(items);
  const selected = [];
  const hosts = new Set();
  const sourceName = item => {
    try { return new URL(item.link).hostname.replace(/^www\./i, ''); }
    catch { return item.source || 'source'; }
  };
  for (const item of uniqueItems) {
    const host = sourceName(item);
    if (!hosts.has(host)) {
      hosts.add(host);
      selected.push(item);
    }
    if (selected.length >= 10) break;
  }
  if (selected.length < 10) {
    for (const item of uniqueItems) {
      if (!selected.includes(item)) selected.push(item);
      if (selected.length >= 10) break;
    }
  }
  const links = selected.map(item => `<li><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a> <span class="source-name">(${escapeHtml(sourceName(item))})</span></li>`);
  return `<section class="article-sources"><h2>Sources and further reading</h2><ul>${links.join('')}</ul><p class="article-disclaimer">This article is for information and education. Crypto markets can move sharply, and nothing here is a recommendation to buy or sell an asset.</p></section>`;
}

function articleDocument(date, fragment, items, prefix) {
  const displayDate = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Today's Crypto Article - ${displayDate} | TopCryptosNews</title><meta name="description" content="A daily, source-linked roundup of major crypto market, regulation, adoption, and security developments."><link href="${prefix}tailwind.css" rel="stylesheet"><link href="${prefix}crypto-pages.css" rel="stylesheet"></head><body class="bg-gray-900 text-gray-100 min-h-screen flex flex-col"><header class="border-b border-gray-800 bg-gray-900 sticky top-0 z-50"><div class="crypto-shell py-3"><div class="site-header"><a href="${prefix}index.html" class="text-xl font-bold text-white site-brand">TopCryptosNews</a><nav class="site-nav" aria-label="Primary navigation"><a href="${prefix}cryptocurrencies.html">Cryptos</a><a href="${prefix}marketcap.html">Cryptos by Marketcap</a><a href="${prefix}todays-article.html">Today's article</a><a href="${prefix}candlesticks.html">Candlesticks</a><a href="${prefix}insights.html">Guides</a></nav><img src="${prefix}tcn.jpg" alt="TopCryptosNews" class="site-logo"></div></div></header><main class="article-shell flex-grow"><section class="article-intro"><div><p class="article-kicker">Daily crypto briefing</p><h1>Today's article</h1><p class="article-deck">A source-linked newsletter covering the market, regulation, adoption, security, and the stories moving crypto today.</p></div></section><article class="daily-article"><p class="article-byline">${displayDate} · Written for TopCryptosNews</p>${fragment}${sourceList(items)}</article></main><footer class="bg-gray-950 text-gray-400 text-center p-5 text-sm"><p><a href="${prefix}privacypolicy.html">Privacy Policy</a> | <a href="${prefix}terms.html">Terms of Use</a> | <a href="${prefix}contact.html">Contact</a> | <a href="${prefix}about.html">About Us</a></p><p class="mt-2">&copy; 2025 topcryptosnews.com. All rights reserved.</p></footer><script src="${prefix}theme.js"></script></body></html>`;
}

function getEdition() {
  if (process.env.ARTICLE_EDITION === 'morning' || process.env.ARTICLE_EDITION === 'evening') return process.env.ARTICLE_EDITION;
  return new Date().getUTCHours() < 9 ? 'morning' : 'evening';
}

function editionTitle(edition) {
  return edition === 'morning' ? 'Morning edition' : 'Evening edition';
}

function editionSections(editions) {
  return editions.map(edition => `<section class="article-edition"><p class="article-edition-label">${editionTitle(edition.edition)}</p><p class="article-byline">${edition.displayDate} Â· Written for TopCryptosNews</p>${edition.fragment}${sourceList(edition.items || [])}</section>`).join('\n');
}

function combinedArticleDocument(date, editions, prefix) {
  const displayDate = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Today's Crypto Article - ${displayDate} | TopCryptosNews</title><meta name="description" content="A daily, source-linked roundup of major crypto market, regulation, adoption, and security developments."><link href="${prefix}tailwind.css" rel="stylesheet"><link href="${prefix}crypto-pages.css" rel="stylesheet"></head><body class="bg-gray-900 text-gray-100 min-h-screen flex flex-col"><header class="border-b border-gray-800 bg-gray-900 sticky top-0 z-50"><div class="crypto-shell py-3"><div class="site-header"><a href="${prefix}index.html" class="text-xl font-bold text-white site-brand">TopCryptosNews</a><nav class="site-nav" aria-label="Primary navigation"><a href="${prefix}cryptocurrencies.html">Cryptos</a><a href="${prefix}marketcap.html">Cryptos by Marketcap</a><a href="${prefix}todays-article.html">Today's article</a><a href="${prefix}candlesticks.html">Candlesticks</a><a href="${prefix}insights.html">Guides</a></nav><img src="${prefix}tcn.jpg" alt="TopCryptosNews" class="site-logo"></div></div></header><main class="article-shell flex-grow"><section class="article-intro"><div><p class="article-kicker">Daily crypto briefing</p><h1>Today's article</h1><p class="article-deck">Two source-linked editions covering the market, regulation, adoption, security, and the stories moving crypto today.</p></div></section><article class="daily-article">${editionSections(editions)}</article></main><footer class="bg-gray-950 text-gray-400 text-center p-5 text-sm"><p><a href="${prefix}privacypolicy.html">Privacy Policy</a> | <a href="${prefix}terms.html">Terms of Use</a> | <a href="${prefix}contact.html">Contact</a> | <a href="${prefix}about.html">About Us</a></p><p class="mt-2">&copy; 2025 topcryptosnews.com. All rights reserved.</p></footer><script src="${prefix}theme.js"></script></body></html>`;
}

async function main() {
  fs.mkdirSync(ARTICLES_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const items = [];
  for (const feed of FEEDS) {
    try { items.push(...parseFeed(await fetchText(feed), new URL(feed).hostname)); }
    catch (error) { console.warn(`Feed unavailable: ${feed}: ${error.message}`); }
  }
  const uniqueItems = deduplicate(items);
  const webItems = await searchWeb([
    'latest crypto market news Bitcoin Ethereum ETF flows today',
    'crypto regulation stablecoins ETFs legal developments today',
    'crypto macro economy markets dollar rates geopolitics today',
    'site:x.com crypto market sentiment Bitcoin Ethereum today'
  ]);
  const researchItems = deduplicate([...uniqueItems, ...webItems]);
  const edition = getEdition();
  const snapshot = await fetchSnapshot();
  const promptTemplate = fs.readFileSync(PROMPT_PATH, 'utf8');
  const xSourceNotes = process.env.X_SOURCE_NOTES || 'No X/Twitter source notes were supplied for this run. Do not claim that social posts were searched.';
  const prompt = promptTemplate
    .replace('{{SOURCE_NOTES}}', providerResearchNotes(researchItems))
    .replace('{{X_SOURCE_NOTES}}', process.env.X_SOURCE_NOTES || providerResearchNotes(webItems.filter(item => /(?:x\.com|twitter\.com)/i.test(item.link))) || 'No X/Twitter source notes were supplied for this run. Do not claim that social posts were searched.')
    .replace('{{MARKET_SNAPSHOT}}', snapshotText(snapshot))
    .concat(`\n\nEdition focus: This is the ${edition} edition. The morning edition should emphasize overnight developments and the Asia/Europe handoff; the evening edition should incorporate Europe/U.S. developments and explain what changed since the morning edition.`);
  if (process.env.PREPARE_AI_PROMPT === 'true') {
    const promptPath = process.env.AI_PROMPT_PATH || path.join(ROOT, '.tmp', 'article-prompt.txt');
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, prompt, 'utf8');
    console.log(`Prepared article prompt: ${promptPath}`);
    return;
  }
  let fragment = '';
  if (process.env.MODEL_RESPONSE_FILE && fs.existsSync(process.env.MODEL_RESPONSE_FILE)) {
    fragment = cleanGeneratedFragment(fs.readFileSync(process.env.MODEL_RESPONSE_FILE, 'utf8'));
  } else if (process.env.GROQ_API_KEY) {
    try { fragment = cleanGeneratedFragment(await generateWithGroq(prompt, { maxTokens: 3500 })); }
    catch (error) { console.warn(`Groq generation unavailable; using source-based fallback: ${error.message}`); }
  } else if (process.env.USE_GITHUB_MODELS === 'true') {
    try { fragment = cleanGeneratedFragment(await generateWithGithubModel(prompt)); }
    catch (error) { console.warn(`Model generation unavailable; using source-based fallback: ${error.message}`); }
  } else {
    console.log('GitHub Models disabled for scheduled publishing; using source-based fallback.');
  }
  if (fragment.length < 1200) fragment = fallbackFragment(uniqueItems, snapshot);

  const displayDate = new Date(`${today}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const editionData = { date: today, edition, displayDate, fragment, items: researchItems };
  fs.writeFileSync(path.join(ARTICLES_DIR, `${today}-${edition}.json`), `${JSON.stringify(editionData, null, 2)}\n`, 'utf8');
  const existingDates = fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) : [];
  const dates = [...new Set([today, ...existingDates])].sort().reverse().slice(0, 365);
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(dates, null, 2)}\n`, 'utf8');

  const editions = ['morning', 'evening']
    .map(name => path.join(ARTICLES_DIR, `${today}-${name}.json`))
    .filter(file => fs.existsSync(file))
    .map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  const archivePath = path.join(ARTICLES_DIR, `${today}.html`);
  fs.writeFileSync(archivePath, combinedArticleDocument(today, editions, '../'), 'utf8');

  let page = fs.readFileSync(ARTICLE_TEMPLATE, 'utf8');
  page = page.replace(/data-article-date="[^"]+"/, `data-article-date="${today}"`)
    .replace(/<title>Today's Crypto Article - [^|]+\|/, `<title>Today's Crypto Article - ${displayDate} |`)
    .replace(/<input id="articleDate"[^>]*>/, `<input id="articleDate" type="date" value="${today}" min="${dates[dates.length - 1]}" max="${today}" aria-label="Choose an article date" />`)
    .replace(/<!-- DAILY_ARTICLE_START -->[\s\S]*?<!-- DAILY_ARTICLE_END -->/, `<!-- DAILY_ARTICLE_START -->\n    <article class="daily-article"><p class="article-byline">${displayDate} · Written for TopCryptosNews</p>${fragment}${sourceList(uniqueItems)}</article>\n    <!-- DAILY_ARTICLE_END -->`);
  page = page.replace(/<!-- DAILY_ARTICLE_START -->[\s\S]*?<!-- DAILY_ARTICLE_END -->/, `<!-- DAILY_ARTICLE_START -->\n    <article class="daily-article">${editionSections(editions)}\n    </article>\n    <!-- DAILY_ARTICLE_END -->`);
  fs.writeFileSync(ARTICLE_TEMPLATE, page, 'utf8');
  console.log(`Published ${today}: ${archivePath}`);
}

main().catch(error => { console.error(error); process.exit(1); });
