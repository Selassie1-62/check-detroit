// Robot MARC (Ifremer, modèle de vagues WW3) — version TEST.
// 1. Explore le serveur de données d'Ifremer (THREDDS) et liste les prévisions de vagues WW3.
// 2. Pour celles qui couvrent Wimereux, lit les variables disponibles et extrait la série au point de Wimereux.
// 3. Écrit tout dans marc.json (et dans le journal du robot) pour qu'on voie ce qui est accessible.
import { writeFile } from "node:fs/promises";

const PT = { name: "Wimereux", lat: 50.7793, lon: 1.582 }; // point MARC regardé par Henry (50°46,76' N, 1°34,92' E)
const HOSTS = ["https://tds1.ifremer.fr", "https://tds3.ifremer.fr"];
const WANT = ["hs", "t02", "t0m1", "fp", "tp", "dir", "dp", "phs0", "phs1", "phs2", "ptp0", "ptp1", "ptp2", "pdir0", "pdir1", "pdir2", "uwnd", "vwnd"];
const MAX_FETCH = 150;
let nFetch = 0;
const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };

async function get(url, ms = 20000) {
  if (++nFetch > MAX_FETCH) throw new Error("trop de requêtes");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "check-detroit (github.com/Selassie1-62/check-detroit)" } });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) {
    return { ok: false, status: 0, text: String(e.message || e) };
  } finally { clearTimeout(t); }
}

// --- 1. Exploration des catalogues ---
const datasets = new Map(); // urlPath -> {host, name, urlPath}
// Jeux connus (fiches Sextant d'Ifremer), testés même si l'exploration échoue
for (const [host, urlPath] of [
  ["https://tds1.ifremer.fr", "MARC-WW3_NORGAS_2MIN-FOR_FULL_TIME_SERIE"],
  ["https://tds3.ifremer.fr", "IOWAGA-WW3-FORECAST_GLOBMULTI_ATNE-10M_FIELD_NC_MARC_WW3-ATNE-10M"],
]) datasets.set(urlPath, { host, name: "connu", urlPath });
for (const host of HOSTS) {
  const queue = [`${host}/thredds/catalog.xml`, `${host}/thredds/catalog/catalog.xml`];
  const seen = new Set();
  let depth = 0;
  while (queue.length && depth < 400) {
    const url = queue.shift(); depth++;
    if (seen.has(url)) continue; seen.add(url);
    const r = await get(url);
    if (!r.ok) { say(`catalogue ${url} → ${r.status} ${r.status ? "" : r.text}`); continue; }
    const attr = (tag, k) => (tag.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || "";
    for (const [tag] of r.text.matchAll(/<catalogRef[^>]*>/g)) {
      const href = attr(tag, "xlink:href"), title = attr(tag, "xlink:title");
      if (!href) continue;
      // On ne descend que dans ce qui parle de vagues / WW3 / MARC / Manche
      if (!/ww3|wave|vague|marc|manche|norgas|manga|iowaga/i.test(href + title)) continue;
      const next = new URL(href, url).href;
      if (!seen.has(next)) queue.push(next);
    }
    for (const [tag] of r.text.matchAll(/<dataset[^>]*urlPath="[^"]+"[^>]*>/g)) {
      const name = attr(tag, "name"), urlPath = attr(tag, "urlPath");
      if (/ww3/i.test(name + urlPath)) datasets.set(urlPath, { host, name, urlPath });
    }
    if (nFetch > MAX_FETCH - 30) break;
  }
}
say(`${datasets.size} jeu(x) de données WW3 trouvés :`);
for (const d of datasets.values()) say(`  - ${d.host.replace("https://", "")} ${d.urlPath} (${d.name})`);

// --- 2. Couverture de Wimereux, variables, extraction ---
const prio = (d) => (/manche|manga|channel|200m|norgas/i.test(d.urlPath) ? 0 : /atne|10m/i.test(d.urlPath) ? 1 : 2) + (/full_time|best|latest/i.test(d.urlPath) ? 0 : 0.5);
const cands = [...datasets.values()].filter((d) => /for/i.test(d.urlPath) || /forecast/i.test(d.name)).sort((a, b) => prio(a) - prio(b)).slice(0, 10);
const results = [];
for (const d of cands) {
  const base = `${d.host}/thredds/ncss/${d.urlPath}`;
  const meta = await get(`${base}/dataset.xml`);
  if (!meta.ok) { say(`✗ ${d.urlPath} : extraction ponctuelle refusée (${meta.status})`); results.push({ ...d, ok: false, why: `dataset.xml ${meta.status}` }); continue; }
  const vars = [...meta.text.matchAll(/<grid name="([^"]+)"/g)].map((m) => m[1]);
  const box = (k) => { const m = meta.text.match(new RegExp(`<${k}>([-\\d.]+)</${k}>`)); return m ? +m[1] : null; };
  const W = box("west"), E = box("east"), S = box("south"), N = box("north");
  const covers = W == null || (PT.lon >= W && PT.lon <= E && PT.lat >= S && PT.lat <= N);
  say(`• ${d.urlPath} : ${vars.length} variables, zone ${W}..${E} E / ${S}..${N} N ${covers ? "→ couvre Wimereux" : "→ hors zone"}`);
  if (!covers) { results.push({ ...d, ok: false, why: "hors zone", vars }); continue; }
  const use = WANT.filter((v) => vars.includes(v));
  if (!use.length) { say(`  aucune variable utile (${vars.slice(0, 20).join(", ")})`); results.push({ ...d, ok: false, why: "pas de variable utile", vars }); continue; }
  const q = use.map((v) => `var=${v}`).join("&") + `&latitude=${PT.lat}&longitude=${PT.lon}&time_start=present&time_duration=P3D&accept=csv`;
  const r = await get(`${base}?${q}`, 45000);
  if (!r.ok) { say(`  extraction ${r.status} : ${r.text.slice(0, 200)}`); results.push({ ...d, ok: false, why: `csv ${r.status}`, vars }); continue; }
  const lines = r.text.trim().split("\n");
  say(`  ✓ ${lines.length - 1} pas de temps. Extrait :`);
  for (const l of lines.slice(0, 6)) say(`    ${l}`);
  results.push({ ...d, ok: true, vars: use, csv: lines.slice(0, 80) });
}

await writeFile("marc.json", JSON.stringify({ generatedAt: new Date().toISOString(), point: PT, requests: nFetch, results, log }, null, 1) + "\n");
const good = results.filter((r) => r.ok);
say(good.length ? `MARC accessible : ${good.map((r) => r.urlPath).join(", ")}` : "Aucune extraction MARC réussie (voir le journal).");
