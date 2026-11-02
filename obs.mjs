// Robot « vent mesuré » : lit les sémaphores et stations côtières Météo-France (API publique DPObs,
// mesures toutes les 6 minutes) et écrit obs.json, que la page affiche.
// La clé reste secrète (secret GitHub MF_APIKEY) : la page publique ne lit que obs.json.
import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.MF_APIKEY;
const BASE = "https://public-api.meteofrance.fr/public/DPObs/v1";
// Stations recherchées par nom dans la liste Météo-France (sémaphores et stations du littoral).
const WANTED = [
  { key: "grisnez", label: "Cap Gris-Nez", re: /GRIS.?NEZ/i },
  { key: "boulogne", label: "Boulogne (sémaphore)", re: /BOULOGNE/i },
  { key: "calais", label: "Calais", re: /CALAIS/i },
  { key: "dunkerque", label: "Dunkerque", re: /DUNKERQUE/i },
  { key: "touquet", label: "Le Touquet", re: /TOUQUET/i },
];
const KT = 1.943844; // m/s → nœuds

if (!KEY) { console.error("MF_APIKEY manquant (Settings > Secrets and variables > Actions)."); process.exit(1); }
const H = { apikey: KEY, accept: "application/json" };

async function get(path) {
  const r = await fetch(BASE + path, { headers: H });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${path} ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { return txt; }
}

// Liste des stations : mise en cache dans stations-mf.json (elle change rarement).
async function stations() {
  try { return JSON.parse(await readFile("stations-mf.json", "utf8")); } catch {}
  const raw = await get("/liste-stations?format=json");
  const rows = Array.isArray(raw) ? raw : (raw.stations || raw.features?.map((f) => f.properties) || []);
  const found = [];
  for (const w of WANTED) {
    const row = rows.find((r) => Object.values(r).some((v) => typeof v === "string" && w.re.test(v)));
    if (!row) { console.log("Station introuvable :", w.label); continue; }
    const id = row.id ?? row.Id_station ?? row.id_station ?? row.ID ?? row.Id;
    const name = Object.values(row).find((v) => typeof v === "string" && w.re.test(v));
    found.push({ key: w.key, label: w.label, id: String(id), name });
  }
  await writeFile("stations-mf.json", JSON.stringify(found, null, 2) + "\n");
  console.log("Stations retenues :", found.map((s) => `${s.label} (${s.id}, ${s.name})`).join(" · "));
  return found;
}

const list = await stations();
const out = { updatedAt: new Date().toISOString(), source: "Météo-France, données d'observation (DPObs)", stations: [] };
for (const s of list) {
  try {
    const raw = await get(`/station/infrahoraire-6m?id_station=${encodeURIComponent(s.id)}&format=json`);
    const arr = Array.isArray(raw) ? raw : [raw];
    const last = arr.filter((o) => o && o.ff != null).sort((a, b) => String(b.validity_time).localeCompare(String(a.validity_time)))[0];
    if (!last) { out.stations.push({ ...s, error: "pas de mesure de vent" }); continue; }
    out.stations.push({
      ...s, time: last.validity_time,
      wind: Math.round(last.ff * KT), dir: last.dd ?? null,
      gust: last.fxi10 != null ? Math.round(last.fxi10 * KT) : null,
      tempC: last.t != null ? Math.round((last.t - 273.15) * 10) / 10 : null,
    });
  } catch (e) { out.stations.push({ ...s, error: String(e.message).slice(0, 120) }); }
}
await writeFile("obs.json", JSON.stringify(out, null, 2) + "\n");
console.log(out.stations.map((s) => s.error ? `${s.label}: ${s.error}` : `${s.label}: ${s.wind} nds (raf. ${s.gust}) ${s.dir}°`).join("\n"));
