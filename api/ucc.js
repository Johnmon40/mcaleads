import axios from "axios";
import xml2js from "xml2js";

export default async function handler(req, res) {
  try {
    const feedUrl = "https://icis.corp.delaware.gov/Ecorp/UCC/UCC.rss";

    const response = await axios.get(feedUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const parsed = await xml2js.parseStringPromise(response.data);

    const items = parsed.rss.channel[0].item.map(item => ({
      title: item.title[0],
      link: item.link[0]
    }));

    res.status(200).json({ items });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
