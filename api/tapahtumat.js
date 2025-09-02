// PATH: api/tapahtumat.js
import ical from "node-ical";
import https from "https";

/**
 * /api/tapahtumat
 * Palauttaa tulevat tapahtumat valitulle lajille. Luokittelee ottelut vs. muut.
 * Toistuvista tapahtumista palautetaan vain seuraava esiintymä (UID-ryhmittely).
 *
 * Kyselyparametrit:
 *   - laji=jaakiekko|salibandy|jalkapallo (oletus: jaakiekko)
 *   - tyyppi=kaikki|ottelut|muut (oletus: kaikki)
 *
 * Palautetut kentät (per tapahtuma):
 *   - alku: ISO-aika (seuraavan esiintymän alkamishetki)
 *   - nimi: alkuperäinen SUMMARY (prefix säilytetty)
 *   - visibleName: SUMMARY ilman "Xxx: " -etuliitettä
 *   - kuvaus: DESCRIPTION (usein linkki)
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
    const nyt = new Date();

    // Etuliitteen poisto (esim. "HPV Jääkiekko: ")
    const stripPrefix = (txt = "") => txt.replace(/^[^:]+:\s*/, "");

    // Pieni helper toistuvien exdate-poikkeamien ohitukseen
    const isExcluded = (evt, dt) => {
      if (!evt?.exdate) return false;
      return Object.values(evt.exdate).some((ex) => {
        const exDate = ex instanceof Date ? ex : new Date(ex);
        return exDate.getTime() === dt.getTime();
      });
    };

    // Kategorisointi (järjestys ratkaisee)
    const classify = (visibleName) => {
      const n = (visibleName || "").toLowerCase();

      // 1) Ottelu: hpv + viiva
      const isMatch = n.includes("hpv") && n.includes("-");
      if (isMatch) return { eventType: "ottelu", subType: "ottelu" };

      // 2) Turnaus
      if (/turnaus/.test(n)) return { eventType: "muu", subType: "turnaus" };

      // 3) Treenit — joustava juuritunnistus (treeni|reeni|harjoit|harkat|harkka)
      if (/(treeni|reeni|harjoit|harkat|harkka)/.test(n))
        return { eventType: "muu", subType: "treenit" };

      // 4) Viihde: sauna, laiva, risteily, virkistys
      if (/(sauna|laiva|risteily|virkistys)/.test(n))
        return { eventType: "muu", subType: "viihde" };

      // 5) Muu
      return { eventType: "muu", subType: "muu" };
    };

    // Kerätään seuraava esiintymä per UID
    const nextByUID = new Map();

    // Kerätään override-instanssit talteen (RECURRENCE-ID)
    const overridesByUID = new Map();

    for (const data of icsStrings) {
      const parsed = ical.parseICS(data);

      // Ensimmäinen läpikäynti: tallenna override-instanssit (RECURRENCE-ID)
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

      // Toinen läpikäynti: käsittele vain masterit (ja yksittäiset)
      for (const key of Object.keys(parsed)) {
        const e = parsed[key];
        if (!e || e.type !== "VEVENT") continue;

        // Ohita override-instanssit
        if (e.recurrenceid) continue;

        const originalStart =
          e.start instanceof Date ? e.start : e.start ? new Date(e.start) : null;
        const hasRRule = !!e.rrule;

        // Laske seuraava esiintymä vain masterille
        let nextStart = null;
        let sourceForFields = e;

        if (hasRRule && e.rrule) {
          let candidate = e.rrule.after(nyt, true);
          let guard = 0;
          while (candidate && isExcluded(e, candidate) && guard < 20) {
            candidate = e.rrule.after(candidate, false);
            guard++;
          }
          if (candidate && candidate > nyt) {
            const uid = e.uid || "";
            const overrides = overridesByUID.get(uid);
            if (overrides) {
              const ov = overrides.get(candidate.getTime());
              if (ov) {
                sourceForFields = ov;
                if (ov.start instanceof Date) {
                  candidate = ov.start;
                } else if (ov.start) {
                  candidate = new Date(ov.start);
                }
              }
            }
            nextStart = candidate;
          }
        } else {
          if (originalStart && originalStart > nyt) nextStart = originalStart;
        }

        if (!nextStart) continue;

        const uid = e.uid || `${e.summary}-${e.start?.toISOString?.() || ""}`;
        const name = sourceForFields.summary || e.summary || "";
        const visibleName = stripPrefix(name);

        const { eventType, subType } = classify(visibleName);

        if (tyyppi === "ottelut" && eventType !== "ottelu") continue;
        if (tyyppi === "muut" && eventType !== "muu") continue;

        const kuvaus = sourceForFields.description || e.description || "";
        const sijainti = sourceForFields.location || e.location || "";

        const prev = nextByUID.get(uid);
        if (!prev || nextStart < prev.alkuDate) {
          nextByUID.set(uid, {
            alkuDate: nextStart,
            alku: nextStart.toISOString(),
            nimi: name,
            visibleName,
            kuvaus,
            sijainti,
            eventType,
            subType,
            isRecurring: hasRRule, // <- uusi kenttä
          });
        }
      }
    }

    const tulos = Array.from(nextByUID.values())
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
