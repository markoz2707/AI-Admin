/**
 * Schemat i normalizacja planu wykonania.
 *
 * LLM (lub warstwa budująca plan) musi dostarczyć STRUKTURALNY plan, a nie prozę.
 * Ten moduł parsuje i normalizuje wejście do stabilnego kształtu:
 *
 *   {
 *     summary: string,
 *     steps: [
 *       { id, type, description, os?, command?, serviceName?, action?, packageName? }
 *     ]
 *   }
 *
 * Surowe wejście może być obiektem lub stringiem JSON (np. odpowiedź LLM, z
 * której wycinamy pierwszy blok {...}). Kroki bez sensownej treści są odrzucane.
 */

const ALLOWED_TYPES = new Set([
  'command',
  'service',
  'package',
  'installation',
  'noop',
]);

function extractJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('Nie znaleziono obiektu JSON w treści planu');
  }
  return JSON.parse(match[0]);
}

function normalizeType(t) {
  const type = String(t || '').toLowerCase();
  return ALLOWED_TYPES.has(type) ? type : 'command';
}

/**
 * Normalizuje pojedynczy krok. Zwraca null, jeśli krok jest pusty/niewykonalny.
 */
function normalizeStep(raw, index) {
  if (!raw || typeof raw !== 'object') return null;

  const type = normalizeType(raw.type);
  const step = {
    id: raw.id || `step_${index + 1}`,
    type,
    description: raw.description || raw.name || '',
    os: raw.os ? String(raw.os).toLowerCase() : undefined,
  };

  if (type === 'service') {
    step.serviceName = raw.serviceName || raw.name || null;
    step.action = (raw.action || '').toLowerCase() || null;
    if (!step.serviceName || !step.action) return null;
    return step;
  }

  if (type === 'package' || type === 'installation') {
    step.packageName = raw.packageName || raw.app || raw.name || null;
    if (!step.packageName) return null;
    return step;
  }

  if (type === 'noop') {
    return step;
  }

  // type === 'command'
  step.command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!step.command) return null;
  return step;
}

/**
 * Parsuje i waliduje plan.
 * @param {string|Object} raw
 * @returns {{ summary:string, steps:Array }}
 */
function parsePlan(raw) {
  const obj = extractJson(raw);
  const rawSteps = Array.isArray(obj.steps)
    ? obj.steps
    : Array.isArray(obj.tasks)
    ? obj.tasks
    : [];

  const steps = [];
  rawSteps.forEach((s, i) => {
    const norm = normalizeStep(s, i);
    if (norm) steps.push(norm);
  });

  return {
    summary: obj.summary || obj.plan || '',
    steps,
  };
}

/**
 * Buduje plan z listy "tasks" (zgodnych z dotychczasowym PromptProcessor).
 * @param {Array} tasks
 * @param {string} summary
 */
function planFromTasks(tasks = [], summary = '') {
  const steps = [];
  tasks.forEach((t, i) => {
    const norm = normalizeStep(t, i);
    if (norm) steps.push(norm);
  });
  return { summary, steps };
}

module.exports = {
  parsePlan,
  planFromTasks,
  normalizeStep,
  ALLOWED_TYPES,
};
