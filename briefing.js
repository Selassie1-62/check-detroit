// Beach marshal : le briefing des 3 prochaines heures, juste avant de se mettre à l'eau.
// Sources : AROME HD (Météo-France, pas de 15 min) via Open-Meteo pour le vent, les rafales et les averses ;
// marée et température de l'eau du Check ; vent mesuré aux sémaphores pour juger si la prévision colle à la réalité.
import { compass, shoreType, angDiff, toLocalIso, wingSize } from "./logic.js?v=7";

const W = "https://api.open-meteo.com/v1/forecast";
const r0 = (x) => Math.round(x);
const hm = (t) => t.slice(11, 16).replace(":", "h");

// Prévision au quart d'heure (AROME HD), avec repli sur la version « seamless » de Météo-France.
export async function fetchNowcast(spot) {
  for (const model of ["meteofrance_arome_france_hd", "meteofrance_seamless"]) {
    try {
      const url = `${W}?latitude=${spot.lat}&longitude=${spot.lon}&models=${model}&wind_speed_unit=kn&timezone=Europe%2FParis&forecast_days=2` +
        `&minutely_15=wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation&hourly=weather_code,cape,precipitation`;
      const r = await fetch(url); const j = await r.json();
      const m = j && j.minutely_15;
      if (!r.ok || !m || !m.time || !m.wind_speed_10m || m.wind_speed_10m.every((v) => v == null)) continue;
      return { model, m, h: j.hourly || null };
    } catch {}
  }
  return null;
}

// Pleines et basses mers à la minute près : parabole sur les 3 heures autour de chaque extremum horaire.
function tideTurns(hours) {
  const out = [];
  for (let k = 1; k < hours.length - 1; k++) {
    const a = hours[k - 1].tide, b = hours[k].tide, c = hours[k + 1].tide;
    if (a == null || b == null || c == null) continue;
    const pm = b > a && b >= c, bm = b < a && b <= c;
    if (!pm && !bm) continue;
    const den = a - 2 * b + c, off = den ? (0.5 * (a - c)) / den : 0; // décalage en heures (-0,5 → +0,5)
    const t = toLocalIso(new Date(Date.parse(hours[k].t + ":00") + off * 3600e3));
    out.push({ t, type: pm ? "PM" : "BM", h: b - 0.25 * (a - c) * off });
  }
  return out;
}
const tideAt = (hours, ms) => {
  const k = hours.findIndex((h) => Date.parse(h.t + ":00") > ms);
  if (k < 1 || hours[k].tide == null || hours[k - 1].tide == null) return null;
  const t0 = Date.parse(hours[k - 1].t + ":00"), f = (ms - t0) / 3600e3;
  return hours[k - 1].tide + f * (hours[k].tide - hours[k - 1].tide);
};

function suit(sst) {
  if (sst == null) return null;
  if (sst < 10) return "5/4 mm, cagoule, gants et chaussons";
  if (sst < 13) return "5/4 mm et chaussons (gants si tu restes longtemps)";
  if (sst < 16) return "4/3 mm, chaussons conseillés";
  if (sst < 19) return "3/2 mm";
  return "shorty ou 2 mm";
}

/**
 * @param o.spot spot (SPOTS), o.hours heures du Check pour ce spot, o.now Date,
 *        o.nc résultat de fetchNowcast, o.obs stations mesurées proches (déjà triées), o.days lever/coucher,
 *        o.kind "prone" | "wing" | "downwind", o.kg poids pour la taille d'aile
 */
