#!/usr/bin/env node
import { Command } from "commander";
import process from "node:process";
import { authCommand } from "./commands/auth";
import { profilesCommand } from "./commands/profiles";
import { redactCommand } from "./commands/redact";
import { cfg } from "./lib/config";
import { locationCommand } from "./commands/location";
import { formatError, log } from "./lib/log";
import { affiliateCommand } from "./commands/affiliate";

// Capture any uncaught async errors
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection:", formatError(reason));
  process.exitCode = 1;
});

// Capture any uncaught sync errors
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception:", formatError(err));
  process.exitCode = 1;
});

try {
  // Auto-help only when no args at all
  const argv = process.argv.slice(2);
  const args = argv.length === 0 ? ["--help"] : argv;

  const program = new Command();
  program
    .name(cfg.appName)
    .version(cfg.version)
    .description(`${cfg.appName} CLI`);

  program.addCommand(authCommand);
  program.addCommand(profilesCommand);
  program.addCommand(redactCommand);
  program.addCommand(locationCommand);
  program.addCommand(affiliateCommand);

  program.parse([process.argv[0], process.argv[1], ...args]);
} catch (e) {
  log.error(formatError(e));
  process.exitCode = 1;
}
