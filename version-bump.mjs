// Sync manifest.json and versions.json with package.json on `npm version`.
// `npm version <bump>` writes the new version to package.json, runs this
// via the `version` lifecycle hook, then commits + tags the staged files.
import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error("version-bump: npm_package_version is not set — run via `npm version`.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`version-bump: synced manifest.json + versions.json to ${targetVersion} (minAppVersion ${minAppVersion}).`);
