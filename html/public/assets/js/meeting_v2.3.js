const LOGIN_URL = "https://app.shieldrtc.com/api/login";
const CREATE_ROOM_URL = "https://app.shieldrtc.com/api/rooms/create";
const PORTAL_URL = "https://app.shieldrtc.com/api/token/livekit";

// --- Multi-device support: allow one user to join the same room from multiple devices/tabs.
// LiveKit requires each participant identity to be unique, so we send:
// - device_id: stable per browser (localStorage)
// - session_id: unique per tab/load
const __DEVICE_ID_KEY = 'shieldrtc_device_id';

// TODO: giá trị này sẽ inject từ server sau
let isHost = false;

function __lkMakeId(prefix = 'id') {
  try {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      return `${prefix}_${crypto.randomUUID()}`;
    }
  } catch (e) {}
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function __lkGetOrCreateDeviceId() {
  let id = '';
  try { id = localStorage.getItem(__DEVICE_ID_KEY) || ''; } catch (e) {}
  if (!id) {
    id = __lkMakeId('dev');
    try { localStorage.setItem(__DEVICE_ID_KEY, id); } catch (e) {}
  }
  return id;
}

const DEVICE_ID  = __lkGetOrCreateDeviceId();
const SESSION_ID = __lkMakeId('sess');

let SIGNAL_JWT = null;
let currentRoom = null;       // giữ instance room để disconnect

// trạng thái UI
let cameraEnabled = true;
let micEnabled = true;
let speakerEnabled = true;
let cameraFacingMode = 'user'; // 'user' = cam trước, 'environment' = cam sau

// local tracks
let localVideoTrack = null;
let localVideoElement = null;
let localHasAudio = false;

let localMediaReady = false;

function waitLocalMediaReady(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (localMediaReady) { clearInterval(t); resolve(true); return; }
      if (Date.now() - start > timeoutMs) { clearInterval(t); resolve(false); }
    }, 50);
  });
}

// screen share local
let screenShareEnabled = false;
let localScreenTracks = []; // video + optional audio

// screen share arbitration (single active sharer)
let myScreenShareStartedAt = null; // ms epoch when local started sharing (or attempting)
let startingScreenShare = false;   // true while starting screen share

// camera restore state khi screen share
let cameraPrevEnabledBeforeScreen = null;
let cameraDisabledByScreenShare = false;

// Chat related
let CHAT_USERNAME = null;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Chat unread indicator state (red dot on the Open chat button)
let __chatHasUnread = false;

function setChatUnread(on){
  __chatHasUnread = !!on;
  const btn = document.getElementById('openChatBtn');
  if (btn) btn.classList.toggle('has-unread', __chatHasUnread);
}

function isChatPaneVisible(){
  const pane = document.getElementById('chatPane');
  if (!pane) return false;
  if (pane.classList.contains('is-hidden')) return false;
  try {
    return getComputedStyle(pane).display !== 'none';
  } catch (e) {
    return true;
  }
}

function clearChatUnreadIfAtBottom(){
  const box = document.getElementById('chatBox');
  if (!box) return;
  const stickThreshold = 60;
  const distanceFromBottom = (box.scrollHeight - box.scrollTop - box.clientHeight);
  if (distanceFromBottom < stickThreshold) setChatUnread(false);
}

/** Simple escape để tránh chèn HTML trực tiếp */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function appendChatMessage(sender, message, isLocal) {
  const box = document.getElementById('chatBox');
  if (!box) return;

  // Only auto-scroll if the user is already near the bottom (so they can read older messages).
  // If chat is closed, never auto-scroll on incoming messages.
  const stickThreshold = 60;
  const chatVisible = isChatPaneVisible();
  const distanceFromBottom = (box.scrollHeight - box.scrollTop - box.clientHeight);
  const shouldStick = chatVisible && (distanceFromBottom < stickThreshold);

  const line = document.createElement('div');
  line.className = `msg ${isLocal ? 'me' : 'them'}`;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = isLocal ? 'You' : (sender || 'Peer');

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = String(message ?? '');

  line.appendChild(meta);
  line.appendChild(bubble);

  box.appendChild(line);

  // Auto-scroll only when the user is already at the bottom AND chat is visible.
  // Always scroll for local messages (sending) so the UX feels immediate.
  if (shouldStick || isLocal) {
    box.scrollTop = box.scrollHeight;
  }

  // Unread indicator rules:
  // - If chat is closed: show dot on any incoming (remote) message.
  // - If chat is open but user is not near the bottom: show dot (new msg is below).
  if (!isLocal) {
    const notVisibleNow = (!chatVisible) || !shouldStick;
    if (notVisibleNow) setChatUnread(true);
  }
}

function resetChatBox() {
  const box = document.getElementById('chatBox');
  if (box) box.innerHTML = '';
  setChatUnread(false);
}

// --- Data channel helpers (chat + control messages)
function safeParseJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function publishDataObject(obj) {
  if (!currentRoom || !currentRoom.localParticipant) return;
  try {
    const encoded = textEncoder.encode(JSON.stringify(obj));
    await currentRoom.localParticipant.publishData(encoded, { reliable: true });
    console.log('publishDataObject', obj);
  } catch (e) {
    // ignore
  }
}

async function broadcastScreenShareClaim(startedAt) {
  if (!currentRoom) return;
  await publishDataObject({
    type: 'screen_share_claim',
    ts: Number(startedAt || Date.now()),
    sid: currentRoom.localParticipant.sid,
    sender: CHAT_USERNAME || currentRoom.localParticipant.identity || 'User'
  });
}

async function broadcastScreenShareRelease() {
  if (!currentRoom) return;
  await publishDataObject({
    type: 'screen_share_release',
    ts: Date.now(),
    sid: currentRoom.localParticipant.sid,
    sender: CHAT_USERNAME || currentRoom.localParticipant.identity || 'User'
  });
}


// --- Mic state broadcast (to make mute UI reliable across mobile/desktop) ---
// Rationale: relying on track/publication mute flags can be flaky on some mobile browsers.
// Each peer broadcasts its micEnabled state and also replies to snapshot requests.
function getLocalIdentityKeyForBroadcast() {
  try {
    if (currentRoom && currentRoom.localParticipant) {
      const p = currentRoom.localParticipant;
      // Multi-device ready: identify by per-connection SID only.
      const sid = String((p.sid || '')).trim();
      return sid || 'local';
    }
  } catch (e) {}
  return 'local';
}

function getLocalMicEnabledForBroadcast() {
  try {
    const lp = currentRoom && currentRoom.localParticipant;
    if (lp) {
      // (A) Ưu tiên API của SDK nếu có
      const v = lp.isMicrophoneEnabled;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'function') {
        const r = v.call(lp);
        if (typeof r === 'boolean') return r;
      }

      // (B) Fallback: soi publications audio của local
      const pubs = getAudioTrackPublicationsSafe(lp) || [];
      if (pubs.length) {
        const states = pubs.map(getPubMutedSafe).filter(x => typeof x === 'boolean');
        if (states.length) {
          // pubMuted=false => mic đang enabled
          if (states.some(m => m === false)) return true;
          if (states.every(m => m === true)) return false;
        }
      } else {
        // không có audio pub => coi như mic off
        return false;
      }
    }
  } catch (e) {}

  // (C) Cuối cùng mới fallback về biến nội bộ
  return !!(micEnabled && localHasAudio);
}

async function broadcastMicStateNow(extra) {
  console.log('[mic_state tx]', {
    sid: currentRoom?.localParticipant?.sid,
    micEnabled,
    localHasAudio,
    sdk: (currentRoom?.localParticipant?.isMicrophoneEnabled),
    enabled: getLocalMicEnabledForBroadcast(),
  });

  if (!currentRoom || !currentRoom.localParticipant) return;
  const obj = Object.assign({
    type: 'mic_state',
    enabled: getLocalMicEnabledForBroadcast(),
    sid: currentRoom.localParticipant.sid,
    ts: Date.now(),
  }, (extra && typeof extra === 'object') ? extra : {});
  await publishDataObject(obj);
}

async function requestMicStatesNow(extra) {
  if (!currentRoom || !currentRoom.localParticipant) return;
  const obj = Object.assign({
    type: 'mic_state_req',
    from_sid: currentRoom.localParticipant.sid,
    from_key: getLocalIdentityKeyForBroadcast(),
    ts: Date.now(),
  }, (extra && typeof extra === 'object') ? extra : {});
  await publishDataObject(obj);
}



// --- Peer broadcast helpers (mic mute state sync for new joiners) ---
async function broadcastPeerHelloNow(extra) {
  if (!currentRoom || !currentRoom.localParticipant) return;
  const obj = Object.assign({
    type: 'peer_hello',
    sid: currentRoom.localParticipant.sid,
    ts: Date.now(),
  }, (extra && typeof extra === 'object') ? extra : {});
  await publishDataObject(obj);
}

function scheduleMicStateBurst(reason){
  // Broadcast our current mic state a few times to cover datachannel warmup for new joiners.
  const delays = [0, 240, 850, 1900, 3600];
  delays.forEach((d, idx) => {
    setTimeout(() => {
      try { broadcastMicStateNow({ cause: reason || 'burst', n: idx + 1 }); } catch (e) {}
    }, d);
  });
}

function schedulePeerHelloBurst(){
  const delays = [120, 520, 1400];
  delays.forEach((d, idx) => {
    setTimeout(() => {
      try { broadcastPeerHelloNow({ n: idx + 1 }); } catch (e) {}
    }, d);
  });
}


