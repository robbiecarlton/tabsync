import { describe, expect, it } from 'vitest';
import {
  concatBytes,
  fromBase64Url,
  fromCrockford,
  toBase64Url,
  toCrockford,
  toHex,
  utf8Decode,
  utf8Encode,
} from './encoding';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

describe('hex', () => {
  it('encodes bytes', () => {
    expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe('000f10ff');
  });
});

describe('utf8', () => {
  it('round-trips non-ASCII text', () => {
    expect(utf8Decode(utf8Encode('héllo ✓ 漢字'))).toBe('héllo ✓ 漢字');
  });
});

describe('base64url', () => {
  it('uses the URL-safe alphabet without padding', () => {
    expect(toBase64Url(new Uint8Array([251, 255, 191]))).toBe('-_-_');
    expect(toBase64Url(new Uint8Array([1]))).toBe('AQ');
  });

  it.each([0, 1, 2, 3, 31, 32, 33])('round-trips %i bytes', (n) => {
    const bytes = random(n);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });
});

describe('crockford base32', () => {
  it('encodes known values', () => {
    expect(toCrockford(new Uint8Array([0]))).toBe('00');
    expect(toCrockford(new Uint8Array([255]))).toBe('ZW');
    expect(toCrockford(utf8Encode('foobar'))).toBe('CSQPYRK1E8');
  });

  it('encodes 32 bytes as 52 characters', () => {
    expect(toCrockford(random(32))).toHaveLength(52);
  });

  it.each([1, 5, 16, 32])('round-trips %i bytes', (n) => {
    const bytes = random(n);
    expect(fromCrockford(toCrockford(bytes))).toEqual(bytes);
  });

  it('ignores case, spaces and dashes, and maps look-alike letters', () => {
    const bytes = random(32);
    const encoded = toCrockford(bytes);
    const messy = encoded
      .toLowerCase()
      .replace(/(.{4})/g, '$1- ')
      .replace(/0/g, 'o')
      .replace(/1/g, 'l');
    expect(fromCrockford(messy)).toEqual(bytes);
  });

  it('rejects invalid characters', () => {
    expect(() => fromCrockford('ABCU')).toThrow(/Invalid character "U"/);
  });
});

describe('concatBytes', () => {
  it('joins arrays in order', () => {
    expect(concatBytes(new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2, 3]))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});
