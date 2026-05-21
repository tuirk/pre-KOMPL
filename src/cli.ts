#!/usr/bin/env node
import { Command } from "commander";
import { cmdIngest, cmdStatus, cmdErrors, cmdPartials, cmdReclassify } from "./commands.js";

const program = new Command();
program
  .name("pre-kompl")
  .description("Lightweight catalog for saved bookmarks.")
  .version("0.1.0");

program
  .command("ingest <folder>")
  .description("Ingest a folder of bookmark exports / notes files")
  .action(async (folder: string) => {
    await cmdIngest(folder);
  });

program
  .command("status")
  .description("Show database statistics")
  .action(() => {
    cmdStatus();
  });

program
  .command("errors")
  .description("Show ingestion errors needing review")
  .option("-n, --limit <count>", "max errors to display", "20")
  .action((opts) => {
    cmdErrors(parseInt(opts.limit, 10));
  });

program
  .command("partials")
  .description("Show partial records (incomplete but in catalog)")
  .option("-n, --limit <count>", "max partials to display", "20")
  .action((opts) => {
    cmdPartials(parseInt(opts.limit, 10));
  });

program
  .command("reclassify")
  .description("Re-apply pure-logic rules (dead-link, brand-default, legacy migrations) to existing rows without re-fetching")
  .action(() => {
    cmdReclassify();
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
