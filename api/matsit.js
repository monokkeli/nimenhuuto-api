// PATH: api/matsit.js
import ical from "node-ical";
import https from "https";

/**
 * Yhdistetty Nimenhuuto-proxy:
 * - Lataa kaikki kolme kalenteria rinnakkain
 * - Suodattaa VAIN tulevat TAPAHTUMAT, jotka näyttävät otteluilta:
 *    * (nimen etuliite poistettu) sisältää "hpv" JA "-"
 * - Palauttaa yhteisen listan aikajärjestyksessä
 *
 * HUOM: SUMMARY säilytetään sellaisenaan vastauksessa (esim. "HPV Jääkiekko: HPV - Vihu"),
 * mutta suodatus tehdään etuliitteen poiston jälkeen.
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

    const nyt = new Date();

    // Pieni apufunktio: poista mahdollinen "Jotain: " -etuliite
    const stripPrefix = (txt = "") => txt.replace(/^[^:]+:\s*/, "");

    // Jäsennä, rakenna ja SUODATA vain ottelut (hpv + viiva)
    const kaikkiTapahtumat = icsStrings.flatMap((data) => {
      const parsed = ical.parseICS(data);
      return Object.values(parsed)
        .filter((e) => e.type === "VEVENT")
        .map((e) => ({
          alku: e.start,                 // DTSTART
          nimi: e.summary,               // SUMMARY (säilytetään alkuperäisenä)
          kuvaus: e.description ?? "",   // DESCRIPTION (sis. usein linkin)
          sijainti: e.location ?? "",    // LOCATION
        }))
        .filter((evt) => {
          const n = stripPrefix(evt.nimi || "").toLowerCase();
          return n.includes("hpv") && n.includes("-"); // ← vain ottelut
        });
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
