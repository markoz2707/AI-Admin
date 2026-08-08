const OpenAIProvider = require('./providers/openai-provider');
const LocalLLMProvider = require('./providers/local-provider');
const { classifySensitivity } = require('./sensitivity');
const { Anonymizer } = require('./anonymizer');

/**
 * LLMRouter
 *
 * Wybiera provider (wewnętrzny/lokalny vs zewnętrzny) dla każdego zapytania na
 * podstawie polityki i klasyfikacji poufności. Implementuje ten sam interfejs
 * co dawny LLMClient (query / queryWithContext / checkAvailability), więc jest
 * podmianą "drop-in" w TaskGenerator/PromptProcessor.
 *
 * Polityki (config.policy):
 *  - 'auto'      : dane poufne -> lokalny; jeśli brak lokalnego, a dozwolona
 *                  anonimizacja -> anonimizacja + zewnętrzny; inaczej dane
 *                  niepoufne -> zewnętrzny (lub lokalny w razie braku).
 *  - 'local'     : zawsze lokalny.
 *  - 'openai'    : zawsze zewnętrzny (surowo).
 *  - 'anonymize' : zawsze zewnętrzny, ale dane poufne anonimizowane.
 *
 * Gdy dane są poufne i nie da się ich bezpiecznie obsłużyć (brak lokalnego i
 * brak zgody na anonimizację), router ODMAWIA wysyłki (rzuca błąd z kodem
 * LLM_SENSITIVE_BLOCKED) zamiast wyciekać dane na zewnątrz.
 */
class LLMRouter {
  constructor(config = {}) {
    this.logger = config.logger || null;
    this.setConfig(config);
  }

  setConfig(config = {}) {
    this.policy = config.policy || 'auto';
    this.allowAnonymization = config.allowAnonymization !== false;
    this.external = new OpenAIProvider({ ...(config.external || {}), logger: this.logger });
    this.local = new LocalLLMProvider({ ...(config.local || {}), logger: this.logger });
  }

  /**
   * Wyznacza decyzję routingu BEZ wysyłania zapytania (do audytu/testów).
   * @param {string} text
   * @param {Object} [options] – { context, sensitive }
   * @returns {{ provider: 'local'|'openai', mode: 'raw'|'anonymize'|'blocked', sensitive: boolean, reasons: string[] }}
   */
  decide(text, options = {}) {
    const classification =
      typeof options.sensitive === 'boolean'
        ? { sensitive: options.sensitive, reasons: ['override'] }
        : classifySensitivity(text, options.context || {});
    const { sensitive, reasons } = classification;

    const localOk = this.local.isConfigured();
    const externalOk = this.external.isConfigured();

    if (this.policy === 'local') {
      return { provider: 'local', mode: 'raw', sensitive, reasons };
    }
    if (this.policy === 'openai') {
      return { provider: 'openai', mode: 'raw', sensitive, reasons };
    }
    if (this.policy === 'anonymize') {
      return {
        provider: 'openai',
        mode: sensitive ? 'anonymize' : 'raw',
        sensitive,
        reasons,
      };
    }

    // policy === 'auto'
    if (sensitive) {
      if (localOk) return { provider: 'local', mode: 'raw', sensitive, reasons };
      if (externalOk && this.allowAnonymization) {
        return { provider: 'openai', mode: 'anonymize', sensitive, reasons };
      }
      return { provider: 'openai', mode: 'blocked', sensitive, reasons };
    }
    // niepoufne
    if (externalOk) return { provider: 'openai', mode: 'raw', sensitive, reasons };
    if (localOk) return { provider: 'local', mode: 'raw', sensitive, reasons };
    return { provider: 'openai', mode: 'raw', sensitive, reasons };
  }

  _providerByName(name) {
    return name === 'local' ? this.local : this.external;
  }

  async query(prompt, options = {}) {
    return this.queryWithContext([{ role: 'user', content: prompt }], options);
  }

  async queryWithContext(messages, options = {}) {
    const joined = (messages || []).map((m) => m.content).join('\n');
    const decision = this.decide(joined, options);

    if (this.logger) {
      this.logger.info('LLM routing', {
        provider: decision.provider,
        mode: decision.mode,
        sensitive: decision.sensitive,
        reasons: decision.reasons,
      });
    }

    if (decision.mode === 'blocked') {
      const err = new Error(
        `Wykryto dane poufne (${decision.reasons.join(', ')}), a brak lokalnego LLM i zgody na anonimizację — odmawiam wysłania do zewnętrznego providera.`
      );
      err.code = 'LLM_SENSITIVE_BLOCKED';
      throw err;
    }

    const provider = this._providerByName(decision.provider);

    if (decision.mode === 'anonymize') {
      // Lokalna anonimizacja -> zewnętrzny LLM -> lokalna de-anonimizacja.
      const anon = new Anonymizer();
      const safeMessages = anon.anonymizeMessages(messages);
      const response = await provider.queryWithContext(safeMessages, options);
      return anon.deanonymize(response);
    }

    return provider.queryWithContext(messages, options);
  }

  async checkAvailability() {
    // Dostępny, jeśli którykolwiek provider odpowiada.
    const [extOk, locOk] = await Promise.all([
      this.external.isConfigured() ? this.external.checkAvailability() : Promise.resolve(false),
      this.local.isConfigured() ? this.local.checkAvailability() : Promise.resolve(false),
    ]);
    return extOk || locOk;
  }

  /** Status konfiguracji providerów (diagnostyka/UI). */
  getStatus() {
    return {
      policy: this.policy,
      allowAnonymization: this.allowAnonymization,
      external: { name: 'openai', configured: this.external.isConfigured() },
      local: {
        name: 'local',
        configured: this.local.isConfigured(),
        baseUrl: this.local.baseUrl,
        model: this.local.model,
      },
    };
  }
}

module.exports = LLMRouter;
