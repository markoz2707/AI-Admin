const BaseLLMProvider = require('./base-provider');

/**
 * Provider wewnętrzny / lokalny.
 *
 * Domyślnie kompatybilny z Ollama (http://localhost:11434, endpoint /api/chat),
 * dzięki czemu dane poufne nie opuszczają hosta/sieci. Endpoint i model są
 * konfigurowalne, więc można podpiąć dowolny serwer zgodny z tym API
 * (np. własny wrapper, vLLM za proxy itp.).
 *
 * Używa wbudowanego fetch (Node >= 18).
 */
class LocalLLMProvider extends BaseLLMProvider {
  /**
   * @param {Object} config
   *  - enabled?: boolean
   *  - baseUrl?: string (domyślnie http://localhost:11434)
   *  - model?: string  (np. 'llama3.1', 'qwen2.5')
   *  - timeoutMs?: number
   *  - logger?
   */
  constructor(config = {}) {
    super();
    this.enabled = config.enabled !== false;
    this.baseUrl = (config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    this.model = config.model || null;
    this.timeoutMs = config.timeoutMs || 120000;
    this.logger = config.logger || null;
  }

  get name() {
    return 'local';
  }

  get isLocal() {
    return true;
  }

  isConfigured() {
    return !!(this.enabled && this.baseUrl && this.model);
  }

  async query(prompt, options = {}) {
    return this.queryWithContext([{ role: 'user', content: prompt }], options);
  }

  async queryWithContext(messages, options = {}) {
    if (!this.isConfigured()) {
      throw new Error(
        'LocalLLMProvider nie jest skonfigurowany (brak enabled/baseUrl/model)'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: options.model || this.model,
          messages,
          stream: false,
          options: {
            temperature: options.temperature ?? 0.2,
            num_predict: options.maxTokens || 1024,
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = await response.json();
      // Ollama /api/chat -> { message: { content }, ... }
      const content =
        data && data.message && typeof data.message.content === 'string'
          ? data.message.content
          : null;
      if (content === null) {
        throw new Error('Nieoczekiwany format odpowiedzi lokalnego LLM');
      }
      return content;
    } catch (error) {
      if (this.logger) {
        this.logger.error(`LocalLLMProvider błąd zapytania: ${error.message}`);
      }
      throw new Error(`LLM (local) query failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async checkAvailability() {
    if (!this.isConfigured()) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = LocalLLMProvider;