function scheduleMicRequestBurst(){
  // New joiner asks everyone for current mic state.
  // Burst helps cover datachannel warmup + mobile timing quirks.
  const delays = [60, 260, 820, 1650, 3200];
  delays.forEach((d, idx) => {
    setTimeout(() => {
      try { requestMicStatesNow({ n: idx + 1 }); } catch (e) {}
    }, d);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // --- UI refs
  const toggleCameraBtn  = document.getElementById("toggleCameraBtn");
  const toggleCameraIcon = toggleCameraBtn ? toggleCameraBtn.querySelector('.material-symbols-outlined') : null;

  const toggleMicBtn  = document.getElementById("toggleMicBtn");
  const toggleMicIcon = toggleMicBtn ? toggleMicBtn.querySelector('.material-symbols-outlined') : null;

  const toggleSpeakerBtn  = document.getElementById("toggleSpeakerBtn");
  const toggleSpeakerIcon = toggleSpeakerBtn ? toggleSpeakerBtn.querySelector('.material-symbols-outlined') : null;

  const switchCameraBtn  = document.getElementById("switchCameraBtn");
  const toggleScreenBtn  = document.getElementById("toggleScreenBtn");
  const toggleScreenIcon = toggleScreenBtn ? toggleScreenBtn.querySelector('.material-symbols-outlined') : null;

  // Stage layout refs
  const stageEl      = document.getElementById('stage');
  const screenPaneEl = document.getElementById('screenPane');
  const usersPaneEl  = document.getElementById('usersPane');
  const splitterEl   = document.getElementById('splitter');
  const screenSlotEl = document.getElementById('screenSlot');
  const videosEl     = document.getElementById('videos');

  // Move control dock to the bottom of the stage panel (screen share + user cams)
  const stageControlsMount = document.getElementById('stageControlsMount');
  const mediaWrapperEl = document.getElementById('mediaWrapper');
  if (stageControlsMount && mediaWrapperEl) {
    stageControlsMount.appendChild(mediaWrapperEl);
  }


  // Topbar status (connection + people count)
  const topbarRoomEl   = document.getElementById('topbarRoom');
  const topbarRoomDot  = topbarRoomEl ? topbarRoomEl.querySelector('.dot') : null;
  const topbarRoomText = topbarRoomEl ? topbarRoomEl.querySelector('.chipText') : null;
  const topbarCountEl  = document.getElementById('topbarCount');

  function setTopbarStatus(connected, roomId) {
    if (topbarRoomDot) topbarRoomDot.classList.toggle('ok', !!connected);
    if (topbarRoomText) topbarRoomText.textContent = connected ? (`Room: ${roomId || ''}`) : 'Not connected';
  }

    function getRenderedTileCount() {
    try {
      if (!videosEl) return 0;
      return videosEl.querySelectorAll('.tile').length;
    } catch (e) { return 0; }
  }

  function getRemoteParticipantsCount(room) {
    if (!room) return 0;
    const m =
      room.participants ||
      room.remoteParticipants ||
      room.remoteParticipantsMap ||
      room._participants ||
      room._remoteParticipants ||
      null;

    try {
      if (m && typeof m.size === 'number') return m.size;
      if (Array.isArray(m)) return m.length;
      if (m && typeof m === 'object') return Object.keys(m).length;
    } catch (e) {}
    return 0;
  }
  // Collect a robust set of live participant SIDs from whatever map the SDK exposes.
  // This prevents tile-prune from accidentally removing remote tiles on some LiveKit versions.
  function collectLiveParticipantSids(room) {
    const live = new Set();
    if (!room) return live;

    try { if (room.localParticipant && room.localParticipant.sid) live.add(String(room.localParticipant.sid)); } catch (e) {}

    const candidates = [
      room.participants,
      room.remoteParticipants,
      room.remoteParticipantsMap,
      room._participants,
      room._remoteParticipants
    ];

    for (const m of candidates) {
      if (!m) continue;
      try {
        // Map-like
        if (typeof m.size === 'number' && typeof m.forEach === 'function') {
          m.forEach((p, k) => {
            try { if (k != null) live.add(String(k)); } catch (e) {}
            try { if (p && p.sid != null) live.add(String(p.sid)); } catch (e) {}
          });
          continue;
        }

        // Array-like
        if (Array.isArray(m)) {
          m.forEach((p) => { try { if (p && p.sid != null) live.add(String(p.sid)); } catch (e) {} });
          continue;
        }

        // Plain object map
        if (typeof m === 'object') {
          try { Object.keys(m).forEach((k) => { if (k != null) live.add(String(k)); }); } catch (e) {}
          try { Object.values(m).forEach((p) => { if (p && p.sid != null) live.add(String(p.sid)); }); } catch (e) {}
        }
      } catch (e) {}
    }

    return live;
  }

  // Enumerate remote participants in a version-tolerant way (used to create placeholder tiles for "camera off" users).
  function getRemoteParticipantsList(room) {
    const list = [];
    if (!room) return list;

    const m =
      room.participants ||
      room.remoteParticipants ||
      room.remoteParticipantsMap ||
      room._participants ||
      room._remoteParticipants ||
      null;

    try {
      if (m && typeof m.forEach === 'function') {
        m.forEach((p) => { if (p && p.sid) list.push(p); });
        return list;
      }
      if (Array.isArray(m)) {
        m.forEach((p) => { if (p && p.sid) list.push(p); });
        return list;
      }
      if (m && typeof m === 'object') {
        Object.values(m).forEach((p) => { if (p && p.sid) list.push(p); });
      }
    } catch (e) {}

    return list;
  }


  function updateTopbarCount() {
    if (!topbarCountEl) return;
    if (!currentRoom) { topbarCountEl.textContent = '0'; return; }

    // Prefer what we actually render (works even if SDK participant maps differ across versions).
    const rendered = getRenderedTileCount();
    const remote = getRemoteParticipantsCount(currentRoom);
    const count = rendered > 0 ? rendered : (1 + remote);

    topbarCountEl.textContent = String(count);
  }

  // initial
  setTopbarStatus(false, '');
  updateTopbarCount();


  // Participant UI state
  const participantTiles = new Map();   // sid -> tileEl
  const participantNames = new Map();   // sid -> string
  const screenShares     = new Map();   // sid -> { track, el, name, publication? }
  const participantSeenAt = new Map(); // sid -> ms first seen (for mic sync grace)
  const MIC_GRACE_MS = 1400;
  const REMOTE_NO_PUB_GRACE_MS = 250;
  
  // Robust cleanup: remove orphan tiles even if some disconnect events are missed (network drops, tab kills, etc.)
  let participantPruneTimer = null;
  let participantPruneEnabledAt = 0;
  let participantLastNonEmptyAt = 0;
  
  function pruneStaleParticipantTiles() {
    try {
      if (!currentRoom) return;
      const st = String((currentRoom.connectionState || currentRoom.state || currentRoom._connectionState || '')).toLowerCase();
      // Only prune when we can positively detect "connected". If unknown, skip to avoid flicker.
      if (!st) return;
      if (st.includes('reconnect') || st.includes('connecting')) return;
      if (!st.includes('connected')) return;
      if (participantPruneEnabledAt && Date.now() < participantPruneEnabledAt) return;
    } catch (e) { return; }

    // Guard: some SDK versions momentarily show 0 participants during warmup/reconnect.
    // Avoid pruning remote tiles too aggressively (causes flicker).
    try {
      const remoteSize = getRemoteParticipantsCount(currentRoom);
      if (remoteSize > 0) participantLastNonEmptyAt = Date.now();
      if (remoteSize === 0 && participantTiles.size > 1) {
        if (!participantLastNonEmptyAt || (Date.now() - participantLastNonEmptyAt) < 5000) return;
      }
    } catch (e) {}
    const live = collectLiveParticipantSids(currentRoom);
    // Safety: if SDK reports remote participants but we couldn't enumerate them (temporary warmup), don't prune.
    try {
      const remoteSizeNow = getRemoteParticipantsCount(currentRoom);
      if (remoteSizeNow > 0 && live.size <= 1 && participantTiles.size > 1) return;
    } catch (e) {}
    
    const toRemove = [];
    try {
      for (const sid of participantTiles.keys()) {
        const s = String(sid || '').trim();
        if (!s) continue;
        if (!live.has(s)) toRemove.push(s);
      }
    } catch (e) {}
    if (!toRemove.length) return;
    
    for (const sid of toRemove) {
      // identity bookkeeping
      try {
      } catch (e) {}
      
      // Remove UI tile + media
      try { removeParticipantTile(sid); } catch (e) {}
      try { cleanupParticipantMediaElements(sid); } catch (e) {}
      
      // Remove screen share UI for that sid
      try {
        const item = screenShares.get(sid);
        if (item && item.el) { try { item.el.remove(); } catch (e) {} }
        screenShares.delete(sid);
        if (activeScreenSid === sid) activeScreenSid = null;
      } catch (e) {}
    }
    
    try { renderActiveScreen(); } catch (e) {}
    try { updateTopbarCount(); } catch (e) {}
  }
  
  function startParticipantPruneLoop() {
    try { stopParticipantPruneLoop(); } catch (e) {}
    // Prevent early pruning while participant maps are still warming up (avoid UI flicker)
    try { participantPruneEnabledAt = Date.now() + 3500; } catch (e) { participantPruneEnabledAt = 0; }
    try { participantLastNonEmptyAt = 0; } catch (e) {}
    participantPruneTimer = setInterval(() => {
      try { pruneStaleParticipantTiles(); } catch (e) {}
    }, 2500);
  }
  
  function stopParticipantPruneLoop() {
    if (participantPruneTimer) {
      try { clearInterval(participantPruneTimer); } catch (e) {}
      participantPruneTimer = null;
    }
    try { participantPruneEnabledAt = 0; } catch (e) {}
  }
// Mic state broadcast cache (sid -> { enabled, ts })
  const micBroadcastBySid = new Map(); // sid -> { enabled, ts }
  const MIC_BROADCAST_TTL_MS = 24 * 60 * 60 * 1000; // keep for up to 24h within a session

  let activeScreenSid = null;

  // Screen tile (left pane)
  const screenTileEl = document.createElement('div');
  screenTileEl.className = 'screen-tile';
  screenTileEl.innerHTML = `
<div class="name-tag"></div>
<div class="media"></div>
`;

// Placeholder shown when no one is sharing the screen
const screenPlaceholderEl = document.createElement('div');
screenPlaceholderEl.className = 'screen-placeholder';
screenPlaceholderEl.innerHTML = `
  <span class="material-symbols-outlined">screen_share</span>
  <div class="t">No active screen share</div>
  <div class="s">When someone shares their screen, it will appear here.</div>
`;


// --- Screen zoom controls (phóng to / thu nhỏ) + drag to move
const zoomInBtn  = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');


// --- Screen map (mini map) for screen share when zoomed in
// Shows a small square map next to the zoom-in (magnifier) icon.
// User can drag inside the map to move the current view.
(function injectScreenMapCss(){
  if (document.getElementById('screenMapCss')) return;
  const st = document.createElement('style');
  st.id = 'screenMapCss';
  st.textContent = `
    .screen-map{
      width: 88px; height: 88px;
      border: 1px solid rgba(255,255,255,.18);
      background: rgba(0,0,0,.22);
      border-radius: 12px;
      position: relative;
      overflow: hidden;
      display: none;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      box-shadow: 0 8px 22px rgba(0,0,0,.18);
      backdrop-filter: blur(6px);
    }
    .screen-map.is-active{ display: inline-block; }
    .screen-map::before{
      content: '';
      position: absolute; inset: 0;
      background-image: linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px);
      background-size: 22px 22px;
      opacity: .7;
      pointer-events: none;
    }
    .screen-map-viewport{
      position: absolute;
      left: 0; top: 0;
      border: 2px solid rgba(255,255,255,.72);
      border-radius: 10px;
      background: rgba(255,255,255,.07);
      box-shadow: 0 6px 16px rgba(0,0,0,.22);
      cursor: grab;
      touch-action: none;
      will-change: transform, width, height;
    }
    .screen-map.is-dragging .screen-map-viewport{ cursor: grabbing; }
  `;
  document.head.appendChild(st);
})();

let screenMapEl = null;
let screenMapViewportEl = null;
let screenMapDragging = false;
let screenMapPointerId = null;

function ensureScreenMapMounted(){
  if (!zoomInBtn) return;
  if (screenMapEl) return;

  const parent = zoomInBtn.parentElement;
  if (!parent) return;

  screenMapEl = document.createElement('div');
  screenMapEl.className = 'screen-map';
  screenMapEl.setAttribute('aria-label', 'Screen map');
  screenMapEl.setAttribute('title', 'Drag to move the shared screen view');
  screenMapEl.innerHTML = `<div class="screen-map-viewport"></div>`;
  screenMapViewportEl = screenMapEl.querySelector('.screen-map-viewport');

  // Insert right next to the zoom-in button (kế bên icon kính lúp)
  if (zoomInBtn.nextSibling) parent.insertBefore(screenMapEl, zoomInBtn.nextSibling);
  else parent.appendChild(screenMapEl);

  // Interactions: click/drag inside the map to move view
  const onMove = (clientX, clientY) => {
    if (!screenMapEl) return;

    const hasScreen = !!activeScreenSid && screenShares && screenShares.has(activeScreenSid);
    if (!hasScreen || screenZoom <= 1) return;

    const mapRect = screenMapEl.getBoundingClientRect();
    const mx0 = clamp(clientX - mapRect.left, 0, mapRect.width);
    const my0 = clamp(clientY - mapRect.top, 0, mapRect.height);

    const z = screenZoom;
    // locator size reflects current zoom (visible fraction ~= 1/z)
    const locW = clamp(mapRect.width  / z, 14, mapRect.width);
    const locH = clamp(mapRect.height / z, 14, mapRect.height);

    // center the locator under pointer
    const x = clamp(mx0 - locW/2, 0, mapRect.width  - locW);
    const y = clamp(my0 - locH/2, 0, mapRect.height - locH);

    // convert locator position -> panX/panY
    const tileRect = screenTileEl.getBoundingClientRect();
    const maxX = (tileRect.width  * (z - 1)) / 2;
    const maxY = (tileRect.height * (z - 1)) / 2;

    const denomX = (mapRect.width  - locW) || 1;
    const denomY = (mapRect.height - locH) || 1;

    const ratioX = clamp(x / denomX, 0, 1);
    const ratioY = clamp(y / denomY, 0, 1);

    // ratio 0 => panX = +maxX (view left), ratio 1 => panX = -maxX (view right)
    panX = maxX * (1 - 2 * ratioX);
    panY = maxY * (1 - 2 * ratioY);

    applyTransformToActiveScreen();
  };

  screenMapEl.addEventListener('pointerdown', (e) => {
    // Only when zoomed in
    if (screenZoom <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    screenMapDragging = true;
    screenMapPointerId = e.pointerId;
    try { screenMapEl.setPointerCapture(e.pointerId); } catch (err) {}
    screenMapEl.classList.add('is-dragging');
    onMove(e.clientX, e.clientY);
  });

  screenMapEl.addEventListener('pointermove', (e) => {
    if (!screenMapDragging) return;
    if (screenMapPointerId != null && e.pointerId !== screenMapPointerId) return;
    e.preventDefault();
    onMove(e.clientX, e.clientY);
  });

  const end = (e) => {
    if (!screenMapDragging) return;
    if (screenMapPointerId != null && e.pointerId !== screenMapPointerId) return;
    screenMapDragging = false;
    screenMapPointerId = null;
    try { screenMapEl.releasePointerCapture(e.pointerId); } catch (err) {}
    screenMapEl.classList.remove('is-dragging');
  };

  screenMapEl.addEventListener('pointerup', end);
  screenMapEl.addEventListener('pointercancel', end);

  window.addEventListener('resize', () => {
    try { updateScreenMap(); } catch (e) {}
  }, { passive: true });
}

function updateScreenMap(){
  ensureScreenMapMounted();
  if (!screenMapEl || !screenMapViewportEl) return;

  const hasScreen = !!activeScreenSid && screenShares && screenShares.has(activeScreenSid);
  const active = hasScreen && screenZoom > 1;

  screenMapEl.classList.toggle('is-active', !!active);
  if (!active) return;

  const mapRect = screenMapEl.getBoundingClientRect();
  const z = screenZoom;

  const locW = clamp(mapRect.width  / z, 14, mapRect.width);
  const locH = clamp(mapRect.height / z, 14, mapRect.height);

  // map pan range based on screen tile size
  const tileRect = screenTileEl.getBoundingClientRect();
  const maxX = (tileRect.width  * (z - 1)) / 2;
  const maxY = (tileRect.height * (z - 1)) / 2;

  const denomX = (2 * maxX) || 1;
  const denomY = (2 * maxY) || 1;

  // NOTE: locator moves opposite of pan direction
  const rx = clamp(((-panX + maxX) / denomX), 0, 1);
  const ry = clamp(((-panY + maxY) / denomY), 0, 1);

  const x = (mapRect.width  - locW) * rx;
  const y = (mapRect.height - locH) * ry;

  screenMapViewportEl.style.width  = locW + 'px';
  screenMapViewportEl.style.height = locH + 'px';
  screenMapViewportEl.style.transform = `translate(${x}px, ${y}px)`;
}



const fsBtn     = document.getElementById('stageFsBtn');
const openChatBtn = document.getElementById('openChatBtn');
const fsBtnIcon  = fsBtn ? fsBtn.querySelector('.material-symbols-outlined') : null;
const openChatIcon = openChatBtn ? openChatBtn.querySelector('.material-symbols-outlined') : null;

// Fullscreen (layout) + chat dock refs
const sideEl = document.querySelector('aside.side');
const chatPaneEl = document.getElementById('chatPane');
const chatDockMountEl = document.getElementById('chatDockMount');
const chatNormalMountEl = document.getElementById('chatNormalMount');
const chatCardEl = document.getElementById('chatCard');

let uiStageFullscreen = false;
let uiChatOpen = false;

function syncTopbarHeightVar(){
  // If fullscreen hides topbar, force height = 0 to avoid stale values
  if (document.body.classList.contains('is-stage-fullscreen')) {
    document.documentElement.style.setProperty('--topbarH', `0px`);
    return;
  }

  const el = document.querySelector('.topbar');
  if (!el) return;

  const h = Math.ceil(el.getBoundingClientRect().height || 0);
  document.documentElement.style.setProperty('--topbarH', `${h}px`);
}
syncTopbarHeightVar();

function getPx(v, fallback){
  const n = Number(String(v||'').replace('px',''));
  return Number.isFinite(n) && n>0 ? n : fallback;
}

let __usersOneColMinPx = null;
function computeUsersOneColMinPx(){
  // Minimum width for the user cam list to fit exactly ONE tile column (no horizontal overflow).
  // We measure a probe .tile outside of flex constraints so clamp(160px, 18vw, 240px) resolves correctly.
  try{
    const probe = document.createElement('div');
    probe.className = 'tile';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.left = '-9999px';
    probe.style.top = '-9999px';
    probe.style.height = '100px';
    document.body.appendChild(probe);

    const csTile = getComputedStyle(probe);
    const tileMinW = parseFloat(csTile.minWidth || '0') || 0;
    const tileW0 = probe.getBoundingClientRect().width || 0;
    // Use the computed width (clamp(...) result) as the real "1 column" width; fall back to min-width.
    const tileW = Math.max(0, tileW0 || tileMinW);
    probe.remove();

    // padding left+right from the tiles container (fallback: 20)
    let padLR = 20;
    try{
      if (videosEl){
        const cs = getComputedStyle(videosEl);
        const pl = parseFloat(cs.paddingLeft || '0') || 0;
        const pr = parseFloat(cs.paddingRight || '0') || 0;
        padLR = pl + pr;
      }
    }catch(e){}

    // reserve scrollbar width so a long list doesn't force a horizontal scroll
    const scrollbarReserve = 16;

    const min = Math.ceil(tileW + padLR + scrollbarReserve + 2);
    return (Number.isFinite(min) && min > 0) ? min : 190;
  }catch(e){
    return 190;
  }
}

function getUsersMinPx(){
  let cssMin = 190;
  try{
    const v = getComputedStyle(document.documentElement).getPropertyValue('--usersPaneMin');
    cssMin = getPx(v, 190);
  }catch(e){}
  if (__usersOneColMinPx == null) __usersOneColMinPx = computeUsersOneColMinPx();
  return Math.max(cssMin, __usersOneColMinPx);
}
function getScreenMinPx(){
  try{
    const v = getComputedStyle(document.documentElement).getPropertyValue('--screenPaneMin');
    return getPx(v, 320);
  }catch(e){ return 320; }
}
function getChatWidthPx(){
  try{
    const v = getComputedStyle(document.documentElement).getPropertyValue('--chatPaneW');
    return getPx(v, 340);
  }catch(e){ return 340; }
}

function dockChatIntoStage(){
  if (!chatCardEl || !chatDockMountEl) return;
  if (chatDockMountEl.contains(chatCardEl)) return;
  chatDockMountEl.appendChild(chatCardEl);
  chatCardEl.classList.add('is-chat-docked');
}

function undockChatToNormal(){
  if (!chatCardEl || !chatNormalMountEl) return;
  if (chatNormalMountEl.contains(chatCardEl)) return;
  chatNormalMountEl.appendChild(chatCardEl);
  chatCardEl.classList.remove('is-chat-docked');
}

function closeDockedChat(){
  uiChatOpen = false;
  if (chatPaneEl) chatPaneEl.classList.add('is-hidden');
  if (openChatIcon) openChatIcon.textContent = 'chat';
  if (openChatBtn) openChatBtn.title = 'Open chat';
}

function openDockedChat(){
  uiChatOpen = true;
  if (chatPaneEl) chatPaneEl.classList.remove('is-hidden');
  if (openChatIcon) openChatIcon.textContent = 'close';
  if (openChatBtn) openChatBtn.title = 'Close chat';
  // If user is already at the bottom, remove the unread dot (they can see latest messages).
  try{ requestAnimationFrame(() => clearChatUnreadIfAtBottom()); }catch(e){}
  try{ document.getElementById('chatInput')?.focus(); }catch(e){}
}

function toggleDockedChat(){
  if (uiChatOpen) closeDockedChat();
  else openDockedChat();
  // re-clamp splitter when chat pane width changes
  try{ window.dispatchEvent(new Event('resize')); }catch(e){}
}

function syncFsUi(){
  document.body.classList.toggle('is-stage-fullscreen', uiStageFullscreen);
  document.body.classList.toggle('is-chat-open', uiChatOpen);
  syncTopbarHeightVar();

  if (fsBtnIcon) fsBtnIcon.textContent = uiStageFullscreen ? 'fullscreen_exit' : 'fullscreen';
  if (fsBtn) fsBtn.title = uiStageFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
  if (openChatBtn) openChatBtn.title = uiChatOpen ? 'Close chat' : 'Open chat';
}

function enterStageFullscreen(){
  uiStageFullscreen = true;
  syncFsUi();

  // In fullscreen, default to maximize the screen-share pane
  // (keep participants list at minimum = 1 column).
  try{
    requestAnimationFrame(() => {
      try{
        if (screenPaneEl && !screenPaneEl.classList.contains('is-hidden')) {
          const rect = stageEl.getBoundingClientRect();
          const minScreen = getScreenMinPx();
          const minUsers  = getUsersMinPx();
          const splitW = splitterEl ? (splitterEl.getBoundingClientRect().width || 8) : 8;
          const chatW  = (chatPaneEl && !chatPaneEl.classList.contains('is-hidden')) ? getChatWidthPx() : 0;
          const max = Math.max(minScreen, rect.width - minUsers - chatW - splitW);
          const w = Math.max(minScreen, Math.min(max, max));
          screenPaneEl.style.flexBasis = `${w}px`;
}
      }catch(e){}
      try{ window.dispatchEvent(new Event('resize')); }catch(e){}
    });
  }catch(e){
    try{ window.dispatchEvent(new Event('resize')); }catch(e){}
  }
}

function exitStageFullscreen(){
  uiStageFullscreen = false;
  syncFsUi();
  try{ window.dispatchEvent(new Event('resize')); }catch(e){}
}

function toggleStageFullscreen(){
  if (uiStageFullscreen) exitStageFullscreen();
  else enterStageFullscreen();
}

if (fsBtn) {
  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStageFullscreen();
  });
}

if (openChatBtn) {
  openChatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDockedChat();
  });
}

