import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const manifestPath = new URL("./manifest.json", import.meta.url);
const sourcePath = new URL("./src/index.js", import.meta.url);
const distDir = new URL("./dist/", import.meta.url);
const distMainPath = new URL("./dist/index.js", import.meta.url);
const distManifestPath = new URL("./dist/manifest.json", import.meta.url);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const source = await readFile(sourcePath, "utf8");
const forceDeveloperBuild = process.argv.includes("--developer-build");
const forceReleaseBuild = process.argv.includes("--release-build");
const developerMode = (() => {
    if (forceDeveloperBuild) return true;
    if (forceReleaseBuild) return false;
    const value = String(process.env.KEY_INTERCEPT_DEVELOPER_MODE ?? process.env.KEY_INTERCEPT_DEBUG_MODE ?? "").trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
})();
const sourceWithoutExports = source
    .replace(/^\s*export\s+const\s+onLoad\s*=.*$/m, "")
    .replace(/^\s*export\s+const\s+onUnload\s*=.*$/m, "")
    .replace(/^\s*export\s+default\s+plugin;?\s*$/m, "")
    .replace(/__KEY_INTERCEPT_DEVELOPER_MODE__/g, developerMode ? "true" : "false")
    .trim();

const builtSource = `(function(vendetta){${sourceWithoutExports}\nreturn plugin;})(vendetta)`;

await mkdir(distDir, { recursive: true });
await writeFile(distMainPath, builtSource);

const hash = createHash("sha256").update(builtSource, "utf8").digest("hex").toUpperCase();
manifest.hash = hash;
manifest.main = "index.js";

await writeFile(distManifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("kettu plugin built");
