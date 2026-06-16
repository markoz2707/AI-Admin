/**
 * Tick utrzymania (jeden cykl pętli agenta): perceive → [poison-guard] → goal →
 * plan → execute. Zależności są wstrzykiwane, więc orchestracja jest testowalna,
 * a w produkcji spina kolektor środowiska, `buildPlan` i `executeAutonomously`.
 *
 * Twarda zasada bezpieczeństwa: serwery, których percepcja nosi znamiona
 * wstrzyknięcia (snapshot.perceptionWarnings), są POMIJANE — nie podejmujemy
 * decyzji na danych z potencjalnie skompromitowanego hosta.
 *
 * Autonomia jest opt-in (autoExecute); bez goalProvider tick tylko percypuje.
 */

function createMaintenanceTick(deps = {}) {
  const {
    listServers,
    collect,
    goalProvider = null,
    buildPlan,
    executeAutonomously,
    logger = null,
    autoExecute = false,
  } = deps;

  if (typeof listServers !== 'function' || typeof collect !== 'function') {
    throw new Error('maintenance-tick wymaga listServers() i collect()');
  }

  return async function tick() {
    const summary = { perceived: 0, poisoned: 0, proposed: 0, executed: 0, errors: 0 };
    let servers = [];
    try {
      servers = await listServers();
    } catch (e) {
      if (logger) logger.error('Tick utrzymania: nie można pobrać serwerów', e);
      summary.errors++;
      return summary;
    }

    for (const server of servers) {
      let snapshot;
      try {
        snapshot = await collect(server);
      } catch (e) {
        summary.errors++;
        if (logger) logger.error('Tick utrzymania: błąd percepcji', e, { serverId: server.id });
        continue;
      }
      summary.perceived++;

      // Poison-guard: nie działamy na serwerze z zatrutą percepcją.
      if (snapshot && Array.isArray(snapshot.perceptionWarnings) && snapshot.perceptionWarnings.length) {
        summary.poisoned++;
        if (logger) {
          logger.warn('Tick utrzymania: pomijam serwer z zatrutą percepcją', {
            serverId: server.id,
            warnings: snapshot.perceptionWarnings.length,
          });
        }
        continue;
      }

      if (!goalProvider) continue;

      let goal;
      try {
        goal = await goalProvider(server, snapshot);
      } catch (e) {
        summary.errors++;
        if (logger) logger.error('Tick utrzymania: błąd goalProvider', e, { serverId: server.id });
        continue;
      }
      if (!goal) continue; // brak dryfu / nic do zrobienia

      let plan;
      try {
        plan = await buildPlan(goal, server.id);
        summary.proposed++;
      } catch (e) {
        summary.errors++;
        if (logger) logger.error('Tick utrzymania: błąd buildPlan', e, { serverId: server.id });
        continue;
      }

      if (autoExecute) {
        try {
          await executeAutonomously(server.id, plan.planId, { planHash: plan.planHash });
          summary.executed++;
        } catch (e) {
          summary.errors++;
          if (logger) logger.error('Tick utrzymania: błąd wykonania', e, { serverId: server.id });
        }
      }
    }

    if (logger) logger.info('Tick utrzymania: cykl zakończony', summary);
    return summary;
  };
}

module.exports = { createMaintenanceTick };
