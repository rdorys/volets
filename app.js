import {
  PROFILES, NTS_CONFIG_SERVICE, CRYPTO_SERVICE, ALL_SERVICES,
  parseBlindConfig, OFFSET, readFloat, blindCommand, hex,
} from './protocol.js';

const $ = (id) => document.getElementById(id);
const VERSION = '2026-11-04.2';
const LOCAL_KEY = 'volets.aliases.v1';
const LOG_KEY = 'volets.log.v1';
const DEBUG_KEY = 'volets.debug.v1';
const LOG_MAX_CHARS = 200000;
const IDENTIFY_DELTA = 20;
const IDENTIFY_MS = 6000;
const POLL_MS = 3000;

const state = {
  device: null, server: null, profile: null,
  writeChar: null, liveChar: null, groups: [], live: null,
  pollTimer: null, notifying: false,
  shared: { devices: {}, groups: {} },
  local: { devices: {}, groups: {} },
};

// --- Journal et messages ---

// Le journal est gardé dans l'ordre chronologique ; en mode debug il survit au rechargement.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* stockage indisponible */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* idem */ } },
};

let logText = '';
const debugOn = () => $('debugMode').checked;

function log(msg) {
  logText = (logText + `${new Date().toISOString()}  ${msg}\n`).slice(-LOG_MAX_CHARS);
  if (debugOn()) store.set(LOG_KEY, logText);
  $('log').textContent = logText.split('\n').reverse().join('\n').slice(0, 20000);
}

function logHeader() {
  return [
    `Volets ${VERSION}`,
    `Date : ${new Date().toISOString()}`,
    `Navigateur : ${navigator.userAgent}`,
    `Web Bluetooth : ${navigator.bluetooth ? 'oui' : 'non'}`,
    `Boîtier : ${state.device?.name || '(aucun)'} — ${state.profile?.label || '?'}`,
    `Groupes : ${JSON.stringify(state.groups.map(({ el, ...g }) => g))}`,
    '',
  ].join('\n');
}

async function copyLog() {
  const text = logHeader() + logText;
  try {
    await navigator.clipboard.writeText(text);
    toast("Journal copié : collez-le dans l'appli Claude.");
  } catch {
    // Presse-papiers refusé : on affiche le texte brut à sélectionner.
    $('log').textContent = text;
    getSelection().selectAllChildren($('log'));
    toast('Journal sélectionné : copiez-le manuellement.');
  }
}

function initDebug() {
  $('debugMode').checked = store.get(DEBUG_KEY) === '1';
  if (debugOn()) {
    logText = store.get(LOG_KEY) || '';
    log(`Mode debug actif (${VERSION})`);
  }
  $('debugMode').addEventListener('change', () => {
    store.set(DEBUG_KEY, debugOn() ? '1' : '0');
    if (debugOn()) {
      store.set(LOG_KEY, logText);
      log('Mode debug activé');
    } else {
      store.remove(LOG_KEY);
    }
  });
  $('copyLog').addEventListener('click', copyLog);
  $('clearLog').addEventListener('click', () => {
    logText = '';
    store.remove(LOG_KEY);
    $('log').textContent = '';
  });
}

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + kind;
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// --- Alias : partagés (aliases.json) + locaux (ce téléphone) ---

function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) state.local = { devices: {}, groups: {}, ...JSON.parse(raw) };
  } catch { /* stockage indisponible : on continue sans */ }
}

function saveLocal() {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state.local)); } catch { /* idem */ }
  renderAliasExport();
}

async function loadShared() {
  try {
    const res = await fetch('aliases.json', { cache: 'no-store' });
    if (res.ok) state.shared = { devices: {}, groups: {}, ...(await res.json()) };
  } catch { log('aliases.json introuvable, seuls les noms locaux sont utilisés'); }
  renderAliasExport();
}

const groupKey = (deviceName, index) => `${deviceName}#${index}`;

function deviceAlias(name) {
  return state.local.devices[name] || state.shared.devices[name] || '';
}

function groupAlias(deviceName, g) {
  const key = groupKey(deviceName, g.index);
  return state.local.groups[key] || state.shared.groups[key] || g.name || `Store ${g.index + 1}`;
}

function renderAliasExport() {
  const merged = {
    devices: { ...state.shared.devices, ...state.local.devices },
    groups: { ...state.shared.groups, ...state.local.groups },
  };
  $('aliasExport').value = JSON.stringify(merged, null, 2);
}

// --- Connexion ---

