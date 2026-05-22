import { describe, expect, it } from 'vitest';
import { encodePrefix, encodeSuffix, matches } from '../../../src/vanity/matcher.js';

describe('encodePrefix / encodeSuffix — valid chars', () => {
    it('encodes a valid base58 string to UTF-8 bytes', () => {
        const b = encodePrefix('abc');
        expect(b).toEqual(new Uint8Array([97, 98, 99]));
    });

    it('encodeSuffix mirrors encodePrefix', () => {
        expect(encodeSuffix('Xyz')).toEqual(encodePrefix('Xyz'));
    });
});

describe('encodePrefix / encodeSuffix — invalid chars throw', () => {
    it('"0" is not base58', () => { expect(() => encodePrefix('0')).toThrow(); });
    it('"l" is not base58', () => { expect(() => encodeSuffix('l')).toThrow(); });
    it('"I" is not base58', () => { expect(() => encodePrefix('I')).toThrow(); });
    it('"O" is not base58', () => { expect(() => encodeSuffix('O')).toThrow(); });
    it('"+" is not base58', () => { expect(() => encodePrefix('a+b')).toThrow(); });
});

describe('matches — prefix only', () => {
    it('matching prefix returns true', () => {
        expect(matches('abcXYZ', encodePrefix('abc'), undefined, true)).toBe(true);
    });

    it('non-matching prefix returns false', () => {
        expect(matches('xyzABC', encodePrefix('abc'), undefined, true)).toBe(false);
    });

    it('address shorter than prefix returns false', () => {
        expect(matches('ab', encodePrefix('abc'), undefined, true)).toBe(false);
    });

    it('address exactly equal to prefix returns true', () => {
        expect(matches('abc', encodePrefix('abc'), undefined, true)).toBe(true);
    });
});

describe('matches — suffix only', () => {
    it('matching suffix returns true', () => {
        expect(matches('ABCxyz', undefined, encodeSuffix('xyz'), true)).toBe(true);
    });

    it('non-matching suffix returns false', () => {
        expect(matches('ABCabc', undefined, encodeSuffix('xyz'), true)).toBe(false);
    });

    it('address shorter than suffix returns false', () => {
        expect(matches('xy', undefined, encodeSuffix('xyz'), true)).toBe(false);
    });

    it('address exactly equal to suffix returns true', () => {
        expect(matches('xyz', undefined, encodeSuffix('xyz'), true)).toBe(true);
    });
});

describe('matches — prefix + suffix combined', () => {
    const p = encodePrefix('A');
    const s = encodeSuffix('z');

    it('both match → true', () => {
        expect(matches('A1234z', p, s, true)).toBe(true);
    });

    it('prefix matches but suffix fails → false', () => {
        expect(matches('A1234X', p, s, true)).toBe(false);
    });

    it('suffix matches but prefix fails → false', () => {
        expect(matches('B1234z', p, s, true)).toBe(false);
    });

    it('neither matches → false', () => {
        expect(matches('B1234X', p, s, true)).toBe(false);
    });
});

describe('matches — case-insensitive', () => {
    it('uppercase prefix matches lowercase address char', () => {
        expect(matches('aBCDEF', encodePrefix('A'), undefined, false)).toBe(true);
    });

    it('lowercase prefix matches uppercase address char', () => {
        expect(matches('ABCDEF', encodePrefix('a'), undefined, false)).toBe(true);
    });

    it('caseSensitive:true rejects wrong case', () => {
        expect(matches('aBCDEF', encodePrefix('A'), undefined, true)).toBe(false);
    });

    it('case-insensitive suffix match', () => {
        expect(matches('ABC123Z', undefined, encodeSuffix('z'), false)).toBe(true);
    });
});

describe('matches — no constraints', () => {
    it('no prefix and no suffix → always true', () => {
        expect(matches('anything', undefined, undefined, true)).toBe(true);
    });

    it('empty string address with no constraints → true', () => {
        expect(matches('', undefined, undefined, true)).toBe(true);
    });
});

describe('encodePrefix / encodeSuffix — empty string', () => {
    it('encodePrefix("") does not throw and returns empty Uint8Array', () => {
        expect(() => encodePrefix('')).not.toThrow();
        expect(encodePrefix('')).toEqual(new Uint8Array([]));
    });

    it('encodeSuffix("") does not throw and returns empty Uint8Array', () => {
        expect(() => encodeSuffix('')).not.toThrow();
        expect(encodeSuffix('')).toEqual(new Uint8Array([]));
    });
});

describe('matches — zero-length constraint Uint8Arrays', () => {
    it('empty prefix Uint8Array skips prefix check → true', () => {
        expect(matches('anything', new Uint8Array([]), undefined, true)).toBe(true);
    });

    it('empty prefix and empty suffix both skip → true', () => {
        expect(matches('', new Uint8Array([]), new Uint8Array([]), true)).toBe(true);
    });
});
