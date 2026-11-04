import type { AuthResult, TokenInfo } from './types';

/**
 * Build the footer's token description from an AuthResult. Copies only the
 * origin, the sealed flag, and the expiry. The token itself is never copied.
 */
export function tokenInfoFor(auth: AuthResult): TokenInfo {
  return {
    source: auth.source,
    sealed: auth.sealed === true,
    expiresAt: auth.expiresAt,
  };
}
