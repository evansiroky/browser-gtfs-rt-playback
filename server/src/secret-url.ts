import { inspect } from 'node:util';

const REDACTED = '[redacted]';

/**
 * A feed URL. Feed URLs are secrets (they may embed API keys), so the value is held in a private
 * field and every way of turning the object into text (`String()`, template literals,
 * `JSON.stringify`, `util.inspect`, loggers) yields `[redacted]`. Only {@link reveal} returns the
 * URL, and only the fetch code calls it.
 */
export class SecretUrl {
  readonly #url: URL;

  constructor(url: URL) {
    this.#url = url;
  }

  reveal(): URL {
    return new URL(this.#url.href);
  }

  /**
   * Substrings that must never appear in output: the URL itself, the URL without its query, the
   * query string, credentials, and each query parameter value. Used to scrub log lines.
   */
  secretFragments(): string[] {
    const url = this.#url;
    const fragments = [url.href, `${url.origin}${url.pathname}`, url.search.slice(1)];
    if (url.username) fragments.push(url.username);
    if (url.password) fragments.push(url.password);
    for (const value of url.searchParams.values()) fragments.push(value, encodeURIComponent(value));
    // Short values (e.g. "1", "json") would scrub ordinary words from every log line.
    return [...new Set(fragments)].filter((fragment) => fragment.length >= 4);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
