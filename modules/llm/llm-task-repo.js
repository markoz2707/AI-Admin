const { getConnection } = require('../database/database-config');
const Logger = require('../access/logger');

const logger = new Logger('llm-task-repo.log');

class LLMTaskRepository {
  constructor() {
    this.conn = getConnection();
  }

  /**
   * Tworzy wpis llm_tasks.
   * @param {Object} data
   *  - serverId
   *  - appUserId
   *  - prompt
   *  - plan
   *  - status
   *  - autoExecute (bool)
   * @returns {Promise<Object>} pełny rekord llm_tasks
   */
  async insertTask(data) {
    const {
      serverId = null,
      appUserId = null,
      prompt,
      plan = null,
      status = 'planned',
      autoExecute = true,
    } = data || {};

    if (!prompt) {
      throw new Error('LLMTaskRepository.insertTask: prompt is required');
    }

    try {
      const result = await this.conn.run(
        `
        INSERT INTO llm_tasks (
          server_id,
          app_user_id,
          prompt,
          plan,
          status,
          auto_execute,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
        [
          serverId,
          appUserId,
          prompt,
          plan,
          status,
          autoExecute ? 1 : 0,
        ]
      );

      const id = result && (result.lastID || result.lastId || result.id);
      return this.getTaskById(id);
    } catch (error) {
      logger.error('LLMTaskRepository.insertTask failed', error, {
        serverId,
        appUserId,
      });
      throw error;
    }
  }

  async getTaskById(id) {
    try {
      return await this.conn.get(
        'SELECT * FROM llm_tasks WHERE id = ? LIMIT 1',
        [id]
      );
    } catch (error) {
      logger.error('LLMTaskRepository.getTaskById failed', error, { id });
      throw error;
    }
  }

  /**
   * Wstawia wynik zadania do llm_task_results.
   * @param {Object} data
   *  - llmTaskId (required)
   *  - stepIndex
   *  - taskType
   *  - description
   *  - command
   *  - status ('success'|'error')
   *  - result
   *  - errorMessage
   */
  async insertResult(data) {
    const {
      llmTaskId,
      stepIndex = null,
      taskType = null,
      description = null,
      command = null,
      status,
      result = null,
      errorMessage = null,
    } = data || {};

    if (!llmTaskId) {
      throw new Error('LLMTaskRepository.insertResult: llmTaskId is required');
    }
    if (!status) {
      throw new Error('LLMTaskRepository.insertResult: status is required');
    }

    try {
      await this.conn.run(
        `
        INSERT INTO llm_task_results (
          llm_task_id,
          step_index,
          task_type,
          description,
          command,
          status,
          result,
          error_message,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
        [
          llmTaskId,
          stepIndex,
          taskType,
          description,
          command,
          status,
          result,
          errorMessage,
        ]
      );
    } catch (error) {
      logger.error('LLMTaskRepository.insertResult failed', error, {
        llmTaskId,
        status,
      });
      throw error;
    }
  }

  /**
   * Zwraca historię zadań i wyników dla danego serwera.
   * @param {number} serverId
   * @param {number} [limit=50]
   */
  async getHistoryByServer(serverId, limit = 50) {
    const safeLimit = Math.max(
      1,
      Math.min(parseInt(limit, 10) || 50, 200)
    );

    try {
      const tasks = await this.conn.all(
        `
        SELECT *
        FROM llm_tasks
        WHERE server_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `,
        [serverId, safeLimit]
      );

      if (!tasks || tasks.length === 0) {
        return [];
      }

      const taskIds = tasks.map((t) => t.id);
      const placeholders = taskIds.map(() => '?').join(',');
      const results = await this.conn.all(
        `
        SELECT *
        FROM llm_task_results
        WHERE llm_task_id IN (${placeholders})
        ORDER BY created_at ASC, id ASC
      `,
        taskIds
      );

      const grouped = {};
      for (const t of tasks) {
        grouped[t.id] = {
          task: t,
          results: [],
        };
      }

      for (const r of results || []) {
        if (grouped[r.llm_task_id]) {
          grouped[r.llm_task_id].results.push(r);
        }
      }

      return Object.values(grouped);
    } catch (error) {
      logger.error('LLMTaskRepository.getHistoryByServer failed', error, {
        serverId,
        limit,
      });
      throw error;
    }
  }
}

module.exports = new LLMTaskRepository();