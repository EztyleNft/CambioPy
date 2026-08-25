'use strict';

// Envío de notificaciones push vía Firebase Cloud Messaging (FCM).
// Degrada con elegancia: si no hay credenciales configuradas, queda deshabilitado
// y `sendPush` solo registra en consola (útil para probar el backend sin Firebase).

const fs = require('fs');
const path = require('path');

let admin = null;
let enabled = false;

// Carga la service account desde:
//  1) la variable de entorno FIREBASE_SERVICE_ACCOUNT (el JSON completo), o
//  2) un archivo (GOOGLE_APPLICATION_CREDENTIALS o ./service-account.json).
function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw && raw.trim().startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('[push] FIREBASE_SERVICE_ACCOUNT no es JSON válido:', e.message);
    }
  }
  const credPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.resolve(__dirname, '..', 'service-account.json');
  if (fs.existsSync(credPath)) {
    return JSON.parse(fs.readFileSync(credPath, 'utf8'));
  }
  return null;
}

function init() {
  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    console.warn(
      '[push] Sin credenciales de Firebase (ni FIREBASE_SERVICE_ACCOUNT ni service-account.json). ' +
        'Push DESHABILITADO: el backend igual evalúa alertas y las loguea.'
    );
    return;
  }
  try {
    admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    enabled = true;
    console.log('[push] Firebase Admin inicializado. Push HABILITADO.');
  } catch (e) {
    console.error('[push] No se pudo inicializar Firebase Admin:', e.message);
  }
}

// Devuelve 'ok' | 'invalid-token' | 'skipped' | 'error'
async function sendPush(token, notification, data) {
  if (!enabled) {
    console.log(`[push:mock] -> ${token.slice(0, 12)}… ${notification.title}`);
    return 'skipped';
  }
  try {
    await admin.messaging().send({
      token,
      notification,
      data: data || {},
      android: { priority: 'high', notification: { channelId: 'price_alerts' } },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    return 'ok';
  } catch (e) {
    const code = e && e.errorInfo && e.errorInfo.code;
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      return 'invalid-token';
    }
    console.error('[push] error enviando:', code || e.message);
    return 'error';
  }
}

module.exports = { init, sendPush, isEnabled: () => enabled };
