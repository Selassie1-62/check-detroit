// Robot « bouées en amont » : lit Sandettie et Greenwich (Met Office via NOAA NDBC) et la bouée houlographe de Hastings (Cefas WaveNet, licence OGL v3,
// mesures toutes les 30 min, horodatées au DÉBUT de la mesure, en UTC) et écrit bouees.json.
// Si une houle longue venant de l'W/SW y est détectée, envoie une alerte ntfy : elle atteint la
// côte d'Opale ~1 h 30 à 2 h plus tard.
import { readFile, writeFile } from "node:fs/promises";

const URL = "https://data-api.cefas.co.uk/api/recordsets/12651/data?page=1&resultsPerPage=1000000";
const BUOYS = [
  { id: "HASTINGSWN", label: "Hastings (Manche Est)", distKm: 58, note: "En amont pour la houle d'W à SW" },
];
// Bateaux-feux du Met Office relayés par la NOAA (NDBC, domaine public) : mesures horaires.
const NDBC = [
  { id: "62304", label: "Sandettie (bateau-feu)", distKm: 30, note: "En amont pour la mer de N à NE (Calais, Wissant)" },
  { id: "62305", label: "Greenwich (bateau-feu, Manche)", distKm: 110, note: "Loin en amont pour la houle d'W à SW" },
];
const TOPIC = process.env.NTFY_TOPIC;
const SITE = process.env.SITE_URL || "";
// Seuils d'alerte « houle longue en approche » (calés sur la session du 31/10 à Wimereux).
const ALERT = { minTp: 10, minHs: 0.25, dirFrom: 195, dirTo: 290, cooldownH: 12 };

let items = [];
try {
  const r = await fetch(URL, { headers: { accept: "application/json", "user-agent": "check-detroit (non-commercial)" } });
  if (r.ok) items = (await r.json()).items || []; else console.error("Cefas indisponible :", r.status);
} catch (e) { console.error("Cefas injoignable :", e.message); }

const out = { updatedAt: new Date().toISOString(), source: "Cefas WaveNet (Open Government Licence v3.0) - Hull et al. (2023), WaveNet near real-time data feed, doi:10.14466/CefasDataHub.142", buoys: [] };
for (const b of BUOYS) {
  const rows = items.filter((i) => i.Deployment === b.id);
  if (!rows.length) { out.buoys.push({ ...b, error: "pas de données" }); continue; }
  // Regroupe par horodatage : { t, Hm0, Tpeak, Tz, W_PDIR, W_SPR, TEMP }
  const byT = new Map();
  for (const i of rows) {
    const o = byT.get(i.DateTime) || { t: i.DateTime + "Z" };
    o[i.Parameter] = Math.round(i.ResultMean * 100) / 100;
    byT.set(i.DateTime, o);
  }
  const series = [...byT.values()].sort((a, c) => (a.t < c.t ? -1 : 1)).filter((o) => o.Hm0 != null).slice(-48); // 24 h
  out.buoys.push({ ...b, lat: rows[0].Latitude, lon: rows[0].Longitude, last: series.at(-1), series });
}
// Format NDBC realtime2 : #YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP ... (plus récent en premier, "MM" = manquant)
for (const b of NDBC) {
  try {
    const r = await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${b.id}.txt`, { headers: { "user-agent": "check-detroit (non-commercial)" } });
    if (!r.ok) { out.buoys.push({ ...b, error: `NDBC ${r.status}` }); continue; }
    const lines = (await r.text()).split("\n");
    const head = lines[0].replace(/^#/, "").trim().split(/\s+/);
    const col = (row, name) => { const v = row[head.indexOf(name)]; return v == null || v === "MM" ? null : Number(v); };
    const KT = 1.943844;
    const series = lines.filter((l) => l && !l.startsWith("#")).map((l) => l.trim().split(/\s+/)).map((row) => ({
      t: `${row[0]}-${row[1]}-${row[2]}T${row[3]}:${row[4]}:00Z`,
      Hm0: col(row, "WVHT"), Tpeak: col(row, "DPD"), Tz: col(row, "APD"), W_PDIR: col(row, "MWD"), TEMP: col(row, "WTMP"),
      wind: col(row, "WSPD") != null ? Math.round(col(row, "WSPD") * KT) : null, windDir: col(row, "WDIR"),
      gust: col(row, "GST") != null ? Math.round(col(row, "GST") * KT) : null,
    })).filter((o) => o.Hm0 != null || o.wind != null).slice(0, 24).reverse();
    if (!series.length) { out.buoys.push({ ...b, error: "pas de mesure récente" }); continue; }
    out.buoys.push({ ...b, source: "Met Office via NOAA NDBC", last: series.at(-1), series });
  } catch (e) { out.buoys.push({ ...b, error: "NDBC injoignable" }); }
}

await writeFile("bouees.json", JSON.stringify(out) + "\n");
out.buoys.forEach((b) => console.log(b.error ? `${b.label}: ${b.error}` :
  `${b.label}: Hs ${b.last.Hm0} m · Tp ${b.last.Tpeak} s · ${b.last.W_PDIR}° · vent ${b.last.wind ?? "—"} nds · ${b.last.t}`));

// Alerte houle longue à Hastings
const h = out.buoys.find((b) => b.id === "HASTINGSWN" && b.last);
if (TOPIC && h) {
  const L = h.last, d = L.W_PDIR;
  const fromW = d != null && d >= ALERT.dirFrom && d <= ALERT.dirTo;
  if (L.Tpeak >= ALERT.minTp && L.Hm0 >= ALERT.minHs && fromW) {
    let st = {}; try { st = JSON.parse(await readFile("bouees-state.json", "utf8")); } catch {}
    if (!st.last || Date.now() - st.last > ALERT.cooldownH * 3600e3) {
      const eta = Math.round((h.distKm / (0.78 * L.Tpeak * 3.6)) * 10) / 10; // vitesse de groupe en eau profonde
      const res = await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: TOPIC, priority: 4, tags: ["ocean"], ...(SITE ? { click: SITE } : {}),
          title: `Houle longue détectée à Hastings · ${L.Tpeak} s`,
          message: `Hs ${L.Hm0} m · Tp ${L.Tpeak} s · venant de ${Math.round(d)}°.\nArrivée estimée côte d'Opale dans ~${eta} h (Wimereux, Équihen, Hardelot).\nVérifie la bouée d'Ambleteuse.` }) });
      if (res.ok) { st.last = Date.now(); await writeFile("bouees-state.json", JSON.stringify(st) + "\n"); console.log("Alerte houle longue envoyée."); }
    }
  }
}
