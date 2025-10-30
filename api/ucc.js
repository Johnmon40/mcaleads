import axios from "axios";
import xml2js from "xml2js";
import https from "https";

export default async function handler(req, res) {
  try {
    const url = "https://icis.corp.delaware.gov/Ecorp/UCC/UCC.rss";

    // Delaware site can drop TLS — tell axios to retry relaxed
    const agent = new https.Agent({ rejectUnauthorized: false });

    const { data } = await axios.get(url, {
      httpsAgent: agent,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/rss+xml,application/xml,text/xml"
      },
      timeout: 20000,
      validateStatus: () => true
    });

    // If Delaware returns HTML (error firewall page), skip parsing
    if (typeof data !== "string" || data.trim().startsWith("<!DOCTYPE html")) {
      return res.status(200).json({ items: [] });
    }

    const parser = new xml2js.Parser({
      explicitArray: false,
      tagNameProcessors: [xml2js.processors.stripPrefix],
      mergeAttrs: true
    });

    let feed;
    try {
      feed = await parser.parseStringPromise(data);
    } catch {
      return res.status(200).json({ items: [] });
    }

    const entries = feed?.rss?.channel?.item;
    if (!entries) return res.status(200).json({ items: [] });

    const items = Array.isArray(entries) ? entries : [entries];

    return res.status(200).json({
      items: items.map(i => ({
        title: i.title || "Untitled",
        link: i.link || "#",
        state: "DE"
      }))
    });
  } catch (err) {
    console.error("UCC API ERROR:", err.message);
    return res.status(200).json({ items: [] });
  }
}
