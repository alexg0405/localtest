import { describe, expect, it } from 'vitest';
import { isLocalRequest } from './http';

describe('isLocalRequest', () => {
  it('accepts only same-origin requests on this computer', () => {
    expect(isLocalRequest({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin' }, '127.0.0.1')).toBe(true);
    expect(isLocalRequest({ host: 'localhost:5173' }, '::1')).toBe(true);
    expect(isLocalRequest({ host: 'localhost:5173' }, '::ffff:127.0.0.1')).toBe(true);
    expect(isLocalRequest({ host: '127.0.0.1:5173', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, '127.0.0.1')).toBe(false);
    expect(isLocalRequest({ host: '127.0.0.1:5173', 'sec-fetch-site': 'cross-site' }, '127.0.0.1')).toBe(false);
    expect(isLocalRequest({ host: 'evil.example:5173', origin: 'http://evil.example:5173' }, '127.0.0.1')).toBe(false); // DNS rebinding
  });

  it('rejects other devices even when they claim to be localhost', () => {
    expect(isLocalRequest({ host: '127.0.0.1:5173' }, '192.168.1.20')).toBe(false);
    expect(isLocalRequest({ host: 'localhost:5173' }, '::ffff:192.168.1.20')).toBe(false);
    expect(isLocalRequest({ host: 'localhost:5173' }, undefined)).toBe(false);
  });
});
