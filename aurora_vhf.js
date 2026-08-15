/* =============================================================================
   AURORA VHF — module autonome, pensé pour être ouvert dans une fenêtre
   webview Python (pywebview) plus tard, indépendamment du client ATC complet.

   Utilise EXACTEMENT le même schéma Firebase que aurora_atc_client.js pour la
   voix (voice_presence/<freq>/<callsign>, voice_signal/<freq>/<callsign>) :
   un pilote ouvert ici et un contrôleur ouvert dans le client complet, sur la
   même fréquence, se parlent directement — aucune synchronisation supplémentaire
   n'est nécessaire entre les deux pages.

   API exposée pour le pont Python (à appeler plus tard via
   webview.evaluate_js("...") depuis msfs_tracker_gui.pyw) :
     window.auroraVhf.setCallsign("AFR1217")
     window.auroraVhf.setFrequency(118.650)
     window.auroraVhf.connect()
     window.auroraVhf.disconnect()
     window.auroraVhf.isConnected()  -> bool
   Ces fonctions sont déjà prêtes ; il ne restera côté Python qu'à ouvrir une
   fenêtre webview pointant vers aurora_vhf.html (en la servant en HTTPS ou
   localhost — voir la remarque sur le micro plus bas) et à les appeler.
============================================================================= */
"use strict";

window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;

function $(id){ return document.getElementById(id); }
function log(msg){
  const l = $("log");
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  l.appendChild(line);
  l.scrollTop = l.scrollHeight;
  while (l.children.length > 40) l.removeChild(l.firstChild);
}

const params = new URLSearchParams(location.search);
const state = {
  callsign: (params.get("callsign") || "PILOTE").toUpperCase(),
  vhfFreq: parseFloat(params.get("freq")) || 118.650,
  connected: false,
  pttKeyCode: "Backslash",
};
$("in-callsign").value = state.callsign;
$("in-callsign").addEventListener("change", () => { state.callsign = $("in-callsign").value.trim().toUpperCase() || "PILOTE"; });

/* --- Firebase (SDK Web uniquement, comme le client ATC complet) --- */
let db = null, firebaseReady = false;
function initFirebase(){
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.databaseURL || /votre-projet/.test(cfg.databaseURL)){
    log("Firebase non configuré (aurora-config.js).");
    return;
  }
  try{
    firebase.initializeApp(cfg);
    db = firebase.database();
    firebaseReady = true;
    $("led-fb").classList.add("on");
    log("Firebase connecté.");
  } catch(err){
    log("Erreur Firebase : " + err.message);
  }
}
initFirebase();
if (window.isSecureContext){
  $("ptt-hint").textContent = "Maintenez le bouton ou la touche pour transmettre.";
} else {
  $("ptt-hint").innerHTML = "⚠️ Micro désactivé ici : HTTPS ou \"localhost\" requis (pas une IP http:// directe).";
  $("ptt-hint").style.color = "var(--danger)";
}

/* --- Fréquence --- */
function refreshFreqDisplay(){ $("freq-display").value = state.vhfFreq.toFixed(3); }
function retune(newFreq){
  state.vhfFreq = Math.round(newFreq * 1000) / 1000;
  refreshFreqDisplay();
  if (state.connected){ leaveVoiceMesh(); joinVoiceMesh(); }
}
function applyManualFreq(){
  const v = parseFloat(String($("freq-display").value).replace(",", "."));
  if (isNaN(v)){ log("Fréquence invalide."); refreshFreqDisplay(); return; }
  retune(Math.min(136.990, Math.max(118.000, v)));
}
$("freq-set").addEventListener("click", applyManualFreq);
$("freq-display").addEventListener("keydown", e => { if (e.key === "Enter") { applyManualFreq(); e.target.blur(); } });
$("freq-display").addEventListener("blur", applyManualFreq);
refreshFreqDisplay();

/* --- Connexion (présence sur la fréquence + maillage voix) --- */
$("btn-connect").addEventListener("click", () => {
  if (!firebaseReady){ log("Impossible : Firebase non configuré."); return; }
  state.connected = true;
  $("btn-connect").style.display = "none";
  $("btn-disconnect").style.display = "inline-block";
  log(`${state.callsign} en ligne sur ${state.vhfFreq.toFixed(3)}.`);
  joinVoiceMesh();
});
$("btn-disconnect").addEventListener("click", () => {
  state.connected = false;
  $("btn-connect").style.display = "inline-block";
  $("btn-disconnect").style.display = "none";
  log(`${state.callsign} déconnecté.`);
  leaveVoiceMesh();
});
window.addEventListener("beforeunload", () => leaveVoiceMesh());

