# Check Détroit

Site de conditions de foil pour le détroit du Pas-de-Calais (Hardelot → Calais) : prone, downwind, wing.
Un bouton **Check** interroge 8 modèles (vent : AROME HD, ICON-D2, ECMWF, GFS · vagues : ICON-EWAM, MFWAM,
ECMWF-WAM, GFS-Wave) via Open-Meteo, calcule un consensus pondéré et liste les créneaux jouables sur 3 jours.
Un robot vérifie toutes les 3 heures et envoie une notification push (ntfy) quand une fenêtre GO de prone
ou de downwind apparaît.

## Contenu

| Fichier | Rôle |
|---|---|
| `index.html` | La page : bouton Check, **homespot** (spot choisi en grand, barre des 3 jours), **carte interactive** (Leaflet, fond CARTO/OpenStreetMap) |
| `icon.png` | Icône pour l'écran d'accueil de l'iPhone |
| `logic.js` | Récupération des modèles, consensus, seuils, fenêtres (partagé page + robot) |
| `alert.mjs` | Le robot d'alertes |
| `.github/workflows/alertes.yml` | Lance le robot toutes les 3 h |
| `obs.mjs` + `.github/workflows/vent-mesure.yml` | Robot « Mesures » (toutes les 30 min) : vent des sémaphores → `obs.json` |
| `bouees.mjs` | Lit Hastings, West Gabbard 2 et Scilly (Cefas WaveNet), Sandettie et Greenwich (NDBC) toutes les 30 min, écrit `bouees.json`. Alertes « houle longue en approche » et « Calais peut marcher » (mer de NE mesurée + vent faible ou de terre) |
| `alerts-state.json` | Mémoire des alertes déjà envoyées (anti-doublon) |
| `package.json` | Réglage technique pour Node |

## Mise en ligne (une seule fois, ~15 minutes, depuis un ordinateur)

### 1. Créer le compte et le dépôt
1. Crée un compte gratuit sur **github.com**.
2. Bouton **+** en haut à droite → **New repository**.
   Nom : `check-detroit` · coche **Public** · **Create repository**.
3. Sur la page du dépôt vide, clique **uploading an existing file**.
4. Dézippe `check-detroit.zip` sur ton ordinateur, puis **glisse tout le contenu du dossier**
   (y compris le dossier `.github`) dans la page. Sur Mac, `.github` est caché : dans le Finder,
   fais **Cmd + Maj + .** pour l'afficher. **Commit changes**.
   Vérifie ensuite que le fichier `.github/workflows/alertes.yml` apparaît bien dans le dépôt.

### 2. Publier le site
1. Dans le dépôt : **Settings → Pages**.
2. *Source* : **Deploy from a branch** · *Branch* : **main** / **(root)** → **Save**.
3. Au bout d'une à deux minutes, l'adresse s'affiche :
   `https://TON-NOM.github.io/check-detroit/`. Ajoute-la à l'écran d'accueil de l'iPhone
   (Safari → Partager → Sur l'écran d'accueil).

### 3. Brancher les alertes
1. Installe l'app gratuite **ntfy** sur l'iPhone, touche **+** et abonne-toi au canal :
   **`check-detroit-8ec87f2c`** (serveur ntfy.sh par défaut). Donne ce nom aux copains qui veulent les alertes.
2. Dans le dépôt : **Settings → Secrets and variables → Actions**.
   - Onglet **Secrets** → **New repository secret** : nom `NTFY_TOPIC`, valeur `check-detroit-8ec87f2c`.
   - Onglet **Variables** → **New repository variable** :
     `SITE_URL` = l'adresse du site (étape 2) · `RIDER_KG` = `65` (ton poids, pour la taille de wing).
3. Onglet **Actions** du dépôt : si GitHub demande d'activer les workflows, accepte.
   Ouvre **Alertes foil** → **Run workflow** pour un premier test. Le journal affiche
   « Modèles vent x/4, vagues x/4 » et les alertes envoyées.

Le nom du canal sert de mot de passe : quiconque le connaît reçoit les alertes. Pour en changer,
remplace le secret `NTFY_TOPIC` et réabonne-toi dans l'app.

