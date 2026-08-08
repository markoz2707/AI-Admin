/**
 * Wykrywanie dryfu względem stanu pożądanego (desired-state).
 *
 * Porównuje migawkę środowiska (z environment-collector) z deklaratywną
 * specyfikacją stanu pożądanego i zwraca listę rozbieżności oraz zadania
 * remediacji (zgodne z typed actions — `service`/`installation`), gotowe do
 * `LLMManager.buildPlanFromTasks` (bez udziału LLM).
 *
 * desiredState (przykład):
 *   {
 *     services: { nginx: 'running', cron: 'running' },
 *     packages: ['curl', 'htop']
 *   }
 *
 * Deterministyczne i offline.
 */

function serviceLooksActive(svc) {
  const status = String((svc && (svc.status || svc.sub)) || '').toLowerCase();
  // \b zapobiega dopasowaniu "active" wewnątrz "inactive".
  return /\b(running|active)\b/.test(status);
}

/**
 * @param {Object} snapshot – migawka z environment-collector
 * @param {Object} desiredState
 * @returns {{ drifted:boolean, issues:Array, tasks:Array }}
 */
function detectDrift(snapshot = {}, desiredState = {}) {
  const issues = [];
  const tasks = [];

  const services = Array.isArray(snapshot.services) ? snapshot.services : [];
  const packages = Array.isArray(snapshot.packages) ? snapshot.packages : [];

  // Usługi, które mają działać.
  const desiredServices = desiredState.services || {};
  for (const [name, expected] of Object.entries(desiredServices)) {
    if (String(expected).toLowerCase() !== 'running') continue;
    const found = services.find((s) => s && (s.name === name || s.name === `${name}.service`));
    if (!found || !serviceLooksActive(found)) {
      issues.push({ type: 'service', resource: name, expected: 'running', actual: found ? found.status : 'absent' });
      tasks.push({ type: 'service', serviceName: name, action: 'start', description: `Uruchom usługę ${name}` });
    }
  }

  // Pakiety, które mają być zainstalowane.
  const desiredPackages = Array.isArray(desiredState.packages) ? desiredState.packages : [];
  for (const pkg of desiredPackages) {
    const installed = packages.some((p) => p && (p.name === pkg || p === pkg));
    if (!installed) {
      issues.push({ type: 'package', resource: pkg, expected: 'installed', actual: 'absent' });
      tasks.push({ type: 'installation', packageName: pkg, description: `Zainstaluj pakiet ${pkg}` });
    }
  }

  return { drifted: issues.length > 0, issues, tasks };
}

/**
 * Fabryka goalProvider/planProvider dla pętli utrzymania opartej o desired-state.
 * Zwraca funkcję (server, snapshot) -> { tasks, summary } | null (gdy brak dryfu).
 * @param {Function|Object} desiredStateFor – mapa serverId->spec albo funkcja(server)->spec
 */
function createDesiredStateGoal(desiredStateFor) {
  const specFor = (server) =>
    typeof desiredStateFor === 'function'
      ? desiredStateFor(server)
      : (desiredStateFor || {})[server.id] || (desiredStateFor || {})[String(server.id)];

  return (server, snapshot) => {
    const spec = specFor(server) || {};
    const drift = detectDrift(snapshot, spec);
    if (!drift.drifted) return null;
    return {
      tasks: drift.tasks,
      summary: `Remediacja dryfu na serwerze ${server.id}: ${drift.issues
        .map((i) => `${i.type}:${i.resource}`)
        .join(', ')}`,
      issues: drift.issues,
    };
  };
}

module.exports = { detectDrift, createDesiredStateGoal };
