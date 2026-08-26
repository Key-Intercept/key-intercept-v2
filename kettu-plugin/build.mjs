import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const manifestPath = new URL("./manifest.json", import.meta.url);
const sourcePath = new URL("./src/index.js", import.meta.url);
const distDir = new URL("./dist/", import.meta.url);
const distMainPath = new URL("./dist/index.js", import.meta.url);
const distManifestPath = new URL("./dist/manifest.json", import.meta.url);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const source = await readFile(sourcePath);

await mkdir(distDir, { recursive: true });
await writeFile(distMainPath, source);

const hash = createHash("sha256").update(source).digest("hex");
manifest.hash = hash;
manifest.main = "index.js";

await writeFile(distManifestPath, JSON.stringify(manifest));
console.log("kettu plugin built");
