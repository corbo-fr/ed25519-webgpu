const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const enc = new TextEncoder();

function validate(s: string): void {
  for (const c of s) {
    if (!BASE58.includes(c)) throw new Error(`Invalid base58 character: '${c}'`);
  }
}

function toLower(b: number): number {
  return b >= 65 && b <= 90 ? b + 32 : b;
}

/** Validates and encodes a base58 prefix string. Throws on invalid characters. */
export function encodePrefix(prefix: string): Uint8Array {
  validate(prefix);
  return enc.encode(prefix);
}

/** Validates and encodes a base58 suffix string. Throws on invalid characters. */
export function encodeSuffix(suffix: string): Uint8Array {
  validate(suffix);
  return enc.encode(suffix);
}

export function matches(
  pubkey58: string,
  prefix?: Uint8Array,
  suffix?: Uint8Array,
  caseSensitive = true,
): boolean {
  if (prefix?.length) {
    if (pubkey58.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      const a = caseSensitive ? pubkey58.charCodeAt(i) : toLower(pubkey58.charCodeAt(i));
      const b = caseSensitive ? prefix[i] : toLower(prefix[i]);
      if (a !== b) return false;
    }
  }
  if (suffix?.length) {
    if (pubkey58.length < suffix.length) return false;
    const off = pubkey58.length - suffix.length;
    for (let i = 0; i < suffix.length; i++) {
      const a = caseSensitive ? pubkey58.charCodeAt(off + i) : toLower(pubkey58.charCodeAt(off + i));
      const b = caseSensitive ? suffix[i] : toLower(suffix[i]);
      if (a !== b) return false;
    }
  }
  return true;
}
