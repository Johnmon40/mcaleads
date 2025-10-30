// api/search.js  (Node 18+)
const axios = require('axios');
const cheerio = require('cheerio');

const BING_KEY = process.env.BING_API_KEY || '';
const OPENCORP_KEY = process.env.OPENCORPORATES_KEY || '';

const BING_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search';

module.exports = async (req, res) => {
  const q = (req.query.q || '').trim();
  if(!q) return res.status(400).send({ error: 'Missing q' });

  try{
    // 1) Try Bing Web Search (fast & structured) if key provided
    let items = [];
    if(BING_KEY){
      const bresp = await axios.get(BING_ENDPOINT, {
        params: { q: `${q} "merchant cash advance" OR "seeking funding" OR "UCC-1"`, count: 10 },
        headers: { 'Ocp-Apim-Subscription-Key': BING_KEY },
        timeout: 15000
      });
      const webPages = bresp.data.webPages?.value || [];
      items = webPages.map(w => ({ title: w.name, url: w.url, snippet: w.snippet, source: 'bing' }));
    }

    // 2) Enrich with OpenCorporates (if looks like a company name)
    if(OPENCORP_KEY){
      // minimal OpenCorporates example: search companies by name
      const oc = await axios.get('https://api.opencorporates.com/v0.4/companies/search', {
        params: { q, api_token: OPENCORP_KEY, per_page: 5 }
      });
      if(oc.data && oc.data.results && oc.data.results.companies){
        for(const c of oc.data.results.companies){
          items.push({
            title: c.company?.company_name || 'Company',
            url: c.company?.opencorporates_url,
            snippet: `Company number: ${c.company?.company_number || 'N/A'} • Jurisdiction: ${c.company?.jurisdiction_code || ''}`,
            source: 'opencorporates'
          });
        }
      }
    }

    // 3) Small fallback: search Google via simple scrape of a site with permissive robots (for demo only)
    // WARNING: scraping Google/Bing search pages violates their ToS. Avoid in production.
    if(!items.length){
      const qstr = encodeURIComponent(`${q} "seeking funding" "merchant cash advance"`);
      const searchUrl = `https://html.duckduckgo.com/html?q=${qstr}`;
      const sresp = await axios.get(searchUrl, { timeout: 15000, headers: { 'User-Agent': 'LeadFinderBot/1.0 (+https://yourdomain.example)' } });
      const $ = cheerio.load(sresp.data);
      $('a.result__a').each((i, el)=>{
        if(i>=10) return;
        const url = $(el).attr('href');
        const title = $(el).text();
        const snippet = $(el).closest('.result').find('.result__snippet').text();
        items.push({ title, url, snippet, source: 'duckduckgo' });
      });
    }

    // Post-filter: keep unique urls and simple heuristics (contains 'fund', 'loan', 'UCC', 'merchant')
    const seen = new Set();
    const out = [];
    for(const it of items){
      if(!it.url) continue;
      const u = it.url.split('#')[0].split('?')[0];
      if(seen.has(u)) continue;
      seen.add(u);
      const text = ((it.title||'') + ' ' + (it.snippet||'')).toLowerCase();
      const keep = /fund|loan|merchant|advance|mca|ucc|seeking|apply/i.test(text);
      if(keep) out.push(it);
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send({ items: out.slice(0, 40) });

  }catch(err){
    console.error('search error', err?.message || err);
    return res.status(500).send({ error: 'search failed', details: err?.message || '' });
  }
};