// Clear unread dot when user scrolls down to the bottom.
const chatBoxEl = document.getElementById('chatBox');
if (chatBoxEl) {
  chatBoxEl.addEventListener('scroll', () => {
    try{ clearChatUnreadIfAtBottom(); }catch(e){}
  }, { passive: true });
}

// initial state
try{ dockChatIntoStage(); }catch(e){}
try{ closeDockedChat(); }catch(e){}
syncFsUi();
try{ setStageScreenVisible(false); }catch(e){}
let screenZoom = 1;
const SCREEN_ZOOM_MIN  = 1;
const SCREEN_ZOOM_MAX  = 3;
const SCREEN_ZOOM_STEP = 0.25;
let lastRenderedScreenSid = null;

// pan state (only meaningful when zoom > 1)
let panX = 0;
let panY = 0;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function updatePannableUI() {
  if (screenZoom > 1) screenTileEl.classList.add('is-pannable');
  else screenTileEl.classList.remove('is-pannable', 'is-grabbing');
}

function clampPanToBounds() {
  const rect = screenTileEl.getBoundingClientRect();
  const maxX = (rect.width  * (screenZoom - 1)) / 2;
  const maxY = (rect.height * (screenZoom - 1)) / 2;
  panX = clamp(panX, -maxX, maxX);
  panY = clamp(panY, -maxY, maxY);
}

function applyTransformToActiveScreen() {
  const item = activeScreenSid ? screenShares.get(activeScreenSid) : null;
  if (!item || !item.el) return;

  if (screenZoom <= 1) { panX = 0; panY = 0; }
  clampPanToBounds();

  item.el.style.transform = `translate(${panX}px, ${panY}px) scale(${screenZoom})`;
  item.el.style.transformOrigin = 'center center';
  updatePannableUI();
  try { updateScreenMap(); } catch (e) {}
}

function applyZoomToActiveScreen() {
  try {
    // if active changed, reset zoom + pan
    if (activeScreenSid !== lastRenderedScreenSid) {
      screenZoom = 1;
      panX = 0; panY = 0;
      lastRenderedScreenSid = activeScreenSid;
      updateZoomButtons();
      updatePannableUI();
    }
    applyTransformToActiveScreen();
  } catch (e) {}
}

function updateZoomButtons() {
  const hasScreen = !!activeScreenSid && screenShares && screenShares.has(activeScreenSid);
  if (!hasScreen) {
    if (zoomOutBtn) zoomOutBtn.disabled = true;
    if (zoomInBtn)  zoomInBtn.disabled  = true;
    try { updateScreenMap(); } catch (e) {}
    return;
  }
  if (zoomOutBtn) zoomOutBtn.disabled = (screenZoom <= SCREEN_ZOOM_MIN + 1e-9);
  if (zoomInBtn)  zoomInBtn.disabled  = (screenZoom >= SCREEN_ZOOM_MAX - 1e-9);
}

function resetScreenZoomAndPan() {
  screenZoom = 1;
  panX = 0; panY = 0;
  applyTransformToActiveScreen();
  updateZoomButtons();
}

function resetScreenZoom() { resetScreenZoomAndPan(); }

if (zoomInBtn) {
  zoomInBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    screenZoom = clamp(screenZoom + SCREEN_ZOOM_STEP, SCREEN_ZOOM_MIN, SCREEN_ZOOM_MAX);
    applyTransformToActiveScreen();
    updateZoomButtons();
  });
}

