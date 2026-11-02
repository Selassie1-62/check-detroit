// Check Détroit — logique partagée par la page (navigateur) et le robot d'alertes (Node 20+).
// Données : Open-Meteo (usage non commercial, attribution DWD / Météo-France / ECMWF / NOAA).

export const SPOTS = [
  { id: "hardelot", name: "Hardelot", short: "Hardelot", lat: 50.635, lon: 1.54, facing: 275 },
  { id: "equihen", name: "Équihen · Le Portel", short: "Équihen", lat: 50.68, lon: 1.53, facing: 270 },
  { id: "boulogne", name: "Boulogne-sur-Mer", short: "Boulogne", lat: 50.735, lon: 1.55, facing: 290 },
  { id: "wimereux", name: "Wimereux · Ambleteuse · Audresselles", short: "Wimereux", lat: 50.81, lon: 1.54, facing: 270 },
  { id: "wissant", name: "Wissant · Tardinghen", short: "Wissant", lat: 50.92, lon: 1.64, facing: 315 },
  { id: "sangatte", name: "Sangatte · Blériot · Calais", short: "Calais", lat: 50.98, lon: 1.78, facing: 335 },
];

// Parcours de downwind : sens du vent acceptable (provenance, degrés) et côte longée.
export const RUNS = [
  { id: "gn-sangatte", name: "Gris-Nez → Sangatte", spot: "wissant", facing: 315, wind: [195, 285], ideal: [215, 255], km: 14 },
  { id: "sangatte-wissant", name: "Sangatte / Escalles → Wissant", spot: "wissant", facing: 315, wind: [320, 50], ideal: [340, 25], km: 10 },
  { id: "wimereux-audresselles", name: "Wimereux → Audresselles", spot: "wimereux", facing: 270, wind: [165, 235], ideal: [180, 215], km: 8 },
  { id: "hardelot-portel", name: "Hardelot → Le Portel", spot: "equihen", facing: 270, wind: [165, 235], ideal: [180, 215], km: 8 },
  { id: "portel-hardelot", name: "Le Portel → Hardelot", spot: "equihen", facing: 270, wind: [310, 20], ideal: [330, 5], km: 8 },
  { id: "audresselles-wimereux", name: "Audresselles → Wimereux", spot: "wimereux", facing: 270, wind: [310, 20], ideal: [330, 5], km: 8 },
];

// Modèles et poids (tirés des comparaisons avec la bouée d'Ambleteuse, octobre 2026).
export const WIND_MODELS = [
  { key: "arome", label: "AROME HD", ids: ["meteofrance_arome_france_hd", "meteofrance_arome_france"], weight: 2.0 },
  { key: "icond2", label: "ICON-D2", ids: ["icon_d2", "dwd_icon_d2"], weight: 1.4 },
  { key: "ecmwf", label: "ECMWF", ids: ["ecmwf_ifs025", "ecmwf_ifs"], weight: 1.0 },
  { key: "gfs", label: "GFS", ids: ["gfs_seamless", "ncep_gfs_seamless"], weight: 0.6 },
];
export const WAVE_MODELS = [
  { key: "ewam", label: "ICON-EWAM", ids: ["ewam", "dwd_ewam"], weight: 2.0 },
  { key: "mfwam", label: "MFWAM", ids: ["meteofrance_wave"], weight: 1.4 },
  { key: "ecwam", label: "ECMWF-WAM", ids: ["ecmwf_wam", "ecmwf_wam025"], weight: 1.0 },
  { key: "gfswave", label: "GFS-Wave", ids: ["ncep_gfswave025", "ncep_gfswave016"], weight: 0.4 },
];

export const THRESHOLDS = {
  prone: { goPower: 1.5, goPeriod: 8, maybePower: 0.8, maybePeriod: 6.5, maxHs: 2.2 },
  downwind: { paddle: 18, wing: 14, maxMean: 28, maxGust: 32, bumpsHs: 0.6, bumpsT: 4.5 },
  wing: { min: 12, max: 28, maxGust: 34 },
};

