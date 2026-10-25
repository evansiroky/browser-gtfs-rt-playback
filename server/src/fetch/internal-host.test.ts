import { describe, expect, it } from 'vitest';
import { isInternalHost } from './internal-host.js';

describe('isInternalHost', () => {
  it.each([
    'localhost',
    'LOCALHOST.',
    'api.localhost',
    'metadata.google.internal',
    'anything.internal',
    '127.0.0.1',
    '127.255.0.9',
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '[::1]',
    '[::]',
    '[fe80::1]',
    '[fd00::5]',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[::ffff:a9fe:a9fe]',
  ])('%s is internal', (host) => {
    expect(isInternalHost(host)).toBe(true);
  });

  it.each([
    'feeds.example.com',
    'internal.example.com',
    '8.8.8.8',
    '172.32.0.1',
    '100.128.0.1',
    '[2001:db8::1]',
    '[::ffff:808:808]',
  ])('%s is not internal', (host) => {
    expect(isInternalHost(host)).toBe(false);
  });

  it('agrees with how the URL parser normalizes hosts', () => {
    for (const url of [
      'http://2130706433/',
      'http://0x7f.1/',
      'http://[::ffff:169.254.169.254]/',
      'http://METADATA.GOOGLE.INTERNAL/',
    ]) {
      expect(isInternalHost(new URL(url).hostname), url).toBe(true);
    }
  });
});