if (zoomOutBtn) {
  zoomOutBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    screenZoom = clamp(screenZoom - SCREEN_ZOOM_STEP, SCREEN_ZOOM_MIN, SCREEN_ZOOM_MAX);
    if (screenZoom <= 1) { panX = 0; panY = 0; }
    applyTransformToActiveScreen();
    updateZoomButtons();
  });
}

// Drag to move when zooming in
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panBaseX = 0;
let panBaseY = 0;

screenTileEl.addEventListener('pointerdown', (e) => {
  if (screenZoom <= 1) return;
  if (e.target && e.target.closest && e.target.closest('.screen-zoom-controls')) return;

  isPanning = true;
  screenTileEl.classList.add('is-grabbing');
  panStartX = e.clientX;
  panStartY = e.clientY;
  panBaseX = panX;
  panBaseY = panY;

  try { screenTileEl.setPointerCapture(e.pointerId); } catch (err) {}
  e.preventDefault();
});

screenTileEl.addEventListener('pointermove', (e) => {
  if (!isPanning) return;
  const dx = e.clientX - panStartX;
  const dy = e.clientY - panStartY;
  panX = panBaseX + dx;
  panY = panBaseY + dy;
  applyTransformToActiveScreen();
  e.preventDefault();
});

function endPan(e) {
  if (!isPanning) return;
  isPanning = false;
  screenTileEl.classList.remove('is-grabbing');
  try { if (e && e.pointerId != null) screenTileEl.releasePointerCapture(e.pointerId); } catch (err) {}
}

screenTileEl.addEventListener('pointerup', endPan);
screenTileEl.addEventListener('pointercancel', endPan);

// keep pan within bounds after resizing/splitting
window.addEventListener('resize', () => {
  applyTransformToActiveScreen();
});

updateZoomButtons();
updatePannableUI();


  function getDisplayName(participant) {
    // ưu tiên CHAT_USERNAME cho local (đỡ bị sid/identity lạ)
    if (currentRoom && participant && participant.sid === currentRoom.localParticipant?.sid) {
      return CHAT_USERNAME || participant.name || participant.identity || 'You';
    }
    return (participant && (participant.name || participant.identity)) ? (participant.name || participant.identity) : 'User';
  }

  function getCameraPlaceholderHtml() {
    return `
      <div class="placeholder">
        <span class="material-symbols-outlined">videocam_off</span>
        <div>Camera off</div>
      </div>
    `;
  }

  
  function updateMicIndicator(sid, muted) {
    console.log('Start updateMicIndicator', muted);
    const tile = participantTiles.get(sid);
    if (!tile) return;
    const badge = tile.querySelector('.mic-badge');
    const icon = tile.querySelector('.mic-icon');
    if (!badge || !icon) return;

    const isMuted = !!muted;
    icon.textContent = isMuted ? 'mic_off' : 'mic';
    badge.classList.toggle('is-muted', isMuted);
    badge.classList.remove('is-unknown');
    badge.title = isMuted ? 'Mic muted' : 'Mic on';

    console.log(sid, isMuted);
  }

  function setMicUnknown(sid) {
    const tile = participantTiles.get(sid);
    if (!tile) return;
    const badge = tile.querySelector('.mic-badge');
    const icon = tile.querySelector('.mic-icon');
    if (!badge || !icon) return;

    icon.textContent = 'mic';
    badge.classList.remove('is-muted');
    badge.classList.add('is-unknown');
    badge.title = 'Mic status';
  }

  function getTrackPublicationsSafe(participant) {
    if (!participant) return [];
    try {
      if (typeof participant.getTrackPublications === 'function') {
        return participant.getTrackPublications() || [];
      }
    } catch (e) {}

    const m = participant.tracks || participant.trackPublications || participant._trackPublications;
    try {
      if (m && typeof m.values === 'function') return Array.from(m.values());
    } catch (e) {}
    return [];
  }


  function isAudioPublication(pub){
    if (!pub) return false;
    try {
      const kind = (pub.kind != null) ? pub.kind
        : (pub.trackKind != null) ? pub.trackKind
        : (pub.track && pub.track.kind != null) ? pub.track.kind
        : null;

      const source = (pub.source != null) ? pub.source
        : (pub.track && pub.track.source != null) ? pub.track.source
        : null;

      const ks = String(kind || '').toLowerCase();
      const ss = String(source || '').toLowerCase();

      // Screen-share audio is still "audio" kind, but we don't want to treat it as mic.
      if (ss.includes('screen')) return false;

      // Prefer explicit microphone source if available
      if (ss.includes('microphone') || ss === 'mic') return true;
      if (ks.includes('microphone') || ks === 'mic') return true;

      // Fallback: any non-screen audio kind
      return ks.includes('audio');
    } catch (e) {
      return false;
    }
  }

  function getAudioTrackPublicationsSafe(participant) {
    if (!participant) return [];

    // Newer SDKs expose audioTrackPublications as a Map
    try {
      const m = participant.audioTrackPublications;
      if (m && typeof m.values === 'function') {
        const pubs = Array.from(m.values()).filter(p => p && isAudioPublication(p));
        if (pubs.length) return pubs;
      }
    } catch (e) {}

    // Fallback: filter from all publications
    try {
      return getTrackPublicationsSafe(participant).filter(p => p && isAudioPublication(p));
    } catch (e) {
      return [];
    }
  }

  function getPubMutedSafe(pub){
  if (!pub) return null;

  // TrackPublication: isMuted (bool) or isMuted() (fn) depending on SDK version
  try {
    const v1 = pub.isMuted;
    if (typeof v1 === 'boolean') return v1;
    if (typeof v1 === 'function') {
      const r = v1.call(pub);
      if (typeof r === 'boolean') return r;
    }
  } catch (e) {}

  // Some SDKs use "muted"
  try {
    const v2 = pub.muted;
    if (typeof v2 === 'boolean') return v2;
    if (typeof v2 === 'function') {
      const r = v2.call(pub);
      if (typeof r === 'boolean') return r;
    }
  } catch (e) {}

  // Publication enabled flags (rare but exist in some wrappers)
  try {
    const en = (pub.isEnabled != null) ? pub.isEnabled : pub.enabled;
    if (typeof en === 'boolean') return !en;
    if (typeof en === 'function') {
      const r = en.call(pub);
      if (typeof r === 'boolean') return !r;
    }
  } catch (e) {}

  // Track: sometimes exposes enabled/muted state when subscribed
  try {
    const t = pub.track;
    if (t) {
      const a = t.isMuted;
      if (typeof a === 'boolean') return a;
      const b = t.muted;
      if (typeof b === 'boolean') return b;

      const en = t.isEnabled;
      if (typeof en === 'boolean') return !en;
      if (typeof en === 'function') {
        const r = en.call(t);
        if (typeof r === 'boolean') return !r;
      }

      // MediaStreamTrack.enabled is the strongest signal (when available)
      const mst = t.mediaStreamTrack || t._mediaStreamTrack;
      if (mst && typeof mst.enabled === 'boolean') return !mst.enabled;
    }
  } catch (e) {}

  return null;
}

  // Mic UI anti-flap cache
  // confidence: 2=hard (SDK mute flags), 1=soft (heuristic), 0=unknown
  const micStateCache = new Map(); // sid -> { muted: boolean|null, confidence: number, updatedAt: number }

  function applyMicUnknown(sid) {
    const now = Date.now();
    const prev = micStateCache.get(sid);
    // Don't overwrite a known state with "unknown"
    if (prev && prev.confidence >= 1) return;
    try { setMicUnknown(sid); } catch (e) {}
    micStateCache.set(sid, { muted: null, confidence: 0, updatedAt: now });
  }

  function applyMicState(sid, muted, confidence) {
    const now = Date.now();
    const nextMuted = (typeof muted === 'boolean') ? muted : null;
    const prev = micStateCache.get(sid);

    if (nextMuted === null) { applyMicUnknown(sid); return; }

    if (prev && prev.muted === nextMuted && prev.confidence >= confidence) {
      prev.updatedAt = now;
      return;
    }

    // Anti-flap: don't let a weaker signal flip a stronger, recent state.
    if (prev && prev.confidence > confidence && prev.muted !== nextMuted && (now - prev.updatedAt) < 1200) {
      return;
    }

    try { updateMicIndicator(sid, nextMuted); } catch (e) {}
    micStateCache.set(sid, { muted: nextMuted, confidence: confidence, updatedAt: now });
  }



function updateMicIndicatorFromParticipant(participant) {
  if (!participant) return;
  const sid = participant.sid;

  const isLocal = !!(currentRoom && currentRoom.localParticipant && sid === currentRoom.localParticipant.sid);

  // Local: reflect our own toggle state (most reliable)
  if (isLocal) {
    try { applyMicState(sid, ((!localHasAudio) || (!micEnabled)), 2); } catch (e) {}
    return;

  }
  const firstSeen = participantSeenAt.get(sid) || 0;
  const ageMs = firstSeen ? (Date.now() - firstSeen) : 999999;

  // 0) Peer-broadcasted mic state (authoritative when available)
  try {
    const b = micBroadcastBySid.get(sid);
    if (b && typeof b.enabled === 'boolean') {
      const ts = Number(b.ts || 0);
      if (!ts || (Date.now() - ts) < MIC_BROADCAST_TTL_MS) {
        applyMicState(sid, !b.enabled, 2);
        return; // <- QUAN TRỌNG: đừng cho heuristic override nữa
      }
    }
  } catch (e) {}

  // 0) If they're speaking / audio level > 0, it's definitely NOT muted.
  try {
    const al = participant.audioLevel;
    if (typeof al === 'number' && al > 0.02) {
      applyMicState(sid, false, 1);
      return;
    }
  } catch (e) {}
  try {
    const sp = participant.isSpeaking;
    if (sp === true) {
      applyMicState(sid, false, 1);
      return;
    }
  } catch (e) {}

  // 1) Explicit microphone enabled flag (if exposed by SDK)
  try {
    const v = participant.isMicrophoneEnabled;
    if (typeof v === 'boolean') {
      if (v === false) { applyMicState(sid, true, 2); return; }
      if (v === true && ageMs > 200) { applyMicState(sid, false, 1); return; }
    } else if (typeof v === 'function') {
      const r = v.call(participant);
      if (typeof r === 'boolean') {
        if (r === false) { applyMicState(sid, true, 2); return; }
        if (r === true && ageMs > 200) { applyMicState(sid, false, 1); return; }
      }
    }
  } catch (e) {}

  // 2) Publications-based (works even when not subscribed to audio)
  const pubs = getAudioTrackPublicationsSafe(participant) || [];
  if (pubs.length) {
    const states = pubs.map(getPubMutedSafe).filter(v => typeof v === 'boolean');
    if (states.some(v => v === false)) { applyMicState(sid, false, 2); return; }
    if (states.length && states.every(v => v === true)) { applyMicState(sid, true, 2);  return; }

    // We have pubs but can't read mute flags yet (happens on some mobile timings).
    // After a short grace, assume muted (safe default) unless later events prove otherwise.
    if (ageMs >= 1200) { applyMicState(sid, true, 1); return; }

    applyMicUnknown(sid);
    return;
  }

  // 3) No audio pubs: often means remote turned mic off (unpublished).
  if (ageMs >= 800) { applyMicState(sid, true, 1); return; }

  applyMicUnknown(sid);
}


const audioBound = new WeakSet();
  function bindAudioIndicator(participant) {
    if (!participant || audioBound.has(participant)) return;
    audioBound.add(participant);

    // apply current state
    try { updateMicIndicatorFromParticipant(participant); } catch (e) {}

    // listen changes
    try {
      participant.on('trackMuted', (pub) => {
        if (pub && isAudioPublication(pub)) updateMicIndicatorFromParticipant(participant);
      });
      participant.on('trackUnmuted', (pub) => {
        if (pub && isAudioPublication(pub)) updateMicIndicatorFromParticipant(participant);
      });
      participant.on('trackPublished', (pub) => {
        if (pub && isAudioPublication(pub)) updateMicIndicatorFromParticipant(participant);
      });
      participant.on('trackUnpublished', (pub) => {
        if (pub && isAudioPublication(pub)) updateMicIndicatorFromParticipant(participant);
      });
    } catch (e) {}
  }

