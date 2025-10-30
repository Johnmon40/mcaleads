import axios from "axios";
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  try {
    const rss = await axios.get(
      "https://icis.corp.delaware.gov/eCorp/UCC/UCC.rss"
    );

    const $ = cheerio.load(rss.data, { xmlMode: true });
    const items = [];

    $("item").each((i, el) => {
      items.push({
        title: $(el).find("title").text(),
        link: $(el).find("link").text()
      });
    });

    res.status(200).json({ items });
  } catch (err) {
    res.status(500).json({ error: "Failed to load UCC feed", details: err.message });
  }
}
