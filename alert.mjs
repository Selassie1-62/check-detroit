// Robot d'alertes : lancé par GitHub Actions toutes les 3 h.
// Envoie une notification ntfy pour chaque NOUVELLE fenêtre GO (surf foil ou downwind) dans les 3 jours, puis un rappel le matin même.
import { readFile, writeFile } from "node:fs/promises";
import { fetchAll, buildHours, analyse, daylight, toLocalIso } from "./logic.js";

const TOPIC = process.env.NTFY_TOPIC;           // secret du dépôt : nom du canal ntfy
const SITE = process.env.SITE_URL || "";         // adresse du site, ouverte au clic sur la notification
const WEIGHT = +(process.env.RIDER_KG || 75);
const KINDS = (process.env.ALERT_KINDS || "prone,downwind").split(",");
const STATE_FILE = "alerts-state.json";

if (!TOPIC) { console.error("NTFY_TOPIC manquant (Settings > Secrets and variables > Actions)."); process.exit(1); }

const raw = await fetchAll();
const okW = raw.wind.filter((r) => r.data).length, okV = raw.wave.filter((r) => r.data).length;
console.log(`Modèles vent ${okW}/4, vagues ${okV}/4`);
if (!okW || !okV) { console.error("Données insuffisantes, pas d'alerte."); process.exit(0); }

const spots = buildHours(raw);

// Prévision publiée dans le dépôt (prevision.json) : la même que celle du site (AROME 1,3 km seul pour le vent et
// ICON-EWAM seul pour les vagues à moins de 24 h), lisible depuis GitHub pour les « check » faits avec Claude.
{
  const r = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
  const nowIso = toLocalIso(new Date()).slice(0, 13); // heure locale de Paris, comme les données
  const prev = { generatedAt: new Date().toISOString(), note: "Heures locales (Europe/Paris). Consensus pondéré : AROME 1,3 km seul pour le vent et ICON-EWAM seul pour les vagues à moins de 24 h.",
    models: { wind: raw.wind.filter((x) => x.data).map((x) => x.model.label), wave: raw.wave.filter((x) => x.data).map((x) => x.model.label) },
    spots: {} };
  for (const [id, sp] of Object.entries(spots)) {
    prev.spots[id] = {
      name: sp.spot.name, facing: sp.spot.facing,
      tides: sp.tides.filter((x) => x.t.slice(0, 13) >= nowIso).slice(0, 8).map((x) => ({ t: x.t, type: x.type, h: r(x.h, 2) })),
      hours: sp.hours.filter((h) => h.t.slice(0, 13) >= nowIso.slice(0, 13)).slice(0, 54).map((h) => ({
        t: h.t, wind: r(h.c.wind, 0), gust: r(h.c.gust, 0), wdir: r(h.c.wdir, 0),
        hs: r(h.c.hs, 2), tm: r(h.c.tm), wd: r(h.c.wd, 0), swh: r(h.c.swh, 2), swp: r(h.c.swp), swd: r(h.c.swd, 0),
        wwh: r(h.c.wwh, 2), wwp: r(h.c.wwp), tide: r(h.tide, 2), sst: r(h.sst), pmMin: h.c.pmMin ?? null,
        conf: h.c.windSpread != null ? r(h.c.windSpread, 0) : null,
      })),
    };
  }
  await writeFile("prevision.json", JSON.stringify(prev) + "\n");
  console.log("prevision.json écrit :", Object.keys(prev.spots).length, "spots");
}
// Préférence de Henry (17/11/2026) : pas d'alerte wing ni downwind par vent de secteur nord (NW à NE, 315-45°).
// Le surf foil reste alerté (ex. houle de nord à Calais).
const north = (d) => d >= 315 || d <= 45;
const mostlyNorth = (w) => w.wdirs && w.wdirs.length && w.wdirs.filter(north).length / w.wdirs.length >= 0.5;
const wins = analyse(spots, daylight(raw.sun), { weight: WEIGHT })
  .filter((w) => w.level === "go" && KINDS.includes(w.kind))
  .filter((w) => !((w.kind === "wing" || w.kind === "downwind") && mostlyNorth(w)));

let sent = {};
try { sent = JSON.parse(await readFile(STATE_FILE, "utf8")); } catch {}
const now = Date.now();
for (const [k, ts] of Object.entries(sent)) if (now - ts > 5 * 864e5) delete sent[k];

const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", timeZone: "UTC" });
const fmt = (t) => `${dayFmt.format(new Date(t.slice(0, 10) + "T12:00Z"))} ${t.slice(11, 13)}h`;

let n = 0;
for (const w of wins) {
  const key = `${w.kind}|${w.run || w.spot}|${w.start.slice(0, 10)}`;
  if (sent[key]) continue;
  const title = `${w.label} GO · ${w.where}`;
  const body = `${fmt(w.start)} → ${w.end.slice(11, 13)}h\n${(w.best.why || []).join(" · ")}\nConfiance ${w.conf}. Vérifie la bouée avant de partir.`;
  const r = await fetch("https://ntfy.sh/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: TOPIC, title, message: body, priority: 4,
      tags: [w.kind === "prone" ? "ocean" : "wind_face"], ...(SITE ? { click: SITE } : {}) }),
  });
  console.log(r.ok ? "Alerte envoyée :" : "Échec ntfy :", title, w.start);
  if (r.ok) { sent[key] = now; n++; }
}
// Rappel le matin même : une alerte envoyée 3 jours avant passe facilement inaperçue.
const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).format(new Date());
const today = local.slice(0, 10), hourNow = parseInt(local.slice(11, 13), 10);
if (hourNow >= 6 && hourNow <= 10) {
  for (const w of wins.filter((x) => x.start.slice(0, 10) === today)) {
    const key = `${w.kind}|${w.run || w.spot}|${today}|rappel`;
    if (sent[key]) continue;
    const r = await fetch("https://ntfy.sh/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: TOPIC, priority: 4, tags: ["alarm_clock"], ...(SITE ? { click: SITE } : {}),
        title: `Aujourd'hui · ${w.label} GO · ${w.where}`,
        message: `${w.start.slice(11, 13)}h → ${w.end.slice(11, 13)}h\n${(w.best.why || []).join(" · ")}\nConfiance ${w.conf}. Ouvre le briefing « Je pars à l'eau » avant d'y aller.` }),
    });
    console.log(r.ok ? "Rappel envoyé :" : "Échec ntfy :", w.label, w.where, w.start);
    if (r.ok) { sent[key] = now; n++; }
  }
}
await writeFile(STATE_FILE, JSON.stringify(sent, null, 2) + "\n");
console.log(`${wins.length} fenêtre(s) GO, ${n} nouvelle(s) alerte(s).`);