function updateVideoTilesLayout() {
  if (!videosEl) return;

  const isMobile = (() => {
    try { return !!(window.matchMedia && window.matchMedia('(max-width: 640px)').matches); } catch (e) {}
    try { return (window.innerWidth || 9999) <= 640; } catch (e) {}
    return false;
  })();

  const hasScreen = !!(screenPaneEl && !screenPaneEl.classList.contains('is-hidden'));
  const n = (participantTiles && typeof participantTiles.size === 'number')
    ? participantTiles.size
    : (videosEl.children ? videosEl.children.length : 0);

  videosEl.classList.remove(
    'is-gallery', 'gallery-1', 'gallery-2', 'gallery-4',
    'mobile-1', 'mobile-2', 'mobile-3plus'
  );

  // Mobile: requested layout (independent of screen share)
  if (isMobile) {
    if (n <= 1) videosEl.classList.add('mobile-1');
    else if (n === 2) videosEl.classList.add('mobile-2');
    else videosEl.classList.add('mobile-3plus');
    return;
  }

  // Desktop/tablet: auto gallery only when there is NO active screen share.
  if (hasScreen) return;

  if (n === 1) {
    videosEl.classList.add('is-gallery', 'gallery-1');
  } else if (n === 2) {
    videosEl.classList.add('is-gallery', 'gallery-2');
  } else if (n === 3 || n === 4) {
    videosEl.classList.add('is-gallery', 'gallery-4');
  }
  // 5+ => keep default tile sizing
}

// keep layout correct on rotate / resize
window.addEventListener('resize', () => {
  try { updateVideoTilesLayout(); } catch (e) {}
}, { passive: true });
function setStageScreenVisible(visible) {
    if (!screenPaneEl || !splitterEl) return;

    if (visible) {
      screenPaneEl.classList.remove('is-hidden');
      splitterEl.classList.remove('is-hidden');

      // ✅ First time screen-share pane becomes visible in this "share session":
      // default to "users list = min" (screen pane = max),
      // BUT if user has ever dragged splitter (saved basis exists) then keep that.
      try {
        const alreadyInit = screenPaneEl.dataset.ssInitDone === '1';
        if (!alreadyInit) {
          let savedBasis = 0;
          try { savedBasis = Number(localStorage.getItem('screenPaneBasisPx') || '') || 0; } catch (e) {}

          if (stageEl && screenPaneEl) {
            const rect = stageEl.getBoundingClientRect();
            const dir  = getComputedStyle(stageEl).flexDirection;

            if (dir === 'column') {
              // vertical split (mobile)
              let savedY = 0;
              try { savedY = Number(localStorage.getItem('screenPaneBasisPxY') || '') || 0; } catch (e) {}

              const min = 220;
              const max = Math.max(min, rect.height - 220);

              // If user dragged before, restore; otherwise default to "screen max"
              const h = savedY ? clamp(savedY, min, max) : clamp(max, min, max);
              screenPaneEl.style.flexBasis = `${h}px`;
            } else {
              const minScreen = getScreenMinPx();
              const minUsers  = getUsersMinPx();
              const splitW = splitterEl ? (splitterEl.getBoundingClientRect().width || 8) : 8;
              const chatW  = (chatPaneEl && !chatPaneEl.classList.contains('is-hidden')) ? getChatWidthPx() : 0;
              const max = Math.max(minScreen, rect.width - minUsers - chatW - splitW);

              // If user dragged before, restore; otherwise default to max (users min)
              const w = savedBasis ? clamp(savedBasis, minScreen, max) : clamp(max, minScreen, max);
              screenPaneEl.style.flexBasis = `${w}px`;
            }
          }

          // Don't persist here: only persist on actual splitter drag.
          screenPaneEl.dataset.ssInitDone = '1';
        }
      } catch (e) {}

      try { updateVideoTilesLayout(); } catch (e) {}

      // zoom buttons only make sense when we have a screen
      if (zoomInBtn)  zoomInBtn.classList.remove('is-hidden');
      if (zoomOutBtn) zoomOutBtn.classList.remove('is-hidden');

      return;
    }

    // No active screen share: hide the entire screen-share pane (and splitter)
    screenPaneEl.classList.add('is-hidden');
    splitterEl.classList.add('is-hidden');

    // reset "first show" flag for next time
    try { delete screenPaneEl.dataset.ssInitDone; } catch (e) {}

    try { updateVideoTilesLayout(); } catch (e) {}

    // hide zoom buttons
    if (zoomInBtn)  zoomInBtn.classList.add('is-hidden');
    if (zoomOutBtn) zoomOutBtn.classList.add('is-hidden');

    // clear screen tile + reset zoom/pan
    try {
      const media = screenTileEl.querySelector('.media');
      if (media) media.innerHTML = '';
    } catch (e) {}
    activeScreenSid = null;
    lastRenderedScreenSid = null;
    screenZoom = 1;
    panX = 0; panY = 0;
    updateZoomButtons();
    updatePannableUI();
    try { screenTileEl.classList.remove('is-speaking'); } catch (e) {}

    // keep placeholder ready for next share (not visible while pane is hidden)
    try{
      if (screenSlotEl) {
        if (!screenSlotEl.contains(screenPlaceholderEl)) {
          screenSlotEl.innerHTML = '';
          screenSlotEl.appendChild(screenPlaceholderEl);
        }
      }
    }catch(e){}
  }

  function pickNewestScreenSid() {
    let last = null;
    for (const sid of screenShares.keys()) last = sid;
    return last;
  }

  function renderActiveScreen() {
    const hasScreen = screenShares.size > 0;
    setStageScreenVisible(hasScreen);

    if (!hasScreen) return;

    // chọn active nếu chưa có hoặc bị mất
    if (!activeScreenSid || !screenShares.has(activeScreenSid)) {
      activeScreenSid = pickNewestScreenSid();
    }
    const item = activeScreenSid ? screenShares.get(activeScreenSid) : null;
    if (activeScreenSid !== lastRenderedScreenSid) {
      screenZoom = 1;
      panX = 0; panY = 0;
      lastRenderedScreenSid = activeScreenSid;
      updateZoomButtons();
      updatePannableUI();
    }
    if (!item) return;

    // attach vào screen tile
    const nameTag = screenTileEl.querySelector('.name-tag');
    const media   = screenTileEl.querySelector('.media');
    if (nameTag) nameTag.textContent = `${item.name} (Screen)`;
    if (media) {
      media.innerHTML = '';
      
      media.appendChild(item.el);
      applyZoomToActiveScreen();

      // speaking highlight for current screen sharer
      try {
        const p = (currentRoom && currentRoom.localParticipant && currentRoom.localParticipant.sid === activeScreenSid)
          ? currentRoom.localParticipant
          : (currentRoom && currentRoom.participants && currentRoom.participants.get(activeScreenSid));
        screenTileEl.classList.toggle('is-speaking', !!(p && p.isSpeaking));
      } catch (e) {}
    }

    // đảm bảo tile nằm trong slot
    if (screenSlotEl && !screenSlotEl.contains(screenTileEl)) {
      screenSlotEl.innerHTML = '';
      screenSlotEl.appendChild(screenTileEl);
    }
  }


  // Keep bandwidth low: subscribe only the active screen-share track (best-effort).
  // NOTE: This does NOT force-quit remote sharing on server; it only stops receiving old screen tracks quickly.
  // The actual "single active sharer" is enforced cooperatively via data channel claim messages.
  function setOnlyActiveScreenSubscribed() {
    if (!currentRoom) return;
    try {
      screenShares.forEach((item, sid) => {
        const pub = item && item.publication;
        if (!pub || typeof pub.setSubscribed !== 'function') return;
        const shouldSub = (sid === activeScreenSid);
        try { pub.setSubscribed(!!shouldSub); } catch (e) {}
      });
    } catch (e) {}
  }



  

