// api/search.js
// Node 18+ serverless handler suitable for Vercel/Netlify.
// Multi-source search, link fetch + UCC/funding extraction, robots-safe crawl.

const axios = require('axios');
const cheerio = require('cheerio');
const robotsParser = require('robots-parser');
const pLimit = require('p-limit');

const BING_KEY = process.env.BING_API_KEY || '';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID || '';

const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10);
const USER_AGENT = 'MCA-Lead-Finder/1.0 (+https://yourdomain.example)';

const limit = pLimit(MAX_CONCURRENCY);

function simpleTimeout(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callBing(query) {
  if(!BING_KEY) return [];
  try{
    const r = await axios.get('https://api.bing.microsoft.com/v7.0/search', {
      params: { q: query, count: 10 },
      headers: { 'Ocp-Apim-Subscription-Key': BING_KEY },
      timeout: 15000
    });
    return (r.data.webPages?.value || []).map(v => ({
      title: v.name, url: v.url, snippet: v.snippet, source: 'bing'
    }));
  }catch(e){
    console.warn('Bing error', e.message);
    return [];
  }
}

async function callSerpApi(query) {
  if(!SERPAPI_KEY) return [];
  try{
    const r = await axios.get('https://serpapi.com/search.json', {
      params: { q: query, api_key: SERPAPI_KEY, engine: 'google', num: 10 },
      timeout: 15000
    });
    const results = [];
    const serp = r.data;
    (serp.organic_results || []).forEach(o => results.push({
      title: o.title, url: o.link || o.url, snippet: o.snippet || o.snippet_highlighted, source: 'serpapi'
    }));
    return results;
  }catch(e){
    console.warn('SerpAPI error', e.message);
    return [];
  }
}

async function callGoogleCSE(query) {
  if(!GOOGLE_API_KEY || !GOOGLE_CSE_ID) return [];
  try{
    const r = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: { key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID, q: query, num: 10 },
      timeout: 15000
    });
    return (r.data.items || []).map(it => ({ title: it.title, url: it.link, snippet: it.snippet, source: 'google' }));
  }catch(e){
    console.warn('Google CSE error', e.message);
    return [];
  }
}

// Robots check helper
async function allowedToCrawl(url) {
  try{
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    const r = await axios.get(robotsUrl, { timeout: 8000, headers: { 'User-Agent': USER_AGENT } });
    const robots = robotsParser(robotsUrl, r.data);
    return robots.isAllowed(url, USER_AGENT);
  }catch(err){
    // If robots.txt not reachable, assume allowed but be conservative
    return true;
  }
}

