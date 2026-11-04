/**
 * Last line of defence for the debug log. Callers should not pass secrets, but
 * if one slips in (an error body, a stray value), it is replaced here.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // Unsigned or signed JWT.
  [/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<jwt>'],
  // WorkosCursorSessionToken: user_…::<jwt>.
  [/user_[A-Za-z0-9]+::/g, 'user_<redacted>::'],
  // Electron safeStorage ciphertext as stored by Cursor.
  [/cursor-safe-storage:v1:[A-Za-z0-9+/=]+/g, '<sealed>'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
