import { describe, expect, it } from 'vitest';
import { redactingDestination } from './logging.js';
import { SecretUrl } from './secret-url.js';

describe('redactingDestination', () => {
  it('scrubs every fragment of a feed URL from log lines', () => {
    const url = new SecretUrl(
      new URL('https://user:pa55word@feeds.example.test/rt/vp?api_key=SUPERSECRET123&format=pb'),
    );
    const lines: string[] = [];
    const destination = redactingDestination(url.secretFragments(), {
      write: (line) => void lines.push(line),
    });
    destination.write(
      JSON.stringify({
        msg: 'oops https://user:pa55word@feeds.example.test/rt/vp?api_key=SUPERSECRET123&format=pb',
        other:
          'https://feeds.example.test/rt/vp and SUPERSECRET123 and api_key=SUPERSECRET123&format=pb',
      }),
    );
    expect(lines[0]).not.toMatch(/feeds\.example\.test\/rt|SUPERSECRET123|pa55word/);
    expect(lines[0]).toContain('[redacted]');
  });

  it('leaves lines without secrets untouched', () => {
    const lines: string[] = [];
    redactingDestination(['https://feeds.example.test/x'], {
      write: (line) => void lines.push(line),
    }).write('hello\n');
    expect(lines).toEqual(['hello\n']);
  });
});
