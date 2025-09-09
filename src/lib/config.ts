import dotenv from "dotenv";
import process from "node:process";
dotenv.config();

const APP_NAME = "mjctl";
const APP_VERSION = "0.1.0";

const ENV_PREFIX = APP_NAME.toUpperCase();

export const cfg = {
  appName: APP_NAME,
  version: APP_VERSION,
  apiBase: process.env[`${ENV_PREFIX}_API_URL`] ?? "https://mirajobs.com",
  apiClientId: APP_NAME,
  apiBasicAuthUser: process.env[`${ENV_PREFIX}_API_USER`] ?? "",
  apiBasicAuthPassword: process.env[`${ENV_PREFIX}_API_PASSWORD`] ?? "",
  apiMaxAttempts: 5,
  keychainService: APP_NAME,
  keychainAccount: `tokens`,
  // Empty => keychain.ts derives a default machine-specific passphrase
  keychainPassphrase: process.env[`${ENV_PREFIX}_KEYCHAIN_PASSPHRASE`],
};
