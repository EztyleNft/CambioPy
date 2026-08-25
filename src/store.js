'use strict';

// Almacén simple en archivo JSON (sin base de datos, "liviano").
// Estructura:
// {
//   devices: { [token]: { platform, alerts: [PriceAlert...], updatedAt } },
//   rates:   { updatedAt, currencies: {...} }
// }

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

let state = { devices: {}, rates: null };
let writeTimer = null;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state.devices = state.devices || {};
    }
  } catch (e) {
    console.error('No se pudo cargar data.json:', e.message);
    state = { devices: {}, rates: null };
  }
  return state;
}

function persist() {
  // Escritura atómica: archivo temporal + rename.
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('No se pudo guardar data.json:', e.message);
  }
}

// Guardado con "debounce" para no escribir en cada request.
function scheduleSave() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    persist();
  }, 800);
}

// ---- devices ----
function upsertDevice(token, platform, alerts) {
  const prev = state.devices[token] || {};
  state.devices[token] = {
    platform: platform || prev.platform || 'android',
    alerts: Array.isArray(alerts) ? alerts : prev.alerts || [],
    updatedAt: new Date().toISOString(),
  };
  scheduleSave();
  return state.devices[token];
}

function setAlerts(token, alerts) {
  const dev = state.devices[token];
  if (!dev) return null;
  dev.alerts = Array.isArray(alerts) ? alerts : [];
  dev.updatedAt = new Date().toISOString();
  scheduleSave();
  return dev;
}

function removeDevice(token) {
  if (state.devices[token]) {
    delete state.devices[token];
    scheduleSave();
    return true;
  }
  return false;
}

function allDevices() {
  return Object.entries(state.devices).map(([token, d]) => ({ token, ...d }));
}

// ---- rates cache ----
function setRates(rates) {
  state.rates = rates;
  scheduleSave();
}
function getRates() {
  return state.rates;
}

module.exports = {
  load,
  persist,
  upsertDevice,
  setAlerts,
  removeDevice,
  allDevices,
  setRates,
  getRates,
  DATA_FILE,
};
