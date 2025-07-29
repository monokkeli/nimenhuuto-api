import ical from "node-ical";
import https from "https";

export default async function handler(req, res) {
  const icalURL = "https://testihpv.nimenhuuto.com/calendar/ical";

  try {
    const data = await fetchWithHttps(icalURL);
    const parsed = ical.parseICS(data);

    const nyt = new Date();
    const tapahtumat = Object.values(parsed)
      .filter((e) => e.type === "VEVENT")
      .filter((e) => new Date(e.start) > nyt)
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .map((e) => ({
        alku: e.start,
        nimi: e.summary,
        kuvaus: e.description ?? "",
        sijainti: e.location ?? "",
      }));

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(tapahtumat);
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
