// Robot MARC (Ifremer, modèle de vagues WAVEWATCH III, grille NORGAS 2' ≈ 3 km).
// Toutes les 6 h : extrait 3 jours de prévision horaire au point de chaque spot et écrit marc.json.
// Partitions WW3 : 0 = mer du vent, 1 = houle principale, 2 = houle secondaire.
// marc.json garde aussi un historique (hist) : MARC et EWAM à l'heure du passage au point de Wimereux,
// pour les comparer à la bouée d'Ambleteuse avant de décider quel modèle pilote la période.
import { readFile, writeFile } from "node:fs/promises";
import { SPOTS, toLocalIso } from "./logic.js";

const HOST = "https://tds1.ifremer.fr";
const DS = "MARC-WW3_NORGAS_2MIN-FOR_FULL_TIME_SERIE";
const VARS = ["hs", "t02", "fp", "dir", "phs0", "phs1", "phs2", "ptp0", "ptp1", "ptp2", "pdir0", "pdir1", "pdir2"];
// Facteurs d'échelle relevés le 23/11/2026 (les valeurs du CSV sont des entiers compactés) ; relus dans le .das si possible
let SCALE = { hs: 0.002, t02: 0.01, fp: 0.001, dir: 0.1, phs0: 0.002, phs1: 0.002, phs2: 0.002, ptp0: 0.01, ptp1: 0.01, ptp2: 0.01, pdir0: 0.1, pdir1: 0.1, pdir2: 0.1 };
const FILL = -32767;

async function get(url, ms = 45000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "check-detroit (github.com/Selassie1-62/check-detroit)" } });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) { return { ok: false, status: 0, text: String(e.message || e) }; }
  finally { clearTimeout(t); }
}

// 1. Facteurs d'échelle officiels (attributs OPeNDAP)
const das = await get(`${HOST}/thredds/dodsC/${DS}.das`);
if (das.ok) {
  for (const v of VARS) {
    const m = das.text.match(new RegExp(`\\n\\s*${v} \\{([\\s\\S]*?)\\n\\s*\\}`));
    const sf = m && m[1].match(/scale_factor\s+([-\d.eE]+)/);
    if (sf) SCALE[v] = +sf[1];
  }
  console.log("Échelles (.das) :", JSON.stringify(SCALE));
} else console.log(`.das indisponible (${das.status}) : échelles par défaut`);

const val = (raw, v) => (raw === "" || raw == null || +raw === FILL || Number.isNaN(+raw) ? null : Math.round(+raw * SCALE[v] * 100) / 100);
const part = (r, i) => (r[`phs${i}`] == null ? null : { h: r[`phs${i}`], t: r[`ptp${i}`], d: r[`pdir${i}`] });

// 2. Extraction par spot
const out = { generatedAt: new Date().toISOString(), source: "Ifremer MARC, WAVEWATCH III NORGAS 2' (Licence ouverte)", dataset: DS, scale: SCALE, spots: {} };
for (const s of SPOTS) {
  const q = VARS.map((v) => `var=${v}`).join("&") + `&latitude=${s.lat}&longitude=${s.lon}&time_start=present&time_duration=P3D&accept=csv`;
  const r = await get(`${HOST}/thredds/ncss/${DS}?${q}`);
  if (!r.ok) { console.log(`✗ ${s.id} : ${r.status} ${r.text.slice(0, 120)}`); continue; }
  const [head, ...rows] = r.text.trim().split("\n");
  const cols = head.split(",").map((c) => c.split("[")[0]);
  out.spots[s.id] = rows.map((line) => {
    const f = line.split(","), raw = Object.fromEntries(cols.map((c, k) => [c, f[k]]));
    const x = Object.fromEntries(VARS.map((v) => [v, val(raw[v], v)]));
    return {
      t: toLocalIso(new Date(raw.time)), hs: x.hs, tm: x.t02, tp: x.fp ? Math.round((1 / x.fp) * 10) / 10 : null, dir: x.dir,
      ws: part(x, 0), sw1: part(x, 1), sw2: part(x, 2),
    };
  });
  const a = out.spots[s.id][0];
  console.log(`✓ ${s.id} : ${rows.length} h · maintenant ${a?.hs} m, Tp ${a?.tp} s, houle ${a?.sw1?.h} m ${a?.sw1?.t} s ${a?.sw1?.d}°`);
}

// 3. Historique de comparaison au point de Wimereux (MARC et EWAM à l'heure du passage)
let hist = [];
try { hist = JSON.parse(await readFile("marc.json", "utf8")).hist || []; } catch {}
try {
  // Heure pleine la plus proche (le premier pas MARC peut être l'heure suivante)
  const next = toLocalIso(new Date(Date.now() + 30 * 60000)).slice(0, 13);
  const m = (out.spots.wimereux || []).find((h) => h.t.slice(0, 13) === next) || (out.spots.wimereux || [])[0];
  const prev = JSON.parse(await readFile("prevision.json", "utf8"));
  const e = m && (prev.spots?.wimereux?.hours || []).find((h) => h.t.slice(0, 13) === m.t.slice(0, 13));
  if (m) hist.push({ t: m.t, marc: { hs: m.hs, tp: m.tp, sw: m.sw1, ws: m.ws }, ewam: e ? { hs: e.hs, swh: e.swh, swp: e.swp, swd: e.swd, wwh: e.wwh } : null });
} catch (err) { console.log("historique :", err.message); }
out.hist = hist.slice(-400);

await writeFile("marc.json", JSON.stringify(out) + "\n");
console.log(`marc.json écrit : ${Object.keys(out.spots).length} spots, ${out.hist.length} point(s) d'historique`);
