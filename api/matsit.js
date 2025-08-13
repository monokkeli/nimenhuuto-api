// PATH: api/matsit.js
import ical from "node-ical";
import https from "https";

/**
 * Yhdistetty Nimenhuuto-proxy:
 * - Hakee KOLME kalenteria rinnakkain
 * - Lisää jokaiselle tapahtumalle kentän `laji`: "jääkiekko" | "salibandy" | "jalkapallo"
 * - Suodattaa vain tulevat tapahtumat ja lajittelee aikajärjestykseen
 * - Säilyttää SUMMARY/DESCRIPTION/LOCATION → mapattuna: nimi/kuvaus/sijainti
 *
 * Frontti voi tämän jälkeen suodattaa pelkällä: e.laji === valittuLaji
 */
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Lähteet + laji
  const SOURCES = [
    {
      url: "https://hpvjaakiekko.nimenhuuto.com/calendar/ical",
      laji: "jääkiekko",
    },
    {
      url: "https://hpvsalibandy.nimenhuuto.com/calendar/ical",
      laji: "salibandy",
    },
    {
      url: "https://testihpv.nimenhuuto.com/calendar/ical", // testit jalkapalloon
      laji: "jalkapallo",
    },
  ];

  try {
    // Hae kaikki ICS:t rinnakkain
    const icsStrings = await Promise.all(SOURCES.map((s) => fetchWithHttps(s.url)));

    const nyt = new Date();

    // Parsitaan ja liitetään `laji` lähteen perusteella
    const kaikkiTapahtumat = icsStrings.flatMap((data, idx) => {
      const parsed = ical.parseICS(data);
      const laji = SOURCES[idx].laji;

      return Object.values(parsed)
        .filter((e) => e.type === "VEVENT")
        .map((e) => ({
          alku: e.start,                 // DTSTART
          nimi: e.summary,               // SUMMARY (esim. "HPV Jääkiekko: HPV - Vihu")
          kuvaus: e.description ?? "",   // DESCRIPTION (sisältää usein linkin)
          sijainti: e.location ?? "",    // LOCATION
          laji,                          // <- lisätty
        }));
    });

    // Vain tulevat & järjestä
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
