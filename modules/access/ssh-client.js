const { NodeSSH } = require('node-ssh');
const fs = require('fs');
const path = require('path');
const Logger = require('./logger');

class SSHClient {
  constructor(logger = null) {
    this.ssh = new NodeSSH();
    this.connected = false;
    this.logger = logger || new Logger();
  }

  /**
   * Łączy się z serwerem SSH
   * @param {string} host - Adres IP lub nazwa hosta
   * @param {string} username - Nazwa użytkownika
   * @param {string} password - Hasło
   * @param {number} port - Port SSH (domyślnie 22)
   * @returns {Promise<void>}
   */
  async connect(host, username, password, port = 22) {
    try {
      this.logger.log(`Próba połączenia SSH z ${username}@${host}:${port}`);
      await this.ssh.connect({
        host,
        username,
        password,
        port,
        readyTimeout: 10000, // Timeout 10 sekund
      });
      this.connected = true;
      this.logger.log(`Połączono z ${host}`);
    } catch (error) {
      this.logger.error(`Błąd połączenia SSH: ${error.message}`);
      throw new Error(`Nie udało się połączyć z serwerem SSH: ${error.message}`);
    }
  }

  /**
   * Wykonuje polecenie na zdalnym serwerze
   * @param {string} command - Polecenie do wykonania
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async execute(command) {
    if (!this.connected) {
      throw new Error('Brak połączenia SSH. Najpierw wywołaj connect().');
    }

    try {
      this.logger.log(`Wykonywanie polecenia: ${command}`);
      const result = await this.ssh.execCommand(command);
      this.logger.log(`Polecenie wykonane, kod wyjścia: ${result.code}`);
      return result;
    } catch (error) {
      this.logger.error(`Błąd wykonania polecenia: ${error.message}`);
      throw new Error(`Nie udało się wykonać polecenia: ${error.message}`);
    }
  }

  /**
   * Wysyła plik na zdalny serwer
   * @param {string} localPath - Lokalna ścieżka pliku
   * @param {string} remotePath - Zdalna ścieżka pliku
   * @returns {Promise<void>}
   */
  async uploadFile(localPath, remotePath) {
    if (!this.connected) {
      throw new Error('Brak połączenia SSH. Najpierw wywołaj connect().');
    }

    try {
      this.logger.log(`Wysyłanie pliku ${localPath} do ${remotePath}`);
      await this.ssh.putFile(localPath, remotePath);
      this.logger.log('Plik wysłany pomyślnie');
    } catch (error) {
      this.logger.error(`Błąd wysyłania pliku: ${error.message}`);
      throw new Error(`Nie udało się wysłać pliku: ${error.message}`);
    }
  }

  /**
   * Pobiera plik ze zdalnego serwera
   * @param {string} remotePath - Zdalna ścieżka pliku
   * @param {string} localPath - Lokalna ścieżka pliku
   * @returns {Promise<void>}
   */
  async downloadFile(remotePath, localPath) {
    if (!this.connected) {
      throw new Error('Brak połączenia SSH. Najpierw wywołaj connect().');
    }

    try {
      this.logger.log(`Pobieranie pliku ${remotePath} do ${localPath}`);
      await this.ssh.getFile(localPath, remotePath);
      this.logger.log('Plik pobrany pomyślnie');
    } catch (error) {
      this.logger.error(`Błąd pobierania pliku: ${error.message}`);
      throw new Error(`Nie udało się pobrać pliku: ${error.message}`);
    }
  }

  /**
   * Rozłącza połączenie SSH
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this.connected) {
      this.logger.log('Rozłączanie SSH');
      this.ssh.dispose();
      this.connected = false;
      this.logger.log('Rozłączono');
    }
  }

  /**
   * Sprawdza status połączenia
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }
}

module.exports = SSHClient;