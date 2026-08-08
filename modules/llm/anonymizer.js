/**
 * Odwracalna anonimizacja (pseudonimizacja) danych przed wysłaniem do
 * zewnętrznego LLM oraz de-anonimizacja jego odpowiedzi.
 *
 * Wzorzec: lokalna warstwa zastępuje wrażliwe encje (hosty, IP, e-maile,
 * ścieżki, sekrety) stabilnymi placeholderami typu ⟦HOST_1⟧, zachowując mapę
 * odwrotną. Do zewnętrznego modelu trafia wyłącznie zanonimizowany tekst;
 * jego odpowiedź jest następnie odtwarzana lokalnie.
 *
 * To deterministyczna implementacja heurystyczna (offline). Stanowi punkt
 * rozszerzenia pod anonimizację wspomaganą lokalnym LLM (NER) w przyszłości.
 */

// Kolejność MA znaczenie: najpierw najbardziej specyficzne/najdłuższe encje.
const RULES = [
  { type: 'SECRET', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { type: 'SECRET', re: /\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]+/g },
  { type: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'IP', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|\d{1,3}(?:\.\d{1,3}){3})\b/g },
  { type: 'UNCPATH', re: /\\\\[A-Za-z0-9._$-]+\\[^\s"']+/g },
  { type: 'WINPATH', re: /\b[A-Za-z]:\\[^\s"']+/g },
  { type: 'HOST', re: /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi },
];

class Anonymizer {
  constructor() {
    // value -> token oraz token -> value
    this._valueToToken = new Map();
    this._tokenToValue = new Map();
    this._counters = Object.create(null);
  }

  _tokenFor(type, value) {
    if (this._valueToToken.has(value)) {
      return this._valueToToken.get(value);
    }
    this._counters[type] = (this._counters[type] || 0) + 1;
    const token = `[[${type}_${this._counters[type]}]]`;
    this._valueToToken.set(value, token);
    this._tokenToValue.set(token, value);
    return token;
  }

  /**
   * Zwraca zanonimizowaną wersję tekstu. Mapa odwrotna kumuluje się w instancji,
   * dzięki czemu wiele wywołań (np. kolejne wiadomości) jest spójnych.
   * @param {string} text
   * @returns {string}
   */
  anonymize(text) {
    let out = String(text == null ? '' : text);
    for (const { type, re } of RULES) {
      out = out.replace(re, (match) => this._tokenFor(type, match));
    }
    return out;
  }

  /**
   * Odtwarza oryginalne wartości w tekście (np. w odpowiedzi zewnętrznego LLM).
   * @param {string} text
   * @returns {string}
   */
  deanonymize(text) {
    let out = String(text == null ? '' : text);
    for (const [token, value] of this._tokenToValue) {
      out = out.split(token).join(value);
    }
    return out;
  }

  /** Anonimizuje tablicę wiadomości chat ([{role, content}]). */
  anonymizeMessages(messages) {
    return (messages || []).map((m) => ({
      ...m,
      content: this.anonymize(m.content),
    }));
  }

  /** Liczba zmapowanych encji (diagnostyka/telemetria). */
  get size() {
    return this._tokenToValue.size;
  }

  /** Mapowania (tylko do logów/diagnostyki — NIE wysyłać na zewnątrz). */
  mappings() {
    return Array.from(this._tokenToValue.entries()).map(([token, value]) => ({
      token,
      value,
    }));
  }
}

module.exports = { Anonymizer };
