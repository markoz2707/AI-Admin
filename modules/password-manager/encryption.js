const crypto = require('crypto');

class Encryption {
    constructor(masterPassword) {
        this.masterPassword = masterPassword;
        this.algorithm = 'aes-256-cbc';
        this.key = crypto.scryptSync(masterPassword, 'salt', 32);
        this.iv = crypto.randomBytes(16);
    }

    encrypt(text) {
        try {
            const cipher = crypto.createCipher(this.algorithm, this.key);
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            return encrypted;
        } catch (error) {
            console.error('Encryption error:', error);
            throw new Error('Failed to encrypt data');
        }
    }

    decrypt(encryptedText) {
        try {
            const decipher = crypto.createDecipher(this.algorithm, this.key);
            let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) {
            console.error('Decryption error:', error);
            throw new Error('Failed to decrypt data');
        }
    }
}

module.exports = Encryption;