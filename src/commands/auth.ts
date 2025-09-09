import { Command } from "commander";
import { Input } from "../lib/prompt";
import {
  checkUserStatus,
  revokeRefreshToken,
  startEmailLogin,
  verifyEmailCode,
} from "../lib/api";
import { loadTokenBundle, saveTokenBundle } from "../lib/auth";
import { cfg } from "../lib/config";
import { log } from "../lib/log";
import { ApiClientError } from "../lib/apiclient";

const auth = new Command("auth")
  .description("Authenticate and manage tokens")
  .action(function (this: Command) {
    this.outputHelp();
  });

auth
  .command("login")
  .description("Login via email + one-time code (no browser)")
  .option("--email <email:string>", "Email address to authenticate")
  .action(async (opts: { email?: string }) => {
    const isValidEmail = (v: string) => /\S+@\S+\.\S+/.test(String(v ?? "").trim());

    let email = (opts.email ?? "") as string;
    email = (email || "").trim();

    if (email && !isValidEmail(email)) {
      log.error(
        "Invalid email provided via --email. Provide a valid email or omit the flag to be prompted.",
      );
      return;
    }

    if (!email) {
      email = await Input.prompt({
        message: "Email address:",
        prefix: "",
        validate: (v: string) => isValidEmail(v) || "Enter a valid email address",
      });
      email = String(email).trim();
    }

    let start;
    try {
      start = await startEmailLogin(email);
    } catch (e) {
      log.error("Failed to start email login:", e);
      return;
    }

    if (!start || typeof start.code_length !== "number") {
      log.error("Unexpected response from server when starting login.");
      return;
    }

    log.info(
      `We sent a ${start.code_length}-digit code to ${email}. It expires in ${
        start.expires_in / 60
      } min.`,
    );

    let attempts = start.attempts_remaining ?? 5;
    while (attempts-- > 0) {
      const regex = new RegExp(`^[0-9a-zA-Z-]+$`);
      let code = await Input.prompt({
        message: "Enter code from email:",
        prefix: "",
        validate: (v: string) => regex.test(v.trim()) || "Enter alphanumeric characters",
      });
      try {
        code = code.trim().replace(/-/g, "");
        const t = await verifyEmailCode(start.login_id, code);
        log.info(
          `✓ Authenticated as ${email}. Access token expires in ~${
            Math.floor(t.expires_in / 60)
          }m.`,
        );
        await saveTokenBundle(t);
        log.info(`Tokens stored in keychain.`);
        return;
      } catch (e) {
        if (attempts > 0) {
          log.error(`Invalid or expired code. ${attempts} attempt(s) left.`, e);
        } else {
          log.error(`Login failed. Please retry \`${cfg.appName} auth login\`.`);
        }
      }
    }
  });

auth
  .command("status")
  .description("Show current auth status")
  .action(async () => {
    const tok = await loadTokenBundle();
    if (!tok) {
      log.warn(`No auth token found. Try: ${cfg.appName} auth login --email you@example.com`);
      return;
    }

    try {
      const status = await checkUserStatus();
      log.info(`Server status: ${JSON.stringify(status)}`);
    } catch (e) {
      log.error("Failed to get user status from server:", e);
    }
  });

auth
  .command("logout")
  .description("Revoke tokens and remove from keychain")
  .action(async () => {
    // Check if token exists
    const tokens = await loadTokenBundle();
    if (!tokens?.refreshToken) {
      log.warn("No refresh token found, already logged out.");
      return;
    }

    // Trigger a status check to refresh access token if needed
    let status = null;
    try {
      status = await checkUserStatus();
    } catch (e) {
      if (e instanceof ApiClientError && e.statusCode !== 401) {
        log.error("Aborting logout due to unexpected error.", e);
        return;
      }

      log.warn("Failed to check user status due to access denied error, skipping revoke.");
    }

    if (status) {
      const tokens = await loadTokenBundle();
      if (tokens?.refreshToken) {
        try {
          await revokeRefreshToken(tokens.refreshToken);
        } catch (e) {
          log.error("Error revoking token:", e);
        }
      } else {
        log.warn("No refresh token found, skipping revoke.");
      }
    }

  const { deleteTokens } = await import("../lib/keychain");
    await deleteTokens();
    log.info(`✓ Logged out.`);
  });

export const authCommand = auth;
