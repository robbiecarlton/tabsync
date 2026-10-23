import { describe, expect, it } from 'vitest';
import { group, tab, win } from './testing/fixtures';
import {
  isExcludedUrl,
  isNewTabUrl,
  NEW_TAB_URL,
  normalizeUrlForMatching,
  sanitizeWindow,
  sanitizeWindows,
} from './urls';

describe('isExcludedUrl', () => {
  it.each([
    'brave://settings',
    'chrome://extensions/',
    'chrome-extension://abc/popup.html',
    'devtools://devtools/bundled/inspector.html',
    'about:config',
    'view-source:https://example.com',
    'file:///Users/me/doc.pdf',
    'CHROME://history',
    '',
    'not a url',
  ])('excludes %s', (url) => {
    expect(isExcludedUrl(url)).toBe(true);
  });

  it.each(['https://example.com', 'http://localhost:3000/x', 'about:blank', 'ftp://host/file'])(
    'keeps %s',
    (url) => {
      expect(isExcludedUrl(url)).toBe(false);
    },
  );
});

describe('isNewTabUrl', () => {
  it.each(['chrome://newtab/', 'chrome://newtab', 'brave://newtab/', 'chrome://new-tab-page/'])(
    'recognises %s',
    (url) => {
      expect(isNewTabUrl(url)).toBe(true);
    },
  );

  it('does not match other pages', () => {
    expect(isNewTabUrl('chrome://settings/')).toBe(false);
    expect(isNewTabUrl('https://newtab.example/')).toBe(false);
  });
});

describe('normalizeUrlForMatching', () => {
  it('strips the fragment', () => {
    expect(normalizeUrlForMatching('https://a.example/page#section')).toBe(
      'https://a.example/page',
    );
  });

  it('strips utm_* and click ids but keeps other params in order', () => {
    expect(
      normalizeUrlForMatching(
        'https://a.example/p?b=2&utm_source=x&UTM_Medium=y&a=1&fbclid=f&gclid=g#top',
      ),
    ).toBe('https://a.example/p?b=2&a=1');
  });

  it('drops the empty query when only tracking params were present', () => {
    expect(normalizeUrlForMatching('https://a.example/?utm_campaign=z')).toBe('https://a.example/');
  });

  it('canonicalises scheme and host case', () => {
    expect(normalizeUrlForMatching('HTTPS://A.Example/Path')).toBe('https://a.example/Path');
  });

  it('leaves non-http query strings alone', () => {
    expect(normalizeUrlForMatching('ftp://h/f?utm_source=x')).toBe('ftp://h/f?utm_source=x');
  });

  it('handles unparseable input', () => {
    expect(normalizeUrlForMatching('garbage#frag')).toBe('garbage');
  });
});

describe('sanitizeWindow', () => {
  it('drops excluded tabs and unused groups', () => {
    const w = win(
      [
        tab('https://a/', { pinned: true }),
        tab('brave://settings', { groupKey: 'g2' }),
        tab('https://b/', { groupKey: 'g1' }),
      ],
      [group('g1'), group('g2')],
    );
    const result = sanitizeWindow(w)!;
    expect(result.tabs.map((t) => t.url)).toEqual(['https://a/', 'https://b/']);
    expect(result.groups.map((g) => g.key)).toEqual(['g1']);
  });

  it('skips a window with only excluded tabs', () => {
    expect(sanitizeWindow(win([tab('brave://settings'), tab('chrome://history')]))).toBeNull();
  });

  it('drops New Tab pages when the window has other tabs', () => {
    const result = sanitizeWindow(win([tab('https://a/'), tab('chrome://newtab/')]))!;
    expect(result.tabs.map((t) => t.url)).toEqual(['https://a/']);
  });

  it('keeps one New Tab placeholder when it is all that remains', () => {
    const result = sanitizeWindow(
      win([tab('brave://newtab/'), tab('chrome://newtab/'), tab('brave://settings')]),
    )!;
    expect(result.tabs).toEqual([
      { url: NEW_TAB_URL, title: 'New Tab', pinned: false, active: true },
    ]);
  });

  it('preserves duplicate URLs as separate tabs', () => {
    expect(sanitizeWindow(win([tab('https://a/'), tab('https://a/')]))!.tabs).toHaveLength(2);
  });

  it('drops large data: favicons but keeps small ones and http favicons', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(3000);
    const small = 'data:image/png;base64,AAAA';
    const result = sanitizeWindow(
      win([
        tab('https://a/', { favIconUrl: big }),
        tab('https://b/', { favIconUrl: small }),
        tab('https://c/', { favIconUrl: 'https://c/' + 'x'.repeat(3000) }),
      ]),
    )!;
    expect(result.tabs[0]).not.toHaveProperty('favIconUrl');
    expect(result.tabs[1]!.favIconUrl).toBe(small);
    expect(result.tabs[2]!.favIconUrl).toBeDefined();
  });

  it('keeps window metadata', () => {
    const result = sanitizeWindow(
      win([tab('https://a/')], [], { focused: true, state: 'maximized' }),
    )!;
    expect(result.focused).toBe(true);
    expect(result.state).toBe('maximized');
  });
});

describe('sanitizeWindows', () => {
  it('removes windows left empty', () => {
    const result = sanitizeWindows([win([tab('chrome://settings')]), win([tab('https://a/')])]);
    expect(result).toHaveLength(1);
  });
});
