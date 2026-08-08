/**
 * Bazowy interfejs providera LLM.
 *
 * Każdy provider (zewnętrzny/chmurowy lub wewnętrzny/lokalny) implementuje ten
 * sam kontrakt, dzięki czemu LLMRouter może je wymieniać przezroczyście.
 *
 * Kontrakt:
 *   get name(): string            – identyfikator (np. 'openai', 'local')
 *   get isLocal(): boolean        – czy działa lokalnie (dane nie opuszczają hosta)
 *   isConfigured(): boolean       – czy provider ma komplet konfiguracji
 *   query(prompt, options)        – pojedyncze zapytanie tekstowe -> string
 *   queryWithContext(messages, o) – zapytanie z historią wiadomości -> string
 *   checkAvailability()           – health-check -> boolean
 */
class BaseLLMProvider {
  /** @returns {string} */
  get name() {
    throw new Error('not implemented');
  }

  /** @returns {boolean} czy provider jest lokalny (dane nie wychodzą na zewnątrz) */
  get isLocal() {
    return false;
  }

  /** @returns {boolean} */
  isConfigured() {
    return false;
  }

  /**
   * @param {string} _prompt
   * @param {Object} [_options]
   * @returns {Promise<string>}
   */
  async query(_prompt, _options = {}) {
    throw new Error('not implemented');
  }

  /**
   * @param {Array<{role: string, content: string}>} _messages
   * @param {Object} [_options]
   * @returns {Promise<string>}
   */
  async queryWithContext(_messages, _options = {}) {
    throw new Error('not implemented');
  }

  /** @returns {Promise<boolean>} */
  async checkAvailability() {
    return false;
  }
}

module.exports = BaseLLMProvider;
