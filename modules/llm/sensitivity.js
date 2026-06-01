/**
 * Heurystyczny, w pełni lokalny klasyfikator poufności.
 *
 * Decyduje, czy treść (prompt + kontekst serwera) zawiera dane, których nie
 * należy wysyłać w surowej postaci do zewnętrznego LLM. Działa deterministycznie
 * i offline — sama klasyfikacja nie może niczego wysyłać na zewnątrz.
 *
 * Zwraca: { sensitive: boolean, reasons: string[] }
 */

// Wzorce wskazujące na dane wrażliwe.
const PATTERNS = [
  { re: /\b(pass(word)?|has[łl][oa]|credential|poświadcz\w*|poswiadcz\w*|secret|sekret|token|api[_-]?key|klucz)\b/i, reason: 'sekret/hasło/token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'klucz prywatny' },
  { re: /\bssh-(rsa|ed25519|dss)\b/i, reason: 'klucz SSH' },
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, reason: 'adres e-mail' },
  // Prywatne zakresy IP (RFC1918) + loopback.
  { re: /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1)\b/, reason: 'prywatny adres IP' },
  { re: /\b(prod|produkcyj\w*|production)\b/i, reason: 'środowisko produkcyjne' },
  { re: /\b(\d[ -]?){13,19}\b/, reason: 'możliwy numer karty/konta' },
];

// Pola kontekstu serwera, które same w sobie czynią treść poufną.
function contextIsSensitive(context = {}) {
  const reasons = [];
  if (context.environment && /prod|produkc/i.test(String(context.environment))) {
    reasons.push('serwer produkcyjny');
  }
  if (context.containsCredentials) {
    reasons.push('w kontekście są poświadczenia');
  }
  return reasons;
}

/**
 * @param {string} text
 * @param {Object} [context] – np. serverConfig { environment, host, containsCredentials }
 * @returns {{ sensitive: boolean, reasons: string[] }}
 */
function classifySensitivity(text, context = {}) {
  const reasons = new Set();
  const haystack = String(text || '');

  for (const { re, reason } of PATTERNS) {
    if (re.test(haystack)) {
      reasons.add(reason);
    }
  }
  for (const r of contextIsSensitive(context)) {
    reasons.add(r);
  }

  return {
    sensitive: reasons.size > 0,
    reasons: Array.from(reasons),
  };
}

module.exports = { classifySensitivity };
