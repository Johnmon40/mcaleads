// api/leads.js
// Node 18+ (Vercel). Aggregates RSS feeds, enriches via OpenCorporates (optional),
// finds email via Hunter (optional) or mailto:, finds phone via tel: on company site.
// Configure FEED_URLS env var as comma-separated list. Default includes Delaware.

import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import cheerio from 'cheerio';
import robotsParser from 'robots-parser';
import pLimit from 'p-limit';

const USER_AGENT = 'UCC-Lead-Aggregator/1.0 (+https://yourdomain.example)';
const OPENCORP_KEY = process.env.OPENCORPORATES_KEY || '';
const HUNTER_KEY = process.env.HUNTER_KEY || '';
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '6', 10);

// Default feed URLs (start with Delaware). Add more feed URLs through FEED_URLS env var.
const DEFAULT_FEEDS = [
  'https://icis.corp.delaware.gov/Ecorp/UCC/UCC.rss'
];

function uniqBy(arr, keyFn){
  const seen = new Set();
  const out = [];
  for(const a of arr){
    const k = keyFn(a);
    if(seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

async function fetchFeed(url){
  try{
    const r = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': USER_AGENT } });
    const xml = r.data;
    const parsed = await parseStringPromise(xml);
    const items = [];
    const channel = parsed.rss?.channel?.[0] || parsed.feed || {};
    const rssItems = parsed.rss?.channel?.[0]?.item || parsed.feed?.entry || [];
    for(const it of rssItems){
      const title = (it.title && it.title[0]) || (it['title'] && it['title'][0]) || '';
      const link = (it.link && (it.link[0]?._) || it.link && it.link[0]) || (it.link && it.link[0]?.href) || '';
      const desc = (it.description && it.description[0]) || (it.summary && it.summary[0]) || '';
      items.push({ title: title.toString(), link: link.toString(), snippet: desc.toString(), feed: url });
    }
    return items;
  }catch(e){
    console.warn('feed fetch failed', url, e.message);
    return [];
  }
}

async function allowedToCrawl(url){
  try{
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    const r = await axios.get(robotsUrl, { timeout: 8000, headers: { 'User-Agent': USER_AGENT } });
    const robots = robotsParser(robotsUrl, r.data);
    return robots.isAllowed(url, USER_AGENT);
  }catch(e){
    // if robots unreadable, be conservative and allow (so we can attempt limited fetch); change to false if you prefer stronger conservatism
    return true;
  }
}

// Try to extract a domain from the link for enrichment
function domainFromUrl(u){
  try{ return (new URL(u)).hostname.replace(/^www\./,''); }catch(e){ return null; }
}

// Try Hunter email lookup (domain search) - optional and free-tier limited
async function hunterEmailForDomain(domain){
  if(!HUNTER_KEY || !domain) return null;
  try{
    const r = await axios.get('https://api.hunter.io/v2/domain-search', { params: { domain, api_key: HUNTER_KEY, limit: 5 } , timeout:12000 });
    const data = r.data?.data;
    if(!data) return null;
    const emails = (data.emails || []).map(e => e.value).filter(Boolean);
    return emails.length ? emails[0] : null;
  }catch(e){
    console.warn('hunter error', e.message);
    return null;
  }
}

// Fetch page and look for mailto: and tel:
async function fetchContactFromPage(url){
  try{
    if(!await allowedToCrawl(url)) return { email:null, phone:null };
    const r = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': USER_AGENT } });
    const $ = cheerio.load(r.data);
    // mailto:
    const mailto = $("a[href^='mailto:']").first().attr('href');
    const email = mailto ? mailto.replace(/^mailto:/i,'').split('?')[0] : null;
    // tel:
    const tel = $("a[href^='tel:']").first().attr('href');
    const phone = tel ? tel.replace(/^tel:/i,'') : null;
    return { email, phone };
  }catch(e){
    console.warn('page contact fetch failed', url, e.message);
    return { email:null, phone:null };
  }
}

// Optional: OpenCorporates lookup to get company name or website
async function openCorpLookup(name){
  if(!OPENCORP_KEY || !name) return null;
  try{
    const r = await axios.get('https://api.opencorporates.com/v0.4/companies/search', { params: { q: name, api_token: OPENCORP_KEY, per_page: 5 }, timeout:12000 });
    const companies = r.data?.results?.companies || [];
    if(!companies.length) return null;
    const c = companies[0].company;
    return { name: c.company_name, jurisdiction: c.jurisdiction_code, company_number: c.company_number, url: c.opencorporates_url };
  }catch(e){
    console.warn('opencorp error', e.message);
    return null;
  }
}

export default async function handler(req, res) {
  try{
    // FEED_URLS environment var (comma-separated) overrides defaults.
    const feedEnv = process.env.FEED_URLS;
    const feeds = feedEnv ? feedEnv.split(',').map(s=>s.trim()).filter(Boolean) : DEFAULT_FEEDS;

    // fetch all feeds in parallel (limited concurrency)
    const limit = pLimit(6);
    const feedPromises = feeds.map(f => limit(()=>fetchFeed(f)));
    const feedResults = (await Promise.all(feedPromises)).flat();

    // dedupe by link
    const uniq = uniqBy(feedResults, i => (i.link||i.title||i.snippet).toLowerCase());

    // For each item, try to enrich: extract domain -> hunter -> fetch site -> opencorps
    const enrichLimit = pLimit(MAX_CONCURRENCY);
    const tasks = uniq.map(item => enrichLimit(async () => {
      const out = { title: item.title, link: item.link, snippet: item.snippet, feed: item.feed, state: null, business_name: null, email: null, phone: null, ucc: null };

      // Basic heuristics: if feed url contains state's name, set state
      try{
        const f = item.feed.toLowerCase();
        if(f.includes('delaware')) out.state = 'DE';
      }catch(e){}

      // If title includes UCC number, try to extract rough UCC token
      const uccMatch = (item.title || '').match(/\b(UCC[-\s]*1[:#]?\s*[A-Za-z0-9\-\/]{4,50})/i);
      if(uccMatch) out.ucc = uccMatch[0];

      // Business name heuristic
      out.business_name = item.title;

      // Domain from link
      const domain = domainFromUrl(item.link);
      // 1) Try hunter for email by domain (if key provided)
      if(domain){
        const e = await hunterEmailForDomain(domain);
        if(e) out.email = e;
      }
      // 2) If still no email, try to fetch the page and parse mailto / tel
      const contact = await fetchContactFromPage(item.link);
      if(contact.email && !out.email) out.email = contact.email;
      if(contact.phone) out.phone = contact.phone;

      // 3) Try OpenCorporates to get more structure (name/company url)
      if(OPENCORP_KEY){
        const oc = await openCorpLookup(item.title);
        if(oc){
          out.business_name = oc.name || out.business_name;
          // if OpenCorporates gives a URL, attempt to fetch that site too
          if(oc.url && !out.email){
            const ocDomain = domainFromUrl(oc.url);
            if(ocDomain){
              const h = await hunterEmailForDomain(ocDomain);
              if(h) out.email = h;
            }
            const c2 = await fetchContactFromPage(oc.url);
            if(c2.email && !out.email) out.email = c2.email;
            if(c2.phone && !out.phone) out.phone = c2.phone;
          }
        }
      }

      return out;
    }));

    const enriched = (await Promise.all(
