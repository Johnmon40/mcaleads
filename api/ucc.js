// Serverless API: fetches one or more state RSS feeds and returns a unified list.
// Works on Vercel Node 18. No keys, no scraping—just public RSS.
// Add more feeds by setting FEED_URLS in Vercel: comma-separated URLs.

import axios from "axios";
import xml2js from "xml2js";

const DEFAULT_FEEDS = [
  "https://icis.corp.delaware.gov/Ecorp/UCC/UCC.rss" // Delaware
];

const USER_AGENT = "UCC-Feed-Viewer/1.0 (+https://example.com)";

export default async function handler(req, res){
  try{
    const envFeeds = (process.env.FEED_URLS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const feeds = envFeeds.length ? envFeeds : DEFAULT_FEEDS;

    const parser = new xml2js.Parser({ explicitArray: true });

    // fetch all feeds (sequential is safest for serverless; these are tiny)
    const allItems = [];
    for(const url of feeds){
      try{
        const { data } = await axios.get(url, {
          headers: { "User-Agent": USER_AGENT, "Accept": "application/rss+xml,application/xml" },
          timeout: 20000
        });
        const parsed = await parser.parseStringPromise(data);
        const items = parsed?.rss?.channel?.[0]?.item || [];
        for(const i of items){
          allItems.push({
            title: i?.title?.[0] ?? "Untitled",
            link: i?.link?.[0] ?? "#",
            state: guessState(url)
          });
        }
      }catch(e){
        // ignore a bad feed; continue
        console.warn("Feed error:", url, e.message);
      }
    }

    // sort newest first when pubDate exists
    allItems.sort((a,b)=>{
      const da = new Date(a.pubDate || 0).getTime();
      const db = new Date(b.pubDate || 0).getTime();
      return db - da;
    });

    res.setHeader("Content-Type", "application/json");
    res.status(200).json({ items: allItems.slice(0, 200) });
  }catch(err){
    console.error("API error:", err);
    res.status(500).json({ error: err.message || "failed" });
  }
}

function guessState(feedUrl){
  const u = feedUrl.toLowerCase();
  if(u.includes("delaware")) return "DE";
  return null;
}
