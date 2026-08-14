#!/usr/bin/env bun
/**
 * Validates the [vars] block of wrangler.toml before deploy — catches a
 * malformed SIGNAL_WEIGHTS (or one of the optional detection-list overrides)
 * at deploy time rather than at the first incoming email in production.
 */
import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { isValidScores } from "../src/scoring.ts";

const LIST_VARS = [
  "SUSPICIOUS_TLDS",
  "DANGEROUS_EXTENSIONS",
  "MACRO_EXTENSIONS",
  "OOXML_ZIP_EXTENSIONS",
];

function parseJsonVar(name, raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
}

/** Validates a wrangler.toml `[vars]` object; returns a list of error messages (empty when valid). */
export function validateVars(vars) {
  const errors = [];

  if (typeof vars.SIGNAL_WEIGHTS !== "string") {
    errors.push("SIGNAL_WEIGHTS is missing from [vars].");
  } else {
    try {
      const weights = parseJsonVar("SIGNAL_WEIGHTS", vars.SIGNAL_WEIGHTS);
      if (!isValidScores(weights)) {
        errors.push(
          "SIGNAL_WEIGHTS must have exactly the keys content, url, header, " +
            "dnsbl, attachment, pii, each a finite number >= 0.",
        );
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  for (const name of LIST_VARS) {
    const raw = vars[name];
    if (raw === undefined) continue; // optional — falls back to a built-in default
    try {
      const values = parseJsonVar(name, raw);
      if (
        !Array.isArray(values) ||
        !values.every((v) => typeof v === "string")
      ) {
        errors.push(`${name} must be a JSON array of strings.`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (
    vars.STATS_ENABLED !== undefined &&
    vars.STATS_ENABLED !== "true" &&
    vars.STATS_ENABLED !== "false"
  ) {
    errors.push('STATS_ENABLED must be "true" or "false".');
  }

  for (const name of ["STATS_HOUR_RETENTION_DAYS", "STATS_DAY_RETENTION_DAYS"]) {
    const raw = vars[name];
    if (raw === undefined) continue; // optional — falls back to a built-in default
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      errors.push(`${name} must be a positive integer.`);
    }
  }

  return errors;
}

async function main() {
  const wranglerTomlPath = new URL("../wrangler.toml", import.meta.url);
  const toml = await readFile(wranglerTomlPath, "utf8");
  const config = parseToml(toml);
  const errors = validateVars(config.vars ?? {});

  if (errors.length > 0) {
    console.error("wrangler.toml config validation failed:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log("wrangler.toml config is valid.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
