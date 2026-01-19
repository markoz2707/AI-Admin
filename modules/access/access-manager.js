const SSHClient = require('./ssh-client');
const RDPClient = require('./rdp-client');
const WinRMClient = require('./winrm-client');
const Logger = require('./logger');

class AccessManager {
  constructor(logger = null) {
    this.connections = new Map(); // Mapa połączeń: serverId -> { type: 'ssh'|'rdp', client: instance }
    this.logger = logger || new Logger();
  }

  /**
   * Łączy się z serwerem na podstawie typu
   * @param {string} serverId - Unikalny identyfikator serwera
   * @param {string} type - Typ serwera: 'ssh' lub 'rdp'
   * @param {Object} config - Konfiguracja połączenia
   * @param {string} config.host - Adres hosta
   * @param {string} config.username - Nazwa użytkownika
   * @param {string} config.password - Hasło
   * @param {number} config.port - Port (opcjonalny)
   * @param {Object} config.options - Dodatkowe opcje (opcjonalne)
   * @returns {Promise<void>}
   */
  async connect(serverId, type, config) {
    try {
      this.logger.log(`Łączenie z serwerem ${serverId} typu ${type}`);

      if (this.connections.has(serverId)) {
        throw new Error(`Połączenie z serwerem ${serverId} już istnieje`);
      }

      let client;
      if (type === 'ssh') {
        client = new SSHClient(this.logger);
        await client.connect(config.host, config.username, config.password, config.port || 22);
      } else if (type === 'rdp') {
        client = new RDPClient(this.logger);
        await client.connect(config.host, config.username, config.password, config.port || 3389, config.options || {});
      } else if (type === 'winrm') {
        client = new WinRMClient(this.logger);
        await client.connect(config.host, config.username, config.password, config.port || 5985);
      } else {
        throw new Error(`Nieobsługiwany typ połączenia: ${type}`);
      }

      this.connections.set(serverId, { type, client });
      this.logger.logConnectionSuccess(serverId, type);
    } catch (error) {
      this.logger.logConnectionError(serverId, type, error);
      throw error;
    }
  }

  /**
   * Wykonuje polecenie na połączonym serwerze SSH
   * @param {string} serverId - Identyfikator serwera
   * @param {string} command - Polecenie do wykonania
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async executeCommand(serverId, command) {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Brak połączenia z serwerem ${serverId}`);
    }

    if (connection.type !== 'ssh' && connection.type !== 'winrm') {
      throw new Error(`Wykonywanie poleceń jest dostępne tylko dla połączeń 'ssh' i 'winrm'`);
    }

    try {
      this.logger.log(`Wykonywanie polecenia na serwerze ${serverId}: ${command}`);
      const result = await connection.client.execute(command);
      this.logger.log(`Polecenie wykonane na serwerze ${serverId}`);
      return result;
    } catch (error) {
      this.logger.error(`Błąd wykonania polecenia na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Wysyła plik na połączony serwer SSH
   * @param {string} serverId - Identyfikator serwera
   * @param {string} localPath - Lokalna ścieżka pliku
   * @param {string} remotePath - Zdalna ścieżka pliku
   * @returns {Promise<void>}
   */
  async uploadFile(serverId, localPath, remotePath) {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Brak połączenia z serwerem ${serverId}`);
    }

    if (connection.type !== 'ssh') {
      throw new Error(`Transfer plików jest dostępny tylko dla połączeń SSH`);
    }

    try {
      this.logger.log(`Wysyłanie pliku na serwer ${serverId}: ${localPath} -> ${remotePath}`);
      await connection.client.uploadFile(localPath, remotePath);
      this.logger.log(`Plik wysłany na serwer ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd wysyłania pliku na serwer ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Pobiera plik z połączonego serwera SSH
   * @param {string} serverId - Identyfikator serwera
   * @param {string} remotePath - Zdalna ścieżka pliku
   * @param {string} localPath - Lokalna ścieżka pliku
   * @returns {Promise<void>}
   */
  async downloadFile(serverId, remotePath, localPath) {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Brak połączenia z serwerem ${serverId}`);
    }

    if (connection.type !== 'ssh') {
      throw new Error(`Transfer plików jest dostępny tylko dla połączeń SSH`);
    }

    try {
      this.logger.log(`Pobieranie pliku z serwera ${serverId}: ${remotePath} -> ${localPath}`);
      await connection.client.downloadFile(remotePath, localPath);
      this.logger.log(`Plik pobrany z serwera ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd pobierania pliku z serwera ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Rozłącza połączenie z serwerem
   * @param {string} serverId - Identyfikator serwera
   * @returns {Promise<void>}
   */
  async disconnect(serverId) {
    const connection = this.connections.get(serverId);
    if (!connection) {
      this.logger.warn(`Próba rozłączenia nieistniejącego połączenia: ${serverId}`);
      return;
    }

    try {
      this.logger.log(`Rozłączanie z serwerem ${serverId}`);
      await connection.client.disconnect();
      this.connections.delete(serverId);
      this.logger.logDisconnection(serverId, connection.type);
    } catch (error) {
      this.logger.error(`Błąd rozłączania z serwerem ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Sprawdza status połączenia z serwerem
   * @param {string} serverId - Identyfikator serwera
   * @returns {boolean}
   */
  isConnected(serverId) {
    const connection = this.connections.get(serverId);
    return connection ? connection.client.isConnected() : false;
  }

  /**
   * Zwraca listę aktywnych połączeń
   * @returns {Array<{serverId: string, type: string, connected: boolean}>}
   */
  getActiveConnections() {
    const connections = [];
    for (const [serverId, connection] of this.connections) {
      connections.push({
        serverId,
        type: connection.type,
        connected: connection.client.isConnected()
      });
    }
    return connections;
  }

  /**
   * Rozłącza wszystkie aktywne połączenia
   * @returns {Promise<void>}
   */
  async disconnectAll() {
    this.logger.log('Rozłączanie wszystkich połączeń');
    const promises = [];
    for (const serverId of this.connections.keys()) {
      promises.push(this.disconnect(serverId));
    }
    await Promise.allSettled(promises);
    this.logger.log('Wszystkie połączenia rozłączone');
  }

  /**
   * Sprawdza dostępność narzędzi RDP w systemie
   * @returns {Promise<boolean>}
   */
  static async checkRDPAvailability() {
    return RDPClient.checkAvailability();
  }
}

module.exports = AccessManager;