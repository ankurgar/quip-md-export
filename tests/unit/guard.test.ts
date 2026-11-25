import { describe, expect, it } from 'vitest';
import { guardPattern } from '../../src/ui/guard';

describe('browser-level guard pattern', () => {
  const re = (loopback: boolean) => new RegExp(guardPattern(loopback));

  it('covers the Quip API and site hosts', () => {
    for (const url of ['https://platform.quip.com/1/threads/edit-document', 'https://acme.quip.com/anything', 'https://quip.com/x', 'http://platform.quip.com/1/x']) {
      expect(re(false).test(url)).toBe(true);
    }
  });

  it('does not touch unrelated hosts or look-alikes, and only allows loopback in test builds', () => {
    for (const url of ['https://example.com/', 'https://evilquip.com/', 'https://quip.com.evil.example/x', 'http://127.0.0.1:8080/1/x']) {
      expect(re(false).test(url)).toBe(false);
    }
    expect(re(true).test('http://127.0.0.1:8080/1/x')).toBe(true);
  });
});
