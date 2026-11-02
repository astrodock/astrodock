export interface AstrodockAuthOptions {
  authUrl?: string;
  appId?: string;
  appSecret?: string;
}

export interface VerifyResult {
  userId: string;
  email: string;
  name: string;
}

export interface VerifyOptions {
  clientIp?: string;
}

export interface NotifyInput {
  /** The person's platform user id. Give this or `email`. */
  userId?: string;
  email?: string;
  /** Up to 120 characters. */
  title: string;
  /** Up to 1000 characters. */
  body?: string;
  /** Where in your app a tap opens. Must start with a single "/". */
  path?: string;
}

export interface NotifyResult {
  id: string;
}

export class AuthError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number);
}

export class AstrodockAuth {
  authUrl: string;
  appId: string;
  appSecret: string;
  constructor(opts?: AstrodockAuthOptions);
  verify(email: string, password: string, opts?: VerifyOptions): Promise<VerifyResult>;
  notify(notification: NotifyInput): Promise<NotifyResult>;
}
