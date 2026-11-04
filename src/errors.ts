/** Token-side failures raised by auth.ts. */
export type TokenErrorKind = 'token-expired' | 'token-missing' | 'token-read';

/** Thrown by auth.ts. Carries a kind so the panel can show the right hint. */
export class TokenError extends Error {
  constructor(
    readonly kind: TokenErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

export type ErrorKind =
  | TokenErrorKind
  | 'token-decrypt'
  | 'token-rejected'
  | 'unexpected-response'
  | 'api'
  | 'unknown';

/** What the panel shows. `message` is the detail, `hint` says what to do. */
export interface ErrorInfo {
  kind: ErrorKind;
  title: string;
  message: string;
  hint?: string;
}

const RE_SIGN_IN =
  'Sign in to Cursor again, or set a fresh JWT with “Plan Usage: Set Session Token”.';

/**
 * Map any failure to a panel state. Matches by error name so this module does
 * not import vscode-dependent modules (api.ts, auth.ts).
 */
export function describeError(err: unknown): ErrorInfo {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  const status = (err as { status?: unknown } | null)?.status;

  switch (name) {
    case 'SafeStorageError':
      return {
        kind: 'token-decrypt',
        title: 'Session token could not be decrypted',
        message,
        hint: RE_SIGN_IN,
      };
    case 'TokenError': {
      const kind = (err as TokenError).kind;
      if (kind === 'token-expired') {
        return { kind, title: 'Session token expired', message, hint: RE_SIGN_IN };
      }
      if (kind === 'token-missing') {
        return {
          kind,
          title: 'No Cursor session found',
          message,
          hint: 'Sign in to Cursor, or set a session token with “Plan Usage: Set Session Token”.',
        };
      }
      return { kind, title: 'Could not read Cursor session', message, hint: RE_SIGN_IN };
    }
    case 'UnexpectedResponseError':
      return {
        kind: 'unexpected-response',
        title: 'Unexpected response from Cursor',
        message,
        hint: 'Cursor may have changed its usage API. Check for a Plan Usage update.',
      };
    case 'CursorApiError':
      if (status === 401 || status === 403) {
        return {
          kind: 'token-rejected',
          title: 'Cursor rejected the session',
          message,
          hint: RE_SIGN_IN,
        };
      }
      return { kind: 'api', title: 'Cursor API error', message };
    default:
      return { kind: 'unknown', title: 'Could not load plan usage', message };
  }
}
