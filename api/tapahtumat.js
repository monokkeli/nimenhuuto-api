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
 * Palautetut kentät (uusia lisätty otteluille):
 *   - alku: ISO-aika
 *   - nimi: SUMMARY (prefix säilytetty)
 *   - visibleName: SUMMARY ilman "Xxx: " -etuliitettä
 *   - kuvaus: DESCRIPTION
 *   - sijainti: LOCATION
 *   - eventType: "ottelu" | "muu"
 *   - subType: "ottelu" | "turnaus" | "treenit" | "viihde" | "muu"
 *   - isRecurring: boolean
 *   - home_team_name (uusi, vain otteluille)
 *   - away_team_name (uusi, vain otteluille)
 *   - home_is_ours: boolean (uusi, vain otteluille)
 *   - opponent_team_name (uusi, vain otteluille)
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
    salibandy: ["https://hpvsalibandy.nimenhuuto.com/calendar/ical"],
    jalkapallo: ["https://testihpv.nimenhuuto.com/calendar/ical"],
  };

  const SOURCES =
    SOURCES_BY_LAJI[laji] || SOURCES_BY_LAJI["jääkiekko"]; // fallback jääkiekkoon

  try {
    const icsStrings = await Promise.all(SOURCES.map(fetchWithHttps));

    // Aikaikkuna: nyt ... nyt + 1 kuukausi
    const nyt = new Date();
    const windowStart = nyt;
    const windowEnd = new Date(nyt);
    windowEnd.setMonth(windowEnd.getMonth() + 1);

    // --- Apurit ---
    const stripPrefix = (txt = "") => txt.replace(/^[^:]+:\s*/, "");

    const isExcluded = (evt, dt) => {
      if (!evt?.exdate) return false;
      return Object.values(evt.exdate).some((ex) => {
        const exDate = ex instanceof Date ? ex : new Date(ex);
        return exDate.getTime() === dt.getTime();
      });
    };

    /**
     * Siivoa otsikko: yhtenäistä viivat, kutista välit, trimmaa.
     */
    const cleanTitle = (raw = "") =>
      raw
        .replace(/[–—]/g, "-")
        .replace(/\s+/g, " ")
        .trim();

    /**
     * Parsii joukkueet otsikosta HPV-ankkurilla.
     * Oletus: toinen joukkue on aina pelkkä "HPV" (kirjainkoolla ei väliä).
     * Hyväksyy viivan ilman välilyöntejä (esim. "team-HPV" tai "HPV-opponentti").
     * Palauttaa:
     *   { home_team_name, away_team_name, home_is_ours, opponent_team_name }
     * tai null jos ei varma ottelu.
     */
    function parseTeamsFromTitle(titleRaw = "") {
      if (!titleRaw) return null;

      const title = cleanTitle(titleRaw);
      const lower = title.toLowerCase();

      // Etsi "hpv" sanana (sallitaan rajat: alku/loppu/ei-aakkosnumeerinen)
      const hpvRegex = /(^|[^a-z0-9äöå])hpv([^a-z0-9äöå]|$)/i;
      const m = lower.match(hpvRegex);
      if (!m) return null;

      // Selvitä HPV:n indeksi alkuperäisessä merkkijonossa:
      // match.index osoittaa "ennen-ryhmän" alkuun; etsitään varsinainen "hpv".
      // Etsitään ensimmäinen "hpv" case-insensitiivisesti.
      const hpvWordMatch = title.match(/hpv/i);
      if (!hpvWordMatch) return null;
      const hpvStart = hpvWordMatch.index;
      const hpvEnd = hpvStart + hpvWordMatch[0].length;

      // Etsi lähin viiva heti HPV:n vasemmalta tai oikealta (sallitaan valinnainen välilyönti)
      // Vasemman puolen viiva: ..."-"HPV tai ..." - "HPV
      let leftDashIdx = -1;
      for (let i = hpvStart - 1; i >= 0; i--) {
        const ch = title[i];
        if (ch === " ") continue;
        if (ch === "-") {
          leftDashIdx = i;
        }
        break;
      }

      // Oikean puolen viiva: HPV"-"... tai HPV" - "
      let rightDashIdx = -1;
      for (let i = hpvEnd; i < title.length; i++) {
        const ch = title[i];
        if (ch === " ") continue;
        if (ch === "-") {
          rightDashIdx = i;
        }
        break;
      }

      // Jos ei viivaa aivan kyljessä, hyväksytään vielä " vs " / " v " erottimena
      // mutta vain jos molemmilla puolilla on tekstiä.
      const vsRegex = /\s(vs|v)\s/i;
      const hasVs = vsRegex.test(title);

      if (leftDashIdx === -1 && rightDashIdx === -1 && !hasVs) {
        return null; // ei näytä ottelulta
      }

      // Valitse ensisijainen erotin: viiva lähellä HPV:tä, muutoin "vs"
      if (leftDashIdx !== -1) {
        // Muoto: OPPONENTTI - HPV
        const opponent = title.slice(0, leftDashIdx).trim();
        if (!opponent) return null;
        return {
          home_team_name: opponent,
          away_team_name: "HPV",
          home_is_ours: false,
          opponent_team_name: opponent,
        };
      }
      if (rightDashIdx !== -1) {
        // Muoto: HPV - OPPONENTTI
        const opponent = title.slice(rightDashIdx + 1).trim();
        if (!opponent) return null;
        return {
          home_team_name: "HPV",
          away_team_name: opponent,
          home_is_ours: true,
          opponent_team_name: opponent,
        };
      }

      if (hasVs) {
        // "HPV vs OPP" tai "OPP vs HPV" → päättele HPV:n sijainnin mukaan
        const parts = title.split(vsRegex);
        // split palauttaa myös erotinryhmän; suodatetaan tyhjät.
        const tokens = title.split(/\s(?:vs|v)\s/i);
        if (tokens.length === 2) {
          const [p1, p2] = tokens.map((t) => t.trim());
          if (!p1 || !p2) return null;
          if (/^hpv$/i.test(p1)) {
            return {
              home_team_name: "HPV",
              away_team_name: p2,
              home_is_ours: true,
              opponent_team_name: p2,
            };
          }
          if (/^hpv$/i.test(p2)) {
            return {
              home_team_name: p1,
              away_team_name: "HPV",
              home_is_ours: false,
              opponent_team_name: p1,
            };
          }
        }
      }

      return null;
    }

    /**
     * Luokittelee tapahtuman. Käyttää yllä olevaa parseria ottelun tunnistukseen.
     */
    const classify = (visibleName) => {
      const cleaned = cleanTitle(visibleName || "");
      const parsed = parseTeamsFromTitle(cleaned);
      if (parsed) return { eventType: "ottelu", subType: "ottelu", parsed };

      const n = cleaned.toLowerCase();

      // Turnaus
      if (/turnaus/.test(n)) return { eventType: "muu", subType: "turnaus" };

      // Treenit — joustava juuritunnistus
      if (/(treeni|reeni|harjoit|harkat|harkka)/.test(n))
        return { eventType: "muu", subType: "treenit" };

      // Viihde
      if (/(sauna|laiva|risteily|virkistys)/.test(n))
        return { eventType: "muu", subType: "viihde" };

      // Muu
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
          const rid =
            e.recurrenceid instanceof Date ? e.recurrenceid : new Date(e.recurrenceid);
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
            const cls = classify(visibleName);

            // Tyyppisuodatus
            if (tyyppi === "ottelut" && cls.eventType !== "ottelu") continue;
            if (tyyppi === "muut" && cls.eventType !== "muu") continue;

            const baseRow = {
              alkuDate: start,
              alku: start.toISOString(),
              nimi: name,
              visibleName,
              kuvaus: sourceForFields.description || e.description || "",
              sijainti: sourceForFields.location || e.location || "",
              eventType: cls.eventType,
              subType: cls.subType,
              isRecurring: true,
            };

            // Rikasta otteluille
            if (cls.eventType === "ottelu" && cls.parsed) {
              allItems.push({
                ...baseRow,
                home_team_name: cls.parsed.home_team_name,
                away_team_name: cls.parsed.away_team_name,
                home_is_ours: cls.parsed.home_is_ours,
                opponent_team_name: cls.parsed.opponent_team_name,
              });
            } else {
              allItems.push(baseRow);
            }
          }
        } else {
          // Ei toistuva: lisää jos on ikkunassa
          const start =
            e.start instanceof Date ? e.start : e.start ? new Date(e.start) : null;
          if (!start) continue;
          if (start < windowStart || start > windowEnd) continue;

          const name = e.summary || "";
          const visibleName = stripPrefix(name);
          const cls = classify(visibleName);

          if (tyyppi === "ottelut" && cls.eventType !== "ottelu") continue;
          if (tyyppi === "muut" && cls.eventType !== "muu") continue;

          const baseRow = {
            alkuDate: start,
            alku: start.toISOString(),
            nimi: name,
            visibleName,
            kuvaus: e.description || "",
            sijainti: e.location || "",
            eventType: cls.eventType,
            subType: cls.subType,
            isRecurring: false,
          };

          if (cls.eventType === "ottelu" && cls.parsed) {
            allItems.push({
              ...baseRow,
              home_team_name: cls.parsed.home_team_name,
              away_team_name: cls.parsed.away_team_name,
              home_is_ours: cls.parsed.home_is_ours,
              opponent_team_name: cls.parsed.opponent_team_name,
            });
          } else {
            allItems.push(baseRow);
          }
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
