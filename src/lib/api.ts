import apiClient from "./apiclient";
import type { StartEmailLoginResponse, TokenResponse } from "./types";
import { loadTokenBundle } from "./auth";
import { cfg } from "./config";
import { log } from "./log";

const DEFAULT_SCOPES = "default offline_access";

export async function refreshAccessToken() {
  return await apiClient.refreshAccessToken();
}

export async function startEmailLogin(email: string) {
  return await apiClient.sendRequest<StartEmailLoginResponse>("/auth/email/start", {
    params: { email, scopes: DEFAULT_SCOPES },
    auth: false,
  });
}

export async function verifyEmailCode(loginId: string, code: string) {
  return await apiClient.sendRequest<TokenResponse>("/auth/email/verify", {
    params: { login_id: loginId, token: code },
    auth: false,
  });
}

export async function revokeRefreshToken(refreshToken: string) {
  return await apiClient.sendRequest("/auth/revoke", { params: { refresh_token: refreshToken } });
}

export async function checkUserStatus(): Promise<Record<string, unknown>> {
  const tokens = await loadTokenBundle();
  const jwt = tokens?.accessToken;
  if (!jwt) {
    throw new Error(
      `No JWT found in keychain. Authenticate with \`${cfg.appName} auth login\`.`,
    );
  }

  const expiresIn = Math.floor(tokens.expiresAt - Date.now() / 1000);

  if (expiresIn >= 0) {
    log.info("Access token expires in " + expiresIn + " seconds");
  }

  return await apiClient.sendRequest<Record<string, unknown>>("/user/status", { method: "GET" });
}

/* Profile class and profile APIs
   - Profile: typed fields used by the CLI + preserves raw payload for toJSON
   - All profile APIs use apiClient.sendRequest so they benefit from retries/auth handling
*/

export class Profile {
  ProfileID?: string;
  Title?: string;
  Category?: string;
  ShortUrl?: string;
  Visibility?: string;
  Created?: string;
  Summary?: string;
  Yaml?: string;

  private _raw: unknown;

  [key: string]: unknown;

  constructor(data: unknown = {}) {
    this._raw = data;
    Object.assign(this, data);
  }

  toJSON() {
    return this._raw;
  }
}

export async function listProfiles(): Promise<Profile[]> {
  const arr = await apiClient.sendRequest<Profile[]>("/user/profiles", {
    method: "GET",
    ctor: Profile,
  });
  return Array.isArray(arr) ? arr : [];
}

export async function getProfile(identifier: string): Promise<Profile | null> {
  return await apiClient.sendRequest<Profile | null>(
    `/user/profiles/${encodeURIComponent(identifier)}`,
    { method: "GET", ctor: Profile },
  );
}

export async function createProfile(payload: Record<string, unknown>): Promise<Profile> {
  return await apiClient.sendRequest<Profile>("/user/profiles", {
    params: payload,
    method: "POST",
    ctor: Profile,
  });
}

export async function updateProfile(
  id: string,
  payload: Record<string, unknown>,
): Promise<Profile> {
  return await apiClient.sendRequest<Profile>(`/user/profiles/${encodeURIComponent(id)}`, {
    params: payload,
    method: "PUT",
    ctor: Profile,
  });
}

export async function deleteProfile(
  id: string,
): Promise<void> {
  await apiClient.sendRequest<void>(`/user/profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function generateProfileFromResume(
  resumePath: string,
  opts?: { title?: string },
) {
  const fname = resumePath.split(/\\|\//).pop() || "resume";
  const title = opts?.title || "";
  return {
    title: title || `Profile from ${fname}`,
    slug: undefined as string | undefined,
    visibility: "private",
    summary: `AI draft generated from ${fname}`,
    skills: [] as unknown[],
    experience: [] as unknown[],
    contact: {} as Record<string, unknown>,
    metadata: { ai_source: fname } as Record<string, unknown>,
  };
}

// Location types
export type LocationInfo = {
  CountryCode?: string;
  Country?: string;
  RegionID?: number | string;
  Region?: string;
  CityID?: number | string;
  City?: string;
};

export type Country = { CountryCode: string; Country: string };
export type Region = { RegionID: number | string; Region: string };
export type City = { CityID: number | string; City: string };

// Location API
export async function getUserLocation(): Promise<LocationInfo | null> {
  return await apiClient.sendRequest<LocationInfo | null>("/user/location", { method: "GET" });
}

export async function setUserLocation(input: {
  CountryCode?: string;
  RegionID?: number | string;
  CityID?: number | string;
  Detect?: boolean; // when true, server sets location from IP
}): Promise<LocationInfo> {
  await apiClient.sendRequest("/user/location", { method: "PUT", params: input });
  // Fetch resolved labels after save for display
  return await getUserLocation() as LocationInfo;
}

export async function searchCountries(query = "", limit = 15): Promise<Country[]> {
  return await apiClient.sendRequest<Country[]>("/user/locations/countries", {
    method: "GET",
    params: { query, limit },
  });
}

export async function searchRegions(
  CountryCode: string,
  query = "",
  limit = 15,
): Promise<Region[]> {
  return await apiClient.sendRequest<Region[]>("/user/locations/regions", {
    method: "GET",
    params: { CountryCode, query, limit },
  });
}

export async function searchCities(
  RegionID: number | string,
  query = "",
  limit = 15,
): Promise<City[]> {
  return await apiClient.sendRequest<City[]>("/user/locations/cities", {
    method: "GET",
    params: { RegionID, query, limit },
  });
}

type AffiliateLinkResponse = { link?: string | null };
export async function getAffiliateLink(): Promise<string | null> {
  const data = await apiClient.sendRequest<AffiliateLinkResponse>("/user/affiliate/link", {
    method: "GET",
  });
  return data?.link ?? null;
}

export default {
  refreshAccessToken,
  startEmailLogin,
  verifyEmailCode,
  revokeRefreshToken,
  checkUserStatus,
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  generateProfileFromResume,
  getUserLocation,
  setUserLocation,
  searchCountries,
  searchRegions,
  searchCities,
  getAffiliateLink,
};