const WIND_VARS = "wind_speed_10m,wind_direction_10m,wind_gusts_10m";
const WAVE_VARS = "wave_height,wave_period,wave_direction,wind_wave_height,wind_wave_period,wind_wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction";
const SEA_VARS = "sea_level_height_msl,sea_surface_temperature";

// ---------- utilitaires ----------
export const angDiff = (a, b) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; };
const inRange = (dir, [a, b]) => (a <= b ? dir >= a && dir <= b : dir >= a || dir <= b);
export const power = (hs, t) => 0.49 * hs * hs * t; // kW/m
const round = (x, n = 1) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
export const compass = (d) => (d == null ? "—" : COMPASS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16]);

// Type de vent par rapport à la côte : facing = direction vers le large.
export function shoreType(windFrom, facing) {
  const d = angDiff(windFrom, facing); // 0 = plein onshore (le vent vient du large)
  if (d <= 35) return { key: "on", label: "onshore" };
  if (d <= 75) return { key: "sideon", label: "side-onshore" };
  if (d <= 105) return { key: "side", label: "side-shore" };
  if (d <= 145) return { key: "sideoff", label: "side-offshore" };
  return { key: "off", label: "offshore" };
}

// ---------- récupération ----------
async function getJSON(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new Error((j && j.reason) || `HTTP ${r.status}`);
  return j;
}

// Une requête par modèle, toutes les positions à la fois ; essaie les identifiants de secours.
async function fetchModel(base, vars, model, extra) {
  const lat = SPOTS.map((s) => s.lat).join(","), lon = SPOTS.map((s) => s.lon).join(",");
  let lastErr;
  for (const id of model.ids) {
    const url = `${base}?latitude=${lat}&longitude=${lon}&hourly=${vars}&models=${id}&timezone=Europe%2FParis&forecast_days=4${extra || ""}`;
    try {
      const j = await getJSON(url);
      const arr = Array.isArray(j) ? j : [j];
      return { model, id, data: arr };
    } catch (e) { lastErr = e; }
  }
  return { model, error: String(lastErr && lastErr.message || lastErr) };
}

export async function fetchAll() {
  const W = "https://api.open-meteo.com/v1/forecast";
  const M = "https://marine-api.open-meteo.com/v1/marine";
  const jobs = [
    ...WIND_MODELS.map((m) => fetchModel(W, WIND_VARS, m, "&wind_speed_unit=kn")),
    ...WAVE_MODELS.map((m) => fetchModel(M, WAVE_VARS, m)),
  ];
  const lat = SPOTS.map((s) => s.lat).join(","), lon = SPOTS.map((s) => s.lon).join(",");
  const sea = getJSON(`${M}?latitude=${lat}&longitude=${lon}&hourly=${SEA_VARS}&timezone=Europe%2FParis&forecast_days=4`).catch((e) => ({ error: String(e.message) }));
  const sun = getJSON(`${W}?latitude=${SPOTS[0].lat}&longitude=${SPOTS[0].lon}&daily=sunrise,sunset&timezone=Europe%2FParis&forecast_days=4`).catch(() => null);
  const res = await Promise.all(jobs);
  return { wind: res.slice(0, WIND_MODELS.length), wave: res.slice(WIND_MODELS.length), sea: await sea, sun: await sun, fetchedAt: new Date().toISOString() };
}

// ---------- assemblage ----------
function wmean(items) { // items: [{v, w}]
  const ok = items.filter((x) => x.v != null && !Number.isNaN(x.v));
  if (!ok.length) return null;
  const sw = ok.reduce((a, x) => a + x.w, 0);
  return ok.reduce((a, x) => a + x.v * x.w, 0) / sw;
}
function wdir(items) { // moyenne vectorielle pondérée d'angles (provenance)
  const ok = items.filter((x) => x.v != null);
  if (!ok.length) return null;
  let sx = 0, sy = 0;
  ok.forEach((x) => { const r = (x.v * Math.PI) / 180; sx += Math.sin(r) * x.w; sy += Math.cos(r) * x.w; });
  return ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360;
}
const spread = (vals) => { const v = vals.filter((x) => x != null); return v.length > 1 ? Math.max(...v) - Math.min(...v) : null; };

