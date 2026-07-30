/**
 * Error taxonomy.
 *
 * Every kind maps to a message that tells the user what to actually do. The
 * `kind` field is stable and machine-readable; the message is for humans and
 * for the model reading a failed tool result.
 */
export class TxAdminError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = 'TxAdminError';
    this.kind = kind;
  }
}

function make(kind: string, name: string) {
  return class extends TxAdminError {
    constructor(message: string) {
      super(kind, message);
      this.name = name;
    }
  };
}

/** Missing or malformed environment configuration. */
export const ConfigError = make('config', 'ConfigError');

/** Bad credentials, or a session that could not be re-established. Never retried. */
export const AuthError = make('auth', 'AuthError');

/** txAdmin's login rate limiter has blocked us. Retrying makes it worse. */
export const RateLimitError = make('rate_limit', 'RateLimitError');

/** The txAdmin account lacks the permission this action needs. */
export const PermissionError = make('permission', 'PermissionError');

/** FXServer is not running, so server-directed commands cannot be delivered. */
export const ServerOfflineError = make('server_offline', 'ServerOfflineError');

/** Got HTML where JSON was expected — wrong URL, or a proxy stripping headers. */
export const NotTxAdminError = make('not_txadmin', 'NotTxAdminError');

/** txAdmin asked the client to refresh because its version changed. */
export const VersionError = make('version', 'VersionError');

/** A request or socket wait exceeded its deadline. */
export const TimeoutError = make('timeout', 'TimeoutError');
