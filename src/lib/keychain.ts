import { cfg } from "./config";
import { join } from "node:path";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import process from "node:process";
import { Buffer } from "node:buffer";
import { log } from "./log";

// Derive a stable machine-specific passphrase (used when cfg.keychainPassphrase is empty)
function defaultKeychainPassphrase(): string {
  // Prefer Linux machine-id if present
  const candidates = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
  for (const p of candidates) {
    try {
      const id = readFileSync(p, { encoding: "utf8" }).trim();
      if (id) return `mid:${id}`;
    } catch { /* ignore missing/unreadable machine-id */ }
  }
  // Fallback: hostname + OS/arch + home dir
  let hostname = "";
  try {
    hostname = os.hostname();
  } catch { /* ignore */ }
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  return `fp:${hostname}|${process.platform}|${process.arch}|${home}`;
}

interface Keychain {
  setSecret(service: string, account: string, password: string): Promise<void>;
  getSecret(service: string, account: string): Promise<string | null>;
  deleteSecret(service: string, account: string): Promise<boolean>;
}

// File-backed implementation
class FileKeychain implements Keychain {
  private u8ToB64(u8: Uint8Array): string {
    return Buffer.from(u8).toString("base64");
  }
  private b64ToU8(b64: string): Uint8Array {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  private async deriveKey(pass: string, salt: Uint8Array, iterations = 150_000) {
    const enc = new TextEncoder();
    const keyMat = await crypto.subtle.importKey(
      "raw",
      enc.encode(pass),
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations, hash: "SHA-256" },
      keyMat,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  // Resolve passphrase: use cfg.keychainPassphrase when non-empty; otherwise derive default.
  private getPassphrase(): string {
    const p = (cfg.keychainPassphrase ?? "").trim();
    return p || defaultKeychainPassphrase();
  }

  // Always encrypt (no plaintext fallback)
  private async encryptString(plaintext: string): Promise<string> {
    const pass = this.getPassphrase();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveKey(pass, salt);
    const enc = new TextEncoder();
    const alg: AesGcmParams = { name: "AES-GCM", iv: iv.buffer as ArrayBuffer };
    const ctBuf = await crypto.subtle.encrypt(alg, key, enc.encode(plaintext));
    return JSON.stringify({
      v: 1,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 150000, salt: this.u8ToB64(salt) },
      alg: "AES-GCM",
      iv: this.u8ToB64(iv),
      ct: this.u8ToB64(new Uint8Array(ctBuf)),
    });
  }

  // Always decrypt an envelope (no legacy autodetect)
  private async decryptString(data: string): Promise<string> {
    const obj = JSON.parse(data);
    if (!(obj && obj.ct && obj.iv && obj.kdf && obj.kdf.salt && obj.kdf.iterations)) {
      throw new Error("Invalid keychain data format.");
    }
    const pass = this.getPassphrase();
    const salt = this.b64ToU8(String(obj.kdf.salt));
    const iv = this.b64ToU8(String(obj.iv));
    const ct = this.b64ToU8(String(obj.ct));
    const iters = Number(obj.kdf.iterations);
    const key = await this.deriveKey(pass, salt, isFinite(iters) && iters > 0 ? iters : 150000);
    const alg: AesGcmParams = { name: "AES-GCM", iv: iv.buffer as ArrayBuffer };
    const ptBuf = await crypto.subtle.decrypt(alg, key, ct.buffer as ArrayBuffer);
    return new TextDecoder().decode(new Uint8Array(ptBuf));
  }

  private configDir() {
    const maybePath = (cfg as unknown as Record<string, unknown>)["keychainFilePath"];
    if (typeof maybePath === "string" && maybePath) return maybePath;
    const isWindows = process.platform === "win32";
    if (isWindows) return process.env["APPDATA"] ?? process.env["USERPROFILE"] ?? ".";
    return process.env["XDG_CONFIG_HOME"] ?? ((process.env["HOME"] ?? ".") + "/.config");
  }

  private async fileFor(service: string, account: string) {
    const base = await this.configDir();
    const dir = join(base, cfg.appName);
    const file = join(dir, `${service}_${account}.json`);
    return { dir, file };
  }

  async setSecret(service: string, account: string, password: string) {
    const { dir, file } = await this.fileFor(service, account);
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    try {
      if (process.platform !== "win32") await fs.chmod(dir, 0o700);
    } catch { /* ignore chmod */ }
    const tmp = file + ".tmp";

    const payload = await this.encryptString(password);
    await fs.writeFile(tmp, payload, { encoding: "utf8" });

    try {
      if (process.platform !== "win32") await fs.chmod(tmp, 0o600);
    } catch { /* ignore chmod */ }
    await fs.rename(tmp, file);
    try {
      if (process.platform !== "win32") await fs.chmod(file, 0o600);
    } catch { /* ignore chmod */ }
  }

  async getSecret(service: string, account: string) {
    const { file } = await this.fileFor(service, account);
    try {
      const data = await fs.readFile(file, { encoding: "utf8" });
      return await this.decryptString(data);
    } catch (e: unknown) {
      // If file does not exist, return null; otherwise handle decryption errors explicitly
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;

      const errName = e instanceof Error ? e.name : "";
      const msg = e instanceof Error ? e.message : String(e ?? "");
      if (errName === "OperationError" || msg.toLowerCase().includes("decryption failed")) {
        log.error(
          `Stored credentials could not be decrypted. The passphrase may have changed or the data is corrupted. Please run '${cfg.appName} auth login' to sign in again.`,
        );
        // Best-effort cleanup to avoid repeated failures
        try {
          await this.deleteSecret(service, account);
        } catch { /* ignore cleanup failure */ }
        return null;
      }

      throw e;
    }
  }

  async deleteSecret(service: string, account: string) {
    const { file } = await this.fileFor(service, account);
    try {
      await fs.rm(file);
      return true;
    } catch {
      return false;
    }
  }
}

// Factory to choose implementation; only file backend is supported.
function createKeychain(): Keychain {
  return new FileKeychain();
}

// top-level await to select the keychain provider at module init
const keychain: Keychain = createKeychain();

// Exported helpers
export async function saveTokens(data: unknown): Promise<void> {
  const payload = JSON.stringify(data);
  await keychain.setSecret(cfg.keychainService, cfg.keychainAccount, payload);
}

export async function loadTokens<T = unknown>(): Promise<T | null> {
  const val = await keychain.getSecret(cfg.keychainService, cfg.keychainAccount);
  return val ? JSON.parse(val) as T : null;
}

export async function deleteTokens(): Promise<void> {
  log.info("Deleting tokens from keychain");
  await keychain.deleteSecret(cfg.keychainService, cfg.keychainAccount);
}
