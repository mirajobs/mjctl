import prompts, { PromptObject } from "prompts";

// Simple shim to emulate the subset of @cliffy/prompt used in the codebase.
// Usage mirrors: await Input.prompt({ message, prefix?, validate? })

type NamedPrompt = PromptObject & { name: string };
async function ask<T = string>(q: NamedPrompt): Promise<T> {
  const res = await prompts(q, { onCancel: () => void 0 });
  const key = q.name || "value";
  return res[key] as T;
}

export const Input = {
  async prompt(opts: { message: string; prefix?: string; validate?: (v: string) => boolean | string }) {
    return await ask<string>({
      type: "text",
      name: "value",
      message: opts.message,
      validate: opts.validate,
    });
  },
};

export const Confirm = {
  async prompt(opts: { message: string }) {
    return await ask<boolean>({ type: "confirm", name: "value", message: opts.message, initial: false });
  },
};

export const Select = {
  async prompt<T = unknown>(opts: { message: string; options: Array<{ name: string; value: T }> }) {
    const choice = await ask<T>({
      type: "select",
      name: "value",
      message: opts.message,
      choices: opts.options.map((o) => ({ title: o.name, value: o.value })),
    });
    return choice as T;
  },
};
