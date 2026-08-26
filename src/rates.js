'use strict';

// Descarga y arma las cotizaciones. Misma lógica que la app Flutter:
//  - USD: casas de cambio reales (API dolarpy)
//  - BRL/ARS/EUR: compra/venta reales de varias casas multi-moneda
//    (Cambios Alberdi por sucursal + La Moneda de Ciudad del Este; incluye
//    frontera). Respaldo cross-rate vía dólar (open.er-api) si todas fallan.

const DOLARPY_URL = process.env.DOLARPY_URL || 'https://dolar.melizeche.com/api/1.0/';
const FX_USD_URL = process.env.FX_USD_URL || 'https://open.er-api.com/v6/latest/USD';
const ALBERDI_URL = process.env.ALBERDI_URL || 'https://www.cambiosalberdi.com/ws/getTablero.json';
const LA_MONEDA_URL = process.env.LA_MONEDA_URL || 'https://lamoneda.com.py/api/cotizaciones';
const TIMEOUT_MS = 12000;

const ALBERDI_BRANCHES = {
  villamorra: 'Villamorra',
  ciudaddeleste: 'Ciudad del Este',
  saltodelguaira: 'Salto del Guairá',
  km4: 'Km 4',
  encarnacion: 'Encarnación',
};

// "5.900" -> 5900 ; "3,65" -> 3.65 (punto=miles, coma=decimal).
function parsePy(s) {
  const t = String(s).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  return isFinite(n) ? n : 0;
}

const HOUSE_NAMES = {
  bcp: 'BCP (oficial)',
  bonanza: 'Bonanza',
  cambiosalberdi: 'Cambios Alberdi',
  cambioschaco: 'Cambios Chaco',
  eurocambios: 'Eurocambios',
  familiar: 'Cambios Familiar',
  gnbfusion: 'GNB Fusión',
  lamoneda: 'La Moneda',
  maxicambios: 'Maxicambios',
  mundialcambios: 'Mundial Cambios',
  mydcambios: 'MYD Cambios',
  set: 'SET',
};

function pretty(key) {
  if (HOUSE_NAMES[key]) return HOUSE_NAMES[key];
  return key.split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'CambioPy/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchUsdQuotes() {
  const data = await getJson(DOLARPY_URL);
  const houses = data && data.dolarpy;
  if (!houses || typeof houses !== 'object') return [];
  const quotes = [];
  for (const [key, v] of Object.entries(houses)) {
    if (!v || typeof v !== 'object') continue;
    const compra = Number(v.compra);
    const venta = Number(v.venta);
    if (!(compra > 0) || !(venta > 0)) continue;
    quotes.push({
      house: pretty(key),
      compra,
      venta,
      referencial: v.referencial_diario != null ? Number(v.referencial_diario) : undefined,
    });
  }
  quotes.sort((a, b) => {
    const aBcp = a.house.startsWith('BCP') ? 0 : 1;
    const bBcp = b.house.startsWith('BCP') ? 0 : 1;
    if (aBcp !== bBcp) return aBcp - bBcp;
    return a.venta - b.venta;
  });
  return quotes;
}

async function fetchFxUsd() {
  try {
    const data = await getJson(FX_USD_URL);
    const r = data && data.rates;
    if (!r) return {};
    return {
      BRL: Number(r.BRL) || 0,
      ARS: Number(r.ARS) || 0,
      EUR: Number(r.EUR) || 0,
      PYG: Number(r.PYG) || 0,
    };
  } catch {
    return {};
  }
}

