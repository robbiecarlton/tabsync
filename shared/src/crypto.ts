import { gunzip, gzip } from './compression';
import { sha256Hex } from './crypto-primitives';
import {
  concatBytes,
  fromCrockford,
  toBase64Url,
  toCrockford,
  utf8Decode,
  utf8Encode,
} from './encoding';
import type { Snapshot } from './types';
import { parseSnapshot } from './validate';

export { sha256Hex };

/** Bytes of entropy in a profile secret. */
export const SECRET_BYTES = 32;
/** Characters in the encoded secret, ignoring separators (256 bits / 5 bits per char). */
const SECRET_CHARS = Math.ceil((SECRET_BYTES * 8) / 5);

const HKDF_SALT = utf8Encode('tabsync/v1');
const INFO = {
  profileId: utf8Encode('tabsync/v1/profile-id'),
  authToken: utf8Encode('tabsync/v1/auth-token'),
  encKey: utf8Encode('tabsync/v1/enc-key'),
};

/** First byte of every blob; bump when the blob layout or algorithms change. */
export const BLOB_VERSION = 1;
const IV_BYTES = 12;

export class InvalidSecretError extends Error {
  constructor(message = 'That secret is not valid. Check it was copied completely.') {
    super(message);
    this.name = 'InvalidSecretError';
  }
}

export class DecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptError';
  }
}

export function generateSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

/** Formats a secret for display: Crockford base32 in dash-separated groups of four. */
export function formatSecret(secret: Uint8Array): string {
  return toCrockford(secret)
    .match(/.{1,4}/g)!
    .join('-');
}

/** Parses a secret typed or pasted by the user. Throws InvalidSecretError. */
export function parseSecret(text: string): Uint8Array<ArrayBuffer> {
  const compact = text.replace(/[\s-]/g, '');
  if (compact.length !== SECRET_CHARS) throw new InvalidSecretError();
  try {
    return fromCrockford(compact);
  } catch {
    throw new InvalidSecretError();
  }
}

export interface ProfileKeys {
  /** Public identifier sent to the server. */
  profileId: string;
  /** Bearer token; the server stores only its SHA-256. */
  authToken: string;
  /** Non-extractable AES-GCM 256 key. */
  encKey: CryptoKey;
}

async function hkdfBytes(base: CryptoKey, info: Uint8Array<ArrayBuffer>, length: number) {
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Derives the profile ID, auth token and encryption key from a secret (HKDF-SHA256). */
export async function deriveProfileKeys(secret: Uint8Array<ArrayBuffer>): Promise<ProfileKeys> {
  if (secret.length !== SECRET_BYTES) throw new InvalidSecretError();
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ]);
  const [profileId, authToken, encKey] = await Promise.all([
    hkdfBytes(base, INFO.profileId, 16).then(toBase64Url),
    hkdfBytes(base, INFO.authToken, 32).then(toBase64Url),
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: INFO.encKey },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    ),
  ]);
  return { profileId, authToken, encKey };
}

/** What the server stores for an auth token. */
export function hashAuthToken(authToken: string): Promise<string> {
  return sha256Hex(authToken);
}

/**
 * Additional authenticated data binding a blob to its profile and timestamp, so the server
 * can't swap blobs between profiles or times. The timestamp is epoch milliseconds, so it
 * survives the server re-serializing the ISO string.
 */
export function snapshotAad(profileId: string, createdAt: string): Uint8Array<ArrayBuffer> {
  const ms = Date.parse(createdAt);
  if (Number.isNaN(ms)) throw new Error(`Invalid createdAt "${createdAt}"`);
  return utf8Encode(`tabsync/v1|${profileId}|${ms}`);
}

type CryptoContext = Pick<ProfileKeys, 'profileId' | 'encKey'>;

/** Serializes, gzips and encrypts a snapshot. Blob layout: version byte, 12-byte IV, ciphertext. */
export async function encryptSnapshot(
  snapshot: Snapshot,
  { profileId, encKey }: CryptoContext,
): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = await gzip(utf8Encode(JSON.stringify(snapshot)));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: snapshotAad(profileId, snapshot.createdAt) },
    encKey,
    plaintext,
  );
  return concatBytes(new Uint8Array([BLOB_VERSION]), iv, new Uint8Array(ciphertext));
}

export interface BlobMetadata {
  /** Snapshot ID the server filed the blob under. */
  id: string;
  /** Timestamp the server filed the blob under (ISO). */
  createdAt: string;
}

/**
 * Decrypts and validates a blob, checking it belongs to this profile and to the ID and time
 * the server filed it under. Every failure throws DecryptError.
 */
export async function decryptSnapshot(
  blob: Uint8Array<ArrayBuffer>,
  { profileId, encKey }: CryptoContext,
  meta: BlobMetadata,
): Promise<Snapshot> {
  if (blob.length < 1 + IV_BYTES + 16) throw new DecryptError('Snapshot data is truncated');
  if (blob[0] !== BLOB_VERSION) throw new DecryptError(`Unsupported snapshot format ${blob[0]}`);
  let aad: Uint8Array<ArrayBuffer>;
  try {
    aad = snapshotAad(profileId, meta.createdAt);
  } catch (cause) {
    throw new DecryptError('Snapshot has an invalid timestamp', { cause });
  }

  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: blob.slice(1, 1 + IV_BYTES), additionalData: aad },
        encKey,
        blob.slice(1 + IV_BYTES),
      ),
    );
  } catch (cause) {
    throw new DecryptError('Snapshot failed to decrypt (wrong key or tampered data)', { cause });
  }

  let snapshot: Snapshot;
  try {
    snapshot = parseSnapshot(JSON.parse(utf8Decode(await gunzip(plaintext))));
  } catch (cause) {
    throw new DecryptError('Snapshot decrypted but its contents are invalid', { cause });
  }
  if (snapshot.snapshotId !== meta.id) {
    throw new DecryptError('Snapshot ID does not match the server record');
  }
  return snapshot;
}
