const OpenAI = require('openai');

class LLMClient {
  constructor(apiKey, logger = null) {
    this.client = new OpenAI({
      apiKey: apiKey
    });
    this.logger = logger;
  }

  /**
   * Wysyła zapytanie do LLM i zwraca odpowiedź
   * @param {string} prompt - Prompt dla modelu
   * @param {Object} options - Opcje zapytania
   * @param {string} options.model - Model do użycia (domyślnie gpt-4)
   * @param {number} options.maxTokens - Maksymalna liczba tokenów
   * @param {number} options.temperature - Temperatura (0-2)
   * @returns {Promise<string>} Odpowiedź od LLM
   */
  async query(prompt, options = {}) {
    try {
      const {
        model = 'gpt-4',
        maxTokens = 1000,
        temperature = 0.7
      } = options;

      if (this.logger) {
        this.logger.log(`Wysyłanie zapytania do LLM: ${prompt.substring(0, 100)}...`);
      }

      const response = await this.client.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: temperature
      });

      const result = response.choices[0].message.content;

      if (this.logger) {
        this.logger.log(`Otrzymano odpowiedź od LLM (${result.length} znaków)`);
      }

      return result;
    } catch (error) {
      if (this.logger) {
        this.logger.error(`Błąd podczas zapytania do LLM: ${error.message}`);
      }
      throw new Error(`LLM query failed: ${error.message}`);
    }
  }

  /**
   * Wysyła zapytanie z kontekstem rozmowy
   * @param {Array} messages - Tablica wiadomości w formacie [{role: 'user'|'assistant', content: '...'}]
   * @param {Object} options - Opcje zapytania
   * @returns {Promise<string>} Odpowiedź od LLM
   */
  async queryWithContext(messages, options = {}) {
    try {
      const {
        model = 'gpt-4',
        maxTokens = 1000,
        temperature = 0.7
      } = options;

      if (this.logger) {
        this.logger.log(`Wysyłanie zapytania z kontekstem (${messages.length} wiadomości)`);
      }

      const response = await this.client.chat.completions.create({
        model: model,
        messages: messages,
        max_tokens: maxTokens,
        temperature: temperature
      });

      const result = response.choices[0].message.content;

      if (this.logger) {
        this.logger.log(`Otrzymano odpowiedź od LLM z kontekstem (${result.length} znaków)`);
      }

      return result;
    } catch (error) {
      if (this.logger) {
        this.logger.error(`Błąd podczas zapytania z kontekstem do LLM: ${error.message}`);
      }
      throw new Error(`LLM query with context failed: ${error.message}`);
    }
  }

  /**
   * Sprawdza dostępność API
   * @returns {Promise<boolean>}
   */
  async checkAvailability() {
    try {
      await this.query('Test connection', { maxTokens: 10 });
      return true;
    } catch (error) {
      if (this.logger) {
        this.logger.error(`LLM API niedostępny: ${error.message}`);
      }
      return false;
    }
  }
}

module.exports = LLMClient;