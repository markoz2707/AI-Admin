const OpenAI = require('openai');
const BaseLLMProvider = require('./base-provider');

/**
 * Provider zewnętrzny (chmurowy) oparty o OpenAI.
 * UWAGA: dane wysyłane tutaj opuszczają hosta — nie wolno przesyłać surowych
 * danych poufnych (od tego jest router + anonimizacja).
 */
class OpenAIProvider extends BaseLLMProvider {
  /**
   * @param {Object} config
   *  - apiKey: string
   *  - model?: string (domyślnie 'gpt-4o-mini')
   *  - logger?
   */
  constructor(config = {}) {
    super();
    this.apiKey = config.apiKey || null;
    this.model = config.model || 'gpt-4o-mini';
    this.logger = config.logger || null;
    this.client = this.apiKey ? new OpenAI({ apiKey: this.apiKey }) : null;
  }

  get name() {
    return 'openai';
  }

  get isLocal() {
    return false;
  }

  isConfigured() {
    return !!this.apiKey;
  }

  _resolveOptions(options = {}) {
    return {
      model: options.model || this.model,
      maxTokens: options.maxTokens || 1000,
      temperature: options.temperature ?? 0.7,
    };
  }

  async query(prompt, options = {}) {
    return this.queryWithContext([{ role: 'user', content: prompt }], options);
  }

  async queryWithContext(messages, options = {}) {
    if (!this.client) {
      throw new Error('OpenAIProvider nie jest skonfigurowany (brak apiKey)');
    }
    const { model, maxTokens, temperature } = this._resolveOptions(options);
    try {
      const response = await this.client.chat.completions.create({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      });
      return response.choices[0].message.content;
    } catch (error) {
      if (this.logger) {
        this.logger.error(`OpenAIProvider błąd zapytania: ${error.message}`);
      }
      throw new Error(`LLM (openai) query failed: ${error.message}`);
    }
  }

  async checkAvailability() {
    if (!this.isConfigured()) return false;
    try {
      await this.query('ping', { maxTokens: 5 });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = OpenAIProvider;
