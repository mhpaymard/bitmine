import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Environment } from '../../src/config/environment';
import { CryptoService } from '../../src/security/crypto.service';

let directory: string;
let service: CryptoService;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'mitm-crypto-test-'));
  const encryption = join(directory, 'encryption.txt');
  const cookie = join(directory, 'cookie.txt');
  writeFileSync(encryption, 'encryption-secret-with-enough-entropy');
  writeFileSync(cookie, 'cookie-secret-with-enough-entropy');
  const config = {
    get: (key: string) => (key === 'APP_ENCRYPTION_KEY_FILE' ? encryption : cookie),
  } as unknown as ConfigService<Environment, true>;
  service = new CryptoService(config);
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('CryptoService', () => {
  it('authenticates encrypted data and binds it to its context', () => {
    const payload = service.encrypt('sensitive payout metadata', 'payout:one');

    expect(payload).not.toContain('sensitive payout metadata');
    expect(service.decrypt(payload, 'payout:one')).toBe('sensitive payout metadata');
    expect(() => service.decrypt(payload, 'payout:two')).toThrow();
    const parts = payload.split('.');
    parts[3] = `${parts[3]?.startsWith('A') ? 'B' : 'A'}${parts[3]?.slice(1)}`;
    expect(() => service.decrypt(parts.join('.'), 'payout:one')).toThrow();
  });

  it('hashes credentials with Argon2 and fails closed for invalid hashes', async () => {
    const hash = await service.hashSecret('worker-secret');

    expect(hash).not.toContain('worker-secret');
    await expect(service.verifySecret(hash, 'worker-secret')).resolves.toBe(true);
    await expect(service.verifySecret(hash, 'wrong')).resolves.toBe(false);
    await expect(service.verifySecret('not-an-argon-hash', 'worker-secret')).resolves.toBe(false);
  });

  it('produces stable SHA-256 and keyed signatures', () => {
    expect(service.sha256('value')).toHaveLength(64);
    expect(service.sign('value')).toBe(service.sign('value'));
    expect(service.sign('value')).not.toBe(service.sign('different'));
    expect(service.randomToken(18)).not.toBe(service.randomToken(18));
  });
});
