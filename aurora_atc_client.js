/* =============================================================================
   AURORA — client ATC (démo pédagogique)
   Lit/écrit uniquement via le SDK Web Firebase (clé publique + règles de
   sécurité côté base), jamais via une clé de compte de service. Voir
   aurora-config.example.js pour la configuration.
============================================================================= */
"use strict";

/* ---------------------------------------------------------------------------
   0. Configuration (avec repli si aurora-config.js est absent)
--------------------------------------------------------------------------- */
window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;
window.OPENAIP_API_KEY = window.OPENAIP_API_KEY || "";
// Aucun aérodrome par défaut (ni Nantes, ni ailleurs) : tant que l'utilisateur
// n'a pas saisi et chargé sa propre position, on garde une vue neutre centrée
// sur la France métropolitaine, zoomée large — voir locateStation().
const NO_STATION = {
  callsign: "", name: "", icao: "", lat: 46.6, lon: 2.2, elevation_ft: 0, runway: null,
};
window.ATC_STATION = window.ATC_STATION || { ...NO_STATION };

const OPENAIP_BASE = "https://api.core.openaip.net/api";
// OpenAIP rejette (HTTP 400) toute requête dont la zone (bbox) est trop
// grande : on exige un zoom minimum avant d'interroger l'API, comme dans
// sector_manager.html, pour ne jamais déclencher ces 400 par défaut.
const MIN_ZOOM_OPENAIP = 9;

let state = {
  connected: false,
  stationSet: !!(window.ATC_STATION && window.ATC_STATION.icao),
  station: { ...window.ATC_STATION },
  activeTab: "PVD",
  vhfFreq: 118.650,
  pttKeyCode: "Backslash",    // touche PTT (KeyboardEvent.code), modifiable via le bouton "Touche :" du panneau VHF
  comFreqTab: "TUNED",
  selectedCallsign: null,
  dismissed: new Set(),      // callsigns retirés localement du Traffic Manager (DEL)
  flights: {},
  sectors: {},
  atcOnline: {},
  atcStrips: {},              // callsign -> { assigned_alt, assigned_spd, assigned_wp, remarks, squawk_assigned, updated_by, updated_at } — édité ATC uniquement
  strips: {},                 // callsign -> {type}  (bandes affichées dans le bandeau STRIPS)
  prevSquawk: {},             // callsign -> dernier transpondeur connu, pour détecter l'apparition d'une urgence
  vectorMinutes: 1,           // longueur du vecteur de piste (façon radar réel), togglée par "v2"
  waypointsShown: false,       // VOR/NDB/DME (OpenAIP /navaids)
  reportingPointsShown: false, // points RNAV/VFR (OpenAIP /reporting-points)
  airspacesShown: false,
  procFixesShown: false,       // fixes RNAV enroute / SID-STAR (table locale, PAS OpenAIP)
};

function $(id){ return document.getElementById(id); }
function el(tag, cls, html){ const e = document.createElement(tag); if(cls) e.className = cls; if(html!==undefined) e.innerHTML = html; return e; }

function showToast(msg, isErr){
  const t = el("div", "toast" + (isErr ? " err" : ""), msg);
  document.getElementById("workspace").appendChild(t);
  setTimeout(() => { t.style.transition = "opacity .4s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 400); }, 3400);
}

let audioCtx = null;
function emergencyBeep(){
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    [0, 0.22, 0.44].forEach(offset => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(880, now + offset);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.2);
    });
  } catch(err){ /* navigateur sans WebAudio ou lecture bloquée avant interaction utilisateur */ }
}
const EMERGENCY_CODES = new Set(["7500", "7600", "7700"]);

/* ---------------------------------------------------------------------------
   1. Barres d'outils (décoratives façon Aurora + quelques boutons actifs)
--------------------------------------------------------------------------- */
const ROW1 = ["INSET","TRAFFIC","GEO","NAV","1","2","3","4","5","6","7","8","CST","ELEV","AP","WND",
  "RWY","RWC","GTS","TXL","TXI","TXC","STP","APR","PIER","BLD","PLF","DA","PA","RA","DEFA","SAR","WXR","ZM"];
const ROW2 = ["L+","L-","H+","H-","R+","R-","t","v2","vAlt","rAlt","GTR","FLTR","LIST","eSSR","VOR","NDB",
  "FIX","FRQ","VFR","VFRR","MRV","ACC","HS","LS","AH","AL","AWL","ATC","RR","T","MA","CLR","VERA","HOLD"];

const TOOLBAR_ACTIONS = {
  FIX: toggleWaypoints,
  VFR: toggleReportingPoints,
  GTS: toggleAirspaces,
  MRV: toggleProcedureFixes, // fixes RNAV / SID-STAR (table locale, voir aurora-config.js)
  ATC: () => toggleWin("win-atc"),
  LIST: () => toggleWin("win-traffic"),
  CLR: clearComLog,
  MA:  () => toggleWin("win-com"),
  RWY: () => toggleWin("win-airport"),
  v2:  () => { state.vectorMinutes = state.vectorMinutes === 1 ? 2 : 1; showToast(`Vecteur piste : ${state.vectorMinutes} min`); renderAircraftOnMap(); },
};

function buildToolbar(rowId, labels){
  const row = $(rowId);
  labels.forEach(lab => {
    const b = el("button", "tbtn", lab);
    if (TOOLBAR_ACTIONS[lab]){
      b.addEventListener("click", () => { TOOLBAR_ACTIONS[lab](); b.classList.toggle("active"); });
      b.title = "Actif";
    } else {
      b.title = "Non câblé dans cette démo";
      b.addEventListener("click", () => b.classList.toggle("active"));
    }
    row.appendChild(b);
  });
}
buildToolbar("toolbar1", ROW1);
buildToolbar("toolbar2", ROW2);

/* ---------------------------------------------------------------------------
   2. Barre d'onglets
--------------------------------------------------------------------------- */
const TABS = ["ATIS","COM","ATC","TRAFFIC","AIRPORTS","PROFILE","PVD"];
const TAB_FOCUS = {
  ATIS: () => flashHud(),
  COM: () => bringToFront("win-com"),
  ATC: () => bringToFront("win-atc"),
  TRAFFIC: () => bringToFront("win-traffic"),
  AIRPORTS: () => bringToFront("win-airport"),
  PROFILE: () => showToast(`Position : ${state.station.callsign} — ${state.station.name}`),
  PVD: () => recenterOnStation(),
};
function buildTabbar(){
  const bar = $("tabbar");
  bar.innerHTML = "";
  TABS.forEach(t => {
    const d = el("div", "tab" + (t === state.activeTab ? " active" : ""), t);
    d.addEventListener("click", () => {
      state.activeTab = t;
      buildTabbar();
      (TAB_FOCUS[t] || function(){})();
    });
    bar.appendChild(d);
  });
}
buildTabbar();

function flashHud(){
  const hud = $("hud");
  hud.style.outline = "1px solid var(--accent)";
  setTimeout(() => hud.style.outline = "none", 700);
}
function bringToFront(id){
  const w = $(id);
  w.style.display = "flex";
  w.classList.remove("collapsed");
  raiseWindow(w);
  w.style.outline = "1px solid var(--accent)";
  setTimeout(() => w.style.outline = "none", 700);
}
function toggleWin(id){
  const w = $(id);
  w.style.display = (w.style.display === "none") ? "flex" : "none";
}

/* Fenêtres : réduire / fermer / déplacer / redimensionner */
let topZ = 700;
function raiseWindow(w){ topZ += 1; w.style.zIndex = topZ; }

