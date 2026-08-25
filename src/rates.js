'use strict';

// Descarga y arma las cotizaciones. Misma lógica que la app Flutter:
//  - USD: casas de cambio reales (API dolarpy)
//  - BRL/ARS: referencia derivada del dólar local vía open.er-api.

const DOLARPY_URL = process.env.DOLARPY_URL || 'https://dolar.melizeche.com/api/1.0/';
const FX_USD_URL = process.env.FX_USD_URL || 'https://open.er-api.com/v6/latest/USD';
const TIMEOUT_MS = 12000;

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

// Devuelve { updatedAt, currencies: { USD:{quotes,...}, BRL:{...}, ARS:{...} } }
async function fetchRates() {
  const now = new Date().toISOString();
  const usd = await fetchUsdQuotes();
  if (!usd.length) throw new Error('Sin cotizaciones de dólar');

  const fx = await fetchFxUsd();

  const currencies = {
    USD: buildSnapshot('USD', usd, now),
  };

  // Cotización POR CASA a partir de su dólar (compra/venta ÷ USD→moneda).
  const crossQuotes = (perUsd) =>
    perUsd > 0
      ? usd.map((q) => ({ house: q.house, compra: q.compra / perUsd, venta: q.venta / perUsd }))
      : null;

  const addCross = (code, perUsd) => {
    const qs = crossQuotes(perUsd);
    if (qs && qs.length) currencies[code] = buildSnapshot(code, qs, now);
  };

  addCross('BRL', fx.BRL);
  addCross('ARS', fx.ARS);
  addCross('EUR', fx.EUR);

  return { updatedAt: now, currencies };
}

// Agrega los "mejores" precios a un snapshot.
function buildSnapshot(code, quotes, updatedAt) {
  const bestToBuy = quotes.reduce((a, b) => (a.venta <= b.venta ? a : b)); // menor venta
  const bestToSell = quotes.reduce((a, b) => (a.compra >= b.compra ? a : b)); // mayor compra
  const avgCompra = quotes.reduce((s, q) => s + q.compra, 0) / quotes.length;
  const avgVenta = quotes.reduce((s, q) => s + q.venta, 0) / quotes.length;
  return { currency: code, quotes, updatedAt, bestToBuy, bestToSell, avgCompra, avgVenta };
}

module.exports = { fetchRates, buildSnapshot };
