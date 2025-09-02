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
 *   - subType: esim. "treeni" | "turnaus" | "ilmoittautuminen" | "muu"
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
      // node-ical exdate on olio jonka avaimet ovat Date-tyyppisinä tai isoina merkkijonoina
      // Verrataan päivämäärän aikaleimoja (päivän tarkkuus ei riitä, käytetään täyttä aikaa).
      return Object.values(evt.exdate).some((ex) => {
        const exDate = ex instanceof Date ? ex : new Date(ex);
        return exDate.getTime() === dt.getTime();
      });
    };

    // Määritetään tyyppi & alityyppi nimen perusteella (heuristiikka)
    const classify = (visibleName) => {
      const n = (visibleName || "").toLowerCase();

      // Ottelu: hpv + viiva
      const isMatch = n.includes("hpv") && n.includes("-");
      if (isMatch) return { eventType: "ottelu", subType: "ottelu" };

      // Alityypit muihin
      if (/(treeni|harjoit)/.test(n)) return { eventType: "muu", subType: "treeni" };
      if (/turnaus/.test(n)) return { eventType: "muu", subType: "turnaus" };
      if (/ilmoittautum/.test(n)) return { eventType: "muu", subType: "ilmoittautuminen" };

      return { eventType: "muu", subType: "muu" };
    };

    // Parsitaan ja poimitaan seuraava esiintymä per UID
    const nextByUID = new Map();

    for (const data of icsStrings) {
      const parsed = ical.parseICS(data);

      for (const key of Object.keys(parsed)) {
        const e = parsed[key];
        if (!e || e.type !== "VEVENT") continue;

        const originalStart = e.start instanceof Date ? e.start : new Date(e.start);
        const hasRRule = !!e.rrule;

        // Laske seuraava esiintymä:
        let nextStart = null;

        if (hasRRule && e.rrule) {
          // Hae seuraava esiintymä 'nyt' jälkeen, ohita exdate't
          let candidate = e.rrule.after(nyt, true);
          let guard = 0;
          while (candidate && isExcluded(e, candidate) && guard < 10) {
            candidate = e.rrule.after(candidate, false);
            guard++;
          }
          if (candidate && candidate > nyt) {
            nextStart = candidate;
          }
        } else {
          // Ei toistuva -> kelpaa vain tulevaisuuteen sijoittuva
          if (originalStart && originalStart > nyt) {
            nextStart = originalStart;
          }
        }

        if (!nextStart) continue;

        const uid = e.uid || `${e.summary}-${e.start?.toISOString?.() || ""}`;
        const name = e.summary || "";
        const visibleName = stripPrefix(name);

        const { eventType, subType } = classify(visibleName);

        // Tyyppisuodatus (tyyppi=ottelut|muut)
        if (tyyppi === "ottelut" && eventType !== "ottelu") continue;
        if (tyyppi === "muut" && eventType !== "muu") continue;

        // Tallenna pienin (lähin tuleva) nextStart per UID
        const prev = nextByUID.get(uid);
        if (!prev || nextStart < prev.alkuDate) {
          nextByUID.set(uid, {
            alkuDate: nextStart,
            alku: nextStart.toISOString(),
            nimi: name,
            visibleName,
            kuvaus: e.description || "",
            sijainti: e.location || "",
            eventType,
            subType,
            isRecurring: hasRRule,
          });
        }
      }
    }

    // Muunna listaksi, järjestä aikajärjestykseen
    const tulos = Array.from(nextByUID.values())
      .sort((a, b) => a.alkuDate - b.alkuDate)
      .map(({ alkuDate, ...rest }) => rest); // pudota Date-apukenttä

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
