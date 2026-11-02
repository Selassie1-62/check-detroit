// Robot d'alertes : lancé par GitHub Actions toutes les 3 h.
// Envoie une notification ntfy pour chaque NOUVELLE fenêtre GO (prone ou downwind) dans les 3 jours.
import { readFile, writeFile } from "node:fs/promises";
import { fetchAll, buildHours, analyse, daylight } from "./logic.js";

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
const wins = analyse(spots, daylight(raw.sun), { weight: WEIGHT }).filter((w) => w.level === "go" && KINDS.includes(w.kind));

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
await writeFile(STATE_FILE, JSON.stringify(sent, null, 2) + "\n");
console.log(`${wins.length} fenêtre(s) GO, ${n} nouvelle(s) alerte(s).`);
