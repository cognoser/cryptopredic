const TAVILY_URL = 'https://api.tavily.com/search';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function searchWeb(queries) {
  if (!process.env.TAVILY_API_KEY) return [];
  const results = [];
  for (const query of queries) {
    try {
      const response = await fetch(TAVILY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          search_depth: 'basic',
          max_results: 5,
          include_answer: false,
          include_raw_content: false
        })
      });
      if (!response.ok) throw new Error(`Tavily returned ${response.status}: ${await response.text()}`);
      const data = await response.json();
      results.push(...(data.results || []).map(item => ({
        title: item.title || '',
        link: item.url || '',
        description: item.content || item.snippet || '',
        pubDate: item.published_date || '',
        source: 'Tavily web search'
      })));
    } catch (error) {
      console.warn(`Web research unavailable for "${query}": ${error.message}`);
    }
  }
  const seen = new Set();
  return results.filter(item => item.link && !seen.has(item.link) && seen.add(item.link));
}

function researchNotes(items, limit = 24) {
  return items.slice(0, limit).map((item, index) => [
    `${index + 1}. ${item.title}`,
    `Source: ${item.source || 'unknown'}`,
    `Published: ${item.pubDate || 'not supplied'}`,
    `URL: ${item.link || 'not supplied'}`,
    `Notes: ${item.description || 'No notes supplied.'}`
  ].join('\n')).join('\n\n');
}

async function generateWithGroq(prompt, options = {}) {
  if (!process.env.GROQ_API_KEY) return '';
  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      temperature: options.temperature ?? 0.55,
      max_tokens: options.maxTokens || 3500,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!response.ok) throw new Error(`Groq returned ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

module.exports = { generateWithGroq, researchNotes, searchWeb };
