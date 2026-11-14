// Robot « bouées en amont » : lit Sandettie et Greenwich (Met Office via NOAA NDBC) et la bouée houlographe de Hastings (Cefas WaveNet, licence OGL v3,
// mesures toutes les 30 min, horodatées au DÉBUT de la mesure, en UTC) et écrit bouees.json.
// Si une houle longue venant de l'W/SW y est détectée, envoie une alerte ntfy : elle atteint la
// côte d'Opale ~1 h 30 à 2 h plus tard.
import { readFile, writeFile } from "node:fs/promises";

const URL = "https://data-api.cefas.co.uk/api/recordsets/12651/data?page=1&resultsPerPage=1000000";
const BUOYS = [
  { id: "HASTINGSWN", match: /^HASTINGS/i, label: "Hastings (Manche Est)", distKm: 58, note: "En amont pour la houle d'W à SW",
    alert: { dirFrom: 195, dirTo: 290, minTp: 10, minHs: 0.25, spots: "Wimereux (La Rochette, Pointe aux Oies), Équihen, Hardelot" } },
  // Mer du Nord : West Gabbard 2 d'abord ; si elle n'émet plus (> 6 h), relais par South Knock puis Sean P.
  { id: "WGABBARD", match: /GAB/i, label: "West Gabbard 2 (mer du Nord)", distKm: 130, note: "En amont pour la houle de N à NNE",
    relays: [
      { match: /^STHKNOCK|SOUTH.?KNOCK/i, label: "South Knock (estuaire de la Tamise)", distKm: 95, note: "Relais de West Gabbard 2 : mer de N à NE (un peu abritée par les bancs de la Tamise)" },
      { match: /SEAN/i, label: "Sean P (mer du Nord, au large du Norfolk)", distKm: 260, note: "Relais de West Gabbard 2 : houle de N, loin en amont" },
    ],
    alert: { dirFrom: 330, dirTo: 40, minTp: 9, minHs: 0.4, spots: "Calais, Sangatte, Wissant" } },
  // Préavis : la houle atlantique à l'entrée de la Manche, ~15 h avant la côte d'Opale. Elle perd beaucoup en route
  // (Cotentin, île de Wight, Manche qui se resserre) : c'est un signal pour regarder Greenwich puis Hastings, pas une taille à la côte.
  { id: "SCILLY", match: /SCIL/i, label: "Îles Scilly (entrée de la Manche)", distKm: 560, note: "Préavis lointain pour la houle d'W à SW (taille à la côte bien plus faible)",
    alert: { dirFrom: 220, dirTo: 280, minTp: 12, minHs: 1.5, coastRatio: 0.1, spots: "Wimereux (La Rochette, Pointe aux Oies), Équihen, Hardelot — à confirmer à Hastings" } },
];
// Bateaux-feux du Met Office relayés par la NOAA (NDBC, domaine public) : mesures horaires.
const NDBC = [
  { id: "62304", label: "Sandettie (bateau-feu)", distKm: 30, lat: 51.103, lon: 1.8, note: "En amont pour la mer de N à NE (Calais, Wissant)" },
  { id: "62305", label: "Greenwich (bateau-feu, Manche)", distKm: 110, lat: 50.4, lon: 0.0, note: "Loin en amont pour la houle d'W à SW" },
];
const TOPIC = process.env.NTFY_TOPIC;
const SITE = process.env.SITE_URL || "";
// Seuils d'alerte « houle longue en approche » (Hastings calé sur la session du 31/10 à Wimereux ; West Gabbard provisoire).
const COOLDOWN_H = 12;
const inSector = (d, a, b) => d != null && (a <= b ? d >= a && d <= b : d >= a || d <= b);

let items = [];
try {
  const r = await fetch(URL, { headers: { accept: "application/json", "user-agent": "check-detroit (non-commercial)" } });
  if (r.ok) items = (await r.json()).items || []; else console.error("Cefas indisponible :", r.status);
} catch (e) { console.error("Cefas injoignable :", e.message); }

