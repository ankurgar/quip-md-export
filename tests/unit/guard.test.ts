import { describe, expect, it } from 'vitest';
import { guardRule } from '../../src/ui/guard';

describe('browser-level guard rule', () => {
  const rule = guardRule('abcdefghijklmnopabcdefghijklmnop');
  const pattern = new RegExp(rule.condition.regexFilter as string);

  it('blocks every way of changing something and leaves reads alone', () => {
    const methods = rule.condition.requestMethods as string[];
    for (const m of ['post', 'put', 'patch', 'delete', 'other']) expect(methods).toContain(m);
    for (const m of ['get', 'head', 'options']) expect(methods).not.toContain(m);
    expect(rule.action.type).toBe('block');
  });

  it('applies to any web address, not just Quip, but only to requests the extension itself makes', () => {
    for (const url of ['https://platform.quip.com/1/threads/edit-document', 'https://acme.quip.com/x', 'https://example.com/', 'http://127.0.0.1:8080/1/x', 'http://localhost/x']) {
      expect(pattern.test(url), url).toBe(true);
    }
    expect(rule.condition.initiatorDomains).toEqual(['abcdefghijklmnopabcdefghijklmnop']);
  });

  it('includes page loads and every sub-resource type, so a form post or beacon cannot slip through', () => {
    const types = rule.condition.resourceTypes as string[];
    for (const t of ['main_frame', 'sub_frame', 'xmlhttprequest', 'ping', 'websocket', 'other']) expect(types).toContain(t);
  });
});
