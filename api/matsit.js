import ical from "ical";
import https from "https";

export default async function handler(req, res) {
  const icalURL = "https://testihpv.nimenhuuto.com/calendar/ical";

  try {
    const data = await fetchWithHttps(icalURL);
    const parsed = ical.parseICS(data);

    const nyt = new Date();
    const matsit = Object.values(parsed)
      .filter((e) => e.type === "VEVENT")
      .filter((e) => e.summary?.toLowerCase().includes("matsi"))
      .filter((e) => new Date(e.start) > nyt)
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .map((e) => ({
        alku: e.start,
        nimi: e.summary,
      }));

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(matsit);
  } catch (err) {
    console.error("Virhe iCal-haussa:", err);
    res.status(500).json({ virhe: "Virhe haettaessa iCal-dataa" });
  }
}

function fetchWithHttps(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let rawData = "";
        res.on("data", (chunk) => {
          rawData += chunk;
        });
        res.on("end", () => resolve(rawData));
      })
      .on("error", reject);
  });
}
