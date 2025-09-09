import { Command } from "commander";
import { redactResumeFile } from "../lib/pii";
import type { LLMFlagger } from "../lib/pii";
import { cfg } from "../lib/config";
import { log } from "../lib/log";

export const redactCommand = new Command("redact")
  .description("Redact PII from a resume file (PDF/TXT)")
  .arguments("<file:string>")
  .option(
    "--out <path:string>",
    "Optional output base path (without added suffix). e.g. --out ./resume.redacted",
  )
  .option("--upload", "(not implemented) Upload redacted text to the API without prompting")
  .action(async (opts: { out?: string; upload?: boolean }, file: string) => {
    if (!file) {
      log.error(`Usage: ${cfg.appName} redact <file>`);
      return;
    }

    const useNER = true; // envvar MJ_PII_NE == 1
    const flagger: LLMFlagger | null = null;

    // Optional: dynamically load a local Ollama flagger in the future.
    // if (useFlagger) {
    //   try {
    //     // Try to dynamically load an Ollama flagger implementation if present.
    //     // This module is optional; proceed without a flagger if it isn't installed.
    //     const mod = await import("../lib/flagger_ollama.ts");
    //     if (typeof mod?.OllamaFlagger === "function") {
    //       flagger = new mod.OllamaFlagger();
    //     } else {
    //       console.warn("Ollama flagger module found but exported symbol missing. Continuing without flagger.");
    //     }
    //   } catch (e) {
    //     console.warn("Ollama flagger not available, continuing without flagger.");
    //   }
    // }

    try {
      const outBase = opts.out ? String(opts.out).replace(/\.[^.]+$/, "") : undefined;

      const res = await redactResumeFile(file, {
        useNER,
        flagger,
        previewLimit: 12,
        outBase,
      });

      log.info(`✓ Wrote: ${res.outRedactedPath}`);
      log.info(`✓ Wrote: ${res.outReportPath}`);
      log.info("PII counts:", res.counts);

      if (opts.upload) {
        log.warn(
          "--upload is not implemented in this CLI version. The redacted file has been saved for local review.",
        );
      }

      log.info("Review the redacted file locally before uploading.");
      log.info(
        "To upload the redacted file and generate a profile, a separate command will be provided later.",
      );
    } catch (e: unknown) {
      log.error("Failed to redact file:", e instanceof Error ? e.message : String(e));
    }
  });

export default redactCommand;
