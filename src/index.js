'use strict';

// Backend liviano de Cambio Py:
//  - Sirve cotizaciones (GET /rates)
//  - Guarda dispositivos + sus alertas
//  - Cada POLL_MINUTES evalúa alertas y envía push (FCM)

const express = require('express');
const cron = require('node-cron');

const store = require('./store');
const push = require('./push');
const { fetchRates } = require('./rates');
const { evaluateDevice, buildNotification } = require('./alerts');

const PORT = Number(process.env.PORT || 8080);
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 10);
const API_KEY = process.env.API_KEY || ''; // opcional
const RATES_TTL_MS = 5 * 60 * 1000;

store.load();
push.init();

const app = express();
app.use(express.json({ limit: '256kb' }));

// Auth opcional por header x-api-key (solo si API_KEY está definido).
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.path === '/health') return next();
  if (req.get('x-api-key') === API_KEY) return next();
  return res.status(401).json({ error: 'no autorizado' });
});

app.get('/health', (req, res) => {
  const rates = store.getRates();
  res.json({
    ok: true,
    pushEnabled: push.isEnabled(),
    devices: store.allDevices().length,
    ratesUpdatedAt: rates ? rates.updatedAt : null,
    pollMinutes: POLL_MINUTES,
  });
});

// Cotizaciones (la app puede usar esto como fuente más confiable que el scraping directo).
app.get('/rates', async (req, res) => {
  let rates = store.getRates();
  const stale = !rates || Date.now() - Date.parse(rates.updatedAt) > RATES_TTL_MS;
  if (stale) {
    try {
      rates = await fetchRates();
      store.setRates(rates);
    } catch (e) {
      if (!rates) return res.status(503).json({ error: 'no hay cotizaciones', detail: e.message });
    }
  }
  res.json(rates);
});

// Registrar/actualizar un dispositivo y sus alertas.
app.post('/register', (req, res) => {
  const { token, platform, alerts } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token requerido' });
  }
  const dev = store.upsertDevice(token, platform, alerts);
  res.json({ ok: true, alerts: dev.alerts.length });
});

// Actualizar solo las alertas de un dispositivo.
app.put('/devices/:token/alerts', (req, res) => {
  const { token } = req.params;
  const { alerts } = req.body || {};
  const dev = store.setAlerts(token, alerts);
  if (!dev) return res.status(404).json({ error: 'dispositivo no registrado' });
  res.json({ ok: true, alerts: dev.alerts.length });
});

app.delete('/devices/:token', (req, res) => {
  const ok = store.removeDevice(req.params.token);
  res.json({ ok });
});

// Enviar una push de prueba a un token (para el botón "Probar" de la app).
app.post('/test-push', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token requerido' });
  const result = await push.sendPush(
    token,
    { title: 'Cambio Py', body: '¡Las notificaciones funcionan! 🎉' },
    { type: 'test' }
  );
  res.json({ result });
});

// Disparo manual del ciclo (para un cron externo gratis, p. ej. cron-job.org,
// útil en hostings que "duermen" por inactividad).
app.get('/poll', async (req, res) => {
  await poll();
  res.json({ ok: true });
});
app.post('/poll', async (req, res) => {
  await poll();
  res.json({ ok: true });
});

// ---- ciclo de evaluación ----
async function poll() {
  let rates;
  try {
    rates = await fetchRates();
    store.setRates(rates);
  } catch (e) {
    console.error('[poll] no se pudieron obtener cotizaciones:', e.message);
    return;
  }

  const devices = store.allDevices();
  let sent = 0;
  for (const dev of devices) {
    const fired = evaluateDevice(dev.alerts, rates.currencies);
    for (const { alert, value } of fired) {
      const notif = buildNotification(alert, value);
      const result = await push.sendPush(dev.token, notif, {
        type: 'alert',
        currency: alert.currency,
        value: String(value),
      });
      if (result === 'invalid-token') {
        console.log('[poll] token inválido, se elimina el dispositivo');
        store.removeDevice(dev.token);
      } else {
        sent++;
      }
    }
    // Persistir el estado wasMet/lastTriggered actualizado.
    if (dev.alerts.length) store.setAlerts(dev.token, dev.alerts);
  }
  if (devices.length) {
    console.log(`[poll] ${new Date().toISOString()} · ${devices.length} dispositivos · ${sent} avisos`);
  }
}

app.listen(PORT, () => {
  console.log(`Cambio Py backend en http://localhost:${PORT} (poll cada ${POLL_MINUTES} min)`);
  poll(); // primera corrida al arrancar
});

// node-cron: cada POLL_MINUTES minutos.
cron.schedule(`*/${POLL_MINUTES} * * * *`, poll);