function makeDraggable(w, handle){
  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest(".wico")) return; // ne pas démarrer un drag en cliquant réduire/fermer
    e.preventDefault();
    const wsRect = $("workspace").getBoundingClientRect();
    const startRect = w.getBoundingClientRect();
    const dx0 = e.clientX - startRect.left, dy0 = e.clientY - startRect.top;
    // On bascule sur un positionnement left/top explicite (au lieu de right/bottom) dès le premier drag.
    w.style.left = (startRect.left - wsRect.left) + "px";
    w.style.top = (startRect.top - wsRect.top) + "px";
    w.style.right = "auto"; w.style.bottom = "auto";
    w.classList.add("dragging");
    raiseWindow(w);
    function onMove(ev){
      const wr = $("workspace").getBoundingClientRect();
      let left = ev.clientX - wr.left - dx0;
      let top = ev.clientY - wr.top - dy0;
      left = Math.max(0, Math.min(left, wr.width - 60));
      top = Math.max(0, Math.min(top, wr.height - 30));
      w.style.left = left + "px"; w.style.top = top + "px";
    }
    function onUp(){
      w.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
function makeResizable(w, handle){
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const startRect = w.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    w.classList.add("resizing");
    raiseWindow(w);
    function onMove(ev){
      const newW = Math.max(180, startRect.width + (ev.clientX - startX));
      const newH = Math.max(90, startRect.height + (ev.clientY - startY));
      w.style.width = newW + "px"; w.style.height = newH + "px";
    }
    function onUp(){
      w.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
document.querySelectorAll(".win").forEach(w => {
  const collapseBtn = w.querySelector("[data-collapse]");
  const closeBtn = w.querySelector("[data-close]");
  const head = w.querySelector(".win-head");
  if (collapseBtn) collapseBtn.addEventListener("click", () => w.classList.toggle("collapsed"));
  if (closeBtn) closeBtn.addEventListener("click", () => w.style.display = "none");
  w.addEventListener("mousedown", () => raiseWindow(w));
  if (head) makeDraggable(w, head);
  const handle = el("div", "win-resize-handle");
  handle.title = "Redimensionner";
  w.appendChild(handle);
  makeResizable(w, handle);
});

/* ---------------------------------------------------------------------------
   3. Horloges
--------------------------------------------------------------------------- */
function pad2(n){ return String(n).padStart(2, "0"); }
function tickClocks(){
  const now = new Date();
  const z = `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}Z`;
  $("clock-zulu").textContent = z;
  $("clock-local").textContent = `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}`;
}
setInterval(tickClocks, 1000); tickClocks();

/* ---------------------------------------------------------------------------
   4. Position ATC : on tape le callsign, le client cherche l'aérodrome lui-même
      Ordre de recherche : 1) secteur Firebase exact  2) OpenAIP (si clé)
      3) table intégrée d'aérodromes courants  4) coordonnées saisies à la main
--------------------------------------------------------------------------- */

// Repli hors-ligne (pas besoin de clé OpenAIP) pour les aérodromes les plus
// courants — complétez cette liste selon vos besoins. lat/lon = ARP,
// heading_deg = QFU piste principale (pour le vent traversier et le tracé).
const AIRPORT_FALLBACK = {
  LFRS: { name: "NANTES ATLANTIQUE",      lat: 47.1532,  lon: -1.6108,  elevation_ft: 90,  runway: { idents:["03","21"], heading_deg:34,  length_m:2900 } },
  LFPG: { name: "PARIS CHARLES DE GAULLE",lat: 49.0097,  lon: 2.5479,   elevation_ft: 392, runway: { idents:["08L","26R"], heading_deg:75, length_m:4200 } },
  LFPO: { name: "PARIS ORLY",             lat: 48.7233,  lon: 2.3794,   elevation_ft: 291, runway: { idents:["06","24"], heading_deg:63,  length_m:3320 } },
  LFBO: { name: "TOULOUSE BLAGNAC",       lat: 43.6291,  lon: 1.3638,   elevation_ft: 499, runway: { idents:["14L","32R"], heading_deg:140,length_m:3500 } },
  LFML: { name: "MARSEILLE PROVENCE",     lat: 43.4393,  lon: 5.2214,   elevation_ft: 74,  runway: { idents:["13L","31R"], heading_deg:130,length_m:3500 } },
  LFLL: { name: "LYON SAINT-EXUPÉRY",     lat: 45.7256,  lon: 5.0811,   elevation_ft: 821, runway: { idents:["17R","35L"], heading_deg:172,length_m:4000 } },
  LFRN: { name: "RENNES SAINT-JACQUES",   lat: 48.0695,  lon: -1.7346,  elevation_ft: 124, runway: { idents:["10","28"], heading_deg:100,  length_m:2500 } },
  LFOB: { name: "BEAUVAIS-TILLÉ",         lat: 49.4544,  lon: 2.1128,   elevation_ft: 361, runway: { idents:["04","22"], heading_deg:40,   length_m:2430 } },
  LFBD: { name: "BORDEAUX MÉRIGNAC",      lat: 44.8283,  lon: -0.7156,  elevation_ft: 155, runway: { idents:["05","23"], heading_deg:50,   length_m:3100 } },
  LFST: { name: "STRASBOURG ENTZHEIM",    lat: 48.5383,  lon: 7.6282,   elevation_ft: 502, runway: { idents:["05","23"], heading_deg:50,   length_m:2400 } },
  LFMN: { name: "NICE CÔTE D'AZUR",       lat: 43.6584,  lon: 7.2159,   elevation_ft: 13,  runway: { idents:["04L","22R"], heading_deg:40, length_m:2960 } },
  LFQQ: { name: "LILLE LESQUIN",          lat: 50.5633,  lon: 3.0894,   elevation_ft: 157, runway: { idents:["08","26"], heading_deg:80,   length_m:2900 } },
  EGLL: { name: "LONDON HEATHROW",        lat: 51.4700,  lon: -0.4543,  elevation_ft: 83,  runway: { idents:["09L","27R"], heading_deg:90, length_m:3660 } },
  EGKK: { name: "LONDON GATWICK",         lat: 51.1481,  lon: -0.1903,  elevation_ft: 202, runway: { idents:["08R","26L"], heading_deg:80, length_m:3316 } },
  EDDF: { name: "FRANKFURT MAIN",         lat: 50.0333,  lon: 8.5706,   elevation_ft: 364, runway: { idents:["07C","25C"], heading_deg:70, length_m:4000 } },
  EDDM: { name: "MUNICH",                 lat: 48.3538,  lon: 11.7861,  elevation_ft: 1487,runway: { idents:["08L","26R"], heading_deg:80, length_m:4000 } },
  LSZH: { name: "ZÜRICH",                 lat: 47.4647,  lon: 8.5492,   elevation_ft: 1416,runway: { idents:["16","34"], heading_deg:160,  length_m:3700 } },
  LEMD: { name: "MADRID BARAJAS",         lat: 40.4936,  lon: -3.5668,  elevation_ft: 1998,runway: { idents:["18L","36R"], heading_deg:180,length_m:4100 } },
  LIRF: { name: "ROMA FIUMICINO",         lat: 41.8003,  lon: 12.2389,  elevation_ft: 15,  runway: { idents:["16L","34R"], heading_deg:160,length_m:3900 } },
  KJFK: { name: "NEW YORK JFK",           lat: 40.6413,  lon: -73.7781, elevation_ft: 13,  runway: { idents:["04L","22R"], heading_deg:40, length_m:3460 } },
  KLAX: { name: "LOS ANGELES",            lat: 33.9416,  lon: -118.4085,elevation_ft: 125, runway: { idents:["07L","25R"], heading_deg:70, length_m:3380 } },
  // Amérique du Sud / Caraïbes
  SBGR: { name: "SÃO PAULO GUARULHOS",    lat: -23.4356, lon: -46.4731, elevation_ft: 2459,runway: { idents:["09L","27R"], heading_deg:90, length_m:3700 } },
  SAEZ: { name: "BUENOS AIRES EZEIZA",    lat: -34.8222, lon: -58.5358, elevation_ft: 67,  runway: { idents:["11","29"], heading_deg:110,  length_m:3300 } },
  SCEL: { name: "SANTIAGO",               lat: -33.3930, lon: -70.7858, elevation_ft: 1555,runway: { idents:["17L","35R"], heading_deg:170,length_m:3800 } },
  SCCI: { name: "PUNTA ARENAS (porte d'entrée Antarctique)", lat: -53.0026, lon: -70.8546, elevation_ft: 42, runway: { idents:["08","26"], heading_deg:80, length_m:3000 } },
  MMMX: { name: "MEXICO CITY",            lat: 19.4363,  lon: -99.0721, elevation_ft: 7316,runway: { idents:["05L","23R"], heading_deg:50, length_m:3900 } },
  TJSJ: { name: "SAN JUAN PUERTO RICO",   lat: 18.4394,  lon: -66.0018, elevation_ft: 9,   runway: { idents:["08","26"], heading_deg:80,   length_m:3050 } },
  // Afrique
  FAOR: { name: "JOHANNESBURG O.R. TAMBO",lat: -26.1392, lon: 28.2460,  elevation_ft: 5558,runway: { idents:["03L","21R"], heading_deg:30, length_m:4400 } },
  HECA: { name: "LE CAIRE",               lat: 30.1219,  lon: 31.4056,  elevation_ft: 382, runway: { idents:["05L","23R"], heading_deg:50, length_m:4000 } },
  DNMM: { name: "LAGOS MURTALA MUHAMMED", lat: 6.5774,   lon: 3.3212,   elevation_ft: 135, runway: { idents:["18L","36R"], heading_deg:180,length_m:3900 } },
  GMMN: { name: "CASABLANCA MOHAMMED V",  lat: 33.3675,  lon: -7.5900,  elevation_ft: 656, runway: { idents:["17","35"], heading_deg:170,  length_m:3720 } },
  FIMP: { name: "MAURICE SSR",            lat: -20.4302, lon: 57.6836,  elevation_ft: 186, runway: { idents:["14","32"], heading_deg:140,  length_m:3370 } },
  // Moyen-Orient / Asie
  OMDB: { name: "DUBAI",                  lat: 25.2532,  lon: 55.3657,  elevation_ft: 62,  runway: { idents:["12L","30R"], heading_deg:120,length_m:4447 } },
  OTHH: { name: "DOHA HAMAD",             lat: 25.2609,  lon: 51.6138,  elevation_ft: 13,  runway: { idents:["16L","34R"], heading_deg:160,length_m:4850 } },
  VABB: { name: "MUMBAI",                 lat: 19.0896,  lon: 72.8656,  elevation_ft: 39,  runway: { idents:["09","27"], heading_deg:90,   length_m:3660 } },
  VIDP: { name: "DELHI",                  lat: 28.5562,  lon: 77.1000,  elevation_ft: 777, runway: { idents:["10","28"], heading_deg:100,  length_m:4430 } },
  ZBAA: { name: "PÉKIN CAPITAL",          lat: 40.0801,  lon: 116.5846, elevation_ft: 116, runway: { idents:["18L","36R"], heading_deg:180,length_m:3800 } },
  ZSPD: { name: "SHANGHAI PUDONG",        lat: 31.1443,  lon: 121.8083, elevation_ft: 13,  runway: { idents:["17L","35R"], heading_deg:170,length_m:4000 } },
  RJTT: { name: "TOKYO HANEDA",           lat: 35.5494,  lon: 139.7798, elevation_ft: 21,  runway: { idents:["16L","34R"], heading_deg:160,length_m:3000 } },
  RJAA: { name: "TOKYO NARITA",           lat: 35.7647,  lon: 140.3864, elevation_ft: 141, runway: { idents:["16L","34R"], heading_deg:160,length_m:4000 } },
  RKSI: { name: "SÉOUL INCHEON",          lat: 37.4602,  lon: 126.4407, elevation_ft: 23,  runway: { idents:["15L","33R"], heading_deg:150,length_m:3750 } },
  WSSS: { name: "SINGAPOUR CHANGI",       lat: 1.3644,   lon: 103.9915, elevation_ft: 22,  runway: { idents:["02L","20R"], heading_deg:20,  length_m:4000 } },
  VTBS: { name: "BANGKOK SUVARNABHUMI",   lat: 13.6900,  lon: 100.7501, elevation_ft: 5,   runway: { idents:["01L","19R"], heading_deg:10,  length_m:4000 } },
  UUEE: { name: "MOSCOU CHEREMETIEVO",    lat: 55.9726,  lon: 37.4146,  elevation_ft: 622, runway: { idents:["06L","24R"], heading_deg:60,  length_m:3700 } },
  // Océanie / Pacifique
  YSSY: { name: "SYDNEY KINGSFORD SMITH", lat: -33.9399, lon: 151.1753, elevation_ft: 21,  runway: { idents:["07","25"], heading_deg:70,    length_m:3960 } },
  YMML: { name: "MELBOURNE",              lat: -37.6690, lon: 144.8410, elevation_ft: 434, runway: { idents:["09","27"], heading_deg:90,    length_m:3660 } },
  NZAA: { name: "AUCKLAND",               lat: -37.0082, lon: 174.7850, elevation_ft: 23,  runway: { idents:["05L","23R"], heading_deg:50, length_m:3635 } },
  NZCH: { name: "CHRISTCHURCH (porte d'entrée Antarctique)", lat: -43.4894, lon: 172.5320, elevation_ft: 123, runway: { idents:["02","20"], heading_deg:20, length_m:3288 } },
  PGUM: { name: "GUAM (Pacifique)",       lat: 13.4834,  lon: 144.7960, elevation_ft: 297, runway: { idents:["06L","24R"], heading_deg:60,  length_m:3298 } },
  PHNL: { name: "HONOLULU (Pacifique)",   lat: 21.3187,  lon: -157.9224,elevation_ft: 13,  runway: { idents:["08L","26R"], heading_deg:80,  length_m:3750 } },
  // Antarctique — pas d'ICAO officiel pour la plupart des stations ; codes usuels indiqués
  NZSP: { name: "AMUNDSEN-SCOTT SOUTH POLE (Antarctique)", lat: -90.0000, lon: 0.0000,   elevation_ft: 9300,runway: { idents:["01","19"], heading_deg:10, length_m:3000 } },
  NZWD: { name: "WILLIAMS FIELD / McMURDO (Antarctique)",  lat: -77.8672, lon: 167.0567, elevation_ft: 60,  runway: { idents:["16","34"], heading_deg:160, length_m:3000 } },
  NZFX: { name: "PEGASUS FIELD / McMURDO (Antarctique)",   lat: -77.9633, lon: 166.4581, elevation_ft: 30,  runway: { idents:["15","33"], heading_deg:150, length_m:3050 } },
  AT03: { name: "ROTHERA (Antarctique, Royaume-Uni)",      lat: -67.5672, lon: -68.1270, elevation_ft: 52,  runway: { idents:["05","23"], heading_deg:50,  length_m:900 } },
  // Groenland / Arctique
  BGSF: { name: "KANGERLUSSUAQ (Arctique)", lat: 67.0122, lon: -50.7116, elevation_ft: 165,runway: { idents:["09","27"], heading_deg:90,    length_m:2810 } },
};

function icaoFromCallsign(callsign){
  return (callsign.split("_")[0] || callsign).slice(0, 4).toUpperCase();
}

async function openaipFindAirport(icao){
  if (!window.OPENAIP_API_KEY) return null;
  try{
    const url = `${OPENAIP_BASE}/airports?search=${encodeURIComponent(icao)}&limit=5&apiKey=${encodeURIComponent(window.OPENAIP_API_KEY)}`;
    const res = await fetch(url);
    if (res.status === 400) throw new Error("requête refusée (400) par OpenAIP");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = data.items || data.docs || [];
    const hit = items.find(a => (a.icaoCode || a.icao || "").toUpperCase() === icao) || items[0];
    if (!hit || !hit.geometry) return null;
    const [lon, lat] = hit.geometry.coordinates;
    let runway = null;
    if (Array.isArray(hit.runways) && hit.runways.length){
      const r = hit.runways[0];
      const idents = [r.designator || "", r.trueHeading != null ? String(Math.round((r.trueHeading + 180) % 360)).padStart(2,"0") : ""];
      if (r.trueHeading != null) runway = { idents, heading_deg: r.trueHeading, length_m: (r.dimension && r.dimension.length && r.dimension.length.value) || 2500 };
    }
    return { name: hit.name || icao, lat, lon, elevation_ft: (hit.elevation && hit.elevation.value) || 0, runway, source: "openaip" };
  } catch(err){
    showToast("OpenAIP (recherche aérodrome) : " + err.message, true);
    return null;
  }
}

async function locateStation(rawCallsign){
  const callsign = (rawCallsign || "").trim().toUpperCase();
  if (!callsign){ showToast("Entrez un callsign de position (ex: LFRS_TWR).", true); return; }
  state.station.callsign = callsign;
  $("airport-title").textContent = callsign;
  $("station-input").value = callsign;

  // 1) Un secteur exact existe déjà dans Firebase pour ce callsign → le plus fiable.
  const sec = state.sectors[callsign];
  if (sec && sec.polygon && sec.polygon.length){
    const c = polygonCentroid(sec.polygon);
    state.station.lat = c[0]; state.station.lon = c[1];
    state.station.name = callsign;
    showToast(`Position localisée via le secteur Firebase "${callsign}".`);
    finishStationLocate();
    return;
  }

  const icao = icaoFromCallsign(callsign);

  // 2) OpenAIP (si une clé API est configurée).
  const fromOpenaip = await openaipFindAirport(icao);
  if (fromOpenaip){
    state.station.lat = fromOpenaip.lat; state.station.lon = fromOpenaip.lon;
    state.station.name = fromOpenaip.name; state.station.icao = icao;
    if (fromOpenaip.runway) state.station.runway = fromOpenaip.runway;
    showToast(`Aérodrome ${icao} localisé via OpenAIP.`);
    finishStationLocate();
    return;
  }

  // 3) Table intégrée.
  const fb = AIRPORT_FALLBACK[icao];
  if (fb){
    state.station.lat = fb.lat; state.station.lon = fb.lon; state.station.name = fb.name;
    state.station.icao = icao; state.station.runway = fb.runway;
    showToast(`Aérodrome ${icao} localisé (table intégrée).`);
    finishStationLocate();
    return;
  }

  // 4) Échec : on demande les coordonnées à la main plutôt que de bloquer.
  const manual = prompt(
    `Aérodrome "${icao}" introuvable (pas de secteur Firebase, pas de clé OpenAIP ou aucun résultat, absent de la table intégrée).\n` +
    `Entrez ses coordonnées "lat,lon" (ex: 47.15,-1.61), ou Annuler pour garder la position actuelle :`
  );
  if (manual){
    const m = manual.split(",").map(s => parseFloat(s.trim()));
    if (m.length === 2 && !isNaN(m[0]) && !isNaN(m[1])){
      state.station.lat = m[0]; state.station.lon = m[1]; state.station.name = callsign; state.station.icao = icao;
      state.station.runway = null;
      showToast(`Position définie manuellement pour ${icao}.`);
      finishStationLocate();
      return;
    }
    showToast("Coordonnées non reconnues — position inchangée.", true);
  } else {
    showToast(`Position introuvable pour ${icao} — la carte reste centrée sur la position précédente.`, true);
  }
}
function finishStationLocate(){
  state.stationSet = true;
  $("airport-title").textContent = state.station.callsign;
  renderPvd();
  if (map) map.setView([state.station.lat, state.station.lon], Math.max(map.getZoom(), 9));
  if (miniMap) miniMap.setView([state.station.lat, state.station.lon], 14);
  drawRunwayOnMini();
  fetchMetar();
  if (state.procFixesShown) loadProcedureFixes();
}
$("station-load").addEventListener("click", () => locateStation($("station-input").value));
$("station-input").addEventListener("keydown", e => { if (e.key === "Enter") locateStation($("station-input").value); });
$("station-input").value = state.stationSet ? state.station.callsign : "";
$("airport-title").textContent = state.stationSet ? state.station.callsign : "AÉRODROME NON DÉFINI";
if (!state.stationSet) showToast("Aucune position par défaut : saisissez votre callsign (ex: LFRS_TWR) puis \"Charger\".");

/* ---------------------------------------------------------------------------
   5. METAR / ATIS
--------------------------------------------------------------------------- */
function toRad(d){ return d * Math.PI / 180; }
function windComponents(windDirDeg, windKt, rwyHeadingDeg){
  const diff = toRad(rwyHeadingDeg - windDirDeg);
  const head = Math.round(windKt * Math.cos(diff));
  const cross = Math.round(windKt * Math.sin(diff));
  return { head, cross };
}
function computeAtisLetter(zuluDate){
  // Convention ATIS classique : une nouvelle lettre à chaque cycle de 30 min, A→Z puis on boucle.
  const bucket = zuluDate.getUTCHours() * 2 + (zuluDate.getUTCMinutes() >= 30 ? 1 : 0);
  return String.fromCharCode(65 + (bucket % 26));
}
function parseMetarWind(raw){
  const m = raw.match(/\b(\d{3}|VRB)(\d{2,3})(?:G\d{2,3})?(KT|MPS)\b/);
  if (!m) return null;
  let dir = m[1] === "VRB" ? null : parseInt(m[1], 10);
  let spd = parseInt(m[2], 10);
  if (m[3] === "MPS") spd = Math.round(spd * 1.94384);
  return { dir, spd };
}
function parseMetarQnh(raw){
  const q = raw.match(/\bQ(\d{4})\b/);
  if (q) return { unit: "hPa", value: parseInt(q[1], 10) };
  const a = raw.match(/\bA(\d{4})\b/);
  if (a) return { unit: "inHg", value: (parseInt(a[1], 10) / 100).toFixed(2) };
  return null;
}
let lastMetarRaw = "";

// aviationweather.gov annonce explicitement "Cross-origin resource sharing is not
// permitted at this time" : un fetch direct depuis le navigateur échoue donc presque
// toujours (erreur CORS, pas HTTP). On tente quand même en direct (au cas où ça change),
// puis on passe par un proxy CORS public, configurable via window.METAR_CORS_PROXY.
// -----------------------------------------------------------------------------
// Aide partagée : essaie une URL en direct, puis via une liste de proxys CORS
// publics si le direct échoue. Utilisée pour aviationweather.gov (annonce
// explicitement ne pas supporter CORS) ET pour api.core.openaip.net (dont les
// réponses n'incluent PAS "Access-Control-Allow-Origin" non plus : une requête
// serveur-à-serveur identique renvoie 200 avec les bonnes données, mais TOUT
// navigateur la bloque après coup, quels que soient l'origine ou le bbox).
// -----------------------------------------------------------------------------
function corsProxyList(){
  return [
    window.METAR_CORS_PROXY,
    "https://api.codetabs.com/v1/proxy?quest=",
    "https://api.allorigins.win/raw?url=",
    "https://corsproxy.io/?url=",
  ].filter(Boolean);
}
async function fetchTextWithProxies(targetUrl, { directFirst = true } = {}){
  const attempts = [];
  if (directFirst) attempts.push({ url: targetUrl });
  corsProxyList().forEach(p => attempts.push({ url: p + encodeURIComponent(targetUrl) }));
  let lastErr = null;
  for (const attempt of attempts){
    try{
      const res = await fetch(attempt.url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text || !text.trim()) throw new Error("réponse vide");
      return text;
    } catch(err){ lastErr = err; }
  }
  throw lastErr || new Error("toutes les sources ont échoué (direct + proxys)");
}


async function fetchRawMetarText(icao){
  const directUrl = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=raw`;
  const tgftpUrl = `https://tgftp.nws.noaa.gov/data/observations/metar/stations/${icao}.TXT`;
  let text;
  try{
    text = await fetchTextWithProxies(directUrl);
  } catch(err1){
    text = await fetchTextWithProxies(tgftpUrl); // laisse l'erreur remonter si ça échoue aussi
  }
  // Le fichier NOAA tgftp a une ligne d'horodatage puis la ligne METAR : on garde la
  // dernière ligne qui commence par l'identifiant ICAO recherché ; sinon la dernière ligne.
  const lines = text.trim().split("\n").map(l => l.trim()).filter(Boolean);
  const raw = lines.find(l => l.toUpperCase().startsWith(icao)) || lines[lines.length - 1];
  if (!raw) throw new Error("METAR introuvable dans la réponse");
  return raw;
}

async function fetchMetar(){
  const icao = state.station.icao;
  $("hud-metar-status").textContent = "Récupération du METAR…";
  try{
    const raw = await fetchRawMetarText(icao);
    $("hud-metar").textContent = raw;
    lastMetarRaw = raw;
    $("hud-metar-status").textContent = "";

    const wind = parseMetarWind(raw);
    const qnh = parseMetarQnh(raw);
    $("hud-qnh").textContent = `${icao}  ${qnh ? (qnh.unit === "hPa" ? "Q" + qnh.value : "A" + qnh.value) : "—"}` +
      (wind && wind.dir != null ? `  ${pad2(String(wind.dir)).padStart(3,"0")}°${wind.spd}KT` : (wind ? `  VRB${wind.spd}KT` : ""));
    $("hud-wind").textContent = wind ? `Vent : ${wind.dir != null ? wind.dir + "°" : "variable"} / ${wind.spd} kt` : "Vent indisponible";

    const rwy = state.station.runway;
    if (wind && wind.dir != null && rwy && rwy.idents && rwy.idents.length >= 2){
      const h1 = rwy.heading_deg;
      const h2 = (rwy.heading_deg + 180) % 360;
      const c1 = windComponents(wind.dir, wind.spd, h1);
      const c2 = windComponents(wind.dir, wind.spd, h2);
      $("hud-rwy1").textContent = `RWY ${rwy.idents[0]} : ${fmtWindComp(c1)}`;
      $("hud-rwy2").textContent = `RWY ${rwy.idents[1]} : ${fmtWindComp(c2)}`;
    } else {
      $("hud-rwy1").textContent = ""; $("hud-rwy2").textContent = "";
    }

    const zMatch = raw.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
    const obsDate = new Date();
    if (zMatch) obsDate.setUTCHours(parseInt(zMatch[2],10), parseInt(zMatch[3],10), 0, 0);
    $("hud-atis").textContent = computeAtisLetter(obsDate);

    drawRunwayOnMini();
    if (typeof renderFplPanel === "function") renderFplPanel();
  } catch(err){
    $("hud-metar").textContent = `METAR indisponible (${err.message}).`;
    $("hud-metar-status").textContent = "3 sources tentées (direct, proxy aviationweather.gov, proxy NOAA) — toutes ont échoué. Réessai dans 5 min, ou changez window.METAR_CORS_PROXY dans aurora-config.js.";
    $("hud-qnh").textContent = `${icao}  —`;
    $("hud-wind").textContent = "";
    $("hud-atis").textContent = "–";
  }
}
function fmtWindComp(c){
  const headTxt = c.head >= 0 ? `face ${c.head}kt` : `arrière ${-c.head}kt`;
  const crossTxt = `travers ${Math.abs(c.cross)}kt ${c.cross >= 0 ? "D" : "G"}`;
  return `${headTxt} · ${crossTxt}`;
}

/* ---------------------------------------------------------------------------
   6. Firebase (SDK Web — jamais de clé de compte de service ici)
--------------------------------------------------------------------------- */
let db = null, firebaseReady = false;
function initFirebase(){
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.databaseURL || /votre-projet/.test(cfg.databaseURL)){
    $("led-firebase").className = "led";
    showToast("Complétez aurora-config.js (FIREBASE_CONFIG) pour charger le trafic et les secteurs.", true);
    return;
  }
  try{
    firebase.initializeApp(cfg);
    db = firebase.database();
    firebaseReady = true;
    $("led-firebase").className = "led on";
    attachFirebaseListeners();
  } catch(err){
    $("led-firebase").className = "led";
    showToast("Erreur d'initialisation Firebase : " + err.message, true);
  }
}
function attachFirebaseListeners(){
  db.ref("flights").on("value", snap => { state.flights = snap.val() || {}; renderTmChips(); renderFplPanel(); renderAircraftOnMap(); renderVhfUsers(); });
  db.ref("sectors").on("value", snap => { state.sectors = snap.val() || {}; renderPvd(); renderAtcList(); });
  db.ref("atc_online").on("value", snap => { state.atcOnline = snap.val() || {}; renderAtcList(); });
  db.ref("com_log").limitToLast(80).on("value", snap => { renderComLog(snap.val() || {}); });
  // atc_strips : données de travail ATC (altitude/vitesse/route assignées, remarques). Ce nœud
  // est séparé de "flights" (télémétrie brute envoyée par le pilote) : appliquez une règle
  // Firebase du type ".read"/".write": "auth != null && ATC" sur "atc_strips" pour que seuls
  // les contrôleurs authentifiés y aient accès — les pilotes n'ont besoin que de "flights".
  db.ref("atc_strips").on("value", snap => { state.atcStrips = snap.val() || {}; renderFplPanel(); renderStrips(); renderAircraftOnMap(); });
}

/* Connexion / prise de position ------------------------------------------ */
$("btn-connect").addEventListener("click", () => {
  if (!firebaseReady){ showToast("Firebase non configuré — impossible de se déclarer en ligne.", true); return; }
  state.connected = true;
  const ref = db.ref("atc_online/" + state.station.callsign);
  ref.set({
    callsign: state.station.callsign,
    frequency: state.vhfFreq.toFixed(3),
    since: new Date().toISOString(),
  });
  ref.onDisconnect().remove();
  $("btn-connect").style.display = "none";
  $("btn-disconnect").style.display = "inline-block";
  showToast(`${state.station.callsign} en ligne. Seules les zones de cette position restent affichées.`);
  renderPvd();
  refreshOpenaipLayers();
  joinVoiceMesh();
});
$("btn-disconnect").addEventListener("click", () => {
  state.connected = false;
  if (firebaseReady) db.ref("atc_online/" + state.station.callsign).remove();
  $("btn-connect").style.display = "inline-block";
  $("btn-disconnect").style.display = "none";
  showToast(`${state.station.callsign} déconnecté.`);
  renderPvd();
  refreshOpenaipLayers();
  leaveVoiceMesh();
});
window.addEventListener("beforeunload", () => {
  if (state.connected && firebaseReady) db.ref("atc_online/" + state.station.callsign).remove();
  leaveVoiceMesh();
});

/* ---------------------------------------------------------------------------
   7. Carte PVD (Leaflet) + secteurs + anneaux de distance
--------------------------------------------------------------------------- */
let map, sectorLayer, ringLayer, waypointsLayer, reportingPointsLayer, airspacesLayer, procFixesLayer, aircraftLayer, vertexLabelLayer, vectorLayer, rwyPvdLayer;
let currentVoicePresence = {}; // dernier snapshot voice_presence/<freq> reçu, tous callsigns confondus (ATC ET pilotes VHF-only) — déclaré tôt car renderVhfUsers() l'utilise dès le chargement du script
function initMap(){
  map = L.map("pvd-map", { zoomControl: true, worldCopyJump: true })
    .setView([state.station.lat, state.station.lon], state.stationSet ? 9 : 6);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "&copy; OpenStreetMap" }).addTo(map);
  addRecenterControl();

  sectorLayer = L.layerGroup().addTo(map);
  vertexLabelLayer = L.layerGroup().addTo(map);
  ringLayer = L.layerGroup().addTo(map);
  waypointsLayer = L.layerGroup();
  reportingPointsLayer = L.layerGroup();
  airspacesLayer = L.layerGroup();
  procFixesLayer = L.layerGroup();
  aircraftLayer = L.layerGroup().addTo(map);
  vectorLayer = L.layerGroup().addTo(map);
  rwyPvdLayer = L.layerGroup().addTo(map);

  map.on("moveend zoomend", () => {
    refreshOpenaipLayers();
    drawRunwayOnPvd();
  });

  drawDistanceRings();
  renderPvd();
  drawRunwayOnPvd();

  // Sur demande : les points RNAV/VOR/NDB et les espaces aériens sont affichés par
  // défaut dès qu'une clé OpenAIP est configurée (au lieu d'attendre un clic sur FIX/VFR/GTS).
  if (window.OPENAIP_API_KEY){
    state.waypointsShown = true; map.addLayer(waypointsLayer);
    state.reportingPointsShown = true; map.addLayer(reportingPointsLayer);
    state.airspacesShown = true; map.addLayer(airspacesLayer);
    document.querySelectorAll('.tbtn').forEach(b => { if (["FIX","VFR","GTS"].includes(b.textContent)) b.classList.add("active"); });
    refreshOpenaipLayers();
  }
}

