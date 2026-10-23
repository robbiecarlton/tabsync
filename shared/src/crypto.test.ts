import { describe, expect, it } from 'vitest';
import {
  decryptSnapshot,
  DecryptError,
  deriveProfileKeys,
  encryptSnapshot,
  formatSecret,
  generateSecret,
  hashAuthToken,
  InvalidSecretError,
  parseSecret,
  sha256Hex,
  snapshotAad,
} from './crypto';
import { gunzip, gzip } from './compression';
import { utf8Decode, utf8Encode } from './encoding';
import { group, snapshot, tab, win } from './testing/fixtures';

const fixedSecret = () => new Uint8Array(32).map((_, i) => i);

describe('secret format', () => {
  it('generates 32 random bytes', () => {
    const a = generateSecret();
    expect(a).toHaveLength(32);
    expect(generateSecret()).not.toEqual(a);
  });

  it('formats as 13 groups of 4 Crockford characters', () => {
    expect(formatSecret(generateSecret())).toMatch(
      /^([0-9A-HJKMNP-TV-Z]{4}-){12}[0-9A-HJKMNP-TV-Z]{4}$/,
    );
  });

  it('parses its own output, and forgiving variants of it', () => {
    const secret = generateSecret();
    const formatted = formatSecret(secret);
    expect(parseSecret(formatted)).toEqual(secret);
    expect(parseSecret(`  ${formatted.toLowerCase().replace(/-/g, ' ')}\n`)).toEqual(secret);
    expect(parseSecret(formatted.replace(/-/g, ''))).toEqual(secret);
  });

  it.each([
    ['too short', (s: string) => s.slice(0, -1)],
    ['too long', (s: string) => s + 'A'],
    ['invalid character', (s: string) => 'U' + s.slice(1)],
    ['empty', () => ''],
  ])('rejects a secret that is %s', (_name, mangle) => {
    expect(() => parseSecret(mangle(formatSecret(generateSecret())))).toThrow(InvalidSecretError);
  });
});

describe('deriveProfileKeys', () => {
  it('is deterministic for a secret', async () => {
    const a = await deriveProfileKeys(fixedSecret());
    const b = await deriveProfileKeys(fixedSecret());
    expect(a.profileId).toBe(b.profileId);
    expect(a.authToken).toBe(b.authToken);
  });

  it('produces distinct, URL-safe values of the expected size', async () => {
    const { profileId, authToken } = await deriveProfileKeys(fixedSecret());
    expect(profileId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authToken.startsWith(profileId)).toBe(false);
  });

  it('differs for different secrets', async () => {
    const a = await deriveProfileKeys(fixedSecret());
    const b = await deriveProfileKeys(generateSecret());
    expect(b.profileId).not.toBe(a.profileId);
    expect(b.authToken).not.toBe(a.authToken);
  });

  it('makes a non-extractable AES-GCM key', async () => {
    const { encKey } = await deriveProfileKeys(fixedSecret());
    expect(encKey.extractable).toBe(false);
    expect(encKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    await expect(crypto.subtle.exportKey('raw', encKey)).rejects.toThrow();
  });

  it('rejects a secret of the wrong length', async () => {
    await expect(deriveProfileKeys(new Uint8Array(16))).rejects.toThrow(InvalidSecretError);
  });
});

describe('hashing', () => {
  it('sha256Hex matches a known vector', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashAuthToken is the SHA-256 of the token', async () => {
    expect(await hashAuthToken('token')).toBe(await sha256Hex('token'));
  });
});

describe('snapshotAad', () => {
  it('is stable across ISO formatting of the same instant', () => {
    expect(snapshotAad('p', '2026-10-22T12:00:00.000Z')).toEqual(
      snapshotAad('p', '2026-10-22T12:00:00Z'),
    );
    expect(snapshotAad('p', '2026-10-22T12:00:00.000Z')).toEqual(
      snapshotAad('p', '2026-10-22T14:00:00.000+02:00'),
    );
  });

  it('rejects invalid timestamps', () => {
    expect(() => snapshotAad('p', 'nope')).toThrow();
  });
});

describe('gzip', () => {
  it('round-trips and shrinks repetitive data', async () => {
    const data = utf8Encode('https://example.com/'.repeat(1000));
    const compressed = await gzip(data);
    expect(compressed.length).toBeLessThan(data.length / 10);
    expect(utf8Decode(await gunzip(compressed))).toBe(utf8Decode(data));
  });
});

