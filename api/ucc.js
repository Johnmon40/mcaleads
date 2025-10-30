import axios from "axios";
import * as xml2js from "xml2js";

export default async function handler(req, res) {
  try {
    const feedUrl = "https://icis.corp.delaware.gov/Ecorp/UCC/UCC.rss";
    const { data } = await axios.get(feedUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 20000
    });

    const parsed = await xml2js.parseStringPromise(data);
    const items = parsed.rss.channel[0].item.map(x => ({
      title: x.title[0],
      link: x.link[0]
    }));

    res.status(200).json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