// Bouton "rose" en bas à droite de la carte : recentre TOUJOURS sur la position
// actuellement contrôlée (state.station, mise à jour par locateStation()) — jamais
// sur un aérodrome codé en dur. Reste grisé/désactivé tant qu'aucune position
// n'a été chargée (rien à recentrer dessus).
function recenterOnStation(){
  if (!state.stationSet){
    showToast("Aucun aérodrome chargé — saisissez un callsign de position puis \"Charger\".", true);
    return;
  }
  if (map) map.setView([state.station.lat, state.station.lon], Math.max(map.getZoom(), 9));
}
function addRecenterControl(){
  const Recenter = L.Control.extend({
    options: { position: "bottomright" },
    onAdd: function(){
      const box = L.DomUtil.create("div", "leaflet-bar recenter-ctrl");
      box.innerHTML = `<a href="#" role="button" title="Recentrer sur la position contrôlée" id="pvd-recenter">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.4"/>
          <path d="M12 2 L12 6 M12 18 L12 22 M2 12 L6 12 M18 12 L22 12" stroke="currentColor" stroke-width="1.4"/>
          <circle cx="12" cy="12" r="2.2" fill="currentColor"/>
        </svg></a>`;
      L.DomEvent.disableClickPropagation(box);
      box.querySelector("a").addEventListener("click", (e) => { e.preventDefault(); recenterOnStation(); });
      return box;
    }
  });
  new Recenter().addTo(map);
}

