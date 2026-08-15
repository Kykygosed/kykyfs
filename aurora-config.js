// Renommez ce fichier en "aurora-config.js" et placez-le à côté de
// "aurora_atc_client.html". Ne commitez JAMAIS aurora-config.js avec de
// vraies clés dans un dépôt public : ajoutez-le à .gitignore.
//
// C'est exactement le même principe que firebase-config.js pour le
// Sector Manager : ce client ATC ne lit/écrit QUE via le SDK Web Firebase
// (clé publique, restreinte par les règles de sécurité de la base), jamais
// via une clé de compte de service (celle-ci doit rester côté serveur,
// utilisée uniquement par msfs_tracker.py / msfs_tracker_gui.pyw).

// -------------------------------------------------------------------------
// Firebase — Console Firebase > Paramètres du projet > Vos applications
// > icône Web (</>) > copiez l'objet de configuration fourni.
// -------------------------------------------------------------------------
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBPq6Wfxzq02MfK69BFxHm9_FUjDGTmAcw",
  authDomain: "kykychat-24c7f.firebaseapp.com",
  databaseURL: "https://kykychat-24c7f-default-rtdb.firebaseio.com",
  projectId: "kykychat-24c7f",
  storageBucket: "kykychat-24c7f.firebasestorage.app",
  messagingSenderId: "342562811927",
  appId: "1:342562811927:web:0fed1e1f511c4fddcfec52"
};

// -------------------------------------------------------------------------
// OpenAIP — clé API gratuite sur https://accounts.openaip.net
// Nécessaire pour : points RNAV/waypoints et espaces aériens (TMA/CTR) sur
// le PVD. Laissez vide ("") pour désactiver ces couches — le reste du
// client (trafic, secteurs Firebase, COM, strips) fonctionne sans elle.
// Licence des données OpenAIP : CC BY-NC 4.0, usage non commercial.
// -------------------------------------------------------------------------
window.OPENAIP_API_KEY = "50eb1c038a62cd8397ca9f57abae89f4";
window.METAR_CORS_PROXY = "https://api.codetabs.com/v1/proxy?quest=";
// -------------------------------------------------------------------------
// Position ATC à l'ouverture du client : VOLONTAIREMENT non définie.
// Aucun aérodrome n'est chargé par défaut (ni Nantes, ni aucun autre) — au
// premier lancement, l'utilisateur doit saisir son propre callsign de
// position (ex: LFRS_TWR, LFPG_APP...) dans le champ en haut de l'écran et
// cliquer "Charger". Tant que ce n'est pas fait, la carte reste sur une vue
// large sans aérodrome sélectionné.
// -------------------------------------------------------------------------
window.ATC_STATION = null;

// -------------------------------------------------------------------------
// Fixes RNAV enroute / SID / STAR — bouton "MRV" du PVD.
//
// ATTENTION : l'API publique OpenAIP (celle utilisée ci-dessus pour FIX/VFR/GTS)
// NE FOURNIT AUCUNE donnée de procédures IFR (SID/STAR) ni de fixes RNAV
// enroute — vérifié sur le schéma officiel de l'API : les seuls endpoints
// disponibles sont Airports, Airport Reporting Points (VFR), Airspaces,
// Navaids (VOR/NDB/DME), Hotspots, Obstacles, RC Airfields. Il n'y a pas
// d'endpoint "procedures" ou "waypoints enroute". Ces données existent
// normalement dans des bases de navigation proprio (Jeppesen, Navigraph,
// cycle AIRAC officiel), pas dans une base communautaire libre.
//
// Solution : cette table est saisie ET maintenue par vous, par aérodrome
// (clé = code OACI). Elle est vide par défaut — remplissez-la avec les
// coordonnées réelles publiées dans la carte VAC / AIP de vos terrains
// (rubrique "Radionavigation / Routes" ou cartes STAR/SID de la partie IFR).
//
// GABARIT D'EXEMPLE (coordonnées fictives, à REMPLACER) :
// window.PROCEDURE_FIXES = {
//   LFRS: [
//     { name: "ANG",   lat: 47.40, lon: -1.90 },
//     { name: "BALNI", lat: 47.05, lon: -1.75 },
//     { name: "TIPIK", lat: 47.25, lon: -1.35 },
//   ],
// };
window.PROCEDURE_FIXES = window.PROCEDURE_FIXES || {};
