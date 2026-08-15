// Renommez ce fichier en "firebase-config.js" (à côté de sector_manager.html)
// et complétez vos identifiants. Ne commitez JAMAIS firebase-config.js dans un
// dépôt public : ajoutez-le à .gitignore.

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
// OpenAIP — clé API gratuite, à créer sur https://accounts.openaip.net
// Nécessaire pour : import des TMA / CTR aérodrome, et affichage des points
// RNAV. Laissez vide ("") pour désactiver ces deux fonctionnalités (les
// FIR/CTR/NAT via VATSIM restent disponibles sans clé).
// Données OpenAIP sous licence CC BY-NC 4.0 : usage non commercial uniquement.
// -------------------------------------------------------------------------
window.OPENAIP_API_KEY = "50eb1c038a62cd8397ca9f57abae89f4";
