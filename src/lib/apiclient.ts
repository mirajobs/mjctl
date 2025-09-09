import { saveTokenBundle } from "./auth";
import { cfg } from "./config";
import { deleteTokens, loadTokens } from "./keychain";
import { log } from "./log";
import { Buffer } from "node:buffer";
import process from "node:process";
import type { StoredTokens, TokenResponse } from "./types";

const BUILD_INFO = {
  os: process.platform,
  arch: process.arch,
  ver: cfg.version,
};

export class ApiClientError extends Error {
  statusCode?: number;
  statusText?: string;
  response?: Response;
  responseText?: string;

  constructor(
    message: string,
    statusCode?: number,
    response?: Response,
    responseText?: string,
  ) {
    super(message);

    this.name = "ApiClientError";

    this.statusCode = statusCode;
    this.response = response;
    this.responseText = responseText;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ApiClientError);
    }
  }

  override toString(): string {
    const parts: string[] = [];
    if (this.statusCode != null) {
      parts.push(String(this.statusCode) + (this.statusText ? ` ${this.statusText}` : ""));
    }
    if (this.message) parts.push(this.message);
    return parts.length ? parts.join(" : ") : super.toString();
  }
}

export class ApiClient {
  apiBase: string;
  clientId: string;

  constructor(apiBase: string, clientId: string) {
    this.apiBase = apiBase;
    this.clientId = clientId;
  }

  // normalize API path to start with /api/v1/
  normalizePath(path: string) {
    path = path.startsWith("/v1/") || path.startsWith("/api/v1/")
      ? path
      : path.startsWith("/")
      ? `/v1${path}`
      : `/v1/${path}`;

    path = path.startsWith("/api/") ? path : path.startsWith("/") ? `/api${path}` : `/api/${path}`;

    return path;
  }

  sleep(attempt: number) {
    const backoff = Math.pow(2, Math.max(0, attempt - 1)) * 1000 +
      Math.floor(Math.random() * 100);
    log.debug("Waiting for", backoff, "ms ...");
    return new Promise((res) => setTimeout(res, backoff));
  }