function ensureParticipantTile(sid, name) {
    if (!videosEl) return null;

    let tile = participantTiles.get(sid);
    if (tile) {
      const tag = tile.querySelector('.name-tag');
      if (tag) tag.textContent = name;
      participantNames.set(sid, name);
      if (!participantSeenAt.has(sid)) participantSeenAt.set(sid, Date.now());
      return tile;
    }

    tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.sid = sid;
    tile.innerHTML = `
      <div class="name-tag"></div>
      <div class="media">${getCameraPlaceholderHtml()}</div>
      <div class="mic-badge is-unknown" title="Microphone">
        <span class="material-symbols-outlined mic-icon">mic</span>
      </div>
    `;

    const tag = tile.querySelector('.name-tag');
    if (tag) tag.textContent = name;

    participantTiles.set(sid, tile);
    participantNames.set(sid, name);
    if (!participantSeenAt.has(sid)) participantSeenAt.set(sid, Date.now());

    videosEl.appendChild(tile);
    try { updateVideoTilesLayout(); } catch (e) {}
    try { updateTopbarCount(); } catch (e) {}
    // default: unknown mic state (avoid falsely showing red-muted on mobile)
    try { setMicUnknown(sid); } catch (e) {}
    return tile;
  }

  function attachCameraVideoToTile(sid, name, videoEl, isLocal) {
    const tile = ensureParticipantTile(sid, name);
    if (!tile) return;

    const media = tile.querySelector('.media');
    if (!media) return;

    // chỉ giữ 1 camera video
    media.innerHTML = '';

    // dataset để apply speaker mute/cleanup
    videoEl.dataset.participant = sid;
    videoEl.dataset.source = 'camera';

    // mirror cho local cam trước
    if (isLocal && cameraFacingMode === 'user') {
      videoEl.classList.add('mirror-video');
    } else {
      videoEl.classList.remove('mirror-video');
    }

    // Auto adjust portrait/landscape for camera tile
    const applyOrientation = () => {
      const w = Number(videoEl.videoWidth || 0);
      const h = Number(videoEl.videoHeight || 0);
      if (!w || !h) return;

      // portrait (mobile) => contain to avoid cropping
      tile.classList.toggle('is-portrait', h > w);
    };

    // Some browsers only know dimensions after metadata is loaded
    try { videoEl.addEventListener('loadedmetadata', applyOrientation); } catch (e) {}
    // When track dimensions change (rotation, device switch)
    try { videoEl.addEventListener('resize', applyOrientation); } catch (e) {}
    // Best-effort fallback
    setTimeout(applyOrientation, 200);

    media.appendChild(videoEl);
    applyOrientation();
  }

  function removeCameraFromTile(sid) {
    const tile = participantTiles.get(sid);
    if (!tile) return;
    const media = tile.querySelector('.media');
    if (!media) return;
    media.innerHTML = getCameraPlaceholderHtml();
    tile.classList.remove('is-portrait');
  }

  function removeParticipantTile(sid) {
    const tile = participantTiles.get(sid);
    if (tile) {
      try { tile.remove(); } catch (e) {}
    }
    participantTiles.delete(sid);
    participantNames.delete(sid);

    try { updateVideoTilesLayout(); } catch (e) {}
    try { updateTopbarCount(); } catch (e) {}
}

  // ---- Speaking indicator (active speaker border) ----
  const speakingBound = new WeakSet();

  function bindSpeakingIndicator(participant) {
    if (!participant || speakingBound.has(participant)) return;
    speakingBound.add(participant);

    // apply current state (best-effort)
    try {
      const tile = participantTiles.get(participant.sid);
      if (tile) tile.classList.toggle('is-speaking', !!participant.isSpeaking);
    } catch (e) {}

    participant.on('isSpeakingChanged', (speaking) => {
      const tile = participantTiles.get(participant.sid);
      if (tile) tile.classList.toggle('is-speaking', !!speaking);

      // if this participant is currently the active screen sharer, also highlight screen tile
      if (participant.sid === activeScreenSid) {
        screenTileEl.classList.toggle('is-speaking', !!speaking);
      }
    });
  }

  function updateSpeakingFromActiveSpeakers(speakers) {
    const set = new Set((speakers || []).map(p => p.sid));

    // ensure tiles exist and speaking listener is bound
    (speakers || []).forEach(p => {
      try {
        const name = getDisplayName(p);
        ensureParticipantTile(p.sid, name);
        bindSpeakingIndicator(p);
      } catch (e) {}
    });

    participantTiles.forEach((tile, sid) => {
      tile.classList.toggle('is-speaking', set.has(sid));
    });

    if (activeScreenSid) {
      screenTileEl.classList.toggle('is-speaking', set.has(activeScreenSid));
    } else {
      screenTileEl.classList.remove('is-speaking');
    }
  }

  function cleanupParticipantMediaElements(sid) {
    // gỡ tất cả el đã attach có data-participant
    document.querySelectorAll(`[data-participant="${sid}"]`).forEach(el => {
      try { el.remove(); } catch (e) {}
    });
  }

  function applySpeakerMuteToCallMedia() {
    // Mute/unmute tất cả media của participants trong cuộc gọi
    const mediaEls = document.querySelectorAll('audio[data-participant], video[data-participant]');
    mediaEls.forEach(el => {
      el.muted = !speakerEnabled; // speakerEnabled=false => muted=true
    });
  }

  function updateMicUI() {
    if (!toggleMicBtn) return;
    if (toggleMicIcon) toggleMicIcon.textContent = micEnabled ? 'mic' : 'mic_off';
    toggleMicBtn.title = micEnabled ? 'Mute microphone' : 'Unmute microphone';
    if (micEnabled) toggleMicBtn.classList.remove('is-muted');
    else toggleMicBtn.classList.add('is-muted');

    // also update local tile mic indicator
    try {
      if (currentRoom && currentRoom.localParticipant) {
        updateMicIndicator(currentRoom.localParticipant.sid, (!localHasAudio) || (!micEnabled));
      }
    } catch (e) {}
  }

  function updateCameraUI() {
    if (!toggleCameraBtn) return;
    if (toggleCameraIcon) toggleCameraIcon.textContent = cameraEnabled ? 'videocam' : 'videocam_off';
    toggleCameraBtn.title = cameraEnabled ? 'Turn camera off' : 'Turn camera on';
  }

  function updateScreenUI() {
    if (!toggleScreenBtn) return;
    if (toggleScreenIcon) toggleScreenIcon.textContent = screenShareEnabled ? 'stop_screen_share' : 'screen_share';
    toggleScreenBtn.title = screenShareEnabled ? 'Stop sharing' : 'Share screen';
  }

  async function disableLocalCamera() {
    if (!currentRoom) return;
    if (!cameraEnabled) return;

    try {
      if (localVideoTrack) {
        try { currentRoom.localParticipant.unpublishTrack(localVideoTrack); } catch (e) {}
        try { localVideoTrack.stop(); } catch (e) {}
      }
      if (localVideoElement) {
        try { localVideoElement.remove(); } catch (e) {}
      }

      removeCameraFromTile(currentRoom.localParticipant.sid);

      localVideoTrack = null;
      localVideoElement = null;

      cameraEnabled = false;
      updateCameraUI();
    } catch (e) {
      console.error("Disable camera error:", e);
    }
  }

  async function enableLocalCamera() {
    if (!currentRoom) return;
    if (cameraEnabled) return;

    try {
      // tạo track mới (tôn trọng facingMode hiện tại)
      const track = await LivekitClient.createLocalVideoTrack({ facingMode: cameraFacingMode });
      await currentRoom.localParticipant.publishTrack(track);

      const el = track.attach();
      el.dataset.participant = currentRoom.localParticipant.sid;
      el.dataset.source = 'camera';

      localVideoTrack = track;
      localVideoElement = el;

      const name = CHAT_USERNAME || currentRoom.localParticipant.identity || 'You';
      attachCameraVideoToTile(currentRoom.localParticipant.sid, name, el, true);

      cameraEnabled = true;
      updateCameraUI();
      applySpeakerMuteToCallMedia();
    } catch (e) {
      console.error("Enable camera error:", e);
    }
  }

  async function toggleLocalCamera() {
    if (!currentRoom) return;
    if (cameraEnabled) await disableLocalCamera();
    else await enableLocalCamera();
  }

  async function stopScreenShareInternal() {
    const hadLocalShareIntent = !!myScreenShareStartedAt;
    startingScreenShare = false;
    myScreenShareStartedAt = null;

    // unpublish + stop tracks
    if (currentRoom && currentRoom.localParticipant && localScreenTracks.length) {
      for (const t of localScreenTracks) {
        try { currentRoom.localParticipant.unpublishTrack(t); } catch (e) {}
        try { if (typeof t.stop === 'function') t.stop(); } catch (e) {}
      }
    }
    localScreenTracks = [];

    // remove UI element + map
    if (currentRoom && currentRoom.localParticipant) {
      const sid = currentRoom.localParticipant.sid;
      const item = screenShares.get(sid);
      if (item && item.el) {
        try { item.el.remove(); } catch (e) {}
      }
      screenShares.delete(sid);

      if (activeScreenSid === sid) {
        activeScreenSid = null;
      lastRenderedScreenSid = null;
      screenZoom = 1;
      panX = 0; panY = 0;
      updateZoomButtons();
      updatePannableUI();
      }
    }

    screenShareEnabled = false;
    updateScreenUI();
    renderActiveScreen();

    // thông báo nhả quyền share (best-effort)
    try { if (hadLocalShareIntent) await broadcastScreenShareRelease(); } catch (e) {}

    // restore camera nếu trước đó camera đang bật
    try {
      if (toggleCameraBtn) toggleCameraBtn.disabled = false;

      if (cameraDisabledByScreenShare && cameraPrevEnabledBeforeScreen) {
        await enableLocalCamera();
      }
    } catch (e) {}

    cameraDisabledByScreenShare = false;
    cameraPrevEnabledBeforeScreen = null;
  }

  // --- Resizer (splitter)
  function initSplitter() {
    if (!splitterEl || !stageEl || !screenPaneEl) return;

    let dragging = false;
    let axis = 'x';

    let lastBasisX = null;
    let lastBasisY = null;

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    splitterEl.addEventListener('pointerdown', (e) => {
      if (splitterEl.classList.contains('is-hidden')) return;
      dragging = true;
      splitterEl.setPointerCapture(e.pointerId);

      const dir = getComputedStyle(stageEl).flexDirection;
      axis = (dir === 'column') ? 'y' : 'x';

      e.preventDefault();
    });

    splitterEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = stageEl.getBoundingClientRect();

      if (axis === 'x') {
        const x = e.clientX - rect.left;
        const minScreen = getScreenMinPx();
        const minUsers  = getUsersMinPx();
        const splitW = splitterEl.getBoundingClientRect().width || 8;
        const chatW  = (chatPaneEl && !chatPaneEl.classList.contains('is-hidden')) ? getChatWidthPx() : 0;
        const max = Math.max(minScreen, rect.width - minUsers - chatW - splitW);
        const w = clamp(x, minScreen, max);
        screenPaneEl.style.flexBasis = `${w}px`;
        lastBasisX = w;
      } else {
        const y = e.clientY - rect.top;
        const min = 220;
        const max = rect.height - 220;
        const h = clamp(y, min, max);
        screenPaneEl.style.flexBasis = `${h}px`;
        lastBasisY = h;
      }
    });

    const endDrag = () => {
      dragging = false;
      try {
        if (axis === 'x' && lastBasisX != null) {
          localStorage.setItem('screenPaneBasisPx', String(lastBasisX));
        } else if (axis === 'y' && lastBasisY != null) {
          localStorage.setItem('screenPaneBasisPxY', String(lastBasisY));
        }
      } catch (e) {}
      lastBasisX = null;
      lastBasisY = null;
    };
    splitterEl.addEventListener('pointerup', endDrag);
    splitterEl.addEventListener('pointercancel', endDrag);

    // restore basis (from previous drag) and clamp to current viewport to avoid overflow
    function clampSavedBasisToViewport() {
      try {
        const rect = stageEl.getBoundingClientRect();
        const dir = getComputedStyle(stageEl).flexDirection;

        if (dir === 'column') {
          const raw = Number((screenPaneEl.style.flexBasis || '').replace('px','')) ||
                      Number(localStorage.getItem('screenPaneBasisPxY') || '');
          if (!raw) return;

          const min = 220;
          const max = Math.max(min, rect.height - 220);
          const h = clamp(raw, min, max);
          screenPaneEl.style.flexBasis = `${h}px`;
        } else {
          const raw = Number((screenPaneEl.style.flexBasis || '').replace('px','')) ||
                      Number(localStorage.getItem('screenPaneBasisPx') || '');
          if (!raw) return;

          const minScreen = getScreenMinPx();
          const minUsers  = getUsersMinPx();
          const splitW = splitterEl.getBoundingClientRect().width || 8;
          const chatW  = (chatPaneEl && !chatPaneEl.classList.contains('is-hidden')) ? getChatWidthPx() : 0;
          const max = Math.max(minScreen, rect.width - minUsers - chatW - splitW);
          const w = clamp(raw, minScreen, max);
          screenPaneEl.style.flexBasis = `${w}px`;
        }
      } catch (e) {}
    }

    // initial restore
    try {
      const dir = getComputedStyle(stageEl).flexDirection;
      if (dir === 'column') {
        const h = Number(localStorage.getItem('screenPaneBasisPxY') || '');
        if (h) screenPaneEl.style.flexBasis = `${h}px`;
      } else {
        const w = Number(localStorage.getItem('screenPaneBasisPx') || '');
        if (w) screenPaneEl.style.flexBasis = `${w}px`;
      }
    } catch (e) {}

    clampSavedBasisToViewport();
    window.addEventListener('resize', () => {
      syncTopbarHeightVar();
      __usersOneColMinPx = computeUsersOneColMinPx();
      clampSavedBasisToViewport();
    });
  }
  initSplitter();

  // -------- Login
  document.getElementById("loginBtn").onclick = async () => {
    try {
      const username = document.getElementById("username").value;
      const password = document.getElementById("password").value;

      const res = await fetch(LOGIN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();
      if (data.signal_jwt) {
        SIGNAL_JWT = data.signal_jwt;
        CHAT_USERNAME = username || 'User';

        document.getElementById("createRoomBtn").disabled = false;
        document.getElementById("joinBtn").disabled = false;
        alert("Login success! You can now create or join a room.");
      } else {
        alert("Login failed: " + JSON.stringify(data));
      }
    } catch (err) {
      console.error("Login error:", err);
    }
  };

  // Copy Room ID buttons (Created + Join)
function bindCopyIconButton(btn, getText){
  if (!btn) return;

  btn.addEventListener('click', async () => {
    // Guard: ignore double click while đang ở trạng thái "check"
    if (btn.dataset.copyLocked === '1') return;

    const value = (typeof getText === 'function' ? getText() : '') || '';
    const text  = String(value).trim();
    if (!text) return;

    btn.dataset.copyLocked = '1';

    const icon = btn.querySelector('.material-symbols-outlined') || btn.querySelector('span');
    const prevTitle = btn.title || 'Copy room ID';

    try {
      await navigator.clipboard.writeText(text);
      if (icon) icon.textContent = 'check';
      btn.title = 'Copied';
    } catch (err) {
      console.log('Clipboard error:', err);
      btn.dataset.copyLocked = '0';
      return;
    }

    setTimeout(() => {
      if (icon) icon.textContent = 'content_copy';
      btn.title = prevTitle;
      btn.dataset.copyLocked = '0';
    }, 3000);
  });
}

function getRoomIdForCopy(){
  // Prefer actual connected room name (nếu đang trong call)
  try {
    const roomName = currentRoom?.name ? String(currentRoom.name).trim() : '';
    if (roomName) return roomName;
  } catch (e) {}

  const created = document.getElementById('createdRoomId')?.innerText?.trim() || '';
  const input   = document.getElementById('roomId')?.value?.trim() || '';
  return created || input || '';
}

bindCopyIconButton(document.getElementById('copyRoom'), () => document.getElementById('createdRoomId')?.innerText);
bindCopyIconButton(document.getElementById('copyRoomJoin'), getRoomIdForCopy);


  // Send on Enter
  document.getElementById('chatInput').addEventListener('keydown', function(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      document.getElementById('sendChatBtn').click();
    }
  });

  // Tạo phòng
  document.getElementById("createRoomBtn").onclick = async () => {
    try {
      const res = await fetch(CREATE_ROOM_URL, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + SIGNAL_JWT,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ title: "Test Room" })
      });
      const data = await res.json();

      if (data.room_id) {
        const createRoomId = document.getElementById("createdRoomId");

        createRoomId.style.display = 'block';
        createRoomId.innerText = data.room_id;
        document.getElementById("roomId").value = data.room_id;
      } else {
        alert("Create room failed: " + JSON.stringify(data));
      }
    } catch (err) {
      console.error("Create room error:", err);
    }
  };

  // Reset toàn bộ UI call
  function resetCallUI() {
    // tiles + screen slot
    if (videosEl) videosEl.innerHTML = '';
    if (screenSlotEl) screenSlotEl.innerHTML = '';
    participantTiles.clear();
    participantNames.clear();
    screenShares.clear();
    participantSeenAt.clear();
    try { stopParticipantPruneLoop(); } catch (e) {}
    try { micStateCache && micStateCache.clear && micStateCache.clear(); } catch (e) {}
    activeScreenSid = null;
    setStageScreenVisible(false);
    try { screenTileEl.classList.remove('is-speaking'); } catch (e) {}

    // disable End Call
    const endBtn = document.getElementById('endBtn');
    if (endBtn) endBtn.disabled = true;

    // chat
    resetChatBox();
    const sendBtn = document.getElementById('sendChatBtn');
    if (sendBtn) sendBtn.disabled = true;

    // buttons
    if (toggleCameraBtn) toggleCameraBtn.disabled = true;
    if (switchCameraBtn) switchCameraBtn.disabled = true;
    if (toggleMicBtn) toggleMicBtn.disabled = true;
    if (toggleSpeakerBtn) toggleSpeakerBtn.disabled = true;
    if (toggleScreenBtn) toggleScreenBtn.disabled = true;

    // state
    cameraEnabled = true;
    micEnabled = true;
    speakerEnabled = true;
    screenShareEnabled = false;
    cameraFacingMode = 'user';

    localVideoTrack = null;
    localVideoElement = null;

    localScreenTracks = [];
    cameraPrevEnabledBeforeScreen = null;
    cameraDisabledByScreenShare = false;

    updateCameraUI();
    updateMicUI();
    if (toggleSpeakerIcon) toggleSpeakerIcon.textContent = 'volume_up';
    if (toggleSpeakerBtn) toggleSpeakerBtn.title = 'Mute call audio';
    updateScreenUI();

    // Topbar
    try { setTopbarStatus(false, ''); updateTopbarCount(); } catch (e) {}
  }

  // ---- Join room
  document.getElementById("joinBtn").onclick = async () => {
    try {
      const roomId = document.getElementById("roomId").value.trim();
      if (!roomId) { alert("Please enter a room ID first!"); return; }

      // token
      const res = await fetch(PORTAL_URL, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + SIGNAL_JWT,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          room: roomId,
          device_id: DEVICE_ID,
          session_id: SESSION_ID
        })
      });

      let data = null;
      try { data = await res.json(); } catch (e) {}

      if (!res.ok || !data || !data.livekit_url || !data.livekit_jwt) {
        let msg = "Không thể lấy token kết nối.";
        if (data && (data.message || data.error || data.detail)) msg = data.message || data.error || data.detail;
        alert("Join room failed: " + msg);
        resetCallUI();
        return;
      }

      // server trả về data.is_host
      if (typeof data.is_host === 'boolean') {
        isHost = data.is_host;
      }

      // create room
      const room = new LivekitClient.Room();
      currentRoom = room;

      // room disconnected
      room.on('disconnected', (reason) => {
        console.log('[Room disconnected]', reason);
        currentRoom = null;
        resetCallUI();

        if (reason === LivekitClient.DisconnectReason?.ROOM_DELETED) {
          alert("Host ended the room.");
        } else if (reason === LivekitClient.DisconnectReason?.DUPLICATE_IDENTITY) {
          alert("You were disconnected because your identity is used elsewhere.");
        } else if (reason === LivekitClient.DisconnectReason?.JOIN_FAILURE) {
          alert("Cannot join this room. Please try again.");
        } else if (reason === LivekitClient.DisconnectReason?.ROOM_DELETED) {
          alert("Host ended the room.");
        }
      });

      room.on('participantConnected', (participant) => {
        const name = getDisplayName(participant);
        ensureParticipantTile(participant.sid, name);
        try { bindSpeakingIndicator(participant); } catch (e) {}
        try { bindAudioIndicator(participant); } catch (e) {}
        try { updateMicIndicatorFromParticipant(participant); } catch (e) {}
        try { updateTopbarCount(); } catch (e) {}
        // When a new participant joins, broadcast our mic state a few times (peer broadcast)
        try { scheduleMicStateBurst('peer_join'); } catch (e) {}
      });