function nm(meters){ return meters / 1852; }
function bearingDistanceFrom(centerLat, centerLon, lat, lon){
  const R = 6371000;
  const phi1 = toRad(centerLat), phi2 = toRad(lat);
  const dphi = toRad(lat - centerLat), dlambda = toRad(lon - centerLon);
  const a = Math.sin(dphi/2)**2 + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlambda/2)**2;
  const dist = 2 * R * Math.asin(Math.sqrt(a));
  const y = Math.sin(dlambda) * Math.cos(phi2);
  const x = Math.cos(phi1)*Math.sin(phi2) - Math.sin(phi1)*Math.cos(phi2)*Math.cos(dlambda);
  let brg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return { bearing: brg, distanceNm: nm(dist) };
}
function destPoint(lat, lon, bearingDeg, distMeters){
  const R = 6371000;
  const phi1 = toRad(lat), lam1 = toRad(lon), brg = toRad(bearingDeg);
  const dr = distMeters / R;
  const phi2 = Math.asin(Math.sin(phi1)*Math.cos(dr) + Math.cos(phi1)*Math.sin(dr)*Math.cos(brg));
  const lam2 = lam1 + Math.atan2(Math.sin(brg)*Math.sin(dr)*Math.cos(phi1), Math.cos(dr)-Math.sin(phi1)*Math.sin(phi2));
  return [phi2 * 180/Math.PI, lam2 * 180/Math.PI];
}
function polygonCentroid(pts){
  let lat = 0, lon = 0;
  pts.forEach(p => { lat += p[0]; lon += p[1]; });
  return [lat / pts.length, lon / pts.length];
}

function drawDistanceRings(){
  ringLayer.clearLayers();
  const center = [state.station.lat, state.station.lon];
  [10, 20, 40, 80].forEach(radiusNm => {
    L.circle(center, { radius: radiusNm * 1852, color: "#2a2a2a", weight: 1, fill: false, dashArray: "2 5" }).addTo(ringLayer);
    const pt = destPoint(center[0], center[1], 90, radiusNm * 1852);
    L.marker(pt, { icon: L.divIcon({ className: "", html: `<div class="ring-label">${radiusNm}NM</div>`, iconSize: [40,12] }) }).addTo(ringLayer);
  });
  L.marker(center, { icon: L.divIcon({ className: "", html: `<div style="width:6px;height:6px;background:#fff;border-radius:50%;box-shadow:0 0 5px #fff;"></div>`, iconSize: [6,6] }) }).addTo(ringLayer);
}

const TYPE_COLORS = { CTR: "#4f8cff", APP: "#ffb23e", TWR: "#ff5c6c", GND: "#35d07f" };
function renderPvd(){
  if (!map) return;
  sectorLayer.clearLayers();
  vertexLabelLayer.clearLayers();
  const myIcao = icaoFromCallsign(state.station.callsign);
  Object.values(state.sectors || {}).forEach(sec => {
    if (!sec.polygon || !sec.polygon.length) return;
    const isActive = sec.callsign === state.station.callsign;
    // Connecté à une position : on ne montre que les secteurs/TMA de CETTE position
    // (même préfixe ICAO — ex. LFRS_APP/LFRS_GND si on contrôle LFRS_TWR) pour ne pas
    // encombrer le contrôleur avec des zones sans rapport. Avant connexion : tout est visible.
    if (state.connected && icaoFromCallsign(sec.callsign) !== myIcao) return;
    const color = TYPE_COLORS[sec.type] || "#e0912e";
    L.polygon(sec.polygon, {
      color, weight: isActive ? 2 : 1, opacity: isActive ? 0.95 : 0.45,
      fillOpacity: isActive ? 0.04 : 0.02, dashArray: isActive ? null : "4 4"
    }).addTo(sectorLayer).bindTooltip(`${sec.callsign} (${sec.frequency || "—"})`, { sticky: true });

    if (isActive){
      const c = polygonCentroid(sec.polygon);
      sec.polygon.forEach(pt => {
        const bd = bearingDistanceFrom(c[0], c[1], pt[0], pt[1]);
        L.marker(pt, {
          icon: L.divIcon({
            className: "", iconSize: [70, 24], iconAnchor: [35, -4],
            html: `<div class="vtx-label">${bd.bearing.toFixed(0).padStart(3,"0")}<br>${bd.distanceNm.toFixed(2)}</div>`
          })
        }).addTo(vertexLabelLayer);
      });
    }
  });
}

/* Aéronefs sur la carte ---------------------------------------------------- */
function isEmergencySquawk(code){ return code && EMERGENCY_CODES.has(String(code).padStart(4, "0")); }
function emergencyLabel(code){
  if (code === "7700") return "EMER — DÉTRESSE";
  if (code === "7600") return "EMER — PANNE RADIO";
  if (code === "7500") return "EMER — DÉTOURNEMENT";
  return "EMER";
}
function aircraftIcon(headingDeg, selected, emer){
  const rot = Math.round(headingDeg || 0);
  const color = emer ? "#ff2d3d" : (selected ? "#ffe27a" : "#9be89b");
  return L.divIcon({
    className: "", iconSize: [16,16], iconAnchor: [8,8],
    html: `<svg width="16" height="16" viewBox="0 0 16 16" style="transform:rotate(${rot}deg);${emer ? "filter:drop-shadow(0 0 4px #ff2d3d);" : ""}">
      <path d="M8 1 L11 9 L8 7 L5 9 Z" fill="${color}" stroke="#000" stroke-width="0.5"/></svg>`
  });
}
const aircraftMarkers = {};
function renderAircraftOnMap(){
  if (!map) return;
  const seen = new Set();
  vectorLayer.clearLayers();
  Object.entries(state.flights || {}).forEach(([callsign, f]) => {
    if (f.latitude == null || f.longitude == null) return;
    seen.add(callsign);
    const selected = callsign === state.selectedCallsign;
    const sqk = f.transponder;
    const emer = isEmergencySquawk(sqk);

    // Détection d'une NOUVELLE urgence (transition) pour ne biper qu'une fois à l'apparition.
    const prev = state.prevSquawk[callsign];
    if (emer && !isEmergencySquawk(prev)){
      emergencyBeep();
      showToast(`🚨 ${callsign} — ${emergencyLabel(sqk)} (squawk ${sqk})`, true);
    }
    state.prevSquawk[callsign] = sqk;

    let mk = aircraftMarkers[callsign];
    const latlng = [f.latitude, f.longitude];
    if (!mk){
      mk = L.marker(latlng, { icon: aircraftIcon(f.heading_deg, selected, emer) }).addTo(aircraftLayer);
      mk.on("click", () => selectAircraft(callsign));
      mk.on("contextmenu", (e) => { L.DomEvent.preventDefault(e); openAcContextMenu(e.originalEvent, callsign); });
      aircraftMarkers[callsign] = mk;
    } else {
      mk.setLatLng(latlng);
      mk.setIcon(aircraftIcon(f.heading_deg, selected, emer));
    }

    // Ligne de vecteur cap/vitesse, comme sur un vrai radar : projection de la
    // position à N minutes (1 ou 2, bouton "v2") au cap et à la vitesse sol actuels.
    if (f.heading_deg != null && f.ground_speed_kt){
      const lengthM = f.ground_speed_kt * 1852 / 60 * state.vectorMinutes;
      const tip = destPoint(f.latitude, f.longitude, f.heading_deg, lengthM);
      L.polyline([latlng, tip], { color: emer ? "#ff2d3d" : "#8fd6a8", weight: 1.4, opacity: 0.85, className: "vector-line" }).addTo(vectorLayer);
    }

    // Étiquette façon radar réel : indicatif (toujours en couleur d'accent) puis,
    // en dessous, type / route ou directe assignée / altitude / départ-arrivée —
    // en gris tant que le trafic n'est pas "assumé" par ce poste, en vert une fois
    // assumé (clic droit sur l'avion → Assumer). L'état "assumé" est stocké dans
    // atc_strips/<callsign> (voir setAssumed()), donc partagé entre tous les
    // contrôleurs connectés, comme un vrai transfert.
    const strip = state.atcStrips[callsign] || {};
    const assumed = !!strip.assumed;
    const routeLine = strip.assigned_wp ? `DCT ${strip.assigned_wp}` : (f.route ? String(f.route).split(" ").slice(0, 3).join(" ") : "—");
    const depArr = `${f.departure || "????"} ${f.arrival || "????"}`;
    const tagHtml = `<div class="ac-wrap${selected ? " selected" : ""}">` +
      (emer ? `<div class="ac-emer-label">${emergencyLabel(sqk)}</div>` : "") +
      `<div class="ac-tag${emer ? " emer" : ""}${assumed ? " assumed" : ""}">` +
        `<span class="callsign">${callsign}</span>` +
        `<span class="ln">${f.aircraft_type || "????"}</span>` +
        `<span class="ln">${escapeHtml(routeLine)}</span>` +
        `<span class="ln">${Math.round(f.altitude_ft||0)}</span>` +
        `<span class="ln">${escapeHtml(depArr)}</span>` +
      `</div></div>`;
    mk.bindTooltip(tagHtml, { permanent: true, direction: "right", offset: [10, -22], className: "ac-tooltip", opacity: 1 });
  });
  Object.keys(aircraftMarkers).forEach(cs => {
    if (!seen.has(cs)){ aircraftLayer.removeLayer(aircraftMarkers[cs]); delete aircraftMarkers[cs]; delete state.prevSquawk[cs]; }
  });
}
/* Assume/relâche d'un trafic — clic droit sur l'avion → menu contextuel.
   Écrit dans atc_strips/<callsign>/assumed (partagé Firebase, comme le reste
   du strip), donc visible en vert par tous les postes connectés, pas
   seulement localement. */