export function buildHours(raw) {
  const spots = {};
  SPOTS.forEach((s, i) => {
    const byTime = new Map();
    const slot = (t) => { if (!byTime.has(t)) byTime.set(t, { t, wind: {}, wave: {} }); return byTime.get(t); };
    raw.wind.forEach((r) => {
      const d = r.data && r.data[i]; if (!d || !d.hourly) return;
      d.hourly.time.forEach((t, k) => {
        const s_ = d.hourly.wind_speed_10m[k]; if (s_ == null) return;
        slot(t).wind[r.model.key] = { s: s_, d: d.hourly.wind_direction_10m[k], g: d.hourly.wind_gusts_10m[k] };
      });
    });
    raw.wave.forEach((r) => {
      const d = r.data && r.data[i]; if (!d || !d.hourly) return;
      const h = d.hourly;
      h.time.forEach((t, k) => {
        if (h.wave_height[k] == null) return;
        slot(t).wave[r.model.key] = {
          hs: h.wave_height[k], t: h.wave_period ? h.wave_period[k] : null, dir: h.wave_direction ? h.wave_direction[k] : null,
          wwh: h.wind_wave_height ? h.wind_wave_height[k] : null, wwp: h.wind_wave_period ? h.wind_wave_period[k] : null, wwd: h.wind_wave_direction ? h.wind_wave_direction[k] : null,
          swh: h.swell_wave_height ? h.swell_wave_height[k] : null, swp: h.swell_wave_period ? h.swell_wave_period[k] : null, swd: h.swell_wave_direction ? h.swell_wave_direction[k] : null,
        };
      });
    });
    const seaArr = raw.sea && !raw.sea.error ? (Array.isArray(raw.sea) ? raw.sea : [raw.sea]) : [];
    const sd = seaArr[i] && seaArr[i].hourly;
    if (sd) sd.time.forEach((t, k) => { const o = slot(t); o.tide = sd.sea_level_height_msl ? sd.sea_level_height_msl[k] : null; o.sst = sd.sea_surface_temperature ? sd.sea_surface_temperature[k] : null; });

    const hours = [...byTime.values()].sort((a, b) => (a.t < b.t ? -1 : 1)).map((h) => {
      const w = WIND_MODELS.filter((m) => h.wind[m.key]);
      const v = WAVE_MODELS.filter((m) => h.wave[m.key]);
      const W = (f) => w.map((m) => ({ v: h.wind[m.key][f], w: m.weight }));
      const V = (f) => v.map((m) => ({ v: h.wave[m.key][f], w: m.weight }));
      h.c = {
        wind: wmean(W("s")), gust: wmean(W("g")), wdir: wdir(W("d")),
        hs: wmean(V("hs")), tm: wmean(V("t")),
        wwh: wmean(V("wwh")), wwp: wmean(V("wwp")), wwd: wdir(V("wwd")),
        swh: wmean(V("swh")), swp: wmean(V("swp")), swd: wdir(V("swd")),
        nWind: w.length, nWave: v.length,
        windSpread: spread(w.map((m) => h.wind[m.key].s)), hsSpread: spread(v.map((m) => h.wave[m.key].hs)),
      };
      return h;
    });
    spots[s.id] = { spot: s, hours, tides: tideExtremes(hours) };
  });
  return spots;
}

export function tideExtremes(hours) {
  const out = [];
  for (let k = 1; k < hours.length - 1; k++) {
    const a = hours[k - 1].tide, b = hours[k].tide, c = hours[k + 1].tide;
    if (a == null || b == null || c == null) continue;
    if (b > a && b >= c) out.push({ t: hours[k].t, type: "PM", h: b });
    if (b < a && b <= c) out.push({ t: hours[k].t, type: "BM", h: b });
  }
  return out;
}

