import axios from "axios";
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  try {
    const { data } = await axios.get("https://icis.corp.delaware.gov/Ecorp/UCC/UCC.rss");

    const $ = cheerio.load(data, { xmlMode: true });

    const items = [];
    $("item").each((i, el) => {
      items.push({
        title: $(el).find("title").text().trim(),
        link: $(el).find("link").text().trim()
      });
    });

    res.status(200).json({ items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
