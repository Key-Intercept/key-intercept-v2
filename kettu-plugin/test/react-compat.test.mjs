import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "..", "src", "index.js");
const source = await readFile(sourcePath, "utf8");

const requiredSnippets = [
    "function resolveReactHook(React, hookName) {",
    "const defaultHook = React.default?.[hookName];",
    "const h = resolveReactHook(React, \"createElement\");",
    "const useState = resolveReactHook(React, \"useState\");",
    "const useEffect = resolveReactHook(React, \"useEffect\");",
    "const useRef = resolveReactHook(React, \"useRef\");",
    "if (!h || !useState || !useEffect || !useRef) return null;",
    "return h ? h(ConfigPanel, props) : ConfigPanel(props);"
];

for (const snippet of requiredSnippets) {
    assert.ok(source.includes(snippet), `Missing expected React compatibility snippet: ${snippet}`);
}

const forbiddenSnippets = [
    "openStateCandidates.find(",
    "React.useState(",
    "React.useEffect(",
    "React.useRef(",
    "React.createElement("
];

for (const snippet of forbiddenSnippets) {
    assert.ok(!source.includes(snippet), `Found runtime-fragile snippet that should be avoided: ${snippet}`);
}

const entrypointRenderMatches = source.match(/return h \? h\(ConfigPanel, props\) : ConfigPanel\(props\);/g) ?? [];
assert.equal(entrypointRenderMatches.length, 2, "Expected both settings entrypoints to render ConfigPanel via createElement fallback");

console.log("kettu react compatibility test passed");
