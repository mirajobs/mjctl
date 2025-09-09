import { Command } from "commander";
import * as api from "../lib/api";
import { log } from "../lib/log";
import { cfg } from "../lib/config";

const affiliate = new Command("affiliate")
  .description("Affiliate program")
  .action(function (this: Command) {
    this.outputHelp();
  });

affiliate
  .command("link")
  .description("Show your affiliate link")
  .action(async () => {
    try {
      const link = await api.getAffiliateLink();
      log.info(link);
    } catch (e) {
      log.error("Failed to get affiliate link:", e instanceof Error ? e.message : String(e));
    }
  });

affiliate
  .command("stats")
  .description("View affiliate stats in the web UI")
  .action(() => {
    log.info(`View your affiliate stats at: ${cfg.apiBase}/user/affiliate`);
  });

export const affiliateCommand = affiliate;
export default affiliateCommand;