// Fetch page and extract simple metadata + UCC/funding patterns
async function fetchAndExtract(item) {
  try{
    const url = item.url;
    if(!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return null;
    const ok = await allowedToCrawl(url);
    if(!ok) return null;

    const r = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': USER_AGENT } });
    const $ = cheerio.load(r.data);
    const title = $('title').first().text() || item.title || url;
    const text = $('body').text().replace(/\s+/g,' ').slice(0, 3000);
    const snippet = item.snippet || text.slice(0, 300);

    // Heuristics
    const lc = (title + ' ' + snippet + ' ' + text).toLowerCase();
    const tags = [];
    if(/ucc-1|ucc 1|financing statement|financing-statement|ucc filing|ucc filing/i.test(lc)) tags.push('UCC');
    if(/merchant cash advance|merchant-cash-advance|mca|seeking funding|seeking funding|need funding|apply for funding|apply for a loan|need a loan|apply for funding/i.test(lc)) tags.push('FUNDING');
    // revenue hints (weak)
    if(/\$[0-9]{1,3}k|\$[0-9]{3,},|\bannual revenue\b|\bmonthly revenue\b|\brevenue of\b|\bmonthly sales\b/i.test(lc)) tags.push('REVENUE_HINT');

    // extract any UCC-style numbers (very rough)
    const uccMatches = [];
    const uccRegex = /\bUCC[-\s]*1[:\s#]?\s*([A-Za-z0-9\-\/]{5,50})/ig;
    let m;
    while((m = uccRegex.exec(text)) !== null) uccMatches.push(m[1]);

    return {
      title: title.trim(),
      url,
      snippet: snippet.trim(),
      source: item.source || 'web',
      tags,
      uccMatches: uccMatches.slice(0,5)
    };
  }catch(err){
    // ignore fetch errors for individual pages
    console.warn('fetch error', item.url, err.message);
    return null;
  }
}


// Compose smart query templates
function buildQueries(q) {
  const base = q;
  return [
    `${base} "merchant cash advance" OR "MCA" OR "seeking funding"`,
    `${base} "UCC-1" OR "UCC 1" OR "financing statement"`,
    `site:.gov ${base} "UCC-1"`,
    `site:*.state.* ${base} "financing statement"`, // loose site attempt
    `${base} "seeking funding" "apply for funding"`,
    `"${base}" "seeking funding" OR "need funding"`,
  ];
}

module.exports = async (req, res) => {
  const q = (req.query.q || '').trim();
  if(!q) return res.status(400).json({ error: 'Missing q' });

  try{
    // 1) Build queries
    const queries = buildQueries(q);

    // 2) Query providers in parallel (but keep concurrency)
    const providerPromises = [];
    // We'll call each provider for each query but stop once we get a reasonable set
    let rawResults = [];

    for(const qq of queries){
      // try SerpAPI first if available (Google-like)
      if(SERPAPI_KEY) {
        const serpres = await callSerpApi(qq);
        rawResults = rawResults.concat(serpres);
      }
      // Bing
      if(BING_KEY) {
        const bing = await callBing(qq);
        rawResults = rawResults.concat(bing);
      }
      // Google CSE fallback
      if(GOOGLE_API_KEY && GOOGLE_CSE_ID) {
        const g = await callGoogleCSE(qq);
        rawResults = rawResults.concat(g);
      }
      // Small pause to avoid quick-fire rate limits
      await simpleTimeout(250);
      if(rawResults.length >= 30) break; // stop early if enough candidates
    }

    // fallback: if still no results, do a single DuckDuckGo HTML fetch (best-effort demo)
    if(rawResults.length === 0){
      try{
        const qstr = encodeURIComponent(`${q} "seeking funding" "merchant cash advance"`);
        const dd = await axios.get(`https://html.duckduckgo.com/html?q=${qstr}`, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
        const $ = cheerio.load(dd.data);
        $('a.result__a').each((i, el) => {
          if(i >= 10) return;
          const url = $(el).attr('href');
          const title = $(el).text();
          const snippet = $(el).closest('.result').find('.result__snippet').text();
          rawResults.push({ title, url, snippet, source: 'duckduckgo' });
        });
      }catch(e){ /* ignore */ }
    }

    // 3) dedupe rawResults by URL (simple)
    const seen = new Set();
    const unique = [];
    for(const r of rawResults){
      if(!r || !r.url) continue;
      const key = (r.url.split('#')[0].split('?')[0]).toLowerCase();
      if(seen.has(key)) continue;
      seen.add(key);
      unique.push(r);
      if(unique.length >= 60) break;
    }

    // 4) Fetch each candidate page (rate-limited) and extract UCC/funding hints
    const tasks = unique.map(item => limit(() => fetchAndExtract(item)));
    const extracted = (await Promise.all(tasks)).filter(Boolean);

    // 5) Prioritize items that have UCC or FUNDING tags
    extracted.sort((a,b) => {
      const score = (it) => (it.tags.includes('UCC') ? 100 : 0) + (it.tags.includes('FUNDING') ? 50 : 0) + (it.uccMatches?.length || 0)*10;
      return score(b) - score(a);
    });

    // Trim results
    const final = extracted.slice(0, 50);

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ query: q, items: final });
  }catch(err){
    console.error('search handler error', err?.message || err);
    return res.status(500).json({ error: 'search failed', details: err?.message || '' });
  }
};