room.on('participantDisconnected', (participant) => {
        try {
        } catch (e) {}

        // remove tile + cleanup
        removeParticipantTile(participant.sid);

        // remove any screen share
        const item = screenShares.get(participant.sid);
        if (item && item.el) { try { item.el.remove(); } catch (e) {} }
        screenShares.delete(participant.sid);
        if (activeScreenSid === participant.sid) activeScreenSid = null;
        renderActiveScreen();

        cleanupParticipantMediaElements(participant.sid);
        try { updateTopbarCount(); } catch (e) {}
      });


      // --- Mic status indicator updates (best-effort across SDK versions)
      try {
        room.on('trackMuted', (...args) => {
          const publication = args[0];
          const participant = args[1] || args.find(a => a && a.sid);
          if (publication && isAudioPublication(publication)) {
            try { bindAudioIndicator(participant); } catch (e) {}
            try { updateMicIndicatorFromParticipant(participant); } catch (e) {}
          }
        });
        room.on('trackUnmuted', (...args) => {
          const publication = args[0];
          const participant = args[1] || args.find(a => a && a.sid);
          if (publication && isAudioPublication(publication)) {
            try { bindAudioIndicator(participant); } catch (e) {}
            try { updateMicIndicatorFromParticipant(participant); } catch (e) {}
          }
        });
        room.on('trackPublished', (...args) => {
          const publication = args[0];
          const participant = args[1] || args.find(a => a && a.sid);
          if (publication && isAudioPublication(publication)) {
            try { bindAudioIndicator(participant); } catch (e) {}
            try { updateMicIndicatorFromParticipant(participant); } catch (e) {}
          }
        });
        room.on('trackUnpublished', (...args) => {
          const publication = args[0];
          const participant = args[1] || args.find(a => a && a.sid);
          if (publication && isAudioPublication(publication)) {
            try { bindAudioIndicator(participant); } catch (e) {}
            try { updateMicIndicatorFromParticipant(participant); } catch (e) {}
          }
        });
      } catch (e) {}

      function isScreenPublication(pub) {
        try {
          const s = (pub && pub.source != null) ? String(pub.source).toLowerCase() : '';
          // livekit thường dùng: screen_share, screenshare, screenShare...
          return s.includes('screen');
        } catch (e) {
          return false;
        }
      }

      room.on('trackSubscribed', (track, publication, participant) => {
        const name = getDisplayName(participant);
        try { bindSpeakingIndicator(participant); } catch (e) {}

        if (track.kind === 'video') {
          const el = track.attach();
          el.dataset.participant = participant.sid;

          if (isScreenPublication(publication)) {
            el.dataset.source = 'screen';
            // IMPORTANT: user join sau đôi khi không có participantConnected + vòng lặp participants chạy quá sớm.
            // Do đó, khi nhận screen-share track cũng phải đảm bảo tile participant tồn tại,
            // để hiển thị "Camera off" (placeholder) nếu user đó đang không publish camera.
            ensureParticipantTile(participant.sid, name);
            // lưu và render vào pane trái
            screenShares.set(participant.sid, { track, el, name, publication });
            activeScreenSid = participant.sid; // ưu tiên cái mới nhất

            // giảm băng thông: chỉ subscribe active screen
            setOnlyActiveScreenSubscribed();

            renderActiveScreen();
          } else {
            el.dataset.source = 'camera';
            attachCameraVideoToTile(participant.sid, name, el, false);
          }
        } else if (track.kind === 'audio') {
          const el = track.attach();
          el.dataset.participant = participant.sid;
          el.style.display = 'none';
          document.body.appendChild(el);

          // nếu loa đang tắt thì audio mới cũng phải tắt theo
          el.muted = !speakerEnabled;

          // update mic indicator state
          try { updateMicIndicatorFromParticipant(participant); } catch (e) {}
        }
      });

      room.on('trackUnsubscribed', (track, publication, participant) => {
        if (!participant) return;

        if (track.kind === 'video') {
          // detach() trả về list elements
          try {
            const els = track.detach();
            (els || []).forEach(e => { try { e.remove(); } catch (err) {} });
          } catch (e) {}

          if (isScreenPublication(publication)) {
            // remove map
            screenShares.delete(participant.sid);
            if (activeScreenSid === participant.sid) activeScreenSid = null;
            renderActiveScreen();
          } else {
            // remove camera from tile (giữ tile + name)
            removeCameraFromTile(participant.sid);
          }
        } else if (track.kind === 'audio') {
          try {
            const els = track.detach();
            (els || []).forEach(e => { try { e.remove(); } catch (err) {} });
          } catch (e) {}
          try { updateMicIndicatorFromParticipant(participant); } catch (e) {}
        }
      });

      // chat + control data
      room.on('dataReceived', async (payload, participant) => {
        try {
          const text = textDecoder.decode(payload);
          const msgObj = safeParseJson(text);

          

          // --- Peer hello (new joiners) => existing peers broadcast mic state (by unique id, not name)
          if (msgObj.type === 'peer_hello') {
            try { await waitLocalMediaReady(1500); } catch (e) {}
            scheduleMicStateBurst('peer_hello');
            return;
          }
          // --- Mic state sync (peer broadcast)
          if (msgObj && msgObj.type === 'mic_state_req') {
            const fromSid = String(msgObj.from_sid || msgObj.from || (participant && participant.sid) || '').trim();
            try { if (fromSid && currentRoom?.localParticipant && fromSid === currentRoom.localParticipant.sid) return; } catch (e) {}

            // ĐỢI local media sẵn (bounded wait) để enabled không bị false “ảo”
            try { await waitLocalMediaReady(1500); } catch (e) {}

            try { await broadcastMicStateNow({ cause: 'mic_state_req_reply' }); } catch (e) {}
            try { scheduleMicStateBurst('mic_state_req'); } catch (e) {}
            return;
          }

          if (msgObj && msgObj.type === 'mic_state') {
            // sid MUST come from participant if possible (đúng nguồn nhất)
            const senderSid = String((participant && participant.sid) || msgObj.sid || '').trim();
            if (!senderSid) return;

            // Nếu bạn có shadow logic, né luôn shadowed sid để khỏi resurrect tile sai

            // Parse enabled thật chặt (tránh string/undefined gây sai)
            let enabledVal = null;
            if (typeof msgObj.enabled === 'boolean') enabledVal = msgObj.enabled;
            else if (msgObj.enabled === 0 || msgObj.enabled === 1) enabledVal = !!msgObj.enabled;
            if (enabledVal === null) return;

            const ts = Number(msgObj.ts || Date.now());

            // (A) SID cache: authoritative
            const prevSid = micBroadcastBySid.get(senderSid);
            if (!prevSid || ts >= Number(prevSid.ts || 0)) {
              micBroadcastBySid.set(senderSid, { enabled: enabledVal, ts });
            }

            // (B) Optional: vẫn có thể lưu mapping sid -> key để debug, nhưng KHÔNG dùng key để quyết định state
            try {
              const k = String(msgObj.key || msgObj.id || '').trim();
            } catch (e) {}

            // Update UI ngay (mute = !enabled)
            applyMicState(senderSid, !enabledVal, 2);
            return;
          }

          // --- Control: single active screen sharer
          if (msgObj && msgObj.type === 'screen_share_claim') {
            // If someone else starts sharing, the previous sharer should stop (cooperative).
            const fromSid = (participant && participant.sid) || msgObj.sid;
            if (currentRoom && fromSid && fromSid !== currentRoom.localParticipant.sid) {
              const otherTs = Number(msgObj.ts || 0);
              const myTs = Number(myScreenShareStartedAt || 0);
              const iAmSharingOrStarting = !!(screenShareEnabled || startingScreenShare);

              if (iAmSharingOrStarting) {
                // Rule: newer claim wins. If equal timestamp, tie-breaker by sid.
                const shouldYield =
                  (!myTs) ||
                  (otherTs > myTs) ||
                  (otherTs === myTs && String(fromSid) > String(currentRoom.localParticipant.sid));

                if (shouldYield) {
                  await stopScreenShareInternal();
                }
              }
            }
            return;
          }

          if (msgObj && msgObj.type === 'screen_share_release') {
            // nothing to do; track events will update UI
            return;
          }

          // --- Chat
          if (msgObj && msgObj.type === 'chat') {
            const senderName = msgObj.sender || (participant && (participant.name || participant.identity)) || 'Peer';
            appendChatMessage(senderName, msgObj.text || '', false);
          } else {
            const senderName = (participant && (participant.name || participant.identity)) || 'Peer';
            appendChatMessage(senderName, text, false);
          }
        } catch (e) {
          console.error('Decode data failed:', e);
        }
      });


      // active speakers (border highlight)
      room.on('activeSpeakersChanged', (speakers) => {
        try { updateSpeakingFromActiveSpeakers(speakers); } catch (e) {}
      });

      // connect
      await room.connect(data.livekit_url, data.livekit_jwt);

      // Topbar
      try { setTopbarStatus(true, roomId); updateTopbarCount(); } catch (e) {}
      // Peer broadcast mic state so new joiners see correct mute UI (unique id; no name collision)
      try { schedulePeerHelloBurst(); } catch (e) {}
      try { scheduleMicRequestBurst(); } catch (e) {}
      try { startParticipantPruneLoop(); } catch (e) {}
      // IMPORTANT: LiveKit thường KHÔNG bắn participantConnected cho những người đã có sẵn trong room.
      // Vì vậy phải tạo tile cho toàn bộ participants hiện hữu ngay sau khi connect,
      // kể cả user đang share screen và đã tắt/unpublish camera.
      try {
        for (const p of getRemoteParticipantsList(room)) {
          const name = getDisplayName(p);
          ensureParticipantTile(p.sid, name);
          try { bindSpeakingIndicator(p); } catch (e) {}
          try { bindAudioIndicator(p); } catch (e) {}
          try { updateMicIndicatorFromParticipant(p); } catch (e) {}
        }
      } catch (e) {}
      try { updateSpeakingFromActiveSpeakers(room.activeSpeakers || []); } catch (e) {}

      // tạo tile local ngay
      ensureParticipantTile(room.localParticipant.sid, CHAT_USERNAME || room.localParticipant.identity || 'You');
      try { bindSpeakingIndicator(room.localParticipant); } catch (e) {}
      try { bindAudioIndicator(room.localParticipant); } catch (e) {}
      try { updateMicIndicatorFromParticipant(room.localParticipant); } catch (e) {}

      
      // Mobile browsers (đặc biệt iOS Safari) đôi khi populate track publications trễ.
      // Do a small, bounded re-sync (anti-flap logic keeps UI stable).
      [350, 900, 1700].forEach((ms) => {
        setTimeout(() => {
          try {
            for (const p of getRemoteParticipantsList(room)) {
              try { updateMicIndicatorFromParticipant(p); } catch (e) {}
            }
            try { updateMicIndicatorFromParticipant(room.localParticipant); } catch (e) {}
          } catch (e) {}
        }, ms);
      });

      // publish local audio + video
      let localTracks = [];
      try {
        localTracks = await LivekitClient.createLocalTracks({
          audio: true,
          video: { facingMode: cameraFacingMode },
        });
      } catch (e) {
        console.warn("createLocalTracks(audio+video) failed, fallback audio-only:", e);
        try {
          localTracks = await LivekitClient.createLocalTracks({ audio: true, video: false });
        } catch (e2) {
          console.error("createLocalTracks(audio) failed:", e2);
          localTracks = [];
        }
      }

      // track presence flags
      localHasAudio = (localTracks || []).some(t => t && t.kind === 'audio');

      try { scheduleMicStateBurst('joined'); } catch (e) {}

      for (const track of localTracks) {
        await room.localParticipant.publishTrack(track);

        localMediaReady = true;

        // (khuyến nghị) bắn lại 1 burst khi đã “ready” để ai join trễ vẫn bắt được
        try { scheduleMicStateBurst('local_media_ready'); } catch (e) {}

        if (track.kind === 'video') {
          const el = track.attach();
          el.dataset.participant = room.localParticipant.sid;
          el.dataset.source = 'camera';

          localVideoTrack = track;
          localVideoElement = el;

          attachCameraVideoToTile(room.localParticipant.sid, CHAT_USERNAME || room.localParticipant.identity || 'You', el, true);
        }
        // local audio: không attach
      }


      // ensure local mic indicator reflects current state
      try { updateMicIndicator(room.localParticipant.sid, (!localHasAudio) || (!micEnabled)); } catch (e) {}

      // state cameraEnabled dựa vào có localVideoTrack hay không
      cameraEnabled = !!localVideoTrack;
      updateCameraUI();

      // enable UI
      document.getElementById("endBtn").disabled = false;
      const sendBtn = document.getElementById("sendChatBtn");
      if (sendBtn) sendBtn.disabled = false;

      const destroyBtn = document.getElementById('destroyBtn');
      if (destroyBtn) {
        if (isHost) {
          destroyBtn.disabled = false;
          destroyBtn.style.display = '';
        } else {
          destroyBtn.disabled = true;
          destroyBtn.style.display = 'none';
        }
      }

      if (toggleCameraBtn) toggleCameraBtn.disabled = false;
      if (switchCameraBtn) switchCameraBtn.disabled = false;
      if (toggleMicBtn) toggleMicBtn.disabled = false;
      if (toggleScreenBtn) toggleScreenBtn.disabled = false;
      if (toggleSpeakerBtn) toggleSpeakerBtn.disabled = false;

      micEnabled = true;
      updateMicUI();
      try { setTimeout(() => { try { broadcastMicStateNow({ cause: 'join' }); } catch (e) {} }, 120); } catch (e) {}

      speakerEnabled = true;
      if (toggleSpeakerIcon) toggleSpeakerIcon.textContent = 'volume_up';
      if (toggleSpeakerBtn) toggleSpeakerBtn.title = 'Mute call audio';
      applySpeakerMuteToCallMedia();

      screenShareEnabled = false;
      updateScreenUI();

      console.log("Connected to room:", room.name);
    } catch (err) {
      console.error("Join failed:", err);
    }
  };

  // Send chat
  document.getElementById("sendChatBtn").onclick = async () => {
    const input = document.getElementById("chatInput");
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    if (!currentRoom) {
      alert("You are not connected to a room.");
      return;
    }

    try {
      const payloadObj = { type: 'chat', text, sender: CHAT_USERNAME || 'User', ts: Date.now() };
      const encoded = textEncoder.encode(JSON.stringify(payloadObj));
      await currentRoom.localParticipant.publishData(encoded, { reliable: true });

      appendChatMessage('You', text, true);
      input.value = '';
    } catch (e) {
      console.error('Send chat error:', e);
    }
  };

  // Toggle camera
  if (toggleCameraBtn) {
    toggleCameraBtn.onclick = async () => {
      if (!currentRoom) return;
      // nếu đang screen share thì khoá
      if (screenShareEnabled) return;
      await toggleLocalCamera();
    };
  }

  // Switch camera front/back
  if (switchCameraBtn) {
    switchCameraBtn.onclick = async () => {
      // Đảo hướng: trước <-> sau
      cameraFacingMode = cameraFacingMode === 'user' ? 'environment' : 'user';

      try {
        // nếu đang có track thì restart để đổi cam; nếu không, chỉ lưu mode (khi bật cam lại sẽ dùng)
        if (localVideoTrack && typeof localVideoTrack.restartTrack === 'function') {
          await localVideoTrack.restartTrack({ facingMode: cameraFacingMode });

          // cập nhật mirror local
          if (localVideoElement) {
            if (cameraFacingMode === 'user') localVideoElement.classList.add('mirror-video');
            else localVideoElement.classList.remove('mirror-video');
          }
        }
        console.log('Switched camera to', cameraFacingMode);
      } catch (e) {
        console.error('Switch camera failed:', e);
      }
    };
  }

  // Toggle mic
  if (toggleMicBtn) {
    toggleMicBtn.onclick = async () => {
      if (!currentRoom) return;
      try {
        micEnabled = !micEnabled;
        await currentRoom.localParticipant.setMicrophoneEnabled(micEnabled);
        updateMicUI();

        // bắn ngay + bắn burst để cover packet warmup/reconnect
        broadcastMicStateNow({ cause: 'toggle_mic' });
        scheduleMicStateBurst('toggle_mic');
      } catch (e) {
        console.error("Toggle mic error:", e);
      }
    };
  }

  // Toggle speaker (call audio)
  if (toggleSpeakerBtn) {
    toggleSpeakerBtn.onclick = () => {
      if (!currentRoom) return;

      speakerEnabled = !speakerEnabled;
      applySpeakerMuteToCallMedia();

      if (toggleSpeakerIcon) toggleSpeakerIcon.textContent = speakerEnabled ? 'volume_up' : 'volume_off';
      toggleSpeakerBtn.title = speakerEnabled ? 'Mute call audio' : 'Unmute call audio';
    };
  }

  // Toggle screen share
  if (toggleScreenBtn) {
    toggleScreenBtn.onclick = async () => {
      if (!currentRoom) return;

      // Stop
      if (screenShareEnabled) {
        await stopScreenShareInternal();
        return;
      }

      // Start
      try {
        const startedAt = Date.now();
        myScreenShareStartedAt = startedAt;
        startingScreenShare = true;

        // tắt cam local để giảm băng thông
        cameraPrevEnabledBeforeScreen = cameraEnabled;
        cameraDisabledByScreenShare = false;

        if (cameraEnabled) {
          cameraDisabledByScreenShare = true;
          await disableLocalCamera();
        }

        // khoá nút camera trong lúc share
        if (toggleCameraBtn) toggleCameraBtn.disabled = true;

        const tracks = await LivekitClient.createLocalScreenTracks({
          audio: true,
          video: true
        });

        localScreenTracks = tracks;

        for (const t of tracks) {
          await currentRoom.localParticipant.publishTrack(t);

          if (t.kind === 'video') {
            const el = t.attach();
            el.dataset.participant = currentRoom.localParticipant.sid;
            el.dataset.source = 'screen';

            const name = CHAT_USERNAME || currentRoom.localParticipant.identity || 'You';
            screenShares.set(currentRoom.localParticipant.sid, { track: t, el, name, publication: null });
            activeScreenSid = currentRoom.localParticipant.sid;

            // giảm băng thông: chỉ subscribe active screen
            setOnlyActiveScreenSubscribed();

            renderActiveScreen();

            // Nếu user bấm "Stop sharing" ở UI browser → tự dừng
            try {
              if (t.mediaStreamTrack) {
                t.mediaStreamTrack.onended = () => {
                  if (screenShareEnabled) stopScreenShareInternal();
                };
              }
            } catch (e) {}
          }
          // local screen audio: không attach để tránh tự nghe lại
        }

        screenShareEnabled = true;
        startingScreenShare = false;
        updateScreenUI();

        // claim quyền share (single active sharer)
        try { await broadcastScreenShareClaim(startedAt); } catch (e) {}

      } catch (e) {
        console.warn('Start screen share failed:', e);

        startingScreenShare = false;
        myScreenShareStartedAt = null;

        // mở lại nút camera, restore cam nếu cần
        screenShareEnabled = false;
        updateScreenUI();

        try {
          if (toggleCameraBtn) toggleCameraBtn.disabled = false;
          if (cameraDisabledByScreenShare && cameraPrevEnabledBeforeScreen) {
            await enableLocalCamera();
          }
        } catch (err) {}

        cameraDisabledByScreenShare = false;
        cameraPrevEnabledBeforeScreen = null;
      }
    };
  }

  // End call
  document.getElementById("endBtn").onclick = async () => {
    const roomId = document.getElementById("roomId").value.trim();
    if (!roomId) { alert("Missing room id"); return; }

    try {
      const res = await fetch("https://app.shieldrtc.com/api/rooms/end", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + SIGNAL_JWT,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ room_id: roomId })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.warn("End room failed:", err);
        alert(err.error || "Only host can end this room (or server error).");
      }
    } catch (e) {
      console.error("End room error:", e);
    }

    // stop local screen share resources (cleanup nhanh)
    try { await stopScreenShareInternal(); } catch (e) {}

    // disconnect local
    try { stopParticipantPruneLoop(); } catch (e) {}
    if (currentRoom) {
      try { await currentRoom.disconnect(); } catch (e) {}
      currentRoom = null;
    }

    resetCallUI();
  };

  // Disband call
  const destroyBtnEl = document.getElementById('destroyBtn');
  if (destroyBtnEl) {
    destroyBtnEl.onclick = async () => {
      if (!isHost) {
        alert("You are not the host.");
        return;
      }

      const roomId = document.getElementById("roomId").value.trim();
      if (!roomId) {
        alert("Missing room id");
        return;
      }

      const ok = confirm(
        "Disband room?\n" +
        "All participants will exit room immediately."
      );
      if (!ok) return;

      destroyBtnEl.disabled = true;

      try {
        const res = await fetch("https://app.shieldrtc.com/api/rooms/disband", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + SIGNAL_JWT,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ room_id: roomId })
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(err.error || "Disband failed.");
          destroyBtnEl.disabled = false;
          return;
        }
      } catch (e) {
        console.error("Disband error:", e);
        alert("Server error while disbanding room.");
        destroyBtnEl.disabled = false;
        return;
      }

      // cleanup local (host cũng bị out)
      try { await stopScreenShareInternal(); } catch (e) {}
      try { stopParticipantPruneLoop(); } catch (e) {}

      if (currentRoom) {
        try { await currentRoom.disconnect(); } catch (e) {}
        currentRoom = null;
      }

      resetCallUI();
    };
  }
});
