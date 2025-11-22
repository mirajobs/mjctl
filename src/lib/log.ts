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
    try {
      // Fast path for strings
      if (typeof a === "string") return a;

      // Preserve rich Error output (stack or name/message)
      if (a instanceof Error) return formatError(a);

      // Use custom toString when defined (and not the base Object implementation)
      if (a != null && typeof a === "object") {
        const ts = (a as any).toString;
        if (typeof ts === "function" && ts !== Object.prototype.toString) {
          const str = ts.call(a);
          if (typeof str === "string" && str.length) return str;
        }
      }

      // Primitive types (number, boolean, bigint, symbol)
      if (typeof a === "number" || typeof a === "boolean" || typeof a === "bigint" || typeof a === "symbol") {
        return String(a);
      }

      // Attempt JSON serialization; fall back to String()
      const json = JSON.stringify(a);
      return json !== undefined ? json : String(a);
    } catch {
      try {
        return String(a);
      } catch {
        return "[Unprintable]";
      }
    }
  }).join(" ");
}

// Format unknown errors (Error, string, or anything) into a readable string for logging.
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (typeof(err.toString) === "function") return err.toString(); 
    
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
