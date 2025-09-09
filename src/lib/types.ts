export type StartEmailLoginResponse = {
  login_id: string;
  expires_in: number;
  attempts_remaining: number;
  code_length: number;
  rate_limit_after?: number;
};

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: "Bearer";
  scope?: string;
  subject?: { email: string };
};

export type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
  email?: string;
  scope?: string;
  subject?: { email: string };
};
