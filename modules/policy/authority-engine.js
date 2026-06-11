/**
 * Silnik autorytetu — decyduje, czy akcja może być wykonana autonomicznie, czy
 * wymaga nadzoru administratora.
 *
 * Wynik (poziom autorytetu):
 *   AUTONOMOUS  – wykonaj sam, zaloguj
 *   NOTIFY      – wykonaj sam, powiadom (kandydat na deferred-with-veto)
 *   APPROVAL    – wstrzymaj, zapytaj administratora
 *   FORBIDDEN   – nigdy automatycznie
 *
 * Decyzja jest DETERMINISTYCZNA i liczona z metadanych akcji (reversibility,
 * blastRadius, dataLossRisk), oceny guardraila (low/medium/high/critical,
 * self-lockout) oraz kontekstu (środowisko) i polityki admina — nie ze stringa
 * polecenia i nie przez LLM.
 */

const LEVELS = ['AUTONOMOUS', 'NOTIFY', 'APPROVAL', 'FORBIDDEN'];
const idx = (l) => LEVELS.indexOf(l);
const higher = (a, b) => (idx(a) >= idx(b) ? a : b);
function raiseBy(level, n) {
  const i = Math.min(idx(level) + (n || 0), idx('APPROVAL')); // bump nie tworzy FORBIDDEN
  return LEVELS[Math.max(i, 0)];
}

const DEFAULT_POLICY = {
  autonomyEnabled: true,
  // Ile poziomów podnieść wg środowiska (prod ostrożniej).
  environmentBump: { prod: 1, production: 1, stage: 0, staging: 0, dev: 0, test: 0 },
  // Minimalny autorytet per kategoria akcji (np. bezpieczeństwo zawsze approval).
  categoryMin: { security: 'APPROVAL' },
  // Globalny minimalny autorytet.
  minAuthority: 'AUTONOMOUS',
};

/**
 * Ocenia pojedynczą akcję/krok.
 * @param {Object} action – { guard?, metadata?, type? } (krok z buildPlan)
 * @param {Object} [context] – { environment }
 * @param {Object} [policy]
 * @returns {{ authority:string, reasons:string[], requiresSnapshot:boolean }}
 */
function evaluate(action, context = {}, policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const guard = action.guard || {};
  const md = action.metadata || {};
  const reasons = [];

  // Krytyczne polecenia — zakaz bezwzględny.
  if (guard.risk === 'critical') {
    return { authority: 'FORBIDDEN', reasons: ['guardrail: critical'], requiresSnapshot: false };
  }

  let level = 'AUTONOMOUS';

  const selfLockout = (guard.violations || []).some((v) => v && v.selfLockout);
  if (selfLockout) {
    level = higher(level, 'APPROVAL');
    reasons.push('self-lockout (ryzyko odcięcia dostępu)');
  }
  if (md.dataLossRisk === 'high' || md.reversibility === 'irreversible') {
    level = higher(level, 'APPROVAL');
    reasons.push('ryzyko utraty danych / nieodwracalność');
  }
  if (md.blastRadius === 'environment') {
    level = higher(level, 'APPROVAL');
    reasons.push('zasięg: całe środowisko');
  }
  if (guard.risk === 'high') {
    // Reklasyfikacja `sudo`: jeśli JEDYNYM powodem 'high' jest podniesienie
    // uprawnień (sudo) w ramach TYPED ACTION, ryzyko liczymy z metadanych, a nie
    // z obecności sudo (eliminacja approval fatigue dla rutynowych instalacji).
    const highViolations = (guard.violations || []).filter(
      (v) => v && v.severity === 'high' && !v.selfLockout
    );
    const onlySudoHigh =
      highViolations.length > 0 && highViolations.every((v) => /sudo/i.test(v.reason || ''));
    const typed = !!md.category;
    if (onlySudoHigh && typed) {
      level = higher(level, 'NOTIFY');
      reasons.push('sudo w ramach typed action (ryzyko z metadanych)');
    } else {
      level = higher(level, 'APPROVAL');
      reasons.push('guardrail: high');
    }
  }
  if (level === 'AUTONOMOUS' && (guard.risk === 'medium' || md.requiresSnapshot)) {
    // operacje zmieniające stan, ale odwracalne — sam, ale z powiadomieniem
    level = higher(level, 'NOTIFY');
    reasons.push('zmiana stanu (odwracalna)');
  }

  // Podniesienie wg środowiska.
  const bump = p.environmentBump[String(context.environment || '').toLowerCase()] || 0;
  if (bump) {
    const before = level;
    level = raiseBy(level, bump);
    if (level !== before) reasons.push(`środowisko ${context.environment}: +${bump}`);
  }

  // Minimum per kategoria i globalne.
  if (md.category && p.categoryMin[md.category]) {
    level = higher(level, p.categoryMin[md.category]);
  }
  if (p.minAuthority) level = higher(level, p.minAuthority);

  // Autonomia globalnie wyłączona — wszystko co najmniej APPROVAL.
  if (p.autonomyEnabled === false) {
    level = higher(level, 'APPROVAL');
    reasons.push('autonomia wyłączona w polityce');
  }

  if (reasons.length === 0) reasons.push('operacja niskiego ryzyka');
  return { authority: level, reasons, requiresSnapshot: !!md.requiresSnapshot };
}

/**
 * Ocena planu: decyzja per krok + zagregowany maxAuthority.
 * @param {Array} steps
 * @returns {{ steps:Array, maxAuthority:string }}
 */
function evaluatePlan(steps = [], context = {}, policy = {}) {
  let maxAuthority = 'AUTONOMOUS';
  const decided = steps.map((step) => {
    const decision = evaluate(step, context, policy);
    maxAuthority = higher(maxAuthority, decision.authority);
    return { ...step, authority: decision.authority, authorityReasons: decision.reasons };
  });
  return { steps: decided, maxAuthority };
}

module.exports = { evaluate, evaluatePlan, LEVELS, DEFAULT_POLICY };
