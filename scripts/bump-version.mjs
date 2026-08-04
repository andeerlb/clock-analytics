#!/usr/bin/env node
// Bumps tauri.conf.json's and Cargo.toml's version together, in one place,
// so they can't drift apart. Run this *before* tagging a release — commit
// the result, then `git tag vX.Y.Z` that commit — so the tag actually
// points at the code it describes, and `getVersion()` (read at runtime by
// the Settings > Sobre update check) matches what the tag says once built.
//
// `release.yml` also runs this same script per build, as a fallback in
// case a release ever gets tagged without bumping first — but that's a
// safety net, not the primary flow: it patches the CI runner's own
// checkout only, never commits anything back.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: yarn version:bump <version>   (e.g. yarn version:bump 0.2.0)");
  process.exit(1);
}

const confPath = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = version;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

// Only the [package] version — the first `version = "..."` line, since
// that section always comes first in this file. Dependency version
// constraints live under `[dependencies]`/`[dependencies.foo]` further
// down and use a different key shape (`name = "1.2"` or `{ version = ... }`
// inside a table), so this regex won't touch those.
const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8");
const updated = cargo.replace(/^version = ".*"$/m, `version = "${version}"`);
writeFileSync(cargoPath, updated);

console.log(`Bumped app version to ${version} in tauri.conf.json and Cargo.toml.`);
console.log(`Next: review the diff, commit, then "git tag v${version}" that commit.`);
