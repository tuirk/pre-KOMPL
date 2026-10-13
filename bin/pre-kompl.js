#!/usr/bin/env node
// `pre-kompl` command entry. No build step: register tsx's ESM loader and run
// the TypeScript CLI source directly, same as `npx tsx src/cli.ts`.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
