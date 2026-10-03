// Special characters are written as code points, never as raw or escaped characters in the source,
// so none of them can hide in a file. These build regular expression source text at start-up.

const BACKSLASH = String.fromCharCode(92);

/** The character with this code point. */
export const char = (code: number): string => String.fromCodePoint(code);

/** Regular expression source for one code point; needs the "u" flag. */
export const codePoint = (code: number): string => `${BACKSLASH}u{${code.toString(16)}}`;

/** Regular expression source for a range of code points, for use inside [...]. */
export const range = (from: number, to: number): string => `${codePoint(from)}-${codePoint(to)}`;

/** Regular expression source for a backslash escape such as "n", "t", "s" or "p{L}". */
export const escape = (code: string): string => `${BACKSLASH}${code}`;

export const SOFT_HYPHEN = 0xad;
/** Hyphen and non-breaking hyphen. */
export const HYPHEN_VARIANTS = [0x2010, 0x2011];
export const EN_DASH = 0x2013;
export const EM_DASH = 0x2014;