const out = { updatedAt: new Date().toISOString(), source: "Cefas WaveNet (Open Government Licence v3.0) - Hull et al. (2023), WaveNet near real-time data feed, doi:10.14466/CefasDataHub.142", buoys: [] };
const STALE_H = 6;
const newestOf = (re) => items.filter((i) => re.test(i.Deployment)).reduce((m, i) => (!m || i.DateTime > m.DateTime ? i : m), null);
const fresh = (i) => i && Date.now() - Date.parse(i.DateTime + "Z") < STALE_H * 3600e3;
for (const b0 of BUOYS) {
  // Bouée muette : on passe au premier relais qui émet encore (même alerte, distance et libellé du relais).
  let b = b0;
  if (!fresh(newestOf(b0.match)) && b0.relays) {
    const r = b0.relays.find((x) => fresh(newestOf(x.match)));
    if (r) { b = { ...b0, ...r, relayOf: b0.label }; console.log(`${b0.label} muette depuis plus de ${STALE_H} h : relais par ${r.label}`); }
  }
  // Plusieurs bouées peuvent porter un nom proche (ex. West Gabbard / West Gabbard 2) : on garde la plus récente.
  const all = items.filter((i) => b.match.test(i.Deployment));
  const newest = all.reduce((m, i) => (!m || i.DateTime > m.DateTime ? i : m), null);
  const rows = newest ? all.filter((i) => i.Deployment === newest.Deployment) : [];
  if (newest) console.log(`${b.label} : identifiant Cefas ${newest.Deployment}`);
  if (!rows.length) {
    const names = [...new Set(items.map((i) => i.Deployment))].sort().join(", ");
    console.log(`${b.label} : introuvable. Bouées présentes dans le flux Cefas : ${names}`);
    out.buoys.push({ ...b, error: "pas de données" }); continue;
  }
  // Regroupe par horodatage : { t, Hm0, Tpeak, Tz, W_PDIR, W_SPR, TEMP }
  const byT = new Map();
  for (const i of rows) {
    const o = byT.get(i.DateTime) || { t: i.DateTime + "Z" };
    o[i.Parameter] = Math.round(i.ResultMean * 100) / 100;
    byT.set(i.DateTime, o);
  }
  const series = [...byT.values()].sort((a, c) => (a.t < c.t ? -1 : 1)).filter((o) => o.Hm0 != null).slice(-48); // 24 h
  const { relays, match, ...pub } = b;
  out.buoys.push({ ...pub, lat: rows[0].Latitude, lon: rows[0].Longitude, last: series.at(-1), series });
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
      Hm0: col(row, "WVHT"), Tpeak: col(row, "DPD") != null && col(row, "DPD") <= 20 ? col(row, "DPD") : null, // > 20 s : valeur aberrante du bateau-feu Tz: col(row, "APD") != null && col(row, "APD") <= 20 ? col(row, "APD") : null, W_PDIR: col(row, "MWD"), TEMP: col(row, "WTMP"),
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

// Alertes « houle longue en approche »
let st = {}; try { st = JSON.parse(await readFile("bouees-state.json", "utf8")); } catch {}
for (const b of out.buoys.filter((x) => x.alert && x.last)) {
  const A = b.alert, L = b.last, d = L.W_PDIR;
  if (!(TOPIC && L.Tpeak >= A.minTp && L.Hm0 >= A.minHs && inSector(d, A.dirFrom, A.dirTo))) continue;
  if (st[b.id] && Date.now() - st[b.id] < COOLDOWN_H * 3600e3) continue;
  const eta = Math.round((b.distKm / (0.78 * L.Tpeak * 3.6)) * 10) / 10; // vitesse de groupe en eau profonde
  // Heure d'arrivée comptée depuis l'heure de la MESURE (pas de l'envoi de l'alerte).
  const arr = new Date(Date.parse(L.t) + eta * 3600e3).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
  // Taille attendue à la côte : ~10 % de Scilly (calage 11/11/2026 : 3,6-4,1 m / 12,5 s à Scilly → ~0,35 m à Ambleteuse).
  const coast = A.coastRatio ? ` · environ ${(L.Hm0 * A.coastRatio).toFixed(2).replace(".", ",")} m à la côte` : "";
  const res = await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: TOPIC, priority: 4, tags: ["ocean"], ...(SITE ? { click: SITE } : {}),
      title: `Houle longue détectée · ${b.label} · ${L.Tpeak} s`,
      message: `Hs ${L.Hm0} m · Tp ${L.Tpeak} s · venant de ${Math.round(d)}°.\nArrivée estimée ${arr}${coast} (${A.spots}).\nVérifie la bouée la plus proche avant de partir.` }) });
  if (res.ok) { st[b.id] = Date.now(); console.log("Alerte houle longue envoyée :", b.label); }
}
// Alerte « Calais marche » : mer de N à E formée dans le détroit (mesurée, pas prévue) et vent côtier faible ou de terre.
// Calée sur jeudi 05/11/2026 8 h : Sandettie 0,9 m, West Gabbard 2 1,7 m / 6 s ENE, Hastings 0,9 m / 6,3 s ENE, vent E 5-10 nds.
{
  const sand = out.buoys.find((b) => b.id === "62304")?.last, wgB = out.buoys.find((b) => b.id === "WGABBARD"), wg = wgB?.last;
  const wgName = (wgB?.label || "West Gabbard").split(" (")[0];
  const fresh = (L) => L && Date.now() - Date.parse(L.t) < 3 * 3600e3;
  const sandOk = fresh(sand) && sand.Hm0 >= 0.8;
  // Seuil selon la bouée : West Gabbard 2 1,4 m (05/11) ; South Knock en relais, plus abritée, 0,9 m (13/11 : 1,0-1,2 m / 6-8 s, ça marchait à Calais).
  const wgMin = wgB?.relayOf && /KNOCK/i.test(wgB.label) ? 0.9 : 1.4;
  const wgOk = fresh(wg) && wg.Hm0 >= wgMin && (wg.Tpeak ?? 0) >= 5.5 && inSector(wg.W_PDIR, 330, 100);
  let obs = null; try { obs = JSON.parse(await readFile("obs.json", "utf8")).stations.find((s) => s.key === "calais"); } catch {}
  // Plage de Calais orientée ~345° : vent de 60 à 230° = de terre ou travers ; sinon il faut qu'il soit tombé.
  const windOk = obs && obs.wind != null && (obs.wind <= 12 || (inSector(obs.dir, 60, 230) && obs.wind <= 18));
  const hour = parseInt(new Intl.DateTimeFormat("fr-FR", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/Paris" }).format(new Date()), 10);
  console.log(`Calais : Sandettie ${sand?.Hm0 ?? "—"} m · ${wgName} ${wg?.Hm0 ?? "—"} m ${wg?.Tpeak ?? "—"} s · vent ${obs?.wind ?? "—"} nds ${obs?.dir ?? "—"}° → ${(sandOk || wgOk) && windOk ? "ça peut marcher" : "non"}`);
  if (TOPIC && (sandOk || wgOk) && windOk && hour >= 5 && hour <= 16 && !(st.calais && Date.now() - st.calais < COOLDOWN_H * 3600e3)) {
    // Prochaine pleine mer à Calais (modèle Open-Meteo, indicatif).
    let pm = "";
    try {
      const r = await fetch("https://marine-api.open-meteo.com/v1/marine?latitude=50.985&longitude=1.84&hourly=sea_level_height_msl&timezone=Europe%2FParis&forecast_days=2");
      const h = (await r.json()).hourly; const now = new Date().toISOString().slice(0, 13);
      for (let k = 1; k < h.time.length - 1; k++) {
        const [a, b, c] = [h.sea_level_height_msl[k - 1], h.sea_level_height_msl[k], h.sea_level_height_msl[k + 1]];
        if (b > a && b >= c && Date.parse(h.time[k]) > Date.now() - 3600e3) { pm = `Pleine mer vers ${h.time[k].slice(11, 13)} h (modèle, vérifie SHOM) : vise les 2-3 h avant.`; break; }
      }
    } catch {}
    const res = await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: TOPIC, priority: 4, tags: ["ocean"], ...(SITE ? { click: SITE } : {}),
        title: "Calais peut marcher · mer de NE formée",
        message: `Sandettie ${fresh(sand) ? sand.Hm0 + " m" : "muette"} · ${wgName} ${wg?.Hm0 ?? "—"} m / ${wg?.Tpeak ?? "—"} s ${wg?.W_PDIR != null ? Math.round(wg.W_PDIR) + "°" : ""}\nVent à Calais ${obs.wind} nds du ${obs.dir}°.\n${pm || "Vise la fin du montant."}` }) });
    if (res.ok) { st.calais = Date.now(); console.log("Alerte Calais envoyée"); }
  }
}
await writeFile("bouees-state.json", JSON.stringify(st) + "\n");
