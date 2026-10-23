import { describe, expect, it } from 'vitest';
import { fallbackFavicon, faviconUrl, samePixels } from '../src/ui/favicons';

describe('faviconUrl', () => {
  it('builds a _favicon URL with the page URL encoded', () => {
    expect(
      faviconUrl('https://a.example/p?q=1&r=2#x', 32, 'chrome-extension://abc/_favicon/'),
    ).toBe(
      'chrome-extension://abc/_favicon/?pageUrl=https%3A%2F%2Fa.example%2Fp%3Fq%3D1%26r%3D2%23x&size=32',
    );
  });
});

describe('fallbackFavicon', () => {
  it.each([
    ['https://a.example/favicon.ico', 'https://a.example/favicon.ico'],
    ['HTTP://a.example/f.png', 'HTTP://a.example/f.png'],
    ['data:image/png;base64,AAAA', undefined],
    ['chrome://favicon/https://a', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('%s → %s', (stored, expected) => {
    expect(fallbackFavicon(stored)).toBe(expected);
  });
});

describe('samePixels', () => {
  it('compares pixel data exactly', () => {
    expect(samePixels([1, 2, 3, 4], new Uint8ClampedArray([1, 2, 3, 4]))).toBe(true);
    expect(samePixels([1, 2, 3, 4], [1, 2, 3, 5])).toBe(false);
    expect(samePixels([1, 2, 3, 4], [1, 2, 3])).toBe(false);
  });
});
