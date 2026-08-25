'use strict';

// Evaluación de alertas con disparo por flanco (igual que la app).
// PriceAlert: { id, currency, side:'compra'|'venta', direction:'above'|'below',
//               threshold, enabled, note, wasMet, lastTriggered }

const REARM_MS = Number(process.env.ALERT_REARM_HOURS || 6) * 3600 * 1000;

const CURRENCY_META = {
  USD: { name: 'Dólar', flag: '🇺🇸', dec: 0 },
  BRL: { name: 'Real', flag: '🇧🇷', dec: 0 },
  ARS: { name: 'Peso argentino', flag: '🇦🇷', dec: 2 },
  EUR: { name: 'Euro', flag: '🇪🇺', dec: 0 },
};

function groupThousands(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function fmtGs(value, dec) {
  const neg = value < 0;
  const fixed = Math.abs(value).toFixed(dec);
  const [i, d] = fixed.split('.');
  const out = groupThousands(i) + (dec > 0 ? ',' + d : '');
  return (neg ? '-' : '') + out;
}

// Valor accionable para el lado de la alerta.
function currentValue(alert, snap) {
  if (alert.side === 'compra') return snap.bestToSell ? snap.bestToSell.compra : snap.avgCompra;
  return snap.bestToBuy ? snap.bestToBuy.venta : snap.avgVenta;
}

// Evalúa las alertas de un dispositivo contra los snapshots.
// Muta el estado (wasMet/lastTriggered) y devuelve las que dispararon.
function evaluateDevice(alerts, currencies) {
  const fired = [];
  const now = Date.now();

  for (const a of alerts) {
    if (!a.enabled) {
      a.wasMet = false;
      continue;
    }
    const snap = currencies[a.currency];
    if (!snap) continue;

    const value = currentValue(a, snap);
    const met = a.direction === 'above' ? value >= a.threshold : value <= a.threshold;

    const last = a.lastTriggered ? Date.parse(a.lastTriggered) : 0;
    const rearmed = !last || now - last > REARM_MS;

    if (met && !a.wasMet && rearmed) {
      a.lastTriggered = new Date().toISOString();
      fired.push({ alert: a, value });
    }
    a.wasMet = met;
  }
  return fired;
}

function buildNotification(alert, value) {
  const m = CURRENCY_META[alert.currency] || { name: alert.currency, flag: '', dec: 0 };
  const dirLabel = alert.direction === 'above' ? 'subió a' : 'bajó a';
  const sideLabel = alert.side === 'compra' ? 'compra' : 'venta';
  return {
    title: `${m.flag} ${m.name} ${dirLabel} ₲ ${fmtGs(alert.threshold, m.dec)}`,
    body: `La ${sideLabel} está en ₲ ${fmtGs(value, m.dec)}. ¡Momento de mirar!`,
  };
}

module.exports = { evaluateDevice, buildNotification, fmtGs };