describe('encryptSnapshot / decryptSnapshot', () => {
  const sample = () =>
    snapshot([
      win(
        [
          tab('https://a.example/', { pinned: true }),
          tab('https://b.example/', { groupKey: 'g1' }),
        ],
        [group('g1', { title: 'Work' })],
      ),
    ]);
  const meta = (s = sample()) => ({ id: s.snapshotId, createdAt: s.createdAt });

  it('round-trips a snapshot', async () => {
    const keys = await deriveProfileKeys(fixedSecret());
    const blob = await encryptSnapshot(sample(), keys);
    expect(await decryptSnapshot(blob, keys, meta())).toEqual(sample());
  });

  it('starts with the version byte and uses a fresh IV each time', async () => {
    const keys = await deriveProfileKeys(fixedSecret());
    const a = await encryptSnapshot(sample(), keys);
    const b = await encryptSnapshot(sample(), keys);
    expect(a[0]).toBe(1);
    expect(a.slice(1, 13)).not.toEqual(b.slice(1, 13));
  });

  it('does not contain plaintext', async () => {
    const keys = await deriveProfileKeys(fixedSecret());
    const blob = await encryptSnapshot(sample(), keys);
    expect(utf8Decode(blob)).not.toContain('example');
  });

  it('compresses a large snapshot well under the 2 MB cap', async () => {
    const keys = await deriveProfileKeys(fixedSecret());
    const tabs = Array.from({ length: 300 }, (_, i) =>
      tab(`https://site${i % 40}.example/articles/${i}?ref=home`, {
        title: `Article number ${i} on a site`,
      }),
    );
    const big = snapshot([win(tabs.slice(0, 150)), win(tabs.slice(150))]);
    const blob = await encryptSnapshot(big, keys);
    expect(blob.length).toBeLessThan(JSON.stringify(big).length / 3);
    expect(blob.length).toBeLessThan(2 * 1024 * 1024);
  });

  const expectDecryptError = async (promise: Promise<unknown>, message: RegExp) => {
    await expect(promise).rejects.toThrow(DecryptError);
    await expect(promise).rejects.toThrow(message);
  };

  it('fails with the wrong key', async () => {
    const blob = await encryptSnapshot(sample(), await deriveProfileKeys(fixedSecret()));
    const other = await deriveProfileKeys(generateSecret());
    await expectDecryptError(
      decryptSnapshot(
        blob,
        { ...other, profileId: (await deriveProfileKeys(fixedSecret())).profileId },
        meta(),
      ),
      /failed to decrypt/,
    );
  });

  it('fails when the blob is filed under another profile', async () => {
    const keys = await deriveProfileKeys(fixedSecret());
    const blob = await encryptSnapshot(sample(), keys);
    await expectDecryptError(
      decryptSnapshot(blob, { ...keys, profileId: 'someone-else' }, meta()),
      /failed to decrypt/,
    );
  });

  it('fails when the blob is filed under another time', async () => {
    const keys = await deriveProfileKeys(fixedSecret());
    const blob = await encryptSnapshot(sample(), keys);
    await expectDecryptError(
      decryptSnapshot(blob, keys, { ...meta(), createdAt: '2026-10-22T12:00:00.001Z' }),
      /failed to decrypt/,
    );
  });

  it('fails when the blob is filed under another snapshot ID', async () => {
    const keys = await deriveProfileKeys(fixedSecret());
    const blob = await encryptSnapshot(sample(), keys);
    await expectDecryptError(
      decryptSnapshot(blob, keys, { ...meta(), id: 'other-id' }),
      /ID does not match/,
    );
  });

  it('fails on a tampered byte', async () => {
    const keys = await deriveProfileKeys(fixedSecret());
    const blob = await encryptSnapshot(sample(), keys);
    blob[20]! ^= 1;
    await expectDecryptError(decryptSnapshot(blob, keys, meta()), /failed to decrypt/);
  });

  it('fails on a truncated blob or unknown version', async () => {
    const keys = await deriveProfileKeys(fixedSecret());
    const blob = await encryptSnapshot(sample(), keys);
    await expectDecryptError(decryptSnapshot(blob.slice(0, 20), keys, meta()), /truncated/);
    blob[0] = 9;
    await expectDecryptError(decryptSnapshot(blob, keys, meta()), /Unsupported snapshot format 9/);
  });

  it('fails cleanly when the decrypted contents are not a valid snapshot', async () => {
    const keys = await deriveProfileKeys(fixedSecret());
    const bad = { ...sample(), formatVersion: 99 } as unknown as ReturnType<typeof sample>;
    const blob = await encryptSnapshot(bad, keys);
    await expectDecryptError(decryptSnapshot(blob, keys, meta()), /contents are invalid/);
  });
});
