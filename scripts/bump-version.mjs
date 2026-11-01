#!/usr/bin/env node
// The app version lives in package.json — tauri.conf.json reads it from
// there (`"version": "../package.json"`), and that's what `getVersion()`
// returns at runtime (the Settings > Sobre update check). Cargo.toml and
// the app's own entry in Cargo.lock carry a copy, kept in step here.
//
//   yarn version:bump 0.2.0           sets the version in all three files
//   node scripts/bump-version.mjs --check v0.2.0
//                                     fails unless all three already say 0.2.0
//
// Run the bump *before* tagging a release — commit the result, then
// `git tag vX.Y.Z` that commit — so the tag points at the code it
// describes. release.yml runs `--check` against the pushed tag and stops
// the build when they disagree, instead of quietly building a version the
// tagged commit doesn't contain.
import { readFileSync, writeFileSync } from "node:fs";

const PACKAGE_JSON = "package.json";
const CARGO_TOML = "src-tauri/Cargo.toml";
const CARGO_LOCK = "src-tauri/Cargo.lock";

// Only the [package] version — the first `version = "..."` line, since that
// section always comes first. Dependency constraints further down use a
// different key shape, so this won't touch those.
const CARGO_TOML_VERSION = /^version = "(.*)"$/m;
// This app's own [[package]] entry, not any dependency's. `\r?\n`, not
// `\n`: a Windows checkout (the Windows CI runner included) has CRLF line
// endings, which a bare `\n` never matches.
const CARGO_LOCK_VERSION = /(\[\[package\]\]\r?\nname = "pontoscan"\r?\nversion = )"(.*)"/;

const args = process.argv.slice(2);
const check = args[0] === "--check";
const raw = check ? args[1] : args[0];
if (!raw) {
  console.error("Usage: yarn version:bump <version>              (e.g. yarn version:bump 0.2.0)");
  console.error("       node scripts/bump-version.mjs --check <version-or-tag>");
  process.exit(1);
}
// Accepts a bare "0.2.0" or a "v"-prefixed tag name like "v0.2.0" (what
// release.yml passes, straight from the git tag) — stripped here instead of
// in the workflow's shell, since bash's `${VAR#v}` syntax breaks on Windows
// runners (`run:` steps there default to PowerShell).
const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`"${raw}" is not a version like 0.2.0 (or a tag like v0.2.0).`);
  process.exit(1);
}

function currentVersions() {
  const cargoToml = readFileSync(CARGO_TOML, "utf8").match(CARGO_TOML_VERSION);
  const cargoLock = readFileSync(CARGO_LOCK, "utf8").match(CARGO_LOCK_VERSION);
  return {
    [PACKAGE_JSON]: JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version,
    [CARGO_TOML]: cargoToml?.[1],
    [CARGO_LOCK]: cargoLock?.[2],
  };
}

if (check) {
  const mismatched = Object.entries(currentVersions()).filter(([, v]) => v !== version);
  if (mismatched.length > 0) {
    for (const [file, v] of mismatched) console.error(`${file} has version ${v ?? "(not found)"}, expected ${version}.`);
    console.error(`Run "yarn version:bump ${version}", commit, and move the tag to that commit.`);
    process.exit(1);
  }
  console.log(`Version ${version} matches ${Object.keys(currentVersions()).join(", ")}.`);
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
pkg.version = version;
writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + "\n");

const cargoToml = readFileSync(CARGO_TOML, "utf8");
if (!CARGO_TOML_VERSION.test(cargoToml)) throw new Error(`No [package] version found in ${CARGO_TOML}.`);
writeFileSync(CARGO_TOML, cargoToml.replace(CARGO_TOML_VERSION, `version = "${version}"`));

const cargoLock = readFileSync(CARGO_LOCK, "utf8");
if (!CARGO_LOCK_VERSION.test(cargoLock)) throw new Error(`No "pontoscan" package entry found in ${CARGO_LOCK}.`);
writeFileSync(CARGO_LOCK, cargoLock.replace(CARGO_LOCK_VERSION, `$1"${version}"`));

console.log(`Bumped app version to ${version} in ${PACKAGE_JSON}, ${CARGO_TOML} and ${CARGO_LOCK}.`);
console.log(`Next: review the diff, commit, then "git tag v${version}" that commit.`);