function setAssumed(callsign, value){
  if (!state.connected){ showToast("Connectez-vous à une position pour assumer un trafic.", true); return; }
  db.ref(`atc_strips/${callsign}`).update({
    assumed: value,
    assumed_by: value ? state.station.callsign : null,
    assumed_at: value ? Date.now() : null,
  }).catch(err => showToast("Impossible de mettre à jour le strip : " + err.message, true));
}
let acCtxMenuEl = null;
function closeAcContextMenu(){
  if (acCtxMenuEl){ acCtxMenuEl.remove(); acCtxMenuEl = null; }
  document.removeEventListener("click", closeAcContextMenu, true);
}
function openAcContextMenu(evt, callsign){
  closeAcContextMenu();
  const strip = state.atcStrips[callsign] || {};
  const assumed = !!strip.assumed;
  const menu = el("div", "ac-ctx-menu");
  const item1 = el("div", "item" + (assumed ? "" : " on"), assumed ? "Relâcher" : "Assumer " + callsign);
  item1.addEventListener("click", () => { setAssumed(callsign, !assumed); closeAcContextMenu(); });
  menu.appendChild(item1);
  const item2 = el("div", "item", "Sélectionner");
  item2.addEventListener("click", () => { selectAircraft(callsign); closeAcContextMenu(); });
  menu.appendChild(item2);
  document.body.appendChild(menu);
  const x = Math.min(evt.clientX, window.innerWidth - menu.offsetWidth - 8);
  const y = Math.min(evt.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  acCtxMenuEl = menu;
  setTimeout(() => document.addEventListener("click", closeAcContextMenu, true), 0);
}
function selectAircraft(callsign){
  state.selectedCallsign = callsign;
  renderAircraftOnMap();
  renderTmChips();
  renderFplPanel();
  const f = state.flights[callsign];
  if (f && f.latitude != null) map.panTo([f.latitude, f.longitude]);
}

/* ---------------------------------------------------------------------------
   8. Piste(s) — rendu haute visibilité, réutilisé sur la vignette et le PVD
--------------------------------------------------------------------------- */
function runwayList(){
  const rwy = state.station.runway;
  if (!rwy || rwy.heading_deg == null) return [];
  return Array.isArray(rwy) ? rwy : [rwy];
}
// Dessine une piste comme un rectangle plein (largeur réaliste ~45m, jamais moins
// de quelques px visibles) + liseré + axe central pointillé + repères d'identification
// à bulle contrastée à chaque seuil, pour qu'elle ressorte nettement du fond de carte.
function drawRunwayInto(layer, rwy, opts){
  opts = opts || {};
  const widthM = Math.max(rwy.width_m || 45, 45);
  const half = (rwy.length_m || 2000) / 2;
  const c = [state.station.lat, state.station.lon];
  const p1 = destPoint(c[0], c[1], rwy.heading_deg, half);
  const p2 = destPoint(c[0], c[1], (rwy.heading_deg + 180) % 360, half);
  const perpBrg = (rwy.heading_deg + 90) % 360;
  const hw = widthM / 2;
  const corners = [
    destPoint(p1[0], p1[1], perpBrg, hw), destPoint(p1[0], p1[1], perpBrg + 180, hw),
    destPoint(p2[0], p2[1], perpBrg + 180, hw), destPoint(p2[0], p2[1], perpBrg, hw),
  ];
  L.polygon(corners, { color: "#111", weight: 1, fillColor: "#f4f4f0", fillOpacity: 0.96 }).addTo(layer);
  L.polyline([p1, p2], { color: "#c8c8c8", weight: 1, dashArray: "6 6", opacity: 0.9 }).addTo(layer);
  if (rwy.idents && rwy.idents[0]){
    L.marker(p1, { icon: L.divIcon({ className:"", iconSize:[46,20], iconAnchor:[23,10], html:`<div class="rwy-label">${rwy.idents[0]}</div>` }) }).addTo(layer);
  }
  if (rwy.idents && rwy.idents[1]){
    L.marker(p2, { icon: L.divIcon({ className:"", iconSize:[46,20], iconAnchor:[23,10], html:`<div class="rwy-label">${rwy.idents[1]}</div>` }) }).addTo(layer);
  }
}

/* Vignette aéroport (mini carte) ------------------------------------------ */
let miniMap, miniRwyLayer;
function initMiniMap(){
  miniMap = L.map("airport-mini", { zoomControl: false, dragging: true, attributionControl: false })
    .setView([state.station.lat, state.station.lon], 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(miniMap);
  miniRwyLayer = L.layerGroup().addTo(miniMap);
  drawRunwayOnMini();
}
function drawRunwayOnMini(){
  if (!miniMap) return;
  miniRwyLayer.clearLayers();
  runwayList().forEach(rwy => drawRunwayInto(miniRwyLayer, rwy));
}

/* Piste(s) sur le PVD principal — seulement quand assez zoomé pour être lisible */
const RWY_PVD_MIN_ZOOM = 11;
function drawRunwayOnPvd(){
  if (!map || !rwyPvdLayer) return;
  rwyPvdLayer.clearLayers();
  if (map.getZoom() < RWY_PVD_MIN_ZOOM) return;
  runwayList().forEach(rwy => drawRunwayInto(rwyPvdLayer, rwy));
}

/* ---------------------------------------------------------------------------
   9. OpenAIP — navaids (VOR/NDB/DME), points RNAV/VFR, espaces aériens
   Couverture MONDIALE (y compris océans et Antarctique) : les requêtes sont basées
   sur la zone visible de la carte (bbox), sans aucune restriction géographique dans
   le code — la densité de données dépend uniquement de ce que la communauté OpenAIP
   a renseigné dans chaque région (souvent plus clairsemé hors Europe/Amérique du Nord).
--------------------------------------------------------------------------- */
function currentBbox(){
  const b = map.getBounds();
  return `${b.getWest().toFixed(4)},${b.getSouth().toFixed(4)},${b.getEast().toFixed(4)},${b.getNorth().toFixed(4)}`;
}
// Rayon de recherche (mètres) autour du centre de la carte, dérivé de l'étendue
// actuellement visible, plafonné pour rester raisonnable pour l'API.
function currentPosDist(maxKm = 150){
  const c = map.getCenter();
  const b = map.getBounds();
  const kmHalfDiag = c.distanceTo(b.getNorthEast()) / 1000;
  const distM = Math.min(Math.max(kmHalfDiag, 15), maxKm) * 1000;
  return { pos: `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`, dist: Math.round(distM) };
}
function openaipReady(){
  if (!window.OPENAIP_API_KEY){
    showToast("Renseignez OPENAIP_API_KEY dans aurora-config.js pour les points RNAV/VOR et espaces aériens.", true);
    $("led-openaip").className = "led";
    return false;
  }
  $("led-openaip").className = "led on";
  return true;
}
function toggleWaypoints(){
  state.waypointsShown = !state.waypointsShown;
  if (state.waypointsShown){
    map.addLayer(waypointsLayer);
    if (!openaipReady()){ state.waypointsShown = false; map.removeLayer(waypointsLayer); return; }
    loadWaypoints();
  } else {
    map.removeLayer(waypointsLayer);
  }
}
function toggleReportingPoints(){
  state.reportingPointsShown = !state.reportingPointsShown;
  if (state.reportingPointsShown){
    map.addLayer(reportingPointsLayer);
    if (!openaipReady()){ state.reportingPointsShown = false; map.removeLayer(reportingPointsLayer); return; }
    loadReportingPoints();
  } else {
    map.removeLayer(reportingPointsLayer);
  }
}
function toggleAirspaces(){
  state.airspacesShown = !state.airspacesShown;
  if (state.airspacesShown){
    map.addLayer(airspacesLayer);
    if (!openaipReady()){ state.airspacesShown = false; map.removeLayer(airspacesLayer); return; }
    loadAirspaces();
  } else {
    map.removeLayer(airspacesLayer);
  }
}
// SID/STAR & fixes RNAV enroute : OpenAIP (base publique gratuite) ne fournit
// AUCUNE donnée de procédures IFR (SID/STAR) ni de fixes RNAV enroute — ce
// n'est pas dans son schéma (confirmé sur le schéma officiel de l'API :
// endpoints disponibles = Airports, Airport Reporting Points, Airspaces,
// Hotspots, Navaids, Hang Gliding Sites, Obstacles, RC Airfields, Special
// Rules Areas — rien sur les procédures). Ces données viennent normalement
// de bases proprio (Jeppesen/Navigraph/AIRAC). Faute de mieux, ce calque lit
// une table LOCALE et éditable par vous : window.PROCEDURE_FIXES dans
// aurora-config.js. Voir le gabarit d'exemple fourni dans ce fichier.
function toggleProcedureFixes(){
  state.procFixesShown = !state.procFixesShown;
  if (state.procFixesShown){
    map.addLayer(procFixesLayer);
    loadProcedureFixes();
  } else {
    map.removeLayer(procFixesLayer);
  }
}
function loadProcedureFixes(){
  procFixesLayer.clearLayers();
  const table = window.PROCEDURE_FIXES || {};
  const forIcao = table[state.station.icao] || [];
  if (!forIcao.length){
    showToast(`Aucun fixe SID/STAR renseigné pour ${state.station.icao || "cette position"} dans window.PROCEDURE_FIXES (aurora-config.js). OpenAIP ne fournit pas ces données — il faut les saisir vous-même (voir gabarit dans le fichier).`, false);
    return;
  }
  forIcao.forEach(pt => {
    if (pt.lat == null || pt.lon == null) return;
    L.marker([pt.lat, pt.lon], {
      icon: L.divIcon({ className: "wpt-marker", iconSize: [70, 26], iconAnchor: [4, 4],
        html: `<div class="wpt-diamond" style="background:#c78bff; border-color:#7a4fbf; transform:rotate(45deg);"></div><div class="wpt-label"><span style="color:#c78bff;">${escapeHtml(pt.name || "")}</span></div>` })
    }).addTo(procFixesLayer);
  });
}

// Rayon (NM) autour de la position ATC au-delà duquel on masque les espaces aériens
// une fois CONNECTÉ à une position — pour ne montrer que les TMA/zones qui concernent
// le contrôleur, comme demandé. Avant connexion, tout ce qui est dans la vue est affiché
// (utile pour explorer la carte librement).
const CONNECTED_FOCUS_NM = 90;
function geometryCentroidLatLon(geometry){
  let ring = null;
  if (geometry.type === "Polygon") ring = geometry.coordinates[0];
  else if (geometry.type === "MultiPolygon") ring = geometry.coordinates[0][0];
  else if (geometry.type === "Point") return [geometry.coordinates[1], geometry.coordinates[0]];
  if (!ring || !ring.length) return null;
  let lat = 0, lon = 0;
  ring.forEach(([lo, la]) => { lat += la; lon += lo; });
  return [lat / ring.length, lon / ring.length];
}
function withinControllerFocus(latlon){
  if (!state.connected || !latlon) return true; // pas connecté : on montre tout ce qui est visible
  const bd = bearingDistanceFrom(state.station.lat, state.station.lon, latlon[0], latlon[1]);
  return bd.distanceNm <= CONNECTED_FOCUS_NM;
}

// IMPORTANT : tous les endpoints OpenAIP n'acceptent pas le même filtre spatial.
// D'après le schéma officiel de l'API (api.core.openaip.net/api/system/specs/v1/schema.json) :
//   - /airports et /airspaces acceptent "bbox" (minx,miny,maxx,maxy = ouest,sud,est,nord)
//   - /navaids et /reporting-points N'ACCEPTENT PAS "bbox" du tout (paramètre absent
//     de leur schéma) : l'envoyer ne provoque pas d'erreur, il est juste ignoré côté
//     serveur, et l'API renvoie alors une page globale non filtrée (souvent ailleurs
//     dans le monde) — c'est la cause réelle du "les points RNAV n'existent pas".
//     Ces deux endpoints acceptent en revanche "pos" (lat,lon) + "dist" (mètres).
const BBOX_ENDPOINTS = new Set(["airports", "airspaces"]);
async function openaipFetchList(endpoint, extraParams){
  const spatial = BBOX_ENDPOINTS.has(endpoint)
    ? `bbox=${currentBbox()}`
    : (() => { const { pos, dist } = currentPosDist(); return `pos=${encodeURIComponent(pos)}&dist=${dist}`; })();
  const url = `${OPENAIP_BASE}/${endpoint}?${spatial}&limit=1000${extraParams || ""}&apiKey=${encodeURIComponent(window.OPENAIP_API_KEY)}`;
  // api.core.openaip.net ne renvoie PAS "Access-Control-Allow-Origin" sur ces
  // endpoints (vérifié : une requête serveur-à-serveur identique répond 200 avec
  // les bonnes données, mais tout navigateur la bloque quand même). On passe donc
  // systématiquement par la même chaîne de proxys CORS que le METAR.
  const text = await fetchTextWithProxies(url);
  let data;
  try{ data = JSON.parse(text); }
  catch(err){ throw new Error("réponse OpenAIP invalide (pas du JSON) — le proxy a peut-être renvoyé une page d'erreur"); }
  return data.items || data.docs || [];
}

// Ne force plus le zoom de l'utilisateur : /navaids et /reporting-points n'ont
// plus de contrainte de taille de bbox puisqu'on n'envoie plus bbox du tout sur
// ces deux endpoints (voir currentPosDist ci-dessus). Seuls /airports et
// /airspaces gardent la contrainte "dézoomez pas trop" liée à leur bbox.
function pointIdentifier(item){
  return item.identifier || item.name || item.designator || item.tradeName || item.icaoCode || "";
}
async function loadWaypoints(){
  if (!window.OPENAIP_API_KEY) return;
  try{
    const items = await openaipFetchList("navaids");
    console.debug(`[OpenAIP] navaids : ${items.length} résultat(s) sur la zone visible.`);
    waypointsLayer.clearLayers();
    let shown = 0;
    items.forEach(item => {
      const g = item.geometry && item.geometry.coordinates;
      if (!g) return;
      const [lon, lat] = g;
      if (!withinControllerFocus([lat, lon])) return;
      const kind = item.type != null ? navaidTypeLabel(item.type) : "NAV";
      L.marker([lat, lon], {
        icon: L.divIcon({ className: "wpt-marker", iconSize: [70, 26], iconAnchor: [4, 4],
          html: `<div class="wpt-diamond" style="background:#8bd4ff; border-color:#3f7fbf;"></div><div class="wpt-label">${escapeHtml(pointIdentifier(item))} <span style="color:#8bd4ff;">${kind}</span></div>` })
      }).addTo(waypointsLayer);
      shown++;
    });
    if (!shown) showToast("OpenAIP : aucun VOR/NDB référencé dans le rayon visible (base communautaire, couverture variable).", false);
  } catch(err){
    showToast("OpenAIP (VOR/NDB) : " + err.message, true);
  }
}
function navaidTypeLabel(t){
  const map_ = { 2: "NDB", 3: "VOR", 4: "VOR-DME", 9: "DME", 0: "NDB" };
  return map_[t] || "NAV";
}

async function loadReportingPoints(){
  if (!window.OPENAIP_API_KEY) return;
  try{
    const items = await openaipFetchList("reporting-points");
    console.debug(`[OpenAIP] reporting-points : ${items.length} résultat(s) sur la zone visible.`);
    reportingPointsLayer.clearLayers();
    let shown = 0;
    items.forEach(item => {
      const g = item.geometry && item.geometry.coordinates;
      if (!g) return;
      const [lon, lat] = g;
      if (!withinControllerFocus([lat, lon])) return;
      L.marker([lat, lon], {
        icon: L.divIcon({ className: "wpt-marker", iconSize: [70, 26], iconAnchor: [4, 4],
          html: `<div class="wpt-diamond"></div><div class="wpt-label">${escapeHtml(pointIdentifier(item))}</div>` })
      }).addTo(reportingPointsLayer);
      shown++;
    });
    if (!shown) showToast("OpenAIP : aucun point de report VFR référencé dans le rayon visible (base communautaire — les fixes IFR type ANG/BALNI/TIPIK n'en font pas partie, voir bouton SID/STAR).", false);
  } catch(err){
    showToast("OpenAIP (points RNAV/VFR) : " + err.message, true);
  }
}

async function loadAirspaces(){
  if (!window.OPENAIP_API_KEY) return;
  if (map.getZoom() < MIN_ZOOM_OPENAIP){
    showToast(`Zoomez davantage (niveau ${MIN_ZOOM_OPENAIP}+) pour charger les espaces aériens — OpenAIP refuse les zones trop grandes (HTTP 400).`, true);
    return;
  }
  try{
    const items = await openaipFetchList("airspaces");
    airspacesLayer.clearLayers();
    items.forEach(item => {
      const geo = item.geometry;
      if (!geo) return;
      const centroid = geometryCentroidLatLon(geo);
      if (!withinControllerFocus(centroid)) return;
      const polygons = geo.type === "MultiPolygon" ? geo.coordinates : (geo.type === "Polygon" ? [geo.coordinates] : []);
      polygons.forEach(poly => {
        const ring = poly[0].map(([lon, lat]) => [lat, lon]);
        L.polygon(ring, { color: "#9d6bff", weight: 1, opacity: 0.6, fillOpacity: 0.03 })
          .addTo(airspacesLayer)
          .bindTooltip(item.name || "Espace aérien", { sticky: true });
      });
    });
  } catch(err){
    showToast("OpenAIP (espaces aériens) : " + err.message, true);
  }
}

function refreshOpenaipLayers(){
  if (state.waypointsShown) loadWaypoints();
  if (state.reportingPointsShown) loadReportingPoints();
  if (state.airspacesShown) loadAirspaces();
}

/* ---------------------------------------------------------------------------
   10. Panneau ATC (positions en ligne)
--------------------------------------------------------------------------- */
function renderAtcList(){
  const list = $("atc-list");
  list.innerHTML = "";
  const positions = Object.values(state.sectors || {});
  if (!positions.length){
    list.appendChild(el("div", "empty-row", "Aucun secteur défini dans Firebase (voir Sector Manager)."));
  }
  positions.sort((a,b) => a.callsign.localeCompare(b.callsign)).forEach(sec => {
    const online = !!state.atcOnline[sec.callsign];
    const row = el("div", "atc-row");
    row.innerHTML = `<span class="dot${online ? " on" : ""}"></span>
      <span class="cs">${sec.callsign}</span>
      <span class="fr">${sec.frequency || "—"}</span>
      <span class="rt">${sec.rating || "—"}</span>
      <span class="nm">${online ? (state.atcOnline[sec.callsign].callsign) : "hors ligne"}</span>`;
    row.addEventListener("click", () => {
      locateStation(sec.callsign);
    });
    list.appendChild(row);
  });
  $("atc-count").textContent = Object.keys(state.atcOnline).length;
}

/* ---------------------------------------------------------------------------
   11. COM box (chat texte partagé via Firebase, par fréquence)
--------------------------------------------------------------------------- */
const COM_TABS = [
  { key: "TUNED", label: () => state.vhfFreq.toFixed(3) },
  { key: "GUARD", label: () => "GUARD 121.5" },
  { key: "ATC", label: () => "ATC" },
  { key: "BRDCST", label: () => "BRDCST" },
  { key: "PRIVATE", label: () => "PRIVATE" },
];
function buildComTabs(){
  const wrap = $("com-tabs");
  wrap.innerHTML = "";
  COM_TABS.forEach(t => {
    const d = el("div", "com-tab" + (state.comFreqTab === t.key ? " active" : ""), t.label());
    d.addEventListener("click", () => { state.comFreqTab = t.key; buildComTabs(); renderComLogFromCache(); });
    wrap.appendChild(d);
  });
}
buildComTabs();
let comLogCache = {};
function renderComLog(logObj){ comLogCache = logObj; renderComLogFromCache(); }
function renderComLogFromCache(){
  const box = $("com-log");
  const freqKey = state.comFreqTab === "TUNED" ? state.vhfFreq.toFixed(3) : state.comFreqTab;
  const entries = Object.values(comLogCache).filter(m => m.channel === freqKey);
  box.innerHTML = "";
  entries.forEach(m => {
    const ln = el("div", "ln" + (m.from === state.station.callsign ? " self" : ""));
    ln.innerHTML = `<span class="freq">[${m.channel}]</span> <span class="who">${m.from}</span> ${escapeHtml(m.text)}`;
    box.appendChild(ln);
  });
  box.scrollTop = box.scrollHeight;
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function clearComLog(){ $("com-log").innerHTML = ""; showToast("Journal COM effacé localement (Firebase conservé)."); }

function sendComMessage(){
  const input = $("com-input");
  const text = input.value.trim();
  if (!text) return;
  if (!firebaseReady){ showToast("Firebase non configuré — message non envoyé.", true); return; }
  const channel = state.comFreqTab === "TUNED" ? state.vhfFreq.toFixed(3) : state.comFreqTab;
  db.ref("com_log").push({
    channel, from: state.station.callsign, text, ts: Date.now()
  });
  input.value = "";
}
$("com-send").addEventListener("click", sendComMessage);
$("com-input").addEventListener("keydown", e => { if (e.key === "Enter") sendComMessage(); });

/* ---------------------------------------------------------------------------
   12. VHF
--------------------------------------------------------------------------- */
function refreshVhfDisplay(){
  $("vhf-freq").value = state.vhfFreq.toFixed(3);
  buildComTabs(); renderComLogFromCache(); renderVhfUsers();
}
function retuneFrequency(newFreq){
  state.vhfFreq = newFreq;
  refreshVhfDisplay();
  if (state.connected){ leaveVoiceMesh(); joinVoiceMesh(); } // on ne parle qu'à ceux sur la même fréquence
}
function applyManualFreq(){
  const v = parseFloat(String($("vhf-freq").value).replace(",", "."));
  if (isNaN(v)){ showToast("Fréquence invalide.", true); refreshVhfDisplay(); return; }
  const clamped = Math.min(136.990, Math.max(118.000, v));
  retuneFrequency(Math.round(clamped * 1000) / 1000);
}
$("vhf-freq-set").addEventListener("click", applyManualFreq);
$("vhf-freq").addEventListener("keydown", e => { if (e.key === "Enter") { applyManualFreq(); e.target.blur(); } });
$("vhf-freq").addEventListener("blur", applyManualFreq);
const ICE_STATE_LABEL = { new: "…", checking: "…", connected: "🔊", completed: "🔊", disconnected: "⚠️", failed: "✖", closed: "" };
function renderVhfUsers(){
  const wrap = $("vhf-users");
  wrap.innerHTML = "";
  const tuned = state.vhfFreq.toFixed(3);
  // Deux sources à fusionner :
  //  1) state.flights : pilotes qui envoient leur télémétrie complète (msfs_tracker),
  //     on connaît alors com1/com2, filtré sur la fréquence accordée ici.
  //  2) currentVoicePresence : TOUT le monde réellement présent sur le maillage vocal
  //     de la fréquence accordée ici (autres postes ATC, ET pilotes connectés
  //     uniquement via aurora_vhf.html — ceux-ci n'existent jamais dans state.flights).
  //     C'est cette 2e source qui manquait : sans elle, un pilote ouvert sur
  //     aurora_vhf.html seul n'apparaissait jamais côté ATC, même bien connecté en voix.
  const fromFlights = Object.entries(state.flights || {}).filter(([,f]) =>
    (f.com1 != null && Number(f.com1).toFixed(3) === tuned) || (f.com2 != null && Number(f.com2).toFixed(3) === tuned)).map(([cs]) => cs);
  const fromVoice = Object.keys(currentVoicePresence || {}).filter(cs => cs !== state.station.callsign);
  const users = Array.from(new Set([...fromFlights, ...fromVoice]));
  users.forEach(cs => {
    const iceState = voicePeerStatus[cs];
    const badge = iceState ? ` ${ICE_STATE_LABEL[iceState] || ""}` : (fromVoice.includes(cs) ? " …" : "");
    const u = el("div", "u", cs + badge);
    u.title = iceState ? `Liaison voix : ${iceState}` : "Présent sur la fréquence, liaison voix en cours d'établissement";
    u.addEventListener("click", () => selectAircraft(cs));
    wrap.appendChild(u);
  });
  $("vhf-user-count").textContent = users.length;
}
refreshVhfDisplay();

/* ---------------------------------------------------------------------------
   12bis. VHF vocale (PTT) — WebRTC pair-à-pair, signalisation via Firebase
   Fonctionne entre TOUTE instance qui rejoint le même maillage
   ("voice_presence"/"voice_signal" sous la même clé de fréquence) : autres
   postes Aurora ATC, ET pilotes connectés uniquement via aurora_vhf.html
   (client autonome, sans télémétrie MSFS complète). renderVhfUsers() fusionne
   state.flights (pilotes avec télémétrie) et currentVoicePresence (tout le
   monde réellement présent en voix sur la fréquence) pour que ces derniers
   apparaissent bien dans la liste côté ATC, pas seulement dans les logs.
   IMPORTANT : le micro (getUserMedia) exige un contexte sécurisé — servez
   ce fichier en HTTPS ou depuis "localhost". Ouvrir le .html directement
   (file://) ne permettra PAS d'utiliser la voix (le reste fonctionne).
--------------------------------------------------------------------------- */
// STUN seul échoue souvent dès que les deux postes ne sont pas sur le même réseau
// (NAT symétrique, 4G, box grand public...) : on ajoute un serveur TURN gratuit
// (Open Relay Project / Metered) qui relaie le flux quand la connexion directe
// échoue. Si un jour il devient indisponible, remplacez-le par vos propres
// identifiants TURN (Metered, Twilio, ou un coturn auto-hébergé).
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.relay.metered.ca:80" },
  { urls: "turn:global.relay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:global.relay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];
let localMicStream = null;
let pttActive = false;
const voicePeers = {};      // callsign distant -> RTCPeerConnection
const voiceAudioEls = {};   // callsign distant -> <audio>
let voicePresenceRef = null, voicePresenceListenerRef = null, voiceSignalListenerRef = null;

async function ensureMic(){
  if (localMicStream) return localMicStream;
  if (!window.isSecureContext){
    throw new Error("contexte non sécurisé (servez la page en HTTPS, ou depuis \"localhost\"/127.0.0.1 — pas une IP publique en http://)");
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    throw new Error("micro non supporté par ce navigateur");
  }
  localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  localMicStream.getAudioTracks().forEach(t => t.enabled = false); // muet tant que PTT n'est pas maintenu
  return localMicStream;
}

function voiceFreqKey(){ return state.vhfFreq.toFixed(3); }

function sendVoiceSignal(freq, toCallsign, payload){
  db.ref(`voice_signal/${freq}/${toCallsign}`).push({ from: state.station.callsign, ...payload });
}

function createVoicePeer(freq, remoteCallsign){
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  if (localMicStream) localMicStream.getTracks().forEach(t => pc.addTrack(t, localMicStream));
  pc.onicecandidate = (e) => {
    if (e.candidate) sendVoiceSignal(freq, remoteCallsign, { kind: "candidate", candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    let a = voiceAudioEls[remoteCallsign];
    if (!a){ a = document.createElement("audio"); a.autoplay = true; a.volume = 1; a.style.display = "none"; document.body.appendChild(a); voiceAudioEls[remoteCallsign] = a; }
    a.srcObject = e.streams[0];
    a.muted = false;
    a.play().catch(() => { /* certains navigateurs exigent un geste utilisateur — le PTT en fournit un au premier appui */ });
  };
  // Visibilité de l'état de la liaison, pour diagnostiquer un "on ne s'entend pas" au
  // lieu de rester silencieux : on log + on tente un restart ICE si la liaison échoue.
  pc.oniceconnectionstatechange = () => {
    updateVoicePeerStatus(remoteCallsign, pc.iceConnectionState);
    if (pc.iceConnectionState === "failed" && state.station.callsign < remoteCallsign){
      pc.createOffer({ iceRestart: true }).then(offer => pc.setLocalDescription(offer))
        .then(() => sendVoiceSignal(freq, remoteCallsign, { kind: "offer", sdp: pc.localDescription.sdp }))
        .catch(() => {});
    }
  };
  return pc;
}
// Petit indicateur textuel (dans le panneau VHF) de l'état de chaque liaison voix,
// pour pouvoir voir immédiatement si "personne ne s'entend" vient d'un problème
// réseau (ICE "failed"/"disconnected") plutôt que rester dans le flou.
const voicePeerStatus = {};
function updateVoicePeerStatus(cs, iceState){
  voicePeerStatus[cs] = iceState;
  renderVhfUsers();
  if (iceState === "failed") showToast(`Voix : liaison avec ${cs} en échec (réseau/pare-feu) — nouvelle tentative…`, true);
}
function closeVoicePeer(cs){
  if (voicePeers[cs]){ try{ voicePeers[cs].close(); }catch(e){} delete voicePeers[cs]; }
  if (voiceAudioEls[cs]){ voiceAudioEls[cs].remove(); delete voiceAudioEls[cs]; }
  delete voicePeerStatus[cs];
  renderVhfUsers();
}

async function handleVoicePresence(freq, presenceObj){
  currentVoicePresence = presenceObj || {};
  renderVhfUsers();
  const others = Object.keys(presenceObj || {}).filter(cs => cs !== state.station.callsign);
  Object.keys(voicePeers).forEach(cs => { if (!others.includes(cs)) closeVoicePeer(cs); });
  for (const cs of others){
    if (voicePeers[cs]) continue;
    const pc = createVoicePeer(freq, cs);
    voicePeers[cs] = pc;
    // Règle simple pour éviter que les deux côtés proposent une offre en même temps :
    // celui dont le callsign est alphabétiquement le plus petit initie.
    if (state.station.callsign < cs){
      try{
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendVoiceSignal(freq, cs, { kind: "offer", sdp: offer.sdp });
      } catch(err){ showToast("Voix : offre WebRTC impossible — " + err.message, true); }
    }
  }
}
async function handleVoiceSignal(freq, msg){
  if (!msg || !msg.from) return;
  const fromCallsign = msg.from;
  let pc = voicePeers[fromCallsign];
  if (!pc){ pc = createVoicePeer(freq, fromCallsign); voicePeers[fromCallsign] = pc; }
  try{
    if (msg.kind === "offer"){
      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendVoiceSignal(freq, fromCallsign, { kind: "answer", sdp: answer.sdp });
    } else if (msg.kind === "answer"){
      await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    } else if (msg.kind === "candidate" && msg.candidate){
      await pc.addIceCandidate(msg.candidate);
    }
  } catch(err){ /* signal tardif/obsolète après renégociation — sans gravité */ }
}

async function joinVoiceMesh(){
  if (!firebaseReady || !state.connected) return;
  try{ await ensureMic(); }
  catch(err){ showToast("Micro indisponible pour le PTT : " + err.message, true); return; }
  const freq = voiceFreqKey();
  voicePresenceRef = db.ref(`voice_presence/${freq}/${state.station.callsign}`);
  voicePresenceRef.set({ ts: Date.now() })
    .catch(err => showToast("Voix : écriture refusée par Firebase (" + err.message + ") — vérifiez les règles de sécurité sur \"voice_presence\".", true));
  voicePresenceRef.onDisconnect().remove();
  voicePresenceListenerRef = db.ref(`voice_presence/${freq}`);
  voicePresenceListenerRef.on("value", snap => handleVoicePresence(freq, snap.val()),
    err => showToast("Voix : lecture refusée par Firebase (" + err.message + ")", true));
  voiceSignalListenerRef = db.ref(`voice_signal/${freq}/${state.station.callsign}`);
  voiceSignalListenerRef.on("child_added", snap => { handleVoiceSignal(freq, snap.val()); snap.ref.remove().catch(()=>{}); },
    err => showToast("Voix : signalisation refusée par Firebase (" + err.message + ")", true));
}
function leaveVoiceMesh(){
  if (voicePresenceRef) { voicePresenceRef.remove(); voicePresenceRef = null; }
  if (voicePresenceListenerRef) { voicePresenceListenerRef.off(); voicePresenceListenerRef = null; }
  if (voiceSignalListenerRef) { voiceSignalListenerRef.off(); voiceSignalListenerRef = null; }
  Object.keys(voicePeers).forEach(closeVoicePeer);
  Object.keys(voicePeerStatus).forEach(k => delete voicePeerStatus[k]);
  currentVoicePresence = {};
  renderVhfUsers();
  setPtt(false);
}

function setPtt(active){
  if (pttActive === active) return;
  pttActive = active;
  if (localMicStream) localMicStream.getAudioTracks().forEach(t => t.enabled = active);
  const btn = $("vhf-ptt");
  if (btn) btn.classList.toggle("tx", active);
  const label = $("vhf-ptt-label");
  if (label) label.textContent = active ? "🔴 TX" : "PTT";
}
async function requestPtt(){
  if (!state.connected){ showToast("Connectez-vous à une position (bouton START) pour transmettre.", true); return; }
  if (!localMicStream){
    try{ await ensureMic(); if (!voicePresenceRef) joinVoiceMesh(); }
    catch(err){ showToast("Micro indisponible : " + err.message, true); return; }
  }
  setPtt(true);
}
$("vhf-ptt").addEventListener("mousedown", requestPtt);
$("vhf-ptt").addEventListener("touchstart", (e) => { e.preventDefault(); requestPtt(); });
["mouseup","mouseleave","touchend","touchcancel"].forEach(evt => $("vhf-ptt").addEventListener(evt, () => setPtt(false)));

$("vhf-ptt-bind").addEventListener("click", () => {
  showToast("Appuyez sur la touche à utiliser pour le PTT…");
  const handler = (e) => {
    e.preventDefault();
    state.pttKeyCode = e.code;
    $("vhf-ptt-key").textContent = keyCodeLabel(e.code);
    document.removeEventListener("keydown", handler, true);
    showToast("PTT lié à : " + keyCodeLabel(e.code));
  };
  document.addEventListener("keydown", handler, true);
});
function keyCodeLabel(code){
  const SPECIAL = { Backslash: "\\", Space: "Espace", Backquote: "`", Slash: "/",
    ShiftLeft: "Maj (G)", ShiftRight: "Maj (D)", ControlLeft: "Ctrl (G)", ControlRight: "Ctrl (D)",
    AltLeft: "Alt (G)", AltRight: "Alt (D)", CapsLock: "Verr.Maj" };
  if (SPECIAL[code]) return SPECIAL[code];
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ") || code;
}
document.addEventListener("keydown", (e) => {
  if (e.code !== state.pttKeyCode || e.repeat) return;
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return; // ne pas voler le focus des champs de saisie
  e.preventDefault();
  requestPtt();
});
document.addEventListener("keyup", (e) => {
  if (e.code !== state.pttKeyCode) return;
  setPtt(false);
});

/* ---------------------------------------------------------------------------
   13. Traffic manager — sélecteur de callsigns + fiche de vol/strip détaillée
   Les modifications ATC (ALT/SPD/WP/squawk assignés, remarques) sont stockées
   dans "atc_strips/<callsign>", séparément de "flights/<callsign>" (télémétrie
   brute du pilote) : seuls les contrôleurs doivent avoir accès à ce nœud (voir
   la note sur les règles de sécurité Firebase dans attachFirebaseListeners()).
--------------------------------------------------------------------------- */
function renderTmChips(){
  const wrap = $("tm-chips");
  wrap.innerHTML = "";
  const entries = Object.entries(state.flights || {}).filter(([cs]) => !state.dismissed.has(cs));
  if (!entries.length){
    wrap.appendChild(el("div", "empty-row", "Aucun vol actif dans Firebase (lancez msfs_tracker)."));
  }
  entries.sort(([a],[b]) => a.localeCompare(b)).forEach(([cs, f]) => {
    const emer = isEmergencySquawk(f.transponder);
    const chip = el("div", "tm-chip" + (cs === state.selectedCallsign ? " sel" : "") + (emer ? " emer" : ""), (emer ? "🚨 " : "") + cs);
    chip.addEventListener("click", () => selectAircraft(cs));
    wrap.appendChild(chip);
  });
  $("tm-count").textContent = entries.length;
}

function renderFplPanel(){
  const wrap = $("tm-fpl");
  const cs = state.selectedCallsign;
  const f = cs && state.flights[cs];
  if (!f){
    wrap.innerHTML = `<div class="fpl-empty">Cliquez un avion sur le PVD, dans les users VHF, ou choisissez son callsign ci-dessus.</div>`;
    return;
  }
  const strip = state.atcStrips[cs] || {};
  const emer = isEmergencySquawk(f.transponder);
  const tas = f.ground_speed_kt ? "N" + String(Math.round(f.ground_speed_kt)).padStart(4, "0") : "—";
  const route = strip.assigned_wp ? `${f.route || ""} · DIRECT ${strip.assigned_wp}`.trim() : (f.route || "—");
  const logEntries = Object.values(strip.log || {}).slice(-4);
  wrap.innerHTML = `
    <div style="flex:1; min-width:260px;">
      <div class="fpl-top">
        <span class="fpl-cs${emer ? " emer" : ""}">${cs}</span>
        <span class="fpl-route">${f.departure || "????"} → ${f.arrival || "????"}</span>
        <span class="fpl-badge">${f.flight_rules || "—"}</span>
        <span class="fpl-badge" style="color:${strip.assumed ? "var(--ok)" : "var(--text-faint)"}; cursor:pointer;" id="fpl-assume-toggle">
          ${strip.assumed ? "ASSUMÉ" + (strip.assumed_by ? " · " + escapeHtml(strip.assumed_by) : "") : "NON ASSUMÉ"}
        </span>
        ${emer ? `<span class="fpl-emer-badge">${emergencyLabel(f.transponder)}</span>` : ""}
      </div>
      <div class="fpl-cols">
        <div class="fpl-col">
          <div class="fpl-item"><span class="k">Type</span><span class="v">${f.aircraft_type || "—"}</span></div>
          <div class="fpl-item"><span class="k">TAS</span><span class="v">${tas}</span></div>
          <div class="fpl-item"><span class="k">Alt. act.</span><span class="v">${Math.round(f.altitude_ft||0)} ft</span></div>
          <div class="fpl-item"><span class="k">Xpdr</span><span class="v" style="${emer ? "color:#ff5c6c;" : ""}">${f.transponder || "----"}</span></div>
        </div>
        <div class="fpl-col">
          <div class="fpl-item"><span class="k">Route</span><span class="v">${escapeHtml(route)}</span></div>
          <div class="fpl-item"><span class="k">EOBT</span><span class="v">${f.eobt || "—"}</span></div>
          <div class="fpl-item"><span class="k">Alt. croisière</span><span class="v">${f.cruise_altitude || "—"}</span></div>
          ${strip.assigned_alt ? `<div class="fpl-item"><span class="k">ALT assignée</span><span class="v" style="color:#ffe27a;">${strip.assigned_alt} ft</span></div>` : ""}
          ${strip.assigned_spd ? `<div class="fpl-item"><span class="k">SPD assignée</span><span class="v" style="color:#ffe27a;">${strip.assigned_spd} kt</span></div>` : ""}
          ${strip.squawk_assigned ? `<div class="fpl-item"><span class="k">SQK assigné</span><span class="v" style="color:#ffe27a;">${strip.squawk_assigned}</span></div>` : ""}
        </div>
      </div>
    </div>
    <div class="fpl-remarks">
      <div class="fpl-remarks-title">STRIP ATC — visible contrôleurs uniquement</div>
      ${logEntries.length ? logEntries.map(l => `<div class="fpl-remarks-line">${escapeHtml(l.text)} <span style="color:var(--text-faint);">— ${escapeHtml(l.from||"")}</span></div>`).join("")
        : `<div class="fpl-remarks-line" style="color:var(--text-faint);">Aucune remarque pour l'instant.</div>`}
      <div class="fpl-remarks-line metar">${escapeHtml(lastMetarRaw || "")}</div>
    </div>`;
  const assumeBtn = $("fpl-assume-toggle");
  if (assumeBtn) assumeBtn.addEventListener("click", () => setAssumed(cs, !strip.assumed));
}

function requireSelected(){
  if (!state.selectedCallsign || !state.flights[state.selectedCallsign]){
    showToast("Sélectionnez d'abord un vol (chip ci-dessus, PVD ou users VHF).", true);
    return false;
  }
  return true;
}
function stripRef(){ return db.ref(`atc_strips/${state.selectedCallsign}`); }
function pushStripLog(text){
  if (!firebaseReady){ showToast("Firebase non configuré — remarque non enregistrée.", true); return; }
  stripRef().child("log").push({ text, from: state.station.callsign, ts: Date.now() });
}
function setStripFields(fields){
  if (!firebaseReady){ showToast("Firebase non configuré.", true); return; }
  stripRef().update({ ...fields, updated_by: state.station.callsign, updated_at: Date.now() });
}
function bumpNumber(id, delta){
  const inp = $(id);
  const cur = parseFloat(inp.value) || 0;
  inp.value = Math.max(0, cur + delta);
}

$("tm-send").addEventListener("click", () => {
  if (!requireSelected()) return;
  const text = $("tm-cmd").value.trim();
  if (!text){ showToast("Écrivez une remarque avant d'envoyer.", true); return; }
  pushStripLog(text);
  $("tm-cmd").value = "";
});
$("tm-cmd").addEventListener("keydown", e => { if (e.key === "Enter") $("tm-send").click(); });

$("tm-alt-up").addEventListener("click", () => bumpNumber("tm-alt", 100));
$("tm-alt-down").addEventListener("click", () => bumpNumber("tm-alt", -100));
$("tm-spd-up").addEventListener("click", () => bumpNumber("tm-spd", 10));
$("tm-spd-down").addEventListener("click", () => bumpNumber("tm-spd", -10));

$("tm-ok").addEventListener("click", () => {
  if (!requireSelected()) return;
  const fields = {};
  const wp = $("tm-wp").value.trim(); if (wp) fields.assigned_wp = wp.toUpperCase();
  const alt = $("tm-alt").value.trim(); if (alt) fields.assigned_alt = Number(alt);
  const spd = $("tm-spd").value.trim(); if (spd) fields.assigned_spd = Number(spd);
  if (!Object.keys(fields).length){ showToast("Renseignez WP, ALT et/ou SPD avant de valider.", true); return; }
  setStripFields(fields);
  pushStripLog(Object.entries(fields).map(([k,v]) => `${k.replace("assigned_","").toUpperCase()} ${v}`).join(" · "));
  showToast(`Strip ${state.selectedCallsign} mis à jour (ATC uniquement).`);
  $("tm-wp").value = ""; $("tm-alt").value = ""; $("tm-spd").value = "";
});
$("tm-sqk").addEventListener("click", () => {
  if (!requireSelected()) return;
  const code = prompt(`Nouveau code transpondeur assigné à ${state.selectedCallsign} :`, "1000");
  if (code && /^[0-7]{4}$/.test(code)){
    setStripFields({ squawk_assigned: code });
    pushStripLog("SQUAWK ASSIGNÉ " + code);
  } else if (code) showToast("Code invalide (4 chiffres octaux 0-7 attendus).", true);
});
$("tm-ssr").addEventListener("click", () => { if (requireSelected()) pushStripLog("REQUEST SSR MODE C"); });
$("tm-pm").addEventListener("click", () => {
  if (!requireSelected()) return;
  state.comFreqTab = "PRIVATE"; buildComTabs(); renderComLogFromCache();
  $("com-input").value = `@${state.selectedCallsign} `; $("com-input").focus();
  bringToFront("win-com");
});
$("tm-strips").addEventListener("click", () => {
  const w = $("win-strips");
  w.classList.toggle("show");
  if (w.classList.contains("show")){
    if (state.selectedCallsign) addStrip(state.selectedCallsign);
    renderStrips();
  }
});
$("tm-del").addEventListener("click", () => {
  if (!requireSelected()) return;
  state.dismissed.add(state.selectedCallsign);
  showToast(`${state.selectedCallsign} retiré du Traffic Manager (localement — les données Firebase du pilote ne sont pas touchées).`);
  state.selectedCallsign = null;
  renderTmChips(); renderFplPanel(); renderAircraftOnMap();
});

/* ---------------------------------------------------------------------------
   14. Bandes de progression (flight strips) — reflètent aussi atc_strips/
--------------------------------------------------------------------------- */
function addStrip(callsign){ state.strips[callsign] = state.strips[callsign] || { type: "TWR" }; }
function renderStrips(){
  const board = $("strip-board");
  board.innerHTML = "";
  Object.keys(state.strips).forEach(cs => {
    const f = state.flights[cs];
    if (!f) return;
    const s = state.strips[cs];
    const strip = state.atcStrips[cs] || {};
    const card = el("div", "strip " + s.type);
    card.innerHTML = `<div class="row1"><span>${cs}</span><span>${f.aircraft_type || ""}</span></div>
      <div class="row2"><span>${f.departure || "????"} → ${f.arrival || "????"}</span><span>${f.cruise_altitude || ""}</span></div>
      <div class="row3">${f.route || ""}${strip.assigned_wp ? " · DIRECT " + strip.assigned_wp : ""}</div>
      <div class="row3">EOBT ${f.eobt || "—"} · XPDR ${strip.squawk_assigned || f.transponder || "----"} · ${f.flight_rules || ""}</div>
      ${strip.assigned_alt ? `<div class="row3">ALT ATC : ${strip.assigned_alt} ft</div>` : ""}
      ${strip.assigned_spd ? `<div class="row3">SPD ATC : ${strip.assigned_spd} kt</div>` : ""}
      <button class="btn" data-remove>Retirer</button>`;
    card.querySelector("[data-remove]").addEventListener("click", () => { delete state.strips[cs]; renderStrips(); });
    board.appendChild(card);
  });
  if (!Object.keys(state.strips).length){
    board.appendChild(el("div", "empty-row", "Sélectionnez un vol puis cliquez STRIPS pour créer une bande."));
  }
}

/* ---------------------------------------------------------------------------
   15. Démarrage
--------------------------------------------------------------------------- */
function boot(){
  initMap();
  initMiniMap();
  initFirebase();
  fetchMetar();
  setInterval(fetchMetar, 5 * 60 * 1000);
  if (!window.OPENAIP_API_KEY) $("led-openaip").className = "led";
  if ($("vhf-ptt-key")) $("vhf-ptt-key").textContent = keyCodeLabel(state.pttKeyCode);
  const hint = $("vhf-ptt-hint");
  if (hint){
    if (window.isSecureContext){
      hint.textContent = "Voix entre clients Aurora connectés sur cette fréquence. Maintenez le bouton ou la touche.";
      hint.style.color = "";
    } else {
      hint.innerHTML = "⚠️ Micro désactivé sur cette page : le navigateur exige HTTPS ou \"localhost\" (pas une IP en http://). Servez le dossier en HTTPS (Cloudflare Tunnel, ngrok, certificat...) pour activer le PTT.";
      hint.style.color = "var(--danger)";
    }
  }
  showToast(`Position sélectionnée : ${state.station.callsign}. Configurez aurora-config.js si les données ne se chargent pas.`);
}
boot();