async function connect() {
  const showAll = $('showAll').checked;
  const options = showAll
    ? { acceptAllDevices: true, optionalServices: ALL_SERVICES }
    : {
        filters: [
          { services: [PROFILES.v2.configService] },
          { services: [PROFILES.v1.configService] },
          { services: [NTS_CONFIG_SERVICE] },
        ],
        optionalServices: ALL_SERVICES,
      };
  let device;
  try {
    device = await navigator.bluetooth.requestDevice(options);
  } catch (e) {
    if (e.name !== 'NotFoundError') setStatus('Sélection annulée : ' + e.message, 'err');
    return;
  }
  await disconnect();
  state.device = device;
  device.addEventListener('gattserverdisconnected', onDisconnected);
  renderDevice();
  setStatus('Connexion…');
  log(`Appareil choisi : ${device.name || '(sans nom)'}`);
  try {
    state.server = await device.gatt.connect();
    await setup();
  } catch (e) {
    log('Erreur : ' + e.message);
    setStatus('Échec de connexion : ' + e.message, 'err');
  }
}

async function findProfile(server) {
  for (const [key, p] of Object.entries(PROFILES)) {
    try {
      await server.getPrimaryService(p.configService);
      return key;
    } catch { /* service absent, on essaie le suivant */ }
  }
  try {
    await server.getPrimaryService(NTS_CONFIG_SERVICE);
    return 'nts';
  } catch { return null; }
}

async function setup() {
  const key = await findProfile(state.server);
  if (key === 'nts') {
    setStatus("Écran nLight nTS détecté : ce modèle n'est pas encore pris en charge.", 'warn');
    return;
  }
  if (!key) {
    setStatus("Cet appareil n'est pas un boîtier UNITOUCH reconnu.", 'err');
    return;
  }
  const p = PROFILES[key];
  state.profile = p;
  log(`Génération détectée : ${p.label}`);

  try {
    await state.server.getPrimaryService(CRYPTO_SERVICE);
    log('Service de sécurité présent : un code PIN pourrait être exigé pour certaines actions');
  } catch { /* pas de service crypto */ }

  const configChar = await (await state.server.getPrimaryService(p.configService)).getCharacteristic(p.configBlinds);
  const raw = new Uint8Array((await configChar.readValue()).buffer);
  log(`Configuration stores (${raw.length} o) : ${hex(raw)}`);
  state.groups = parseBlindConfig(raw);
  log(`Groupes : ${JSON.stringify(state.groups)}`);

  state.writeChar = await (await state.server.getPrimaryService(p.writeService)).getCharacteristic(p.writeChar);
  state.liveChar = await (await state.server.getPrimaryService(p.liveService)).getCharacteristic(p.liveBlinds);

  try {
    state.liveChar.addEventListener('characteristicvaluechanged', (ev) => onLive(ev.target.value));
    await state.liveChar.startNotifications();
    state.notifying = true;
    log('Notifications activées');
  } catch (e) {
    log('Notifications indisponibles, lecture périodique : ' + e.message);
  }
  await refreshLive();
  if (!state.notifying) state.pollTimer = setInterval(refreshLive, POLL_MS);

  renderGroups();
  $('blinds').classList.remove('hidden');
  $('disconnect').classList.remove('hidden');
  setStatus(`Connecté (${p.label}) — ${state.groups.length} groupe(s) de stores`, 'ok');
}

async function refreshLive() {
  if (!state.liveChar) return;
  try {
    onLive(await state.liveChar.readValue());
  } catch (e) {
    log('Lecture état : ' + e.message);
  }
}

function onLive(dataView) {
  const live = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength).slice();
  if (debugOn() && (!state.live || hex(live) !== hex(state.live))) log(`← état (${live.length} o) : ${hex(live)}`);
  state.live = live;
  updateValues();
}

function onDisconnected() {
  clearInterval(state.pollTimer);
  state.server = state.writeChar = state.liveChar = null;
  state.notifying = false;
  $('disconnect').classList.add('hidden');
  $('blinds').classList.add('hidden');
  setStatus('Déconnecté.', 'warn');
  log('Déconnecté');
}

async function disconnect() {
  if (state.device?.gatt?.connected) state.device.gatt.disconnect();
}

// --- Commandes ---

async function send(offset, value) {
  if (!state.writeChar) return;
  const frame = blindCommand(offset, value);
  log(`→ ${hex(frame)}  (décalage ${offset}, valeur ${value})`);
  try {
    if (state.writeChar.writeValueWithoutResponse) await state.writeChar.writeValueWithoutResponse(frame);
    else await state.writeChar.writeValue(frame);
    if (!state.notifying) setTimeout(refreshLive, 800);
  } catch (e) {
    log('Échec envoi : ' + e.message);
    toast("La commande n'est pas passée : " + e.message);
  }
}

async function identify(g) {
  const current = readFloat(state.live, OFFSET.levelFeedback(g.index));
  const base = Number.isFinite(current) ? Math.round(current) : 50;
  const target = base < 50 ? base + IDENTIFY_DELTA : base - IDENTIFY_DELTA;
  toast(`« ${groupAlias(state.device.name, g)} » va bouger puis revenir.`);
  await send(OFFSET.level(g.index), target);
  setTimeout(() => send(OFFSET.level(g.index), base), IDENTIFY_MS);
}

