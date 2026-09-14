import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash, verify } from 'argon2';
import type { Environment } from '../config/environment';
import { readSecretFile } from '../config/environment';

@Injectable()
export class CryptoService {
  private readonly encryptionKey: Buffer;
  private readonly cookieSecret: Buffer;

  constructor(config: ConfigService<Environment, true>) {
    const encryptionSecret = readSecretFile(config.get('APP_ENCRYPTION_KEY_FILE', { infer: true }));
    const cookieSecret = readSecretFile(config.get('COOKIE_SECRET_FILE', { infer: true }));
    this.encryptionKey = createHash('sha256').update(encryptionSecret, 'utf8').digest();
    this.cookieSecret = createHash('sha256').update(cookieSecret, 'utf8').digest();
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  async hashSecret(secret: string): Promise<string> {
    return hash(secret, { type: 2, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
  }

  async verifySecret(hashValue: string, secret: string): Promise<boolean> {
    try {
      return await verify(hashValue, secret);
    } catch {
      return false;
    }
  }

  encrypt(plaintext: string, context = 'default'): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string, context = 'default'): string {
    const [version, ivEncoded, tagEncoded, ciphertextEncoded] = payload.split('.');
    if (version !== 'v1' || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
      throw new Error('Invalid encrypted payload');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(ivEncoded, 'base64url'),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextEncoded, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  sign(value: string): string {
    return createHmac('sha256', this.cookieSecret).update(value).digest('base64url');
  }

  sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
