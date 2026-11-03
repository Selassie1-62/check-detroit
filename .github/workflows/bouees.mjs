// Robot « bouées en amont » : lit la bouée houlographe de Hastings (Cefas WaveNet, licence OGL v3,
// mesures toutes les 30 min, horodatées au DÉBUT de la mesure, en UTC) et écrit bouees.json.
// Si une houle longue venant de l'W/SW y est détectée, envoie une alerte ntfy : elle atteint la
// côte d'Opale ~1 h 30 à 2 h plus tard.
import { readFile, writeFile } from "node:fs/promises";

const URL = "https://data-api.cefas.co.uk/api/recordsets/12651/data?page=1&resultsPerPage=1000000";
const BUOYS = [
  { id: "HASTINGSWN", label: "Hastings (Manche Est)", distKm: 58, note: "En amont pour la houle d'W à SW" },
  { id: "STHKNOCKWN", label: "South Knock (estuaire de la Tamise)", distKm: 95, note: "Indicatif pour la mer de N à NE" },
];
const TOPIC = process.env.NTFY_TOPIC;
const SITE = process.env.SITE_URL || "";
// Seuils d'alerte « houle longue en approche » (calés sur la session du 31/10 à Wimereux).
const ALERT = { minTp: 10, minHs: 0.25, dirFrom: 195, dirTo: 290, cooldownH: 12 };

const r = await fetch(URL, { headers: { accept: "application/json", "user-agent": "check-detroit (non-commercial)" } });
if (!r.ok) { console.error("Cefas indisponible :", r.status); process.exit(0); }
const items = (await r.json()).items || [];

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
await writeFile("bouees.json", JSON.stringify(out) + "\n");
out.buoys.forEach((b) => console.log(b.error ? `${b.label}: ${b.error}` :
  `${b.label}: Hs ${b.last.Hm0} m · Tp ${b.last.Tpeak} s · ${b.last.W_PDIR}° · ${b.last.t}`));

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
