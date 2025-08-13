// PATH: api/matsit.js
import ical from "node-ical";
import https from "https";

/**
 * Yhdistetty Nimenhuuto-proxy:
 * - Lataa kaikki kolme kalenteria rinnakkain
 * - Suodattaa vain tulevat tapahtumat
 * - Palauttaa yhteisen listan aikajärjestyksessä
 *
 * HUOM: Tapahtuman nimi säilytetään alkuperäisenä (esim. "HPV Jääkiekko: HPV - Vihu"),
 * jotta frontti voi päätellä lajin nimen etuliitteen perusteella.
 */
export default async function handler(req, res) {
  // Salli CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SOURCES = [
    "https://hpvjaakiekko.nimenhuuto.com/calendar/ical", // HPV Jääkiekko
    "https://hpvsalibandy.nimenhuuto.com/calendar/ical", // HPV Salibandy
    "https://testihpv.nimenhuuto.com/calendar/ical",     // Testi HPV (jalkapallon testit)
  ];

  try {
    // Hae kaikki kalenterit rinnakkain
    const icsStrings = await Promise.all(SOURCES.map(fetchWithHttps));

    // Jäsennä ja kerää tapahtumat
    const nyt = new Date();
    const kaikkiTapahtumat = icsStrings.flatMap((data) => {
      const parsed = ical.parseICS(data);
      return Object.values(parsed)
        .filter((e) => e.type === "VEVENT")
        .map((e) => ({
          alku: e.start,
          nimi: e.summary,             // esim. "HPV Jääkiekko: HPV - Vihu"
          kuvaus: e.description ?? "", // esim. Nimenhuuto-linkki
          sijainti: e.location ?? "",
        }));
    });

    // Vain tulevat ja aikajärjestykseen
    const tulevat = kaikkiTapahtumat
      .filter((e) => new Date(e.alku) > nyt)
      .sort((a, b) => new Date(a.alku) - new Date(b.alku));

    res.status(200).json(tulevat);
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
