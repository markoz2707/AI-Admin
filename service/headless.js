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
 * UWAGA: pełny, uwierzytelniony transport poleceń (RBAC po sesji) to osobny,
 * świadomie wydzielony etap. Tu udostępniamy wyłącznie health/status (read-only,
 * tylko localhost), by nie otwierać niedopracowanej powierzchni ataku.
 */

const http = require('http');
const AppService = require('../modules/service/app-service');

const HOST = process.env.AI_ADMIN_SERVICE_HOST || '127.0.0.1';
const PORT = Number(process.env.AI_ADMIN_SERVICE_PORT || 7733);

async function main() {
  const service = new AppService();
  await service.start();

  const server = http.createServer((req, res) => {
    // Tylko lokalne, read-only endpointy.
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/status')) {
      const body = {
        ok: true,
        startedAt: new Date().toISOString(),
        llm: service.llmManager ? service.llmManager.getLLMStatus() : null,
        connections: service.serverManager.getActiveConnections
          ? service.serverManager.getActiveConnections()
          : [],
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
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