export function daylight(sun) {
  if (!sun || !sun.daily) return null;
  return sun.daily.time.map((d, k) => ({ day: d, rise: sun.daily.sunrise[k], set: sun.daily.sunset[k] }));
}
export function isDay(t, days) {
  if (!days) { const h = +t.slice(11, 13); return h >= 8 && h <= 18; }
  const d = days.find((x) => x.day === t.slice(0, 10));
  return d ? t >= d.rise.slice(0, 13) && t <= d.set : true;
}

// ---------- évaluations ----------
const confidence = (c) => {
  if (c.nWind < 2 && c.nWave < 2) return "faible";
  const ws = c.windSpread ?? 0, hs = c.hsSpread ?? 0;
  if (ws <= 4 && hs <= 0.3) return "haute";
  if (ws <= 8 && hs <= 0.6) return "moyenne";
  return "faible";
};

export function evalProne(c, spot) {
  const swh = c.swh ?? 0, swp = c.swp ?? c.tm ?? 0, swd = c.swd ?? c.wwd;
  const exp = swd == null ? 0.6 : (() => { const d = angDiff(swd, spot.facing); return d <= 45 ? 1 : d <= 75 ? 0.6 : d <= 100 ? 0.25 : 0; })();
  const heff = swh * exp, P = power(heff, swp);
  const st = c.wdir == null ? { key: "side" } : shoreType(c.wdir, spot.facing);
  const w = c.wind ?? 0;
  const clean = w < 8 || ((st.key === "off" || st.key === "sideoff") && w <= 18) || (st.key === "side" && w <= 11);
  const messy = (st.key === "on" || st.key === "sideon") && w >= 12;
  const T = THRESHOLDS.prone;
  let level = "no";
  if (P >= T.goPower && swp >= T.goPeriod && clean && heff <= T.maxHs) level = "go";
  else if (P >= T.maybePower && swp >= T.maybePeriod && !messy && heff <= T.maxHs + 0.5) level = "maybe";
  const why = [`houle ${round(heff)} m · ${round(swp, 0)} s ${compass(swd)}`, `${round(P)} kW/m`, `vent ${round(w, 0)} nds ${st.label || ""}`.trim()];
  if (heff > T.maxHs) why.push("trop gros");
  return { level, score: Math.min(100, Math.round((P / 3) * 60 + (clean ? 30 : 0) + Math.min(10, swp))), P: round(P), heff: round(heff), swp: round(swp, 0), why };
}

export function evalDownwind(c, run) {
  const T = THRESHOLDS.downwind;
  const w = c.wind ?? 0, g = c.gust ?? w, d = c.wdir;
  if (d == null) return { level: "no", why: ["vent inconnu"] };
  const st = shoreType(d, run.facing);
  const dirOk = inRange(d, run.wind), ideal = inRange(d, run.ideal);
  const safe = !(st.key === "off" || st.key === "sideoff");
  const bumps = (c.wwh ?? c.hs ?? 0) >= T.bumpsHs && (c.wwp ?? c.tm ?? 0) >= T.bumpsT;
  const weakBumps = (c.wwh ?? c.hs ?? 0) >= 0.4 && (c.wwp ?? c.tm ?? 0) >= 4;
  const tooMuch = w > T.maxMean || g > T.maxGust + 4;
  let level = "no", support = null;
  if (dirOk && safe && !tooMuch && bumps && w >= T.paddle && g <= T.maxGust) { level = "go"; support = "paddle"; }
  else if (dirOk && safe && !tooMuch && weakBumps && w >= T.wing && g <= T.maxGust + 4) { level = w >= T.paddle ? "go" : "maybe"; support = "wing"; }
  const why = [`vent ${round(w, 0)} nds (raf. ${round(g, 0)}) ${compass(d)}`, `bosses ${round(c.wwh ?? c.hs)} m · ${round(c.wwp ?? c.tm, 1)} s`];
  if (!safe) why.push(`${st.label} : dangereux`);
  else if (!dirOk) why.push("mauvais axe");
  if (tooMuch) why.push("trop fort");
  const score = level === "no" ? 0 : Math.min(100, Math.round(40 + (w - T.wing) * 3 + (ideal ? 15 : 0) + (bumps ? 15 : 0)));
  return { level, support, score, why };
}

