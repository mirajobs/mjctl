import { loadTokens, saveTokens } from "./keychain";
import type { StoredTokens, TokenResponse } from "./types";

export async function saveTokenBundle(t: TokenResponse) {
  const expiresAt = Math.floor(Date.now() / 1000) + t.expires_in;
  const bundle: StoredTokens = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt,
    scope: t.scope,
    subject: t.subject,
  };
  await saveTokens(bundle);
}

export async function loadTokenBundle(): Promise<StoredTokens | null> {
  return await loadTokens<StoredTokens>();
}
