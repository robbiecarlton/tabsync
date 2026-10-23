import { toHex, utf8Encode } from './encoding';

/** SHA-256 of a string (UTF-8) or bytes, as lowercase hex. */
export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === 'string' ? utf8Encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
