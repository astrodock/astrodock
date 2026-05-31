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
}
