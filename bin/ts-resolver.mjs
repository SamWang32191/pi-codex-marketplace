import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const STRIP_TYPES_WARNING = "stripTypeScriptTypes is an experimental feature and might change at any time";

function stripTypes(source) {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    const message = warning instanceof Error ? warning.message : String(warning);
    if (message === STRIP_TYPES_WARNING) return;
    emitWarning.call(process, warning, ...args);
  };

  try {
    return stripTypeScriptTypes(source, { mode: "strip" });
  } finally {
    process.emitWarning = emitWarning;
  }
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.endsWith(".js")) {
      const tsSpecifier = specifier.slice(0, -3) + ".ts";
      try {
        return await nextResolve(tsSpecifier, context);
      } catch {
        // Fall back to original error
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts")) {
    return nextLoad(url, context);
  }

  const source = await readFile(new URL(url), "utf8");
  return {
    format: "module",
    shortCircuit: true,
    source: stripTypes(source),
  };
}