  buildHeaders(stored: StoredTokens | null, extra?: Record<string, string>) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(extra ?? {}),
    };

    if (stored?.accessToken) {
      headers["X-Access-Token"] = `Bearer ${stored.accessToken}`;
    }

    if (cfg.apiBasicAuthUser && cfg.apiBasicAuthPassword) {
      const b64 = Buffer.from(`${cfg.apiBasicAuthUser}:${cfg.apiBasicAuthPassword}`, "utf8").toString("base64");
      headers["Authorization"] = `Basic ${b64}`;
    }

    const nodeVer = process.versions.node;
    headers["User-Agent"] =
      `${cfg.appName}Client/${BUILD_INFO.ver} (${this.clientId}; ${BUILD_INFO.os}; ${BUILD_INFO.arch}) Node/${nodeVer}`;

    headers["X-Client-Id"] = this.clientId;
    headers["X-Build-Info"] = JSON.stringify(BUILD_INFO);

    return headers;
  }

  private buildHeadersWithIdempotencyKey(headers: Record<string, string>) {
    const headersWithIdempotency = { ...headers };
    if (!headersWithIdempotency["Idempotency-Key"]) {
      headersWithIdempotency["Idempotency-Key"] = crypto.randomUUID();
    }
    return headersWithIdempotency;
  }

  async getErrorForNonOkResponse(res: Response) {
    const status = res.status;
    const text = await res.text().catch(() => "");
    let message;

    try {
      const json = JSON.parse(text);
      message = json?.msg;
      if (message && json?.details) {
        message += " - " + json.details;
      }
    } catch { /* ignore */ }

    message ??= `${status} ${res.statusText}`;

    const error = new ApiClientError(message, res.status, res, text);
    error.statusText = res.statusText;

    return error;
  }

  async sendRequest<T>(
    path: string,
    options?: {
      params?: Record<string, unknown>;
      auth?: boolean;
      headers?: Record<string, string>;
      method?: string;
      maxAttempts?: number;
      // optional constructor or factory to turn plain JSON into T (or array of T)
      ctor?: { new (data: unknown): unknown } | ((data: unknown) => unknown);
    },
  ): Promise<T> {
    const nowEpoch = Math.floor(Date.now() / 1000);

    const params = options?.params;
    const method = options?.method?.toUpperCase() ?? "POST";
    const headers = method === "GET" || method === "HEAD"
      ? options?.headers
      : this.buildHeadersWithIdempotencyKey(options?.headers ?? {});

    const maxAttempts = options?.maxAttempts ?? cfg.apiMaxAttempts ?? 5;
    let result;
    let lastStatusCode;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (options?.auth !== false) {
          const tokens = await loadTokens<StoredTokens>();
          if (!tokens) {
            throw new ApiClientError(
              "No auth token found. Please authenticate with 'auth login'.",
              401,
            );
          }

          // Check if we need to proactively refresh tokens if expiring soon
          const tokenExpiresSoon = tokens.expiresAt <= nowEpoch + 30;
          const tokenAlreadyExpired = tokens.expiresAt <= nowEpoch;

          if (lastStatusCode === 401 || tokenExpiresSoon || tokenAlreadyExpired) {
            try {
              const issue = tokenAlreadyExpired
                ? "has expired"
                : (tokenExpiresSoon ? "is expiring soon" : "authorization failed");
              log.warn(`Access token ${issue}, refreshing...`);
              await this.refreshAccessToken();
            } catch (refreshErr) {
              if (lastStatusCode === 401 || tokenAlreadyExpired) {
                throw new ApiClientError(String(refreshErr), 401);
              }
              log.debug(
                "Failed to refresh access token that is expiring soon. Proceeding with request despite token refresh failure.",
                refreshErr,
              );
            }
          }
        }

        result = await this.sendRequestInternal<T>(path, method, params, headers);
        break;
      } catch (e) {
        // Unknown exception, re-throw immediately
        if (!(e instanceof ApiClientError)) {
          throw new ApiClientError(String(e));
        }

        // Max attempts reached, re-throw
        if (attempt === maxAttempts) {
          throw e;
        }

        // Non-retriable status code, re-throw
        const retriableStatus = !e.statusCode || e.statusCode === 408 || e.statusCode === 429 ||
          (e.statusCode >= 500 && e.statusCode < 600);
        if (!retriableStatus) {
          throw e;
        }

        log.debug(`Retrying attempt ${attempt}/${maxAttempts}...`);

        lastStatusCode = e.statusCode;

        // Exponential backoff + jitter
        await this.sleep(attempt);
      }
    }

    // instantiate results if a constructor/factory was provided
    return this.instantiateResult<T>(result, options?.ctor);
  }

  // Create instances from plain JSON result when a ctor/factory is provided.
  private instantiateResult<T>(
    result: unknown,
    ctor?: { new (data: unknown): unknown } | ((data: unknown) => unknown),
  ): T {
    if (!ctor) return result as T;

    const isConstructor = (f: unknown): f is { new (data: unknown): unknown } => {
      return typeof f === "function" && !!(f as { prototype?: unknown }).prototype;
    };

    const instantiate = (item: unknown): unknown => {
      try {
        if (isConstructor(ctor)) {
          return new ctor(item);
        }
        return (ctor as (d: unknown) => unknown)(item);
      } catch {
        return item;
      }
    };

    if (Array.isArray(result)) {
      return (result as unknown[]).map((it) => instantiate(it)) as unknown as T;
    }
    return instantiate(result) as unknown as T;
  }

  private async sendRequestInternal<T>(
    path: string,
    method: string,
    params?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(this.normalizePath(path), this.apiBase);

    const tokens = await loadTokens<StoredTokens>();
    const headers = this.buildHeaders(tokens, extraHeaders);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    try {
      const fetchOpts: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      const mUpper = method.toUpperCase();
      if ((mUpper === "GET" || mUpper === "HEAD") && params && typeof params === "object") {
        for (const [k, v] of Object.entries(params)) {
          if (v === undefined || v === null) continue;
          const value = typeof v === "string" || typeof v === "number" || typeof v === "boolean"
            ? String(v)
            : JSON.stringify(v);
          url.searchParams.append(k, value);
        }
      } else if (params != null) {
        fetchOpts.body = JSON.stringify(params);
      }

      const start = Date.now();
      const res = await fetch(url, fetchOpts);
      const elapsed = Date.now() - start;

      if (!res.ok) {
        throw await this.getErrorForNonOkResponse(res);
      }

      log.debug(
        `${method} request to ${url.href} succeeded: ${res.status} ${res.statusText} (took ${elapsed}ms)`,
      );

      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return (await res.json()) as T;
      } else {
        return (await res.text()) as unknown as T;
      }
    } catch (e) {
      log.debug(`${method} request to ${url.href} failed: ${String(e)}`);
      const err = e instanceof ApiClientError ? e : new ApiClientError(String(e));
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async refreshAccessToken() {
    const tokens = await loadTokens<StoredTokens>();
    if (!tokens) {
      throw new ApiClientError("No auth token found. Please authenticate with 'auth login'.", 401);
    }

    const json = await this.sendRequestInternal<TokenResponse>(
      "/v1/auth/token",
      "POST",
      {
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      },
    );
    await saveTokenBundle(json);
  }

  async logout() {
    const tokens = await loadTokens<StoredTokens>();
    if (!tokens) {
      throw new ApiClientError("No auth token found. Please authenticate with 'auth login'.", 401);
    }

    await this.sendRequest("/v1/auth/revoke", { method: "POST" });

    await deleteTokens();
  }
}

export default new ApiClient(cfg.apiBase, cfg.apiClientId);
