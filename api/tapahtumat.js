// PATH: api/tapahtumat.js
import ical from "node-ical";
import https from "https";

/**
 * /api/tapahtumat
 * Palauttaa tulevat tapahtumat valitulle lajille.
 * - Näyttää KAIKKI tapahtumat seuraavan kuukauden ajalta (myös toistuvat).
 * - Toistuvista sarjoista generoidaan kaikki esiintymät aikaväliin [nyt, nyt+1 kk].
 * - EXDATE-poikkeukset ohitetaan.
 * - RECURRENCE-ID (override) korvaa masterin tiedot kyseiselle esiintymälle.
 *
 * Kyselyparametrit:
 *   - laji=jaakiekko|salibandy|jalkapallo (oletus: jaakiekko)
 *   - tyyppi=kaikki|ottelut|muut (oletus: kaikki)
 *
 * Palautetut kentät:
 *   - alku: ISO-aika
 *   - nimi: SUMMARY (prefix säilytetty)
 *   - visibleName: SUMMARY ilman "Xxx: " -etuliitettä
 *   - kuvaus: DESCRIPTION
 *   - sijainti: LOCATION
 *   - eventType: "ottelu" | "muu"
 *   - subType: "ottelu" | "turnaus" | "treenit" | "viihde" | "muu"
 *   - isRecurring: boolean
 */
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const q = req.query || {};
  const laji = String(q.laji || "jaakiekko").toLowerCase();
  const tyyppi = String(q.tyyppi || "kaikki").toLowerCase();

  // iCal-lähteet lajikohtaisesti
  const SOURCES_BY_LAJI = {
    "jääkiekko": ["https://hpvjaakiekko.nimenhuuto.com/calendar/ical"],
    "jaakiekko": ["https://hpvjaakiekko.nimenhuuto.com/calendar/ical"],
    "salibandy": ["https://hpvsalibandy.nimenhuuto.com/calendar/ical"],
    "jalkapallo": ["https://testihpv.nimenhuuto.com/calendar/ical"],
  };

  const SOURCES =
    SOURCES_BY_LAJI[laji] ||
    SOURCES_BY_LAJI["jääkiekko"]; // fallback jääkiekkoon

  try {
    const icsStrings = await Promise.all(SOURCES.map(fetchWithHttps));

    // Aikaikkuna: nyt ... nyt + 1 kuukausi
    const nyt = new Date();
    const windowStart = nyt;
    const windowEnd = new Date(nyt);
    windowEnd.setMonth(windowEnd.getMonth() + 1);

    // Apurit
    const stripPrefix = (txt = "") => txt.replace(/^[^:]+:\s*/, "");

    const isExcluded = (evt, dt) => {
      if (!evt?.exdate) return false;
      return Object.values(evt.exdate).some((ex) => {
        const exDate = ex instanceof Date ? ex : new Date(ex);
        return exDate.getTime() === dt.getTime();
      });
    };

    const classify = (visibleName) => {
      const n = (visibleName || "").toLowerCase();

      // 1) Ottelu: hpv + viiva
      const isMatch = n.includes("hpv") && n.includes("-");
      if (isMatch) return { eventType: "ottelu", subType: "ottelu" };

      // 2) Turnaus
      if (/turnaus/.test(n)) return { eventType: "muu", subType: "turnaus" };

      // 3) Treenit — joustava juuritunnistus
      if (/(treeni|reeni|harjoit|harkat|harkka)/.test(n))
        return { eventType: "muu", subType: "treenit" };

      // 4) Viihde
      if (/(sauna|laiva|risteily|virkistys)/.test(n))
        return { eventType: "muu", subType: "viihde" };

      // 5) Muu
      return { eventType: "muu", subType: "muu" };
    };

    // Kerätään override-instanssit (RECURRENCE-ID)
    // Map: uid -> Map(recurrenceTimeMs -> overrideEvent)
    const overridesByUID = new Map();

    const allItems = [];

    for (const data of icsStrings) {
      const parsed = ical.parseICS(data);

      // 1) Kerää override-instanssit talteen
      for (const key of Object.keys(parsed)) {
        const e = parsed[key];
        if (!e || e.type !== "VEVENT") continue;
        if (e.recurrenceid) {
          const uid = e.uid;
          if (!uid) continue;
          const rid = e.recurrenceid instanceof Date ? e.recurrenceid : new Date(e.recurrenceid);
          const ms = rid.getTime();
          if (!overridesByUID.has(uid)) overridesByUID.set(uid, new Map());
          overridesByUID.get(uid).set(ms, e);
        }
      }

      // 2) Generoi aikavälin esiintymät (masterit ja yksittäiset)
      for (const key of Object.keys(parsed)) {
        const e = parsed[key];
        if (!e || e.type !== "VEVENT") continue;

        // Ohita override-instanssit – ne haetaan overridesByUID:stä esiintymähetkellä
        if (e.recurrenceid) continue;

        const hasRRule = !!e.rrule;
        const uid = e.uid || `${e.summary}-${e.start?.toISOString?.() || ""}`;

        if (hasRRule && e.rrule) {
          // Generoi kaikki esiintymät ikkunaan
          // Huom: kolmas parametri 'inc' = true, sisällytetään rajahetket
          const occurrences = e.rrule.between(windowStart, windowEnd, true);

          for (let occ of occurrences) {
            if (!(occ instanceof Date)) occ = new Date(occ);
            // Ohita EXDATE
            if (isExcluded(e, occ)) continue;

            // Override tälle esiintymälle?
            let sourceForFields = e;
            const ovMap = overridesByUID.get(uid);
            if (ovMap) {
              const ov = ovMap.get(occ.getTime());
              if (ov) {
                sourceForFields = ov;
              }
            }

            // Valitse alkuhetki
            let start = occ;
            if (sourceForFields !== e) {
              // override saattaa siirtää alkua
              if (sourceForFields.start instanceof Date) start = sourceForFields.start;
              else if (sourceForFields.start) start = new Date(sourceForFields.start);
            }

            // Varmista että on ikkunassa (esim. override siirtänyt aikaa)
            if (start < windowStart || start > windowEnd) continue;

            const name = sourceForFields.summary || e.summary || "";
            const visibleName = stripPrefix(name);
            const { eventType, subType } = classify(visibleName);

            // Tyyppisuodatus
            if (tyyppi === "ottelut" && eventType !== "ottelu") continue;
            if (tyyppi === "muut" && eventType !== "muu") continue;

            allItems.push({
              alkuDate: start,
              alku: start.toISOString(),
              nimi: name,
              visibleName,
              kuvaus: sourceForFields.description || e.description || "",
              sijainti: sourceForFields.location || e.location || "",
              eventType,
              subType,
              isRecurring: true,
            });
          }
        } else {
          // Ei toistuva: lisää jos on ikkunassa
          const start =
            e.start instanceof Date ? e.start : e.start ? new Date(e.start) : null;
          if (!start) continue;
          if (start < windowStart || start > windowEnd) continue;

          const name = e.summary || "";
          const visibleName = stripPrefix(name);
          const { eventType, subType } = classify(visibleName);

          if (tyyppi === "ottelut" && eventType !== "ottelu") continue;
          if (tyyppi === "muut" && eventType !== "muu") continue;

          allItems.push({
            alkuDate: start,
            alku: start.toISOString(),
            nimi: name,
            visibleName,
            kuvaus: e.description || "",
            sijainti: e.location || "",
            eventType,
            subType,
            isRecurring: false,
          });
        }
      }
    }

    // Järjestä ajankohdan mukaan ja pudota tekninen kenttä pois
    const tulos = allItems
      .sort((a, b) => a.alkuDate - b.alkuDate)
      .map(({ alkuDate, ...rest }) => rest);

    return res.status(200).json(tulos);
  } catch (err) {
    console.error("Virhe /api/tapahtumat -käsittelyssä:", err);
    return res.status(500).json({ virhe: "Virhe haettaessa iCal-dataa" });
  }
}

function fetchWithHttps(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let rawData = "";
        res.on("data", (chunk) => (rawData += chunk));
        res.on("end", () => resolve(rawData));
      })
      .on("error", reject);
  });
}