/* ---------------------------------------------------------------------------
   Voix PTT — identique au module du client ATC complet (voir aurora_atc_client.js)
--------------------------------------------------------------------------- */
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
const voicePeers = {};
const voiceAudioEls = {};
let voicePresenceRef = null, voicePresenceListenerRef = null, voiceSignalListenerRef = null;

async function ensureMic(){
  if (localMicStream) return localMicStream;
  if (!window.isSecureContext) throw new Error("contexte non sécurisé (HTTPS ou localhost/127.0.0.1 requis — pas une IP publique en http://)");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("micro non supporté par ce navigateur/cette webview");
  localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  localMicStream.getAudioTracks().forEach(t => t.enabled = false);
  return localMicStream;
}
function voiceFreqKey(){ return state.vhfFreq.toFixed(3); }
function sendVoiceSignal(freq, toCallsign, payload){
  db.ref(`voice_signal/${freq}/${toCallsign}`).push({ from: state.callsign, ...payload });
}
const ICE_STATE_LABEL = { new: "…", checking: "…", connected: "🔊", completed: "🔊", disconnected: "⚠️", failed: "✖", closed: "" };
const voicePeerStatus = {};
function updateVoicePeerStatus(cs, iceState){
  voicePeerStatus[cs] = iceState;
  renderUsers(lastPresenceObj);
  if (iceState === "failed") log(`Voix : liaison avec ${cs} en échec (réseau/pare-feu) — nouvelle tentative…`);
}
function createVoicePeer(freq, remoteCallsign){
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  if (localMicStream) localMicStream.getTracks().forEach(t => pc.addTrack(t, localMicStream));
  pc.onicecandidate = (e) => { if (e.candidate) sendVoiceSignal(freq, remoteCallsign, { kind: "candidate", candidate: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    let a = voiceAudioEls[remoteCallsign];
    if (!a){ a = document.createElement("audio"); a.autoplay = true; a.volume = 1; a.style.display = "none"; document.body.appendChild(a); voiceAudioEls[remoteCallsign] = a; }
    a.srcObject = e.streams[0];
    a.muted = false;
    a.play().catch(() => { /* nécessite parfois un geste utilisateur — le PTT en fournit un */ });
  };
  pc.oniceconnectionstatechange = () => {
    updateVoicePeerStatus(remoteCallsign, pc.iceConnectionState);
    if (pc.iceConnectionState === "failed" && state.callsign < remoteCallsign){
      pc.createOffer({ iceRestart: true }).then(offer => pc.setLocalDescription(offer))
        .then(() => sendVoiceSignal(freq, remoteCallsign, { kind: "offer", sdp: pc.localDescription.sdp }))
        .catch(() => {});
    }
  };
  return pc;
}
function closeVoicePeer(cs){
  if (voicePeers[cs]){ try{ voicePeers[cs].close(); }catch(e){} delete voicePeers[cs]; }
  if (voiceAudioEls[cs]){ voiceAudioEls[cs].remove(); delete voiceAudioEls[cs]; }
  delete voicePeerStatus[cs];
  renderUsers(lastPresenceObj);
}
let lastPresenceObj = null;
function renderUsers(presenceObj){
  lastPresenceObj = presenceObj;
  const wrap = $("users");
  wrap.innerHTML = "";
  Object.keys(presenceObj || {}).filter(cs => cs !== state.callsign).forEach(cs => {
    const iceState = voicePeerStatus[cs];
    const d = document.createElement("div");
    d.textContent = cs + (iceState ? ` ${ICE_STATE_LABEL[iceState] || ""}` : "");
    d.title = iceState ? `Liaison voix : ${iceState}` : "Voix non établie";
    wrap.appendChild(d);
  });
}
async function handleVoicePresence(freq, presenceObj){
  renderUsers(presenceObj);
  const others = Object.keys(presenceObj || {}).filter(cs => cs !== state.callsign);
  Object.keys(voicePeers).forEach(cs => { if (!others.includes(cs)) closeVoicePeer(cs); });
  for (const cs of others){
    if (voicePeers[cs]) continue;
    const pc = createVoicePeer(freq, cs);
    voicePeers[cs] = pc;
    if (state.callsign < cs){
      try{
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendVoiceSignal(freq, cs, { kind: "offer", sdp: offer.sdp });
      } catch(err){ log("Offre WebRTC impossible : " + err.message); }
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
  } catch(err){ /* signal obsolète après renégociation, sans gravité */ }
}
async function joinVoiceMesh(){
  if (!firebaseReady || !state.connected) return;
  try{ await ensureMic(); } catch(err){ log("Micro indisponible : " + err.message); return; }
  const freq = voiceFreqKey();
  voicePresenceRef = db.ref(`voice_presence/${freq}/${state.callsign}`);
  voicePresenceRef.set({ ts: Date.now() })
    .catch(err => log("Voix : écriture refusée par Firebase (" + err.message + ") — vérifiez les règles sur \"voice_presence\"."));
  voicePresenceRef.onDisconnect().remove();
  voicePresenceListenerRef = db.ref(`voice_presence/${freq}`);
  voicePresenceListenerRef.on("value", snap => handleVoicePresence(freq, snap.val()),
    err => log("Voix : lecture refusée par Firebase (" + err.message + ")"));
  voiceSignalListenerRef = db.ref(`voice_signal/${freq}/${state.callsign}`);
  voiceSignalListenerRef.on("child_added", snap => { handleVoiceSignal(freq, snap.val()); snap.ref.remove().catch(()=>{}); },
    err => log("Voix : signalisation refusée par Firebase (" + err.message + ")"));
}
function leaveVoiceMesh(){
  if (voicePresenceRef) { voicePresenceRef.remove(); voicePresenceRef = null; }
  if (voicePresenceListenerRef) { voicePresenceListenerRef.off(); voicePresenceListenerRef = null; }
  if (voiceSignalListenerRef) { voiceSignalListenerRef.off(); voiceSignalListenerRef = null; }
  Object.keys(voicePeers).forEach(closeVoicePeer);
  Object.keys(voicePeerStatus).forEach(k => delete voicePeerStatus[k]);
  $("users").innerHTML = "";
  setPtt(false);
}
function setPtt(active){
  if (pttActive === active) return;
  pttActive = active;
  if (localMicStream) localMicStream.getAudioTracks().forEach(t => t.enabled = active);
  $("ptt-btn").classList.toggle("tx", active);
}
async function requestPtt(){
  if (!state.connected){ log("Connectez-vous avant de transmettre."); return; }
  if (!localMicStream){
    try{ await ensureMic(); if (!voicePresenceRef) joinVoiceMesh(); }
    catch(err){ log("Micro indisponible : " + err.message); return; }
  }
  setPtt(true);
}
$("ptt-btn").addEventListener("mousedown", requestPtt);
$("ptt-btn").addEventListener("touchstart", (e) => { e.preventDefault(); requestPtt(); });
["mouseup","mouseleave","touchend","touchcancel"].forEach(evt => $("ptt-btn").addEventListener(evt, () => setPtt(false)));

function keyCodeLabel(code){
  const SPECIAL = { Backslash: "\\", Space: "Espace", Backquote: "`", Slash: "/",
    ShiftLeft: "Maj (G)", ShiftRight: "Maj (D)", ControlLeft: "Ctrl (G)", ControlRight: "Ctrl (D)" };
  if (SPECIAL[code]) return SPECIAL[code];
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ") || code;
}
$("ptt-key").textContent = keyCodeLabel(state.pttKeyCode);
$("ptt-bind").addEventListener("click", () => {
  log("Appuyez sur la touche à utiliser pour le PTT…");
  const handler = (e) => {
    e.preventDefault();
    state.pttKeyCode = e.code;
    $("ptt-key").textContent = keyCodeLabel(e.code);
    document.removeEventListener("keydown", handler, true);
    log("PTT lié à : " + keyCodeLabel(e.code));
  };
  document.addEventListener("keydown", handler, true);
});
document.addEventListener("keydown", (e) => {
  if (e.code !== state.pttKeyCode || e.repeat) return;
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  e.preventDefault();
  requestPtt();
});
document.addEventListener("keyup", (e) => { if (e.code === state.pttKeyCode) setPtt(false); });

/* ---------------------------------------------------------------------------
   Pont pour le futur programme Python (webview.evaluate_js depuis Python)
--------------------------------------------------------------------------- */
window.auroraVhf = {
  setCallsign(cs){ state.callsign = String(cs).toUpperCase(); $("in-callsign").value = state.callsign; log("Callsign : " + state.callsign); },
  setFrequency(f){ retune(parseFloat(f)); },
  connect(){ $("btn-connect").click(); },
  disconnect(){ $("btn-disconnect").click(); },
  isConnected(){ return state.connected; },
};