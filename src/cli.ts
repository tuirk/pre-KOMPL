#!/usr/bin/env node
import { Command } from "commander";
import { cmdIngest, cmdStatus, cmdErrors, cmdPartials, cmdReclassify, cmdSearch, cmdRebuildFts } from "./commands.js";

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

program
  .command("search <query>")
  .description("BM25-ranked full-text search across the catalog. Returns ranked hits + facet counts for refinement.")
  .option("--source <list>", "comma-separated source filter: github,youtube,web,twitter")
  .option("--kind <list>", "comma-separated kind filter: video,github-repo,article,...")
  .option("--folder <prefix>", "filter by folder-path prefix")
  .option("--status <list>", "comma-separated ingest_status filter (default: ok)")
  .option("--partial <list>", "comma-separated partial_reason filter (e.g. dead_link)")
  .option("--limit <n>", "max results (default 20, cap 100)")
  .option("--json", "output the full envelope as JSON")
  .action((query: string, opts) => {
    cmdSearch(query, opts);
  });

program
  .command("rebuild-fts")
  .description("Rebuild the full-text-search index from current Instance data. Run once after upgrading from a pre-FTS DB.")
  .action(() => {
    cmdRebuildFts();
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