export function evalWing(c, spot, weight) {
  const T = THRESHOLDS.wing; const w = c.wind ?? 0, g = c.gust ?? w;
  if (c.wdir == null) return { level: "no", why: [] };
  const st = shoreType(c.wdir, spot.facing);
  const safe = !(st.key === "off" || st.key === "sideoff");
  let level = "no";
  if (safe && w >= T.min + 2 && w <= T.max && g <= T.maxGust) level = "go";
  else if (safe && w >= T.min && w <= T.max + 2 && g <= T.maxGust + 4) level = "maybe";
  return { level, score: level === "no" ? 0 : Math.round(50 + Math.min(30, w)), size: wingSize(w, weight), why: [`${round(w, 0)} nds (raf. ${round(g, 0)}) ${compass(c.wdir)} ${st.label}`] };
}

export const wingSize = (kt, kg = 75) => {
  if (!kt || kt < 8) return null;
  const a = Math.max(2.5, Math.min(7, (kg * 1.1) / kt));
  return Math.round(a * 2) / 2;
};

// ---------- fenêtres ----------
const LV = { no: 0, maybe: 1, go: 2 };
function windowsFrom(hours, evalFn, meta, days, nowIso, endIso) {
  const out = []; let cur = null;
  const end = endIso.slice(0, 13);
  hours.forEach((h) => {
    if (h.t.slice(0, 13) < nowIso.slice(0, 13) || h.t.slice(0, 13) > end) return;
    const e = isDay(h.t, days) ? evalFn(h.c) : { level: "no" };
    if (e.level !== "no") {
      if (!cur) cur = { ...meta, start: h.t, end: h.t, best: e, level: e.level, conf: confidence(h.c), hours: 0 };
      cur.end = h.t; cur.hours++;
      if (LV[e.level] > LV[cur.level]) cur.level = e.level;
      if ((e.score ?? 0) > (cur.best.score ?? 0)) { cur.best = e; cur.conf = confidence(h.c); cur.peak = h.t; }
    } else if (cur) { out.push(cur); cur = null; }
  });
  if (cur) out.push(cur);
  return out.filter((w) => w.hours >= 2 || w.level === "go");
}

export function analyse(spots, days, { now = new Date(), weight = 75, horizonH = 78 } = {}) {
  const nowIso = toLocalIso(now), endIso = toLocalIso(new Date(now.getTime() + horizonH * 3600e3));
  const wins = [];
  SPOTS.forEach((s) => {
    const hrs = spots[s.id].hours;
    wins.push(...windowsFrom(hrs, (c) => evalProne(c, s), { kind: "prone", label: "Prone", where: s.short, spot: s.id }, days, nowIso, endIso));
    wins.push(...windowsFrom(hrs, (c) => evalWing(c, s, weight), { kind: "wing", label: "Wing", where: s.short, spot: s.id }, days, nowIso, endIso));
  });
  RUNS.forEach((r) => {
    wins.push(...windowsFrom(spots[r.spot].hours, (c) => evalDownwind(c, r), { kind: "downwind", label: "Downwind", where: r.name, run: r.id, spot: r.spot }, days, nowIso, endIso));
  });
  wins.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : LV[b.level] - LV[a.level]));
  return wins;
}

// Heure locale Europe/Paris au format « 2026-10-25T07:00 » (comme les réponses Open-Meteo).
export function toLocalIso(d) {
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return p.replace(" ", "T");
}

export function nowHour(spots, spotId, now = new Date()) {
  const iso = toLocalIso(now).slice(0, 13);
  return spots[spotId].hours.find((h) => h.t.slice(0, 13) === iso) || spots[spotId].hours[0];
}
