const TaskGenerator = require('./task-generator');

class PromptProcessor {
  constructor(taskGenerator, logger = null) {
    this.taskGenerator = taskGenerator;
    this.logger = logger;
  }

  /**
   * Przetwarza prompt użytkownika i generuje zadania
   * @param {string} prompt - Prompt użytkownika
   * @param {Object} serverConfig - Konfiguracja serwera
   * @param {Array} installedApps - Lista zainstalowanych aplikacji
   * @returns {Promise<Object>} Wynik przetwarzania z zadaniami
   */
  async processPrompt(prompt, serverConfig, installedApps = []) {
    try {
      if (this.logger) {
        this.logger.log(`Przetwarzanie promptu: "${prompt.substring(0, 100)}..."`);
      }

      // Analiza promptu
      const analysis = await this.analyzePrompt(prompt);

      // Generowanie zadań na podstawie analizy
      const tasks = await this.generateTasksFromAnalysis(analysis, serverConfig, installedApps);

      // Budowanie planu
      const plan = `Plan wygenerowany dla promptu: "${prompt}". 
Główny cel: ${analysis.intent}. 
Aplikacje docelowe: ${analysis.targetApps.join(', ') || 'brak'}.
Wygenerowano ${tasks.length} zadań.`;

      const result = {
        originalPrompt: prompt,
        plan: plan,
        analysis: analysis,
        tasks: tasks,
        serverId: serverConfig.serverId,
        timestamp: new Date().toISOString()
      };

      if (this.logger) {
        this.logger.log(`Przetworzono prompt - wygenerowano ${tasks.length} zadań`);
      }

      return result;
    } catch (error) {
      if (this.logger) {
        this.logger.error(`Błąd przetwarzania promptu: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Analizuje prompt użytkownika przy użyciu LLM
   * @param {string} prompt - Prompt do analizy
   * @returns {Promise<Object>} Analiza promptu
   */
  async analyzePrompt(prompt) {
    try {
      const analysisPrompt = `
Przeanalizuj następujący prompt użytkownika dotyczący zarządzania serwerami i wydobądź kluczowe informacje:

PROMPT: "${prompt}"

Wydobądź następujące informacje w formacie JSON:
{
  "intent": "główny zamiar (install/update/configure/monitor/remove)",
  "targetApps": ["lista aplikacji do zainstalowania/zaktualizowania"],
  "targetServers": ["lista serwerów (jeśli wymienione)"],
  "urgency": "pilność (high/medium/low)",
  "complexity": "złożoność (simple/medium/complex)",
  "requiresConfirmation": true/false,
  "estimatedDuration": "szacowany czas w minutach",
  "riskLevel": "poziom ryzyka (low/medium/high)",
  "dependencies": ["wymagania wstępne"]
}

Jeśli jakaś informacja nie jest dostępna, użyj wartości domyślnych lub pustych tablic.
`;

      const response = await this.taskGenerator.llmClient.query(analysisPrompt, {
        model: 'gpt-4',
        maxTokens: 800,
        temperature: 0.1
      });

      // Parsowanie JSON z odpowiedzi
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      } else {
        // Fallback - podstawowa analiza
        return this.fallbackAnalysis(prompt);
      }
    } catch (error) {
      if (this.logger) {
        this.logger.error(`Błąd analizy promptu: ${error.message}`);
      }
      return this.fallbackAnalysis(prompt);
    }
  }

  /**
   * Fallback analiza promptu gdy LLM nie działa
   * @param {string} prompt - Prompt do analizy
   * @returns {Object} Podstawowa analiza
   */
  fallbackAnalysis(prompt) {
    const lowerPrompt = prompt.toLowerCase();

    let intent = 'configure';
    if (lowerPrompt.includes('zainstaluj') || lowerPrompt.includes('install')) {
      intent = 'install';
    } else if (lowerPrompt.includes('zaktualizuj') || lowerPrompt.includes('update')) {
      intent = 'update';
    } else if (lowerPrompt.includes('usuń') || lowerPrompt.includes('remove')) {
      intent = 'remove';
    }

    // Prosta ekstrakcja aplikacji
    const targetApps = [];
    const commonApps = ['apache', 'nginx', 'mysql', 'postgresql', 'php', 'node', 'python', 'java'];
    commonApps.forEach(app => {
      if (lowerPrompt.includes(app)) {
        targetApps.push(app);
      }
    });

    return {
      intent,
      targetApps,
      targetServers: [],
      urgency: 'medium',
      complexity: 'medium',
      requiresConfirmation: true,
      estimatedDuration: 30,
      riskLevel: 'medium',
      dependencies: []
    };
  }

  /**
   * Generuje zadania na podstawie analizy promptu
   * @param {Object} analysis - Analiza promptu
   * @param {Object} serverConfig - Konfiguracja serwera
   * @param {Array} installedApps - Lista zainstalowanych aplikacji
   * @returns {Promise<Array>} Lista zadań
   */
  async generateTasksFromAnalysis(analysis, serverConfig, installedApps) {
    const tasks = [];

    // Zadania główne na podstawie intent
    if (analysis.intent === 'install' && analysis.targetApps.length > 0) {
      for (const app of analysis.targetApps) {
        tasks.push({
          name: `Zainstaluj ${app}`,
          description: `Zainstaluj aplikację ${app} na serwerze ${serverConfig.serverId} z domyślnymi ustawieniami`,
          priority: analysis.urgency === 'high' ? 'wysoki' : 'średni',
          estimatedTime: `${analysis.estimatedDuration} minut`,
          prerequisites: analysis.dependencies,
          type: 'installation',
          app: app
        });
      }
    }

    // Zadania dodatkowe wygenerowane przez LLM
    try {
      const additionalTasks = await this.taskGenerator.generateTasks(
        serverConfig,
        installedApps,
        `Użytkownik chce: ${analysis.intent} ${analysis.targetApps.join(', ')}`
      );

      tasks.push(...additionalTasks);
    } catch (error) {
      if (this.logger) {
        this.logger.warn(`Nie udało się wygenerować dodatkowych zadań: ${error.message}`);
      }
    }

    return tasks;
  }

  /**
   * Waliduje prompt pod kątem bezpieczeństwa
   * @param {string} prompt - Prompt do walidacji
   * @returns {Object} Wynik walidacji
   */
  validatePrompt(prompt) {
    const issues = [];

    // Sprawdź niebezpieczne komendy
    const dangerousCommands = [
      'rm -rf',
      'format',
      'dd if=',
      'shutdown',
      'reboot',
      'halt',
      'poweroff',
      'sudo su',
      'passwd root'
    ];

    const lowerPrompt = prompt.toLowerCase();
    dangerousCommands.forEach(cmd => {
      if (lowerPrompt.includes(cmd)) {
        issues.push(`Potencjalnie niebezpieczna komenda: ${cmd}`);
      }
    });

    // Sprawdź składnię
    if (prompt.length > 1000) {
      issues.push('Prompt zbyt długi (>1000 znaków)');
    }

    return {
      isValid: issues.length === 0,
      issues: issues
    };
  }

  /**
   * Przetwarza wiele promptów jednocześnie
   * @param {Array} prompts - Lista promptów
   * @param {Object} serverConfig - Konfiguracja serwera
   * @param {Array} installedApps - Lista zainstalowanych aplikacji
   * @returns {Promise<Array>} Wyniki przetwarzania
   */
  async processMultiplePrompts(prompts, serverConfig, installedApps) {
    const results = [];

    for (const prompt of prompts) {
      try {
        const result = await this.processPrompt(prompt, serverConfig, installedApps);
        results.push(result);
      } catch (error) {
        results.push({
          originalPrompt: prompt,
          error: error.message,
          tasks: []
        });
      }
    }

    return results;
  }
}

module.exports = PromptProcessor;