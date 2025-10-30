import axios from "axios";
import xml2js from "xml2js";

export default async function handler(req, res) {
  try {
    const url = "https://icis.corp.delaware.gov/Ecorp/UCC/UCC.rss";

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/rss+xml,application/xml"
      },
      timeout: 20000
    });

    const parser = new xml2js.Parser({
      explicitArray: false,
      tagNameProcessors: [xml2js.processors.stripPrefix]
    });

    const feed = await parser.parseStringPromise(data);

    const items =
      feed?.rss?.channel?.item?.map
        ? feed.rss.channel.item.map(i => ({
            title: i.title || "Untitled",
            link: i.link || "#",
            state: "DE"
          }))
        : [];

    return res.status(200).json({ items });
  } catch (err) {
    console.error("UCC API ERROR:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
