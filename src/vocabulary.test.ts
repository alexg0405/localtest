import { describe, expect, it } from 'vitest';
import { interviewTerms, keytermsFor, parseTerms } from './vocabulary';

describe('vocabulary', () => {
  it('splits terms on new lines, commas, and semicolons', () => {
    expect(parseTerms('Acme Cloud\n  Roomside, gRPC;;  ')).toEqual(['Acme Cloud', 'Roomside', 'gRPC']);
  });

  it('puts your terms first and skips duplicates of built-in ones', () => {
    const terms = keytermsFor('Acme Cloud\nleetcode');
    expect(terms.slice(0, 2)).toEqual(['Acme Cloud', 'leetcode']);
    expect(terms.filter(term => term.toLowerCase() === 'leetcode')).toHaveLength(1);
    expect(terms).toContain('Two Sum');
  });

  it("stays within Deepgram's limits", () => {
    const many = Array.from({ length: 150 }, (_, index) => `term${index}`).join('\n');
    expect(keytermsFor(many)).toHaveLength(100);
    expect(keytermsFor('', 100, 40).join('').length).toBeLessThanOrEqual(40);
    expect(keytermsFor('x'.repeat(80))).not.toContain('x'.repeat(80));
    expect(keytermsFor('')).toEqual(interviewTerms);
  });
});
