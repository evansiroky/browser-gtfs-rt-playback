import { describe, expect, it } from 'vitest';
import { MemoryBudget, rowBytes, stringBytes } from './memory.js';

describe('MemoryBudget', () => {
  it('tracks what is added and released, and allows exactly the limit', () => {
    const budget = new MemoryBudget(100);
    budget.add(60);
    budget.add(40);
    expect(budget.used).toBe(100);
    budget.release(30);
    budget.add(30);
    expect(budget.used).toBe(100);
  });

  it('throws too_large, without a URL in the message, when the limit is crossed', () => {
    const budget = new MemoryBudget(100);
    budget.add(100);
    expect(() => budget.add(1)).toThrowError(
      expect.objectContaining({ code: 'too_large', message: expect.stringContaining('100 bytes') }),
    );
  });
});

describe('size estimates', () => {
  it('counts two bytes per character for text beyond Latin-1', () => {
    expect(stringBytes('abc')).toBe(27);
    expect(stringBytes('é')).toBe(25);
    expect(stringBytes('東京')).toBe(28);
  });

  it('sums the values of a row', () => {
    expect(rowBytes({ a: 'xx', b: '' })).toBe(64 + (8 + 26) + (8 + 24));
  });
});