### 4. Brancher le vent des sémaphores (Météo-France)
1. Crée un compte gratuit sur **portail-api.meteofrance.fr**.
2. Dans le catalogue, abonne-toi à l'API **« Données d'observation »** (DPObs), puis génère une **clé d'API**
   (choisis la durée de validité la plus longue proposée).
3. Dans le dépôt : **Settings → Secrets and variables → Actions → New repository secret** :
   nom `MF_APIKEY`, valeur = la clé.
4. Onglet **Actions** → **Vent mesuré (sémaphores)** → **Run workflow**. Le journal liste les stations trouvées
   et leur vent. La rubrique « Vent mesuré » du site se remplit ensuite toute seule, toutes les 30 minutes.
   La clé reste secrète : le site public ne lit que le fichier `obs.json` produit par le robot.

## Réglages
- **Seuils** : en haut de `logic.js`, objet `THRESHOLDS` (puissance prone, vent mini paddle/wing, rafales max…).
- **Spots** : Hardelot, Équihen · Le Portel, Boulogne, Wimereux, Wissant, Sangatte, Calais. Calais a son propre mode « mer du vent » (mer de N à E, périodes courtes) et une fenêtre de marée (PM −3 h → PM +1 h), calés sur la session du jeudi 05/11/2026 à 8 h.
- **Mon spot** : choisi en haut de la page, mémorisé sur chaque téléphone (Wimereux par défaut). Le port de Boulogne n'est jamais traversé par un parcours de downwind.
- **Spots et parcours** : `SPOTS` et `RUNS` dans `logic.js` (orientation de la côte, secteurs de vent autorisés).
- **Poids des modèles** : `weight` dans `WIND_MODELS` / `WAVE_MODELS`.
- **Types d'alertes** : variable `ALERT_KINDS` (par défaut `prone,downwind` ; ajouter `wing` pour être alerté de chaque jour de vent).

## Limites connues
- Marées : vignettes officielles SHOM (gratuites) pour Boulogne et Calais ; la courbe horaire du tableau vient du modèle Open-Meteo (indicative). L'API SHOM est payante (4 600 €/an, réponse du 06/11/2026).
- Bouée GeoDunes d'Ambleteuse : pas d'accès automatisé sans contribution financière (réponse GeoDunes du 03/11/2026). Consultation manuelle via le lien.
- MARC (Ifremer) : simple lien dans la page. Ses données sont réservées à un usage personnel, sans rediffusion ; une intégration automatique demande l'accord d'Ifremer (formulaire http://forms.ifremer.fr/lops-oc/marc-ww3/).
- Prone à Wimereux (La Rochette, Pointe aux Oies) : petite houle longue acceptée (≥ 0,15 m à ≥ 10 s = Limite, ≥ 0,4 m = GO) si le vent est de terre ou faible (sessions des 31/10 et 11/11/2026).
- Alerte Scilly : heure d'arrivée calculée depuis l'heure de la mesure ; taille à la côte ≈ 10 % de Scilly (calage du 11/11/2026 : 3,6-4,1 m / 12,5 s → ~0,35 m à Ambleteuse, arrivée ~16 h plus tard).
- Briefing « Je pars à l'eau » (`briefing.js`) : vent au quart d'heure (AROME HD), grains, vent de terre, marée, courant, lumière, eau, sur les 3 prochaines heures.
- Courant (Hardelot → Wimereux, connaissance locale) : le jusant porte au sud jusqu'à ~2 h après la basse mer, le flot au nord jusqu'à ~2 h après la pleine mer. Courant dans le sens du vent = moins bon ; contre le vent = mieux.
- Seuils de Calais calés sur une seule session (05/11/2026) : à affiner avec les prochaines.
- Bouée de Scilly : utilisée seulement si elle est présente dans le flux Cefas (le journal du robot liste les bouées disponibles).
- Les modèles ratent souvent la houle longue : le site peut sous-estimer une session de prone. La bouée prime.
- Données Open-Meteo gratuites pour un usage **non commercial**, avec attribution (affichée en bas de page).