export function brief(o) {
  const { spot, hours, now = new Date(), nc, obs = [], days, kind = "wing", kg = 75 } = o;
  const items = []; // { sev: ok | info | warn | danger, icon, title, text }
  const nowMs = now.getTime(), endMs = nowMs + 3 * 3600e3;
  const add = (sev, icon, title, text) => items.push({ sev, icon, title, text });

  // ---------- Vent au quart d'heure ----------
  let series = [];
  if (nc) {
    const m = nc.m;
    series = m.time.map((t, k) => ({ t, ms: Date.parse(t + ":00"), s: m.wind_speed_10m[k], d: m.wind_direction_10m[k], g: m.wind_gusts_10m[k], p: m.precipitation ? m.precipitation[k] : null }))
      .filter((x) => x.s != null && x.ms >= nowMs - 15 * 60e3 && x.ms <= endMs);
  }
  if (series.length >= 4) {
    const s0 = series[0], last = series.at(-1);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const first = series.slice(0, 3), end = series.slice(-3);
    const dS = avg(end.map((x) => x.s)) - avg(first.map((x) => x.s));
    const turn = angDiff(end[1].d, first[1].d);
    const gMax = series.reduce((a, x) => (x.g > (a?.g ?? -1) ? x : a), null);
    const gf = avg(series.map((x) => x.g / Math.max(x.s, 1)));
    const st = shoreType(s0.d, spot.facing);

    // Sécurité d'abord : vent de terre
    const offAt = series.find((x) => ["off", "sideoff"].includes(shoreType(x.d, spot.facing).key) && x.s >= 8);
    if (offAt) add("danger", "⛔", "Vent de terre", offAt === s0
      ? `Le vent est ${shoreType(s0.d, spot.facing).label} (${compass(s0.d)} ${r0(s0.s)} nds) : il pousse vers le large. En cas de casse, tu ne rentres pas tout seul. Pas de session sans bateau ou sans copain.`
      : `Le vent passe ${shoreType(offAt.d, spot.facing).label} vers ${hm(offAt.t)} (${compass(offAt.d)}). Sois revenu avant.`);

    // Tendance
    if (Math.abs(dS) < 4 && turn < 25 && gf < 1.45)
      add("ok", "✅", "Vent stable", `${r0(s0.s)} nds du ${compass(s0.d)} (${st.label}), stable jusqu'à ${hm(last.t)}. Profite.`);
    else {
      if (dS >= 4) { const at = series.find((x) => x.s >= s0.s + 4); add("warn", "📈", "Le vent se renforce", `${r0(s0.s)} → ${r0(last.s)} nds d'ici ${hm(last.t)}${at ? `, nettement dès ${hm(at.t)}` : ""}.${kind === "wing" ? ` Prends plutôt la ${wingSize(Math.max(...series.map((x) => x.s)), kg)} m².` : ""}`); }
      if (dS <= -4) { const at = series.find((x) => x.s <= s0.s - 4); add(kind === "wing" || kind === "downwind" ? "warn" : "info", "📉", "Le vent faiblit", `${r0(s0.s)} → ${r0(last.s)} nds d'ici ${hm(last.t)}${at ? `, baisse marquée vers ${hm(at.t)}` : ""}.${kind === "wing" ? " Garde une marge pour rentrer." : ""}`); }
      if (turn >= 25) add("warn", "🧭", "Le vent tourne", `Du ${compass(first[1].d)} au ${compass(end[1].d)} d'ici ${hm(last.t)} : à ${spot.short}, il passe ${shoreType(end[1].d, spot.facing).label}.`);
      if (gf >= 1.45 && gMax && gMax.g >= 18) add("warn", "💨", "Vent rafaleux", `Rafales jusqu'à ${r0(gMax.g)} nds vers ${hm(gMax.t)} pour ${r0(gMax.s)} nds de moyenne (écart ×${gf.toFixed(1).replace(".", ",")}).`);
    }

    // Grains : pluie au quart d'heure + rafales qui sautent, ou code averse/orage dans l'heure
    const grain = series.find((x, k) => (x.p ?? 0) >= 0.4 && (x.g - (series[k - 1]?.g ?? x.g) >= 5 || x.g >= x.s * 1.6));
    const shower = series.find((x) => (x.p ?? 0) >= 0.3);
    const hh = nc.h;
    const stormH = hh && hh.time ? hh.time.map((t, k) => ({ t, ms: Date.parse(t + ":00"), wc: hh.weather_code?.[k], cape: hh.cape?.[k] }))
      .filter((x) => x.ms >= nowMs - 3600e3 && x.ms <= endMs).find((x) => [95, 96, 99].includes(x.wc) || (x.cape ?? 0) >= 500) : null;
    if (stormH) add("danger", "⛈️", "Risque d'orage", `Atmosphère orageuse vers ${hm(stormH.t)}${stormH.wc >= 95 ? " (orage prévu)" : ` (CAPE ${r0(stormH.cape)} J/kg)`}. Reste près du bord et sors au premier coup de tonnerre.`);
    if (grain) add("warn", "🌧️", "Grain probable", `Vers ${hm(grain.t)} : averse avec rafales jusqu'à ${r0(grain.g)} nds. Un grain passe en 10 à 20 min : regarde le ciel au vent, ne reste pas près du bord sous le vent et évite d’être surtoilé à ce moment-là.`);
    else if (shower) add("info", "🌦️", "Averse possible", `Vers ${hm(shower.t)}, sans saute de vent marquée.`);

    // La prévision colle-t-elle au réel ?
    const mes = obs.find((x) => x.wind != null && nowMs - Date.parse(x.time) < 90 * 60e3);
    if (mes) {
      const diff = mes.wind - s0.s;
      if (Math.abs(diff) >= 4) add("info", "📡", "Prévision à corriger", `${mes.label} mesure ${mes.wind} nds (raf. ${mes.gust ?? "—"}) contre ${r0(s0.s)} prévus : le modèle ${diff > 0 ? "sous-estime" : "surestime"} de ${Math.abs(r0(diff))} nds. Ajuste mentalement la suite d'autant.`);
      else add("ok", "📡", "Prévision confirmée", `${mes.label} mesure ${mes.wind} nds, comme prévu (${r0(s0.s)}).`);
    }
  } else add("info", "ℹ️", "Prévision fine indisponible", "La prévision au quart d'heure n'a pas répondu ; le reste du briefing s'appuie sur le Check.");

  // ---------- Marée ----------
  const turns = tideTurns(hours);
  const nowT = toLocalIso(now);
  const next = turns.find((x) => x.t > nowT), prev = [...turns].reverse().find((x) => x.t <= nowT);
  if (next) {
    const rising = next.type === "PM";
    const h0 = tideAt(hours, nowMs), h2 = tideAt(hours, nowMs + 2 * 3600e3);
    const dh = h0 != null && h2 != null ? h2 - h0 : null;
    const minsTo = Math.round((Date.parse(next.t + ":00") - nowMs) / 60000);
    const phase = prev ? (nowMs - Date.parse(prev.t + ":00")) / (Date.parse(next.t + ":00") - Date.parse(prev.t + ":00")) : 0.5;
    const strong = phase > 0.3 && phase < 0.7; // règle des douzièmes : le gros du mouvement au milieu de la marée
    let txt = `La mer ${rising ? "monte" : "descend"} : ${next.type === "PM" ? "pleine mer" : "basse mer"} vers ${hm(next.t)} (dans ${minsTo >= 60 ? Math.floor(minsTo / 60) + " h " + String(minsTo % 60).padStart(2, "0") : minsTo + " min"}).`;
    if (dh != null) txt += ` ${dh > 0 ? "+" : "−"}${Math.abs(dh).toFixed(1).replace(".", ",")} m dans les 2 h.`;
    if (!spot.current) txt += strong ? " Mi-marée : courant au plus fort, ça dérive vite le long de la côte." : minsTo < 60 ? " Étale proche : courant faible." : "";
    if (spot.tide) {
      const pm = rising ? next : turns.find((x) => x.type === "PM" && x.t > nowT);
      if (pm) txt += ` À ${spot.short}, vise la ${spot.tide.label}.`;
    }
    add("info", rising ? "🌊" : "🏖️", "Marée", txt + " (heures du modèle, ±20 min : la vignette SHOM fait foi)");
  }

  // ---------- Courant de marée et vent ----------
  // Côte d'Opale (connaissance locale) : le jusant porte au sud jusqu'à ~2 h après la basse mer, le flot porte au nord jusqu'à ~2 h après la pleine mer.
  // Vent et courant dans le même sens : session molle et plan d'eau plat ; courant contre le vent : meilleur.
  if (spot.current && turns.length) {
    const C = spot.current, lag = C.lagH * 3600e3;
    const flow = (ms) => { // { dir: direction où va le courant, until, strength 0..1 }
      const k = turns.findIndex((x) => Date.parse(x.t + ":00") + lag > ms);
      if (k < 1) return null;
      const a = Date.parse(turns[k - 1].t + ":00") + lag, b = Date.parse(turns[k].t + ":00") + lag;
      const dir = turns[k - 1].type === "PM" ? (C.flood + 180) % 360 : C.flood;
      return { dir, until: b, strength: Math.sin(Math.PI * (ms - a) / (b - a)), label: dir === C.flood ? "vers le nord" : "vers le sud" };
    };
    const f0 = flow(nowMs);
    const wNow = series.length ? series.slice(0, 4) : null;
    if (f0) {
      const flip = f0.until <= endMs ? f0.until : null;
      const fl = flip ? flow(flip + 60e3) : null;
      const rel = (windFrom, cur) => { const c = Math.cos(((windFrom + 180 - cur.dir) * Math.PI) / 180); return c > 0.5 ? "same" : c < -0.5 ? "against" : "cross"; };
      const force = f0.strength > 0.7 ? "fort" : f0.strength > 0.35 ? "modéré" : "faible";
      let txt = `Courant ${f0.label} (${force})`, sev = "info";
      if (wNow && wNow[0].d != null) {
        const r = rel(wNow[1]?.d ?? wNow[0].d, f0);
        if (r === "same") { sev = f0.strength > 0.35 ? "warn" : "info"; txt += `, dans le même sens que le vent : plan d'eau mou, ${kind === "wing" ? "moins de vent apparent" : kind === "downwind" ? "bosses molles" : "moins de tenue"}.`; }
        else if (r === "against") { sev = "ok"; txt += ", contre le vent : c'est le bon sens, plan d'eau plus vivant."; }
        else txt += ", de travers au vent.";
        if (flip && fl) {
          const late = series.filter((x) => x.ms >= flip);
          const r2 = late.length ? rel(late[0].d, fl) : null;
          txt += ` Il s'inverse vers ${hm(toLocalIso(new Date(flip)))} et part ${fl.label}`;
          txt += r2 === "against" ? " : contre le vent, ça s'améliore à partir de là." : r2 === "same" ? " : dans le sens du vent, ça devient moins bon." : ".";
          if (r === "same" && r2 === "against") sev = "warn";
        }
      } else txt += flip ? `, s'inverse vers ${hm(toLocalIso(new Date(flip)))}.` : ".";
      add(sev, "🔄", "Courant", txt);
    }
  }

  // ---------- Lumière et eau ----------
  const d = days && days.find((x) => x.day === nowT.slice(0, 10));
  if (d) {
    const left = (Date.parse(d.set + ":00") - nowMs) / 60000;
    if (left < 0) add("danger", "🌙", "Nuit", `Le soleil s'est couché à ${hm(d.set)}.`);
    else if (left < 180) add(left < 60 ? "warn" : "info", "🌇", "Lumière", `Coucher du soleil à ${hm(d.set)} : sois au bord avant ${hm(toLocalIso(new Date(Date.parse(d.set + ":00") - 15 * 60e3)))}.`);
  }
  const sst = hours.find((h) => h.t.slice(0, 13) === nowT.slice(0, 13) && h.sst != null)?.sst ?? hours.find((h) => h.sst != null)?.sst;
  if (sst != null) add("info", "🌡️", "Eau", `${sst.toFixed(1).replace(".", ",")} °C : ${suit(sst)}.`);

  // ---------- Synthèse ----------
  const rank = { danger: 3, warn: 2, info: 1, ok: 0 };
  const worst = items.reduce((a, x) => Math.max(a, rank[x.sev]), 0);
  const headline = worst === 3 ? "Prudence : il y a un point bloquant" : worst === 2 ? "Ça se joue, mais reste attentif" : "Feu vert : conditions stables";
  items.sort((a, b) => rank[b.sev] - rank[a.sev]);
  return { headline, sev: ["ok", "info", "warn", "danger"][worst], items, series, model: nc?.model };
}
