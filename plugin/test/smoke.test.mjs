import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pluginPath = join(here, "..", "keyInterceptSelfHosted.tsx");
const source = await readFile(pluginPath, "utf8");

const requiredSnippets = [
    "function shouldApplyRules(config: Config): boolean {",
    "function shouldApplyGag(config: Config): boolean {",
    "function shouldApplyPet(config: Config): boolean {",
    "function shouldApplyBimbo(config: Config): boolean {",
    "function shouldApplyHorny(config: Config): boolean {",
    "function shouldApplyDrone(config: Config): boolean {",
    "function shouldApplyUWU(config: Config): boolean {",
    "function shouldApplyCensored(config: Config): boolean {",
    "msg = applyRules(msg);",
    "msg = applyUWU(msg);",
    "msg = applyHorny(msg);",
    "msg = applyPet(msg);",
    "msg = applyBimbo(msg);",
    "msg = applyCensored(msg);",
    "msg = applyGag(msg);",
    "const droneResult = applyDrone(msg, channelId);"
];

for (const snippet of requiredSnippets) {
    assert.ok(source.includes(snippet), `Missing expected plugin behavior snippet: ${snippet}`);
}

console.log("plugin smoke test passed");
