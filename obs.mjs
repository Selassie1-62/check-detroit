// Robot « vent mesuré » : lit les sémaphores et stations côtières Météo-France (API publique DPObs,
// mesures toutes les 6 minutes) et écrit obs.json, que la page affiche.
// La clé reste secrète (secret GitHub MF_APIKEY) : la page publique ne lit que obs.json.
import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.MF_APIKEY;
const BASES = ["https://public-api.meteofrance.fr/public/DPObs/v1", "https://public-api.meteofrance.fr/public/DPObs/v2"];
// Stations recherchées par nom dans la liste Météo-France (sémaphores et stations du littoral).
const WANTED = [
  { key: "grisnez", label: "Cap Gris-Nez (Audinghen)", re: /GRIS.?NEZ|AUDINGHEN/i },
  { key: "boulogne", label: "Boulogne (sémaphore)", re: /BOULOGNE/i },
  { key: "calais", label: "Calais", re: /CALAIS/i },
  { key: "dunkerque", label: "Dunkerque", re: /DUNKERQUE/i },
  { key: "touquet", label: "Le Touquet", re: /TOUQUET/i },
];
const KT = 1.943844; // m/s → nœuds

if (!KEY) { console.error("MF_APIKEY manquant (Settings > Secrets and variables > Actions)."); process.exit(1); }
// La clé peut être de type « API Key » (en-tête apikey) ou un jeton OAuth2 (en-tête Authorization) :
// on essaie les combinaisons et on garde celle qui marche.
const AUTHS = [{ apikey: KEY }, { Authorization: `Bearer ${KEY}` }];
let combo = null;
const errors = [];

function parse(txt) {
  try { return JSON.parse(txt); } catch {}
  const lines = txt.trim().split(/\r?\n/); if (lines.length < 2) return txt;
  const sep = lines[0].includes(";") ? ";" : ",";
  const head = lines[0].split(sep).map((h) => h.replace(/"/g, "").trim());
  return lines.slice(1).map((l) => { const c = l.split(sep).map((v) => v.replace(/"/g, "").trim()); const o = {};
    head.forEach((h, i) => { const n = Number(c[i]); o[h] = c[i] === "" ? null : Number.isNaN(n) ? c[i] : n; }); return o; });
}

async function get(path) {
  const tries = combo ? [combo] : BASES.flatMap((b) => AUTHS.map((a) => ({ base: b, auth: a })));
  for (const t of tries) {
    for (const fmt of ["json", "csv"]) {
      const url = t.base + path + (path.includes("?") ? "&" : "?") + "format=" + fmt;
      const r = await fetch(url, { headers: { ...t.auth, accept: "*/*" } });
      const txt = await r.text();
      if (r.ok) { if (!combo) { combo = t; console.log(`API Météo-France OK : ${t.base} · en-tête ${Object.keys(t.auth)[0]} · ${fmt}`); } return parse(txt); }
      errors.push(`${r.status} ${t.base.slice(-6)} ${Object.keys(t.auth)[0]} ${fmt} ${txt.slice(0, 90)}`);
      if (r.status === 401 || r.status === 403 || r.status === 404) break; // inutile d'essayer l'autre format
    }
  }
  throw new Error("Aucun accès ne fonctionne :\n  " + errors.slice(-8).join("\n  "));
}

// Liste des stations : mise en cache dans stations-mf.json (elle change rarement).
async function stations() {
  try { return JSON.parse(await readFile("stations-mf.json", "utf8")); } catch {}
  const raw = await get("/liste-stations");
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

let list;
try { list = await stations(); } catch (e) { console.error(e.message); process.exit(1); }
const out = { updatedAt: new Date().toISOString(), source: "Météo-France, données d'observation (DPObs)", stations: [] };
for (const s of list) {
  try {
    const raw = await get(`/station/infrahoraire-6m?id_station=${encodeURIComponent(s.id)}`);
    const arr = Array.isArray(raw) ? raw : [raw];
    const last = arr.filter((o) => o && o.ff != null).sort((a, b) => String(b.validity_time).localeCompare(String(a.validity_time)))[0];
    if (last && !process.env.OBS_KEYS_LOGGED) { console.log("Champs fournis :", Object.keys(last).join(", ")); process.env.OBS_KEYS_LOGGED = "1"; }
    if (!last) { out.stations.push({ ...s, error: "pas de mesure de vent" }); continue; }
    out.stations.push({
      ...s, time: last.validity_time,
      wind: Math.round(last.ff * KT), dir: last.dd ?? null,
      gust: (() => { const g = last.fxi10 ?? last.fxi ?? last.fxi3s ?? last.fxy; return g != null ? Math.round(g * KT) : null; })(),
      tempC: last.t != null ? Math.round((last.t - 273.15) * 10) / 10 : null,
    });
  } catch (e) { out.stations.push({ ...s, error: String(e.message).slice(0, 120) }); }
}
await writeFile("obs.json", JSON.stringify(out, null, 2) + "\n");
console.log(out.stations.map((s) => s.error ? `${s.label}: ${s.error}` : `${s.label}: ${s.wind} nds (raf. ${s.gust}) ${s.dir}°`).join("\n"));
