const LLMClient = require('./llm-client');

class TaskGenerator {
  constructor(llmClient, logger = null) {
    this.llmClient = llmClient;
    this.logger = logger;
  }

  /**
   * Generuje zadania na podstawie konfiguracji serwera i zainstalowanych aplikacji
   * @param {Object} serverConfig - Konfiguracja serwera
   * @param {Array} installedApps - Lista zainstalowanych aplikacji
   * @param {string} context - Dodatkowy kontekst (np. opis zadania użytkownika)
   * @returns {Promise<Array>} Lista proponowanych zadań
   */
  async generateTasks(serverConfig, installedApps = [], context = '') {
    try {
      const prompt = this.buildTaskGenerationPrompt(serverConfig, installedApps, context);

      if (this.logger) {
        this.logger.log(`Generowanie zadań dla serwera ${serverConfig.serverId}`);
      }

      const response = await this.llmClient.query(prompt, {
        model: 'gpt-4',
        maxTokens: 1500,
        temperature: 0.3
      });

      const tasks = this.parseTasksFromResponse(response);

      if (this.logger) {
        this.logger.log(`Wygenerowano ${tasks.length} zadań dla serwera ${serverConfig.serverId}`);
      }

      return tasks;
    } catch (error) {
      if (this.logger) {
        this.logger.error(`Błąd generowania zadań: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Buduje prompt dla generowania zadań
   * @param {Object} serverConfig - Konfiguracja serwera
   * @param {Array} installedApps - Lista zainstalowanych aplikacji
   * @param {string} context - Dodatkowy kontekst
   * @returns {string} Prompt dla LLM
   */
  buildTaskGenerationPrompt(serverConfig, installedApps, context) {
    const { serverId, os, type, host, hardware = {} } = serverConfig;

    return `
Na podstawie następującej konfiguracji serwera i zainstalowanych aplikacji, zaproponuj logiczne następne zadania do wykonania:

SERWER: ${serverId}
SYSTEM OPERACYJNY: ${os}
TYP POŁĄCZENIA: ${type}
HOST: ${host}
SPRZĘT: CPU: ${hardware.cpu || 'nieznany'}, RAM: ${hardware.ram || 'nieznany'}, DYSK: ${hardware.disk || 'nieznany'}

ZAINSTALOWANE APLIKACJE:
${installedApps.map(app => `- ${app.name} (wersja: ${app.version || 'nieznana'})`).join('\n')}

KONTEKST DODATKOWY: ${context}

Zaproponuj 3-5 następnych zadań, które mogą być przydatne po instalacji tych aplikacji. Każde zadanie powinno zawierać:
- Nazwa zadania
- Opis co należy zrobić
- Priorytet (wysoki/średni/niski)
- Szacowany czas wykonania
- Wymagania wstępne

Odpowiedź w formacie JSON:
{
  "tasks": [
    {
      "name": "Nazwa zadania",
      "description": "Opis zadania",
      "priority": "wysoki|średni|niski",
      "estimatedTime": "szacowany czas",
      "prerequisites": ["wymaganie1", "wymaganie2"]
    }
  ]
}
`;
  }

  /**
   * Parsuje zadania z odpowiedzi LLM
   * @param {string} response - Odpowiedź od LLM
   * @returns {Array} Lista zadań
   */
  parseTasksFromResponse(response) {
    try {
      // Znajdź JSON w odpowiedzi
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Nie znaleziono JSON w odpowiedzi LLM');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.tasks || [];
    } catch (error) {
      if (this.logger) {
        this.logger.error(`Błąd parsowania odpowiedzi LLM: ${error.message}`);
      }
      // Fallback - zwróć pustą listę
      return [];
    }
  }

  /**
   * Generuje zadania dla konkretnej aplikacji
   * @param {string} appName - Nazwa aplikacji
   * @param {Object} serverConfig - Konfiguracja serwera
   * @returns {Promise<Array>} Lista zadań specyficznych dla aplikacji
   */
  async generateAppSpecificTasks(appName, serverConfig) {
    try {
      const prompt = `
Dla aplikacji "${appName}" zainstalowanej na serwerze ${serverConfig.os}, zaproponuj zadania konfiguracyjne i optymalizacyjne.

Odpowiedź w formacie JSON jak poprzednio.
`;

      const response = await this.llmClient.query(prompt, {
        model: 'gpt-4',
        maxTokens: 1000,
        temperature: 0.3
      });

      return this.parseTasksFromResponse(response);
    } catch (error) {
      if (this.logger) {
        this.logger.error(`Błąd generowania zadań dla aplikacji ${appName}: ${error.message}`);
      }
      return [];
    }
  }

  /**
   * Generuje zadania na podstawie analizy logów lub błędów
   * @param {Array} logs - Lista logów lub błędów
   * @param {Object} serverConfig - Konfiguracja serwera
   * @returns {Promise<Array>} Lista zadań naprawczych
   */
  async generateFixTasks(logs, serverConfig) {
    try {
      const logsText = logs.map(log => `[${log.level}] ${log.message}`).join('\n');

      const prompt = `
Na podstawie następujących logów z serwera ${serverConfig.serverId} (${serverConfig.os}), zaproponuj zadania naprawcze:

LOGS:
${logsText}

Odpowiedź w formacie JSON jak poprzednio, skupiając się na problemach i ich rozwiązaniach.
`;

      const response = await this.llmClient.query(prompt, {
        model: 'gpt-4',
        maxTokens: 1200,
        temperature: 0.2
      });

      return this.parseTasksFromResponse(response);
    } catch (error) {
      if (this.logger) {
        this.logger.error(`Błąd generowania zadań naprawczych: ${error.message}`);
      }
      return [];
    }
  }
}

module.exports = TaskGenerator;