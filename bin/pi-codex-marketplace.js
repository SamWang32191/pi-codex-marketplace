#!/usr/bin/env node
import { register } from "node:module";

try {
  register("./ts-resolver.mjs", import.meta.url);
} catch {
  // Module registration unsupported or already active
}

const { runCli } = await import("../src/cli/index.js");
const code = await runCli(process.argv.slice(2), process);
process.exitCode = code;
