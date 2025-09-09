import process from "node:process";

function isStdoutTTY(): boolean {
  try {
    return !!process.stdout.isTTY;
  } catch {
    return false;
  }
}

const NO_COLOR = !!process.env["NO_COLOR"];
const COLOR_ENABLED = !NO_COLOR && isStdoutTTY();

function color(s: string, code: number) {
  return COLOR_ENABLED ? `\x1b[${code}m${s}\x1b[0m` : s;
}

function joinArgs(args: unknown[]) {
  return args.map((a) => {
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }).join(" ");
}

// Format unknown errors (Error, string, or anything) into a readable string for logging.
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    // Avoid duplicating the message: stack already starts with `Error: message`
    if (err.stack) return err.stack;
    const name = err.name || "Error";
    return err.message ? `${name}: ${err.message}` : name;
  }
  try {
    return typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export const log = {
  debug: (...args: unknown[]) => console.log(color(`·· ${joinArgs(args)}`, 90)), // dim
  info: (...args: unknown[]) => console.log(joinArgs(args)), // plain, no prefix/color
  warn: (...args: unknown[]) => console.warn(color(`⚠ ${joinArgs(args)}`, 33)), // yellow
  error: (...args: unknown[]) => console.error(color(`✖ ${joinArgs(args)}`, 31)), // red
};
