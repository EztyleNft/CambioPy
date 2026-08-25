# Cambio Py — Backend liviano (alertas push)

Servidor Node mínimo que hace lo que la versión sin-servidor no puede: **enviar notificaciones push instantáneas y confiables** cuando una cotización llega al valor que el usuario pidió, sin depender de que su teléfono despierte solo.

Qué hace:
- Refresca cotizaciones (mismas fuentes que la app: dolarpy + open.er-api) cada `POLL_MINUTES`.
- Guarda cada dispositivo con su token de FCM y sus alertas.
- Evalúa las alertas del lado del servidor y manda **push por FCM**.
- Expone `GET /rates` para que la app pueda usar el backend como fuente de datos (más robusto que el scraping desde el cliente).

Sin base de datos: todo se guarda en `data/data.json`. Sin credenciales de Firebase, igual corre en “modo mock” (evalúa y loguea, pero no envía push) — ideal para probarlo ya.

---

## 1. Correr en local

```bash
cd backend
npm install
cp .env.example .env      # opcional, hay defaults sensatos
npm start
```

Verificá:

```bash
curl http://localhost:8080/health
```

Debería responder `{ "ok": true, "pushEnabled": false, ... }`. `pushEnabled:false` es normal hasta configurar Firebase (paso 3).

---

## 2. Endpoints

| Método | Ruta | Body | Para qué |
|---|---|---|---|
| GET | `/health` | — | Estado del servidor |
| GET | `/rates` | — | Cotizaciones actuales (USD/BRL/ARS) |
| POST | `/register` | `{ token, platform, alerts }` | Alta/actualización de un dispositivo + sus alertas |
| PUT | `/devices/:token/alerts` | `{ alerts }` | Actualizar solo las alertas |
| DELETE | `/devices/:token` | — | Borrar un dispositivo |
| POST | `/test-push` | `{ token }` | Enviar una push de prueba |

`alerts` usa el mismo formato que la app (`PriceAlert.toJson`):
```json
{ "id":"...", "currency":"USD", "side":"venta", "direction":"below",
  "threshold":5900, "enabled":true, "note":"", "wasMet":false, "lastTriggered":null }
```

Si definís `API_KEY` en `.env`, todas las rutas (menos `/health`) exigen el header `x-api-key`.

---

## 3. Activar push real (Firebase Cloud Messaging)

1. Entrá a https://console.firebase.google.com y creá un proyecto (gratis).
2. **Project settings → Service accounts → Generate new private key**. Descargá el JSON.
3. Dale la credencial al backend de una de estas dos formas:
   - **Archivo**: guardalo como `backend/service-account.json`, o apuntá `GOOGLE_APPLICATION_CREDENTIALS` a su ruta.
   - **Variable de entorno** (más cómodo en la nube): pegá **todo el JSON** en la variable `FIREBASE_SERVICE_ACCOUNT`.
4. Reiniciá: `npm start`. Ahora `/health` muestra `pushEnabled: true`.

El **mismo proyecto de Firebase** se usa en la app Flutter para obtener el token FCM (ver `../flutter_push/README.md`).

---

## 4. Desplegar gratis (Render + cron externo)

Camino 100% gratis y sin tarjeta, recomendado:

1. Subí este backend a un repo de **GitHub** (solo la carpeta `backend/`).
2. En **https://render.com** → **New → Web Service** → conectá el repo.
   - **Root Directory**: `backend`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - Plan **Free**.
3. En **Environment** agregá:
   - `FIREBASE_SERVICE_ACCOUNT` = (pegá todo el JSON de la service account)
   - `API_KEY` = una clave inventada (opcional pero recomendado)
   - `POLL_MINUTES` = `10`
4. Deploy. Te queda una URL tipo `https://cambio-py.onrender.com`. Verificá `…/health`.
5. **Mantenerlo despierto + evaluar** (el free de Render duerme por inactividad): en **https://cron-job.org** (gratis) creá un job que haga GET a `https://TU-URL/poll` cada 10 min. Si usaste `API_KEY`, agregá el header `x-api-key`. Ese ping despierta el server y dispara la evaluación de alertas.

> El backend igual corre `node-cron` internamente; el cron externo es el que garantiza que funcione aunque el host se duerma.

**Alternativas**: Fly.io (free allowance, queda siempre prendido, pide tarjeta sin cobro) o un VPS/Raspberry con `pm2 start src/index.js --name cambio-py`.

Para escalar a miles de usuarios, migrá `data.json` a SQLite/Postgres (la interfaz de `store.js` está aislada para que sea un cambio chico).

---

## 5. Cómo se conecta con la app

La app manda sus alertas y su token FCM a `POST /register` cada vez que cambian. El backend hace el resto. La integración del lado Flutter (paquetes, `PushService`, wiring) está en [`../flutter_push/`](../flutter_push/README.md).
