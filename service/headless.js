#!/usr/bin/env node
/**
 * Headless runner — uruchamia control plane AI-Admin BEZ Electrona.
 *
 * To realizuje zasadę „Electron = UI, control plane = zawsze-włączona usługa".
 * Ten sam kod backendu (AppService) działa jako proces usługi: wykonuje
 * migracje, przygotowuje journal wykonania, odzyskuje przerwane plany i
 * inicjalizuje LLMManager. Wystawia lokalny endpoint /health do monitoringu.
 *
 * Uruchomienie:  npm run start:service
 * Konfiguracja:  AI_ADMIN_SERVICE_PORT (domyślnie 7733), AI_ADMIN_SERVICE_HOST
 *                (domyślnie 127.0.0.1 — tylko pętla lokalna).
 *
 * Endpointy (tylko localhost):
 *  - GET  /health, /status            — status (read-only),
 *  - POST /rpc { channel, payload }    — uwierzytelniony dyspozytor poleceń;
 *      token sesji w nagłówku 'x-session-token' lub w payload.sessionToken.
 *      Sesję uzyskuje się przez kanał publiczny 'auth:login'. RBAC egzekwowany
 *      w AppService.dispatch.
 */

const MAX_BODY = 1 << 20; // 1 MiB

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const http = require('http');
const AppService = require('../modules/service/app-service');

const HOST = process.env.AI_ADMIN_SERVICE_HOST || '127.0.0.1';
const PORT = Number(process.env.AI_ADMIN_SERVICE_PORT || 7733);

async function main() {
  const service = new AppService();
  await service.start();

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    // Health/status (read-only).
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/status')) {
      return sendJson(res, 200, {
        ok: true,
        startedAt: new Date().toISOString(),
        llm: service.llmManager ? service.llmManager.getLLMStatus() : null,
        connections: service.serverManager.getActiveConnections
          ? service.serverManager.getActiveConnections()
          : [],
      });
    }

    // Uwierzytelniony dyspozytor poleceń.
    if (req.method === 'POST' && req.url === '/rpc') {
      try {
        const body = await readJsonBody(req);
        const channel = body.channel;
        if (!channel || typeof channel !== 'string') {
          return sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'brak channel' } });
        }
        const payload = { ...(body.payload || {}) };
        // Token z nagłówka ma pierwszeństwo (nie ląduje w body logów aplikacji UI).
        const headerToken = req.headers['x-session-token'];
        if (headerToken) payload.sessionToken = headerToken;
        const result = await service.dispatch(channel, payload);
        return sendJson(res, result.ok ? 200 : 400, result);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: e.message } });
      }
    }

    return sendJson(res, 404, { ok: false, error: { code: 'not_found' } });
  });

  server.listen(PORT, HOST, () => {
    service.logger.info(`Headless control plane nasłuchuje na http://${HOST}:${PORT} (health/status)`);
  });

  // Czyste zamknięcie.
  const shutdown = async (signal) => {
    service.logger.info(`Otrzymano ${signal} — zamykanie...`);
    server.close();
    await service.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[headless] Krytyczny błąd startu:', err);
  process.exit(1);
});
