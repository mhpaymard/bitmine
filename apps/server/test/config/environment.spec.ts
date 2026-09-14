import { describe, expect, it } from 'vitest';
import { validateEnvironment } from '../../src/config/environment';

const required = {
  DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
};

describe('environment validation', () => {
  it('keeps plaintext development listeners compatible and TLS opt-in', () => {
    const config = validateEnvironment(required);
    expect(config.BITCOIN_GATEWAY_TCP_ENABLED).toBe(true);
    expect(config.BITCOIN_GATEWAY_TLS_ENABLED).toBe(false);
    expect(config.BITCOIN_GATEWAY_TLS_PORT).toBe(443);
  });

  it('accepts a dedicated Bitcoin TLS listener', () => {
    const config = validateEnvironment({
      ...required,
      NODE_ENV: 'production',
      GATEWAY_ENABLED: 'true',
      HTTP_HOST: '127.0.0.1',
      BITCOIN_GATEWAY_TCP_ENABLED: 'false',
      BITCOIN_GATEWAY_TLS_ENABLED: 'true',
      MONERO_GATEWAY_TCP_ENABLED: 'false',
      BITCOIN_GATEWAY_TLS_HOST: '0.0.0.0',
      BITCOIN_GATEWAY_TLS_PORT: '443',
    });
    expect(config.BITCOIN_GATEWAY_TCP_ENABLED).toBe(false);
    expect(config.BITCOIN_GATEWAY_TLS_ENABLED).toBe(true);
  });

  it('rejects an API and TLS listener collision', () => {
    expect(() =>
      validateEnvironment({
        ...required,
        GATEWAY_ENABLED: 'true',
        HTTP_HOST: '0.0.0.0',
        HTTP_PORT: '443',
        BITCOIN_GATEWAY_TLS_ENABLED: 'true',
        BITCOIN_GATEWAY_TLS_HOST: '0.0.0.0',
        BITCOIN_GATEWAY_TLS_PORT: '443',
      }),
    ).toThrow(/cannot bind overlapping/u);
  });

  it('rejects collisions between coin listeners, including wildcard host overlap', () => {
    expect(() =>
      validateEnvironment({
        ...required,
        GATEWAY_ENABLED: 'true',
        BITCOIN_GATEWAY_PORT: '4444',
        BITCOIN_GATEWAY_HOST: '127.0.0.1',
        MONERO_GATEWAY_PORT: '4444',
        MONERO_GATEWAY_HOST: '0.0.0.0',
      }),
    ).toThrow(/Bitcoin TCP gateway and Monero TCP gateway/u);
  });

  it('rejects globally disabled TLS verification', () => {
    expect(() => validateEnvironment({ ...required, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toThrow(
      /forbidden/u,
    );
  });

  it('requires encrypted mining listeners in production by default', () => {
    expect(() =>
      validateEnvironment({
        ...required,
        NODE_ENV: 'production',
        GATEWAY_ENABLED: 'true',
        BITCOIN_GATEWAY_TCP_ENABLED: 'true',
        MONERO_GATEWAY_TCP_ENABLED: 'false',
      }),
    ).toThrow(/Plaintext mining listeners/u);
  });

  it('keeps the production admin API on loopback and rejects insecure remote origins', () => {
    expect(() =>
      validateEnvironment({
        ...required,
        NODE_ENV: 'production',
        HTTP_HOST: '0.0.0.0',
      }),
    ).toThrow(/must bind to loopback/u);
    expect(() =>
      validateEnvironment({
        ...required,
        NODE_ENV: 'production',
        ADMIN_ORIGIN: 'http://admin.example.com',
      }),
    ).toThrow(/must use HTTPS/u);
  });
});
