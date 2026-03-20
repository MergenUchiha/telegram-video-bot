import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bit — рекомендован для GCM
const TAG_LENGTH = 16; // 128 bit auth tag

/**
 * Симметричное шифрование строк через AES-256-GCM.
 *
 * Формат зашифрованной строки (base64):
 *   [iv:12 bytes][ciphertext:N bytes][authTag:16 bytes]
 *
 * Ключ задаётся через ENCRYPTION_KEY (64 hex символа = 32 байта).
 * Генерация ключа: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(private readonly config: ConfigService) {
    const hexKey = this.config.get<string>('ENCRYPTION_KEY', '');
    if (!hexKey || hexKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hexKey)) {
      throw new Error(
        'ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
          "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    this.key = Buffer.from(hexKey, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: TAG_LENGTH,
    });

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // iv + ciphertext + authTag → base64
    return Buffer.concat([iv, encrypted, authTag]).toString('base64');
  }

  decrypt(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, 'base64');

    if (buf.length < IV_LENGTH + TAG_LENGTH) {
      throw new Error('Invalid ciphertext: too short');
    }

    const iv = buf.subarray(0, IV_LENGTH);
    const authTag = buf.subarray(buf.length - TAG_LENGTH);
    const encrypted = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
  }
}
