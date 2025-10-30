import axios from "axios";
import xml2js from "xml2js";

export default async function handler(req, res) {
  try {
    // Florida UCC + liens public RSS
    const url = "https://dos.fl.gov/media/rss/business.csv.xml";

    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 20000
    });

    const parser = new xml2js.Parser({ explicitArray: false });
    const feed = await parser.parseStringPromise(data);

    const items = feed.rss.channel.item || [];

    const formatted = Array.isArray(items) ? items : [items];

    res.status(200).json({
      i
