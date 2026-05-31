const crypto = require('crypto');

/**
 * Symetryczne szyfrowanie danych wrażliwych oparte o master-password.
 *
 * UWAGA bezpieczeństwa: poprzednia implementacja używała przestarzałych i
 * niebezpiecznych funkcji crypto.createCipher/createDecipher, które:
 *   - ignorowały przekazany IV (wyprowadzały klucz wewnętrznie z hasła),
 *   - nie zapewniały uwierzytelnienia (brak ochrony integralności).
 *
 * Ta wersja używa AES-256-GCM z losowym IV per operację oraz tagiem
 * uwierzytelniającym. Klucz wyprowadzany jest przez scrypt z losowej soli,
 * a sól i IV są przechowywane razem z szyfrogramem.
 *
 * Format wyjścia (hex): salt(16):iv(12):authTag(16):ciphertext
 */
class Encryption {
  constructor(masterPassword) {
    if (!masterPassword || typeof masterPassword !== 'string') {
      throw new Error('masterPassword is required');
    }
    this.masterPassword = masterPassword;
    this.algorithm = 'aes-256-gcm';
    this.saltLength = 16;
    this.ivLength = 12;
    this.keyLength = 32;
  }

  /** @private wyprowadza klucz z hasła i soli */
  _deriveKey(salt) {
    return crypto.scryptSync(this.masterPassword, salt, this.keyLength);
  }

  encrypt(text) {
    try {
      const salt = crypto.randomBytes(this.saltLength);
      const iv = crypto.randomBytes(this.ivLength);
      const key = this._deriveKey(salt);

      const cipher = crypto.createCipheriv(this.algorithm, key, iv);
      let encrypted = cipher.update(String(text), 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag();

      return [
        salt.toString('hex'),
        iv.toString('hex'),
        authTag.toString('hex'),
        encrypted,
      ].join(':');
    } catch (error) {
      console.error('Encryption error:', error.message);
      throw new Error('Failed to encrypt data');
    }
  }

  decrypt(encryptedText) {
    try {
      const parts = String(encryptedText).split(':');
      if (parts.length !== 4) {
        throw new Error('Invalid encrypted data format');
      }
      const [saltHex, ivHex, authTagHex, ciphertext] = parts;
      const salt = Buffer.from(saltHex, 'hex');
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const key = this._deriveKey(salt);

      const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      console.error('Decryption error:', error.message);
      throw new Error('Failed to decrypt data');
    }
  }
}

module.exports = Encryption;
