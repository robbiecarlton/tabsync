import { describe, expect, it } from 'vitest';
import { matchesExcludeList, parseExcludeList } from './exclude';
import { tab, win } from './testing/fixtures';
import { sanitizeWindow } from './urls';

describe('parseExcludeList', () => {
  it('parses domains, wildcard domains, ports and URL prefixes, ignoring blanks and comments', () => {
    const { rules, errors } = parseExcludeList(
      [
        '# banking',
        'Bank.Example.com',
        '*.login.example.org   # one-time links',
        '',
        '.dot.example',
        'localhost:3000',
        'HTTPS://Example.com/Private/',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
    expect(rules).toEqual([
      { kind: 'domain', host: 'bank.example.com' },
      { kind: 'domain', host: 'login.example.org' },
      { kind: 'domain', host: 'dot.example' },
      { kind: 'domain', host: 'localhost', port: '3000' },
      { kind: 'prefix', prefix: 'https://example.com/Private/' },
    ]);
  });

  it('reports invalid lines with their line numbers', () => {
    const { rules, errors } = parseExcludeList(
      'good.com\nnot a domain\nhttps://\nexample.com/path',
    );
    expect(rules).toEqual([{ kind: 'domain', host: 'good.com' }]);
    expect(errors.map((e) => [e.line, e.text])).toEqual([
      [2, 'not a domain'],
      [3, 'https://'],
      [4, 'example.com/path'],
    ]);
    expect(errors[0]!.message).toMatch(/example\.com.*https:\/\//);
  });

  it('accepts an empty list', () => {
    expect(parseExcludeList('')).toEqual({ rules: [], errors: [] });
  });
});

describe('matchesExcludeList', () => {
  const { rules } = parseExcludeList('bank.com\nlocalhost:3000\nhttps://docs.example.com/private/');

  it.each([
    ['https://bank.com/', true],
    ['https://www.bank.com/login', true],
    ['http://BANK.com/x', true],
    ['https://notbank.com/', false],
    ['https://bank.com.evil.net/', false],
    ['http://localhost:3000/app', true],
    ['http://localhost:4000/app', false],
    ['https://docs.example.com/private/plan', true],
    ['https://DOCS.example.com/private/', true],
    ['https://docs.example.com/public/', false],
    ['https://docs.example.com/Private/', false],
    ['chrome://settings/', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(matchesExcludeList(url, rules)).toBe(expected);
  });

  it('matches nothing with no rules', () => {
    expect(matchesExcludeList('https://bank.com/', [])).toBe(false);
  });
});

describe('sanitizeWindow with an exclude list', () => {
  const { rules } = parseExcludeList('bank.com');

  it('drops matching tabs like internal pages', () => {
    const result = sanitizeWindow(win([tab('https://a/'), tab('https://www.bank.com/')]), {
      exclude: rules,
    })!;
    expect(result.tabs.map((t) => t.url)).toEqual(['https://a/']);
  });

  it('drops a window holding only excluded tabs', () => {
    expect(sanitizeWindow(win([tab('https://bank.com/')]), { exclude: rules })).toBeNull();
  });
});