// --- Affichage ---

function renderDevice() {
  const name = state.device?.name || '(sans nom)';
  $('device').classList.remove('hidden');
  $('deviceAlias').textContent = deviceAlias(name) || 'Boîtier sans nom';
  $('deviceName').textContent = name;
}

function fmt(v) {
  return Number.isFinite(v) ? `${Math.round(v)} %` : '–';
}

function renderGroups() {
  const root = $('groups');
  root.innerHTML = '';
  const deviceName = state.device.name || '';
  for (const g of state.groups) {
    const el = document.createElement('div');
    el.className = 'group' + (g.enabled ? '' : ' disabled');
    el.innerHTML = `
      <div class="group-title">
        <span class="group-alias"></span>
        <span class="value" data-level>–</span>
      </div>
      <div class="group-meta"></div>
      <input type="range" min="0" max="100" step="1" data-slider="level" aria-label="Niveau">
      <div class="rotation hidden">
        <div class="row"><span class="grow group-meta">Orientation des lames</span><span class="value" data-rotation>–</span></div>
        <input type="range" min="0" max="100" step="1" data-slider="rotation" aria-label="Orientation">
      </div>
      <div class="row">
        <button data-act="0">0 %</button>
        <button data-act="100">100 %</button>
        <button data-act="identify" class="grow">Identifier</button>
        <button data-act="rename">Renommer</button>
      </div>`;
    el.querySelector('.group-alias').textContent = groupAlias(deviceName, g);
    el.querySelector('.group-meta').textContent =
      `Groupe ${g.index}` + (g.name ? ` · nom d'origine « ${g.name} »` : '') + (g.enabled ? '' : ' · désactivé');
    if (g.hasRotation) el.querySelector('.rotation').classList.remove('hidden');

    el.querySelector('[data-slider=level]').addEventListener('change', (ev) =>
      send(OFFSET.level(g.index), Number(ev.target.value)));
    el.querySelector('[data-slider=rotation]').addEventListener('change', (ev) =>
      send(OFFSET.rotation(g.index), Number(ev.target.value)));
    el.querySelector('[data-act="0"]').addEventListener('click', () => send(OFFSET.level(g.index), 0));
    el.querySelector('[data-act="100"]').addEventListener('click', () => send(OFFSET.level(g.index), 100));
    el.querySelector('[data-act=identify]').addEventListener('click', () => identify(g));
    el.querySelector('[data-act=rename]').addEventListener('click', () => {
      const v = prompt('Nom de ce store', groupAlias(deviceName, g));
      if (v === null) return;
      const key = groupKey(deviceName, g.index);
      if (v.trim()) state.local.groups[key] = v.trim(); else delete state.local.groups[key];
      saveLocal();
      renderGroups();
    });
    g.el = el;
    root.appendChild(el);
  }
  updateValues();
}

function updateValues() {
  if (!state.live) return;
  const global = readFloat(state.live, OFFSET.globalLevelFeedback);
  $('globalValue').textContent = fmt(global);
  for (const g of state.groups) {
    if (!g.el) continue;
    const level = readFloat(state.live, OFFSET.levelFeedback(g.index));
    const rotation = readFloat(state.live, OFFSET.rotationFeedback(g.index));
    g.el.querySelector('[data-level]').textContent = fmt(level);
    g.el.querySelector('[data-rotation]').textContent = fmt(rotation);
    const slider = g.el.querySelector('[data-slider=level]');
    if (Number.isFinite(level) && document.activeElement !== slider) slider.value = level;
  }
}

// --- Démarrage ---

function init() {
  if (!navigator.bluetooth) {
    $('unsupported').classList.remove('hidden');
    $('connect').disabled = true;
  }
  loadLocal();
  loadShared();
  initDebug();
  $('connect').addEventListener('click', connect);
  $('disconnect').addEventListener('click', disconnect);
  $('globalLevel').addEventListener('change', (ev) => send(OFFSET.globalLevel, Number(ev.target.value)));
  $('renameDevice').addEventListener('click', () => {
    const name = state.device?.name;
    if (!name) return;
    const v = prompt('Nom de ce boîtier (ex. « Bureau 2.14 »)', deviceAlias(name));
    if (v === null) return;
    if (v.trim()) state.local.devices[name] = v.trim(); else delete state.local.devices[name];
    saveLocal();
    renderDevice();
  });
  $('copyAliases').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('aliasExport').value);
      toast('Copié.');
    } catch {
      $('aliasExport').select();
      toast('Sélectionné : copiez manuellement.');
    }
  });
  $('clearAliases').addEventListener('click', () => {
    if (!confirm('Oublier les noms enregistrés sur ce téléphone ?')) return;
    state.local = { devices: {}, groups: {} };
    saveLocal();
    if (state.device) { renderDevice(); if (state.groups.length) renderGroups(); }
  });
}

init();
