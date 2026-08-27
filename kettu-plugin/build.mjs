import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const manifestPath = new URL("./manifest.json", import.meta.url);
const sourcePath = new URL("./src/index.js", import.meta.url);
const distDir = new URL("./dist/", import.meta.url);
const distMainPath = new URL("./dist/index.js", import.meta.url);
const distManifestPath = new URL("./dist/manifest.json", import.meta.url);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const source = await readFile(sourcePath, "utf8");
const sourceWithoutExports = source
    .replace(/^\s*export\s+const\s+onLoad\s*=.*$/m, "")
    .replace(/^\s*export\s+const\s+onUnload\s*=.*$/m, "")
    .replace(/^\s*export\s+default\s+plugin;?\s*$/m, "")
    .trim();

const builtSource = `(function(vendetta){${sourceWithoutExports}\nreturn plugin;})(vendetta)`;

await mkdir(distDir, { recursive: true });
await writeFile(distMainPath, builtSource);

const hash = createHash("sha256").update(builtSource, "utf8").digest("hex").toUpperCase();
manifest.hash = hash;
manifest.main = "index.js";

await writeFile(distManifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("kettu plugin built");
