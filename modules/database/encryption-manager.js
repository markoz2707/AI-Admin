// Prosty, wymienialny manager szyfrowania dla danych wrażliwych.
// Implementacja używa AES-256-GCM, klucz z ENV lub pliku, struktura gotowa do podmiany.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bit
const IV_LENGTH = 12; // rekomendowane dla GCM

// Ścieżka do pliku z kluczem (w katalogu projektu)
const KEY_FILE_PATH = path.join(__dirname, '..', '..', '.encryption-key');

/**
 * Pobiera lub generuje klucz szyfrowania.
 * Kolejność: ENV -> plik -> nowy (zapisywany do pliku)
 */
function getOrCreateEncryptionKey() {
  // 1. Sprawdź zmienną środowiskową
  if (process.env.ENCRYPTION_KEY) {
    console.log('[encryption-manager] Używam klucza z ENCRYPTION_KEY env.');
    return process.env.ENCRYPTION_KEY;
  }

  // 2. Sprawdź plik z kluczem
  try {
    if (fs.existsSync(KEY_FILE_PATH)) {
      const keyFromFile = fs.readFileSync(KEY_FILE_PATH, 'utf8').trim();
      if (keyFromFile && keyFromFile.length === KEY_LENGTH * 2) {
        console.log('[encryption-manager] Załadowano klucz z pliku .encryption-key');
        return keyFromFile;
      }
    }
  } catch (err) {
    console.warn('[encryption-manager] Nie można odczytać pliku klucza:', err.message);
  }

  // 3. Wygeneruj nowy klucz i zapisz do pliku
  const newKey = crypto.randomBytes(KEY_LENGTH).toString('hex');
  try {
    fs.writeFileSync(KEY_FILE_PATH, newKey, { mode: 0o600 }); // tylko właściciel może czytać
    console.log('[encryption-manager] Wygenerowano i zapisano nowy klucz do .encryption-key');
  } catch (err) {
    console.warn('[encryption-manager] Nie można zapisać klucza do pliku:', err.message);
    console.warn('[encryption-manager] UWAGA: Klucz nie będzie trwały między restartami!');
  }

  return newKey;
}

const ENCRYPTION_KEY_HEX = getOrCreateEncryptionKey();
const ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');

/**
 * Logowanie błędów szyfrowania/odszyfrowania.
 * W przyszłości można to podpiąć pod centralny logger / AuditLog.
 */
function logError(message, error) {
  const timestamp = new Date().toISOString();
  // Minimalne logowanie na stderr; brak wrażliwych danych.
  console.error(`[${timestamp}] ${message}: ${error && error.message ? error.message : error}`);
}

/**
 * Szyfruje tekst jawnym używając AES-256-GCM.
 * Zwraca: iv:authTag:cipherText (hex).
 * @param {string} plain
 * @returns {string}
 */
function encrypt(plain) {
  if (plain === null || plain === undefined) {
    return plain;
  }

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

    let encrypted = cipher.update(String(plain), 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    logError('Encryption error', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Odszyfrowuje tekst w formacie iv:authTag:cipherText (hex).
 * @param {string} cipherText
 * @returns {string}
 */
function decrypt(cipherText) {
  if (cipherText === null || cipherText === undefined) {
    return cipherText;
  }

  try {
    const parts = String(cipherText).split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    logError('Decryption error', error);
    throw new Error('Failed to decrypt data');
  }
}

module.exports = {
  encrypt,
  decrypt,
};