// { BRL:[...], ARS:[...], EUR:[...] } con compra/venta reales por sucursal de
// Cambios Alberdi. Map vacío si falla (se usa el cross-rate como respaldo).
async function fetchAlberdi() {
  try {
    const data = await getJson(ALBERDI_URL);
    const result = { BRL: [], ARS: [], EUR: [] };
    for (const [branchKey, items] of Object.entries(data)) {
      if (!Array.isArray(items)) continue;
      const bname = ALBERDI_BRANCHES[branchKey] || branchKey;
      for (const it of items) {
        const code = it && it.bcp;
        if (!result[code]) continue;
        const compra = parsePy(it.compra);
        const venta = parsePy(it.venta);
        if (compra > 0 && venta > 0) {
          result[code].push({ house: `Alberdi · ${bname}`, compra, venta });
        }
      }
    }
    for (const list of Object.values(result)) list.sort((a, b) => a.venta - b.venta);
    return result;
  } catch {
    return {};
  }
}

// La Moneda (Ciudad del Este). API JSON con números ya parseados.
async function fetchLaMoneda() {
  try {
    const data = await getJson(LA_MONEDA_URL);
    const map = { REAL: 'BRL', PESOS: 'ARS', EURO: 'EUR' };
    const result = { BRL: [], ARS: [], EUR: [] };
    for (const it of data.cotizaciones || []) {
      if (it.moneda2 !== 'GUARANI') continue;
      const code = map[it.moneda1];
      if (!code) continue;
      const compra = Number(it.compra);
      const venta = Number(it.venta);
      if (compra > 0 && venta > 0) {
        result[code].push({ house: 'La Moneda · Ciudad del Este', compra, venta });
      }
    }
    return result;
  } catch {
    return {};
  }
}

// Combina todas las fuentes multi-moneda (agregar más acá es trivial).
async function fetchMultiCurrency() {
  const merged = { BRL: [], ARS: [], EUR: [] };
  const sources = await Promise.allSettled([fetchAlberdi(), fetchLaMoneda()]);
  for (const s of sources) {
    if (s.status !== 'fulfilled' || !s.value) continue;
    for (const code of Object.keys(merged)) {
      if (Array.isArray(s.value[code])) merged[code].push(...s.value[code]);
    }
  }
  for (const list of Object.values(merged)) list.sort((a, b) => a.venta - b.venta);
  return merged;
}

// Devuelve { updatedAt, currencies: { USD:{quotes,...}, BRL:{...}, ... } }
async function fetchRates() {
  const now = new Date().toISOString();
  const usd = await fetchUsdQuotes();
  if (!usd.length) throw new Error('Sin cotizaciones de dólar');

  const fx = await fetchFxUsd();
  const multi = await fetchMultiCurrency(); // BRL/ARS/EUR reales (varias casas)

  const currencies = {
    USD: buildSnapshot('USD', usd, now, false),
  };

  // Respaldo: cotización derivada del dólar (cross-rate).
  const crossQuotes = (perUsd) =>
    perUsd > 0
      ? usd.map((q) => ({ house: q.house, compra: q.compra / perUsd, venta: q.venta / perUsd }))
      : null;

  const addCurrency = (code, perUsd) => {
    const real = multi[code];
    if (real && real.length) {
      currencies[code] = buildSnapshot(code, real, now, false);
    } else {
      const qs = crossQuotes(perUsd);
      if (qs && qs.length) currencies[code] = buildSnapshot(code, qs, now, true);
    }
  };

  addCurrency('BRL', fx.BRL);
  addCurrency('ARS', fx.ARS);
  addCurrency('EUR', fx.EUR);

  return { updatedAt: now, currencies };
}

// Agrega los "mejores" precios a un snapshot.
function buildSnapshot(code, quotes, updatedAt, estimated = false) {
  const bestToBuy = quotes.reduce((a, b) => (a.venta <= b.venta ? a : b)); // menor venta
  const bestToSell = quotes.reduce((a, b) => (a.compra >= b.compra ? a : b)); // mayor compra
  const avgCompra = quotes.reduce((s, q) => s + q.compra, 0) / quotes.length;
  const avgVenta = quotes.reduce((s, q) => s + q.venta, 0) / quotes.length;
  return { currency: code, quotes, updatedAt, estimated, bestToBuy, bestToSell, avgCompra, avgVenta };
}

module.exports = { fetchRates, buildSnapshot };
