#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out || "./sorobuild-flow-generated");
const network = args.network || "testnet";
const source = args.source || "default";
const packageFilter = args.package || args.p || null;
const shouldBuild = args.build !== false && args["no-build"] !== true;
const shouldOptimize = args.optimize !== false && args["no-optimize"] !== true;
const input = args.project || args.wasm || args._[0];

if (!input) {
  console.error(`Usage:
  # Build + optimize + generate from a Soroban project root
  node bin/sorobuild-flow-generate.mjs --project ../my_contract --out ./generated --network testnet --source alice

  # Same, positional project path
  node bin/sorobuild-flow-generate.mjs ../my_contract --out ./generated

  # Generate from an existing wasm only
  node bin/sorobuild-flow-generate.mjs --wasm ./target/wasm32v1-none/release/my_contract.wasm --out ./generated --no-build

Options:
  --project <dir>       Cargo project or workspace root
  --wasm <file|dir>     Existing wasm file or directory containing wasm files
  --package <name>      Build one Cargo package in a workspace
  --out <dir>           Output folder
  --network <name>      Stellar network name, default: testnet
  --source <identity>   Stellar CLI identity/source, default: default
  --no-build            Do not run cargo build
  --no-optimize         Do not run stellar contract optimize
`);
  process.exit(1);
}

const workspace = resolveInput(input, args);
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(outDir, "scripts", "invoke"), { recursive: true });
fs.mkdirSync(path.join(outDir, "scripts", "flows"), { recursive: true });
fs.mkdirSync(path.join(outDir, "scripts", "build"), { recursive: true });

let wasmFiles = [];
let buildInfo = null;

if (workspace.kind === "project") {
  buildInfo = buildProject({
    projectRoot: workspace.path,
    packageFilter,
    shouldBuild,
    shouldOptimize,
  });
  wasmFiles = buildInfo.contracts
    .map((c) => c.optimizedWasm || c.wasm)
    .filter(Boolean);
} else {
  const resolvedWasm = resolveWasm(workspace.path);
  if (shouldOptimize) {
    const opt = optimizeWasm(resolvedWasm);
    wasmFiles = [opt || resolvedWasm];
  } else {
    wasmFiles = [resolvedWasm];
  }
}

if (!wasmFiles.length)
  throw new Error("No WASM files found after build/resolve.");

const manifests = [];
for (const wasmPath of wasmFiles) {
  const contractName = toSafeName(
    path.basename(wasmPath).replace(/\.optimized\.wasm$|\.wasm$/i, "")
  );
  const contractDir =
    wasmFiles.length > 1
      ? path.join(outDir, "contracts", contractName)
      : outDir;
  fs.mkdirSync(path.join(contractDir, "scripts", "invoke"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(contractDir, "scripts", "flows"), { recursive: true });

  const inspectText = inspectWasm(wasmPath);
  const sourceRoot = workspace.kind === "project" ? workspace.path : null;
  let functions = parseFunctions(inspectText);

  console.log("===== STELLAR INSPECT OUTPUT START =====");
  console.log(inspectText);
  console.log("===== STELLAR INSPECT OUTPUT END =====");

  console.log("===== PARSED FUNCTIONS =====");
  console.log(JSON.stringify(functions, null, 2));

  // Some Stellar CLI versions format `contract inspect` output differently.
  // If the WASM spec parser returns no normal methods, use the Rust source as a
  // project-mode fallback so MVP users still get invoke scripts immediately.
  // This is especially useful for account contracts where `__check_auth` is
  // intentionally skipped but normal methods like `add_limit` must be generated.
  if (
    sourceRoot &&
    !functions.some((fn) => !isInternalSorobanMethod(fn.name))
  ) {
    const sourceFunctions = parseRustContractFunctions(sourceRoot);
    if (sourceFunctions.length) functions = sourceFunctions;
  }

  const constructorFn = functions.find((fn) =>
    ["__constructor", "constructor"].includes(fn.name)
  );
  const callableFns = functions.filter(
    (fn) => !isInternalSorobanMethod(fn.name)
  );
  const initFn = callableFns.find((fn) =>
    ["init", "initialize"].includes(fn.name)
  );
  const wasmFileName = path.basename(wasmPath);
  const portableWasmPath = `./${wasmFileName}`;
  writeFileAt(contractDir, portableWasmPath, fs.readFileSync(wasmPath));

  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: "sorobuild-flow-mvp",
    contractName,
    wasmPath: portableWasmPath,
    originalWasmPath: wasmPath,
    projectRoot: workspace.kind === "project" ? "." : null,
    originalProjectRoot: workspace.kind === "project" ? workspace.path : null,
    network,
    source,
    constructor: constructorFn || null,
    init: initFn || null,
    functions: callableFns,
    scripts: {
      env: "env.sh",
      arguments: "arguments.sh",
      build: "scripts/build/build.sh",
      deploy: "scripts/deploy.sh",
      invokes: callableFns.map((fn) => `scripts/invoke/${fn.name}.sh`),
      exampleFlow: "scripts/flows/flow.example.sh",
    },
    files: {
      wasm: portableWasmPath,
    },
  };

  writeFileAt(
    contractDir,
    "env.sh",
    renderEnv({
      wasmPath: portableWasmPath,
      network,
      source,
      contractName,
      projectRoot: workspace.kind === "project" ? "." : "",
    })
  );
  writeFileAt(
    contractDir,
    "arguments.sh",
    renderArguments({
      constructorFn,
      callableFns,
    })
  );
  writeFileAt(
    contractDir,
    "scripts/build/build.sh",
    renderGeneratedBuild({
      projectRoot: workspace.kind === "project" ? "." : "",
      packageFilter,
    })
  );
  writeFileAt(
    contractDir,
    "scripts/deploy.sh",
    renderDeploy({ constructorFn, contractName })
  );
  for (const fn of callableFns)
    writeFileAt(contractDir, `scripts/invoke/${fn.name}.sh`, renderInvoke(fn));
  writeFileAt(
    contractDir,
    "scripts/flows/flow.example.sh",
    renderFlow({ callableFns, initFn })
  );
  writeFileAt(contractDir, "manifest.json", JSON.stringify(manifest, null, 2));
  writeFileAt(
    contractDir,
    "README.md",
    renderReadme({ contractName, callableFns, constructorFn, initFn })
  );
  chmodScripts(contractDir);
  manifests.push({ contractName, dir: contractDir, manifest });
}

writeFileAt(
  outDir,
  "workspace.manifest.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      projectRoot: workspace.kind === "project" ? workspace.path : null,
      contracts: manifests.map((m) => ({
        contractName: m.contractName,
        dir: path.relative(outDir, m.dir) || ".",
        manifest: path
          .join(path.relative(outDir, m.dir), "manifest.json")
          .replace(/^\//, ""),
      })),
    },
    null,
    2
  )
);
writeFileAt(outDir, "README.md", renderWorkspaceReadme(manifests));

console.log(`\n✅ Sorobuild Flow bootstrap complete`);
console.log(`📦 Output: ${outDir}`);
for (const item of manifests)
  console.log(
    `  • ${item.contractName}: ${
      path.relative(process.cwd(), item.dir) || item.dir
    }`
  );
console.log(`\nNext:`);
console.log(`  cd ${outDir}`);
console.log(`  # If one contract, run: ./scripts/deploy.sh`);
console.log(
  `  # If multiple contracts, open ./contracts/<name>/ and run ./scripts/deploy.sh`
);

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith("--no-")) result[item.slice(2)] = true;
    else if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) result[key] = true;
      else result[key] = argv[++i];
    } else result._.push(item);
  }
  return result;
}

function resolveInput(inputPath, args) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved))
    throw new Error(`Input does not exist: ${resolved}`);
  if (
    args.wasm ||
    (fs.statSync(resolved).isFile() && resolved.endsWith(".wasm"))
  )
    return { kind: "wasm", path: resolved };
  if (fs.statSync(resolved).isDirectory()) {
    if (fs.existsSync(path.join(resolved, "Cargo.toml")))
      return { kind: "project", path: resolved };
    const wasmCandidates = findFiles(resolved, (f) => f.endsWith(".wasm"), 3);
    if (wasmCandidates.length) return { kind: "wasm", path: resolved };
  }
  throw new Error(
    "Input must be a Cargo project root, a .wasm file, or a directory containing .wasm files"
  );
}

function buildProject({
  projectRoot,
  packageFilter,
  shouldBuild,
  shouldOptimize,
}) {
  if (shouldBuild) {
    console.log("\n=======================================");
    console.log("Building Soroban project");
    console.log("=======================================");
    const cargoArgs = ["build", "--target", "wasm32v1-none", "--release"];
    if (packageFilter) cargoArgs.push("-p", packageFilter);
    execFileSync("cargo", cargoArgs, { cwd: projectRoot, stdio: "inherit" });
  }

  const releaseDir = path.join(
    projectRoot,
    "target",
    "wasm32v1-none",
    "release"
  );
  if (!fs.existsSync(releaseDir))
    throw new Error(`Build output not found: ${releaseDir}`);
  const wasmCandidates = fs
    .readdirSync(releaseDir)
    .filter(
      (file) => file.endsWith(".wasm") && !file.endsWith(".optimized.wasm")
    )
    .filter(
      (file) =>
        !packageFilter || file.includes(packageFilter.replaceAll("-", "_"))
    )
    .sort((a, b) => scoreWasmName(b) - scoreWasmName(a))
    .map((file) => path.join(releaseDir, file));

  const contracts = [];
  for (const wasm of wasmCandidates) {
    let optimizedWasm = null;
    if (shouldOptimize) optimizedWasm = optimizeWasm(wasm);
    contracts.push({ wasm, optimizedWasm });
  }
  return { releaseDir, contracts };
}

function optimizeWasm(wasm) {
  const optPath = wasm.replace(/\.wasm$/i, ".optimized.wasm");
  console.log("\n=======================================");
  console.log(`Optimizing ${path.basename(wasm)}`);
  console.log("=======================================");
  try {
    execFileSync("stellar", ["contract", "optimize", "--wasm", wasm], {
      stdio: "inherit",
    });
    return fs.existsSync(optPath) ? optPath : wasm;
  } catch (e) {
    console.warn(
      `⚠️  Optimize failed for ${wasm}. Continuing with unoptimized WASM.`
    );
    return wasm;
  }
}

function resolveWasm(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved))
    throw new Error(`Input does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (stat.isFile() && resolved.endsWith(".wasm")) return resolved;
  if (stat.isDirectory()) {
    const candidates = findFiles(
      resolved,
      (file) => file.endsWith(".wasm"),
      4
    ).sort(
      (a, b) =>
        scoreWasmName(path.basename(b)) - scoreWasmName(path.basename(a))
    );
    if (!candidates.length)
      throw new Error(`No .wasm files found in ${resolved}`);
    return candidates[0];
  }
  throw new Error(
    "Input must be a .wasm file or a directory containing .wasm files"
  );
}

function findFiles(root, predicate, maxDepth = 5, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (
      ["node_modules", ".git", "target/debug", "target/tmp"].includes(
        entry.name
      )
    )
      continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory())
      out.push(...findFiles(full, predicate, maxDepth, depth + 1));
    else if (predicate(full)) out.push(full);
  }
  return out;
}

function scoreWasmName(name) {
  let score = 0;
  if (name.includes("optimized")) score += 10;
  if (!name.includes("test")) score += 2;
  if (!name.includes("mock")) score += 2;
  return score;
}

function inspectWasm(wasm) {
  const commands = [
    ["stellar", ["contract", "inspect", "--wasm", wasm]],
    ["soroban", ["contract", "inspect", "--wasm", wasm]],
  ];
  const errors = [];
  for (const [cmd, argv] of commands) {
    try {
      return execFileSync(cmd, argv, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      errors.push(`${cmd}: ${e.stderr?.toString?.() || e.message}`);
    }
  }
  throw new Error(
    `Unable to inspect WASM. Install Stellar CLI and try again.\n${errors.join(
      "\n"
    )}`
  );
}

function isInternalSorobanMethod(name) {
  return (
    ["__constructor", "constructor", "__check_auth"].includes(name) ||
    /^__/.test(name)
  );
}

function parseRustContractFunctions(projectRoot) {
  const rustFiles = findFiles(
    projectRoot,
    (file) => file.endsWith(".rs") && !file.endsWith("/test.rs"),
    8
  );
  const functions = [];

  for (const file of rustFiles) {
    const src = fs.readFileSync(file, "utf8");
    const implBlocks = extractContractImplBlocks(src);

    for (const block of implBlocks) {
      const fnRegex = /pub\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;
      let match;
      while ((match = fnRegex.exec(block.body))) {
        const [, name, paramsText] = match;
        const inputs = parseRustInputs(paramsText);
        functions.push({
          name,
          inputs,
          outputs: [],
          raw: `source:${path.relative(projectRoot, file)}:${name}`,
          sourceFallback: true,
        });
      }
    }
  }

  return dedupeByName(functions);
}

function extractContractImplBlocks(src) {
  const blocks = [];
  const attrRegex = /#\[contractimpl(?:\([^\]]*\))?\]/g;
  let attr;

  while ((attr = attrRegex.exec(src))) {
    const afterAttr = src.slice(attr.index);
    const implMatch = afterAttr.match(
      /#\[contractimpl(?:\([^\]]*\))?\]\s*impl\s+([^\{]+)\{/
    );
    if (!implMatch) continue;

    const implHeader = implMatch[1].trim();
    if (
      /CustomAccountInterface/.test(implHeader) ||
      /contracttrait/.test(afterAttr.slice(0, implMatch[0].length))
    ) {
      continue;
    }

    const openBraceIndex = attr.index + implMatch[0].lastIndexOf("{");
    const closeBraceIndex = findMatchingBrace(src, openBraceIndex);
    if (closeBraceIndex === -1) continue;

    blocks.push({
      header: implHeader,
      body: src.slice(openBraceIndex + 1, closeBraceIndex),
    });
  }

  return blocks;
}

function findMatchingBrace(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseRustInputs(paramsText) {
  return splitTopLevel(paramsText, ",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^(&?\s*)?self\b/.test(part))
    .map((part) => {
      const colon = part.indexOf(":");
      if (colon === -1) return null;
      const name = part
        .slice(0, colon)
        .trim()
        .replace(/^mut\s+/, "");
      const rustType = part.slice(colon + 1).trim();
      if (name === "env" && /\bEnv\b/.test(rustType)) return null;
      const type = normalizeRustType(rustType);
      return {
        name,
        type,
        env: envName(name),
        placeholder: sampleValueForType(type),
      };
    })
    .filter(Boolean);
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("<([{".includes(ch)) depth++;
    if (">)]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === delimiter && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function normalizeRustType(type) {
  const clean = type
    .replace(/&/g, "")
    .replace(/mut\s+/g, "")
    .trim();
  if (/\bAddress\b/.test(clean)) return "address";
  if (/\bSymbol\b/.test(clean)) return "symbol";
  if (/\bString\b/.test(clean)) return "string";
  if (/\bBytesN?\b/.test(clean)) return "bytes";
  if (/\bbool\b/.test(clean)) return "bool";
  for (const n of ["i128", "u128", "i64", "u64", "i32", "u32"])
    if (new RegExp(`\\b${n}\\b`).test(clean)) return n;
  if (/\bVec\s*</.test(clean)) return "vec";
  if (/\bMap\s*</.test(clean)) return "map";
  return clean.toLowerCase().replace(/[^a-z0-9_<>:,]/g, "") || "unknown";
}

function parseFunctions(text) {
  // Stellar CLI v23+ prints function specs in multiline blocks:
  //
  //  • Function: add_voter
  //      Docs: ...
  //      Inputs: VecM(...)
  //      Output: VecM(...)
  //
  // Older versions may print single-line Function: ... forms, so keep both.

  const multilineFns = parseMultilineFunctionBlocks(text);
  if (multilineFns.length) return dedupeByName(multilineFns);

  return parseSingleLineFunctions(text);
}

function parseMultilineFunctionBlocks(text) {
  const blocks = text.split(/\n\s*• Function:\s*/).slice(1);
  const fns = [];

  for (const block of blocks) {
    const firstLine = block.split(/\r?\n/)[0]?.trim();
    const name = firstLine?.replace(/\s+$/g, "");
    if (!name) continue;

    const docs = extractFunctionDocs(block);
    const inputsSection = extractBetween(block, "Inputs:", "Output:");
    const outputSection = extractAfter(block, "Output:");

    fns.push({
      name,
      doc: docs,
      inputs: parseMultilineInputs(inputsSection),
      outputs: parseMultilineOutputs(outputSection),
      raw: `cli:inspect:${name}`,
    });
  }

  return dedupeByName(fns);
}

function parseSingleLineFunctions(text) {
  const lines = text.split(/\r?\n/);
  const fns = [];

  for (const line of lines) {
    const match = line.match(
      /Function:\s*([^\s(]+)\s*\((.*)\)\s*->\s*\((.*)\)/
    );
    if (!match) continue;

    const [, name, inputText, outputText] = match;
    fns.push({
      name,
      inputs: parseInputs(inputText),
      outputs: parseOutputs(outputText),
      raw: line.trim(),
    });
  }

  return dedupeByName(fns);
}

function extractFunctionDocs(block) {
  const match = block.match(/Docs:\s*([\s\S]*?)\n\s*Inputs:/);
  if (!match) return "";
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s+/, "").trim())
    .filter(Boolean)
    .join("\n");
}

function extractBetween(text, startLabel, endLabel) {
  const start = text.indexOf(startLabel);
  if (start === -1) return "";
  const from = start + startLabel.length;
  const end = text.indexOf(endLabel, from);
  if (end === -1) return text.slice(from);
  return text.slice(from, end);
}

function extractAfter(text, label) {
  const start = text.indexOf(label);
  if (start === -1) return "";
  return text.slice(start + label.length);
}

function parseMultilineInputs(section) {
  const inputs = [];
  const marker = "ScSpecFunctionInputV0";
  let searchIndex = 0;

  while (true) {
    const markerIndex = section.indexOf(marker, searchIndex);
    if (markerIndex === -1) break;

    const openBraceIndex = section.indexOf("{", markerIndex);
    if (openBraceIndex === -1) break;

    const closeBraceIndex = findMatchingBrace(section, openBraceIndex);
    if (closeBraceIndex === -1) break;

    const inputBlock = section.slice(openBraceIndex + 1, closeBraceIndex);
    const nameMatch = inputBlock.match(/name:\s*StringM\(([^)]*)\)/);
    const typeText = extractTypeAfterTypeField(inputBlock);

    const name = nameMatch?.[1]?.trim();
    if (name) {
      const type = normalizeType(typeText || "unknown");
      inputs.push({
        name,
        type,
        env: envName(name),
        placeholder: sampleValueForType(type),
      });
    }

    searchIndex = closeBraceIndex + 1;
  }

  return inputs;
}

function extractTypeAfterTypeField(block) {
  const typeIndex = block.indexOf("type_:");
  if (typeIndex === -1) return "unknown";

  let value = block.slice(typeIndex + "type_:".length).trim();

  // Simple type line: Address, Symbol, String, I128, ...
  const simple = value.match(/^([A-Za-z][A-Za-z0-9_]*)\s*(?:,|\n|$)/);
  if (
    simple &&
    !["BytesN", "Vec", "Map", "Result", "Option", "Udt"].includes(simple[1])
  ) {
    return simple[1];
  }

  // Complex type: BytesN(...), Vec(...), Udt(...)
  const complex = value.match(/^([A-Za-z][A-Za-z0-9_]*)\s*\(/);
  if (complex) return complex[1];

  return value.split(/\s|,|\{/)[0] || "unknown";
}

function parseMultilineOutputs(section) {
  const outputs = [];
  const typeNames = [];

  // Capture useful outer and inner type names.
  const regex =
    /\b(Address|String|Symbol|Bool|BytesN|Bytes|U32|U64|U128|I32|I64|I128|Void|Result|Option|Vec|Map|Udt)\b/g;
  let match;
  while ((match = regex.exec(section))) {
    typeNames.push(normalizeType(match[1]));
  }

  for (const type of typeNames) {
    if (!type || outputs.some((item) => item.type === type)) continue;
    outputs.push({ name: type, type });
  }

  return outputs;
}

function parseInputs(inputText) {
  const inputs = [];
  const chunks = inputText.split(/ScSpecFunctionInputV0/).slice(1);
  for (const chunk of chunks) {
    const nameMatch = chunk.match(/name:\s*StringM\(([^)]*)\)/);
    const typeText = extractTypeAfterTypeField(chunk);
    const name = nameMatch?.[1]?.trim();
    if (!name) continue;

    const type = normalizeType(typeText || "unknown");
    inputs.push({
      name,
      type,
      env: envName(name),
      placeholder: sampleValueForType(type),
    });
  }
  return inputs;
}

function parseOutputs(outputText) {
  if (!outputText || outputText.trim() === "[]") return [];
  return parseMultilineOutputs(outputText);
}

function normalizeType(type) {
  const clean = String(type || "")
    .replace(/StringM\(|\)/g, "")
    .replace(/ScSpecType/g, "")
    .replace(/\(.+$/g, "")
    .trim();

  const lower = clean.toLowerCase();

  if (lower.includes("address")) return "address";
  if (lower.includes("symbol")) return "symbol";
  if (lower.includes("string")) return "string";
  if (lower.includes("bool")) return "bool";
  if (lower.includes("bytesn") || lower === "bytes") return "bytes";
  if (lower.includes("vec")) return "vec";
  if (lower.includes("map")) return "map";
  if (lower.includes("result")) return "result";
  if (lower.includes("option")) return "option";
  if (lower.includes("void")) return "void";
  if (lower.includes("udt")) return "udt";

  for (const n of ["i128", "u128", "i64", "u64", "i32", "u32"]) {
    if (lower.includes(n)) return n;
  }

  return lower || "unknown";
}

function sampleValueForType(type) {
  const normalized = String(type).includes("ScSpecType")
    ? normalizeType(type)
    : String(type).toLowerCase();
  if (normalized === "address") return "G...";
  if (["i128", "u128", "i64", "u64", "i32", "u32"].includes(normalized))
    return "100";
  if (normalized === "bool") return "true";
  if (normalized === "bytes") return "00";
  if (normalized === "symbol") return "sample";
  if (normalized === "vec") return "[]";
  if (normalized === "map") return "{}";
  return "sample";
}

function dedupeByName(fns) {
  const seen = new Set();
  return fns.filter((fn) => {
    if (seen.has(fn.name)) return false;
    seen.add(fn.name);
    return true;
  });
}

function renderArguments({ constructorFn, callableFns }) {
  const sections = [];

  const constructorArgs = constructorFn?.inputs || [];
  sections.push(
    renderArgumentSection({
      title: "Deploy constructor arguments",
      methodName: "deploy",
      args: constructorArgs,
      emptyMessage: "No constructor arguments detected.",
    })
  );

  for (const fn of callableFns) {
    sections.push(
      renderArgumentSection({
        title: `${fn.name} arguments`,
        methodName: fn.name,
        args: fn.inputs || [],
        emptyMessage: `No arguments detected for ${fn.name}.`,
      })
    );
  }

  return `#!/usr/bin/env bash
set -euo pipefail

# Generated by Sorobuild Flow
# Edit this file before running deploy or invoke scripts.
# Keep env.sh for global workflow settings. Keep method arguments here.

${sections.join("\n\n")}
`;
}

function renderArgumentSection({ title, methodName, args, emptyMessage }) {
  const lines = [
    "# -----------------------------------------------------------------------------",
    `# ${title}`,
    "# -----------------------------------------------------------------------------",
  ];

  if (!args.length) {
    lines.push(`# ${emptyMessage}`);
    return lines.join("\n");
  }

  for (const arg of args) {
    const envVar = argumentEnvName(methodName, arg.name);
    const defaultValue = argumentDefaultValue(methodName, arg);

    lines.push(`# ${arg.name}: ${arg.type}`);
    lines.push(
      `# Used by: ${
        methodName === "deploy"
          ? "scripts/deploy.sh"
          : `scripts/invoke/${methodName}.sh`
      }`
    );
    lines.push(`export ${envVar}=${quoteShellValue(defaultValue)}`);
  }

  return lines.join("\n");
}

function argumentDefaultValue(methodName, arg) {
  const argName = String(arg.name || "").toLowerCase();
  const type = String(arg.type || "").toLowerCase();

  // Common convention: deploy/admin defaults to the configured SOURCE identity.
  // Users can override this by editing DEPLOY_ADMIN in arguments.sh.
  if (methodName === "deploy" && type === "address" && argName === "admin") {
    return "${SOURCE_ADDRESS}";
  }

  return arg.placeholder;
}

function quoteShellValue(value) {
  return JSON.stringify(String(value ?? ""));
}

function argumentEnvName(methodName, argName) {
  return `${envName(methodName)}_${envName(argName)}`;
}

function renderEnv({ wasmPath, network, source, contractName, projectRoot }) {
  const wasmFileName = path.basename(wasmPath);

  return `#!/usr/bin/env bash
set -euo pipefail

# Generated by Sorobuild Flow
# Edit this file for global workflow settings only.
export FLOW_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

export STELLAR_CLI="\${STELLAR_CLI:-stellar}"
export NETWORK="${network}"
export SOURCE="${source}"

# Resolve a Stellar CLI identity to its public address.
# This is used by arguments.sh defaults such as DEPLOY_ADMIN.
resolve_source_address() {
  local identity="$1"

  [[ -z "$identity" ]] && return 0

  "$STELLAR_CLI" keys address "$identity" 2>/dev/null || true
}

export SOURCE_ADDRESS="\${SOURCE_ADDRESS:-$(resolve_source_address "$SOURCE")}"

export WASM_PATH="$FLOW_ROOT/${wasmFileName}"
export CONTRACT_NAME="${contractName}"
export PROJECT_ROOT="${projectRoot ? "$FLOW_ROOT" : ""}"
export CONTRACTS_ENV_FILE="$FLOW_ROOT/contracts.sh"

# Optional: set this after deploy, or let scripts/deploy.sh write it.
export CONTRACT_ID="\${CONTRACT_ID:-}"
`;
}

function renderGeneratedBuild({ projectRoot, packageFilter }) {
  return `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
FLOW_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$FLOW_ROOT/env.sh"

if [ -z "\${PROJECT_ROOT:-}" ]; then
  echo "No PROJECT_ROOT was generated because this flow was created from an existing WASM."
  exit 0
fi

echo "======================================="
echo "Building Soroban project"
echo "======================================="
cd "$PROJECT_ROOT"

cargo build --target wasm32v1-none --release${
    packageFilter ? ` -p ${packageFilter}` : ""
  }

echo "======================================="
echo "Optimizing WASM"
echo "======================================="
stellar contract optimize --wasm "$WASM_PATH" || true
`;
}

function renderDeploy({ constructorFn, contractName }) {
  const constructorArgs = constructorFn?.inputs || [];
  const argExports = constructorArgs
    .map((arg) => {
      const envVar = argumentEnvName("deploy", arg.name);
      return `: "\${${envVar}:?Set ${envVar} in arguments.sh}" # ${arg.name}: ${arg.type}`;
    })
    .join("\n");
  const argFlags = constructorArgs
    .map(
      (arg) =>
        `  --${arg.name.replace(/_/g, "-")} "\$${argumentEnvName(
          "deploy",
          arg.name
        )}" \\`
    )
    .join("\n");

  return `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
FLOW_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$FLOW_ROOT/env.sh"
source "$FLOW_ROOT/arguments.sh"

${argExports || "# No constructor arguments detected."}

echo "======================================="
echo "Deploying $CONTRACT_NAME"
echo "======================================="

DEPLOY_CMD=("$STELLAR_CLI" contract deploy --wasm "$WASM_PATH" --source "$SOURCE" --network "$NETWORK")

${
  constructorArgs.length
    ? `CONTRACT_ID=$("\${DEPLOY_CMD[@]}" -- \
${argFlags.slice(0, -2)}
)`
    : `CONTRACT_ID=$("\${DEPLOY_CMD[@]}")`
}

CONTRACT_ID=$(echo "$CONTRACT_ID" | tr -d '"')

touch "$CONTRACTS_ENV_FILE"
sed -i.bak '/^export CONTRACT_ID=/d' "$CONTRACTS_ENV_FILE" 2>/dev/null || true
echo "export CONTRACT_ID="$CONTRACT_ID"" >> "$CONTRACTS_ENV_FILE"
rm -f "$CONTRACTS_ENV_FILE.bak"

echo "✅ Deployed: $CONTRACT_ID"
echo "Saved to $CONTRACTS_ENV_FILE"
`;
}

function renderInvoke(fn) {
  const argExports = fn.inputs
    .map((arg) => {
      const envVar = argumentEnvName(fn.name, arg.name);
      return `: "\${${envVar}:?Set ${envVar} in arguments.sh}" # ${arg.name}: ${arg.type}`;
    })
    .join("\n");
  const argFlags = fn.inputs
    .map(
      (arg) =>
        `  --${arg.name.replace(/_/g, "-")} "\$${argumentEnvName(
          fn.name,
          arg.name
        )}" \\`
    )
    .join("\n");

  return `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
FLOW_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$FLOW_ROOT/env.sh"
source "$FLOW_ROOT/arguments.sh"
[ -f "$CONTRACTS_ENV_FILE" ] && source "$CONTRACTS_ENV_FILE"

: "\${CONTRACT_ID:?Set CONTRACT_ID or run ./scripts/deploy.sh first}"
${argExports || "# No arguments detected."}

echo "======================================="
echo "Invoking ${fn.name}"
echo "======================================="

RESULT=$("$STELLAR_CLI" contract invoke \
  --id "$CONTRACT_ID" \
  --source "$SOURCE" \
  --network "$NETWORK" \
  -- \
  ${fn.name}${
    fn.inputs.length
      ? ` \
${argFlags.slice(0, -2)}`
      : ""
  }
)

echo "$RESULT"
`;
}

function renderFlow({ callableFns, initFn }) {
  const samples = ["./scripts/deploy.sh"];

  if (initFn) samples.push(`./scripts/invoke/${initFn.name}.sh`);

  for (const fn of callableFns
    .filter((f) => !["init", "initialize"].includes(f.name))
    .slice(0, 6)) {
    samples.push(`./scripts/invoke/${fn.name}.sh`);
  }

  const steps = samples
    .map((sample, index) => {
      const cleanPath = sample.replace(/^\.\//, "");
      return `echo "\\n▶ Step ${index + 1}: ${cleanPath}"
run_step ${JSON.stringify(cleanPath)}`;
    })
    .join("\n\n");

  return `#!/usr/bin/env bash
set -euo pipefail

# Example generated flow. Reorder, delete, or duplicate steps as needed.
# In the Sorobuild UI, this list becomes drag-and-drop workflow blocks.

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"

run_step() {
  local script_path="$1"
  local full_path="$ROOT_DIR/$script_path"

  if [ ! -f "$full_path" ]; then
    echo "❌ Missing workflow step: $script_path"
    exit 1
  fi

  chmod +x "$full_path"
  (cd "$ROOT_DIR" && ./"$script_path")
}

${steps}
`;
}

function renderReadme({ contractName, callableFns, constructorFn, initFn }) {
  return `# Sorobuild Flow Scripts: ${contractName}

Generated from the embedded Soroban contract spec in your WASM.

## Files

- \`env.sh\` — network, source, WASM path, contract env.
- \`scripts/build/build.sh\` — rebuild/optimize helper when generated from a project.
- \`scripts/deploy.sh\` — deploy script${
    constructorFn ? " with constructor args baked into deploy" : ""
  }.
- \`scripts/invoke/*.sh\` — one invocation script per exposed function.
- \`scripts/flows/flow.example.sh\` — editable sequential workflow.
- \`manifest.json\` — machine-readable contract/test map for the Sorobuild UI.

## Functions

${
  callableFns
    .map(
      (fn) =>
        `- \`${fn.name}(${fn.inputs
          .map((i) => `${i.name}: ${i.type}`)
          .join(", ")})\``
    )
    .join("\n") || "No public functions detected."
}

## Run

\`\`\`bash
find . -name "*.sh" -exec chmod +x {} \\;
# Edit env.sh and arguments.sh before running.
./scripts/deploy.sh
./scripts/flows/flow.example.sh
\`\`\`

${
  initFn
    ? "Note: this contract has an `init`/`initialize` style function, so initialization is generated as a separate invoke step after deployment."
    : ""
}
`;
}

function renderWorkspaceReadme(manifests) {
  const lines = [
    "# Sorobuild Flow Generated Workspace",
    "",
    "This folder was generated by Sorobuild Flow.",
    "",
  ];

  if (manifests.length === 1) {
    lines.push("Open the generated scripts directly in this folder:");
    lines.push("");
    lines.push("```bash");
    lines.push('find . -name "*.sh" -exec chmod +x {} \\\\;');
    lines.push("# Edit env.sh and arguments.sh before running.");
    lines.push("./scripts/deploy.sh");
    lines.push("./scripts/flows/flow.example.sh");
    lines.push("```");
  } else {
    lines.push("Multiple contracts were generated:");
    lines.push("");
    for (const m of manifests) {
      lines.push(
        `- \`${m.contractName}\` → \`${path.relative(outDir, m.dir)}\``
      );
    }
    lines.push("");
    lines.push("Open a contract folder and run:");
    lines.push("");
    lines.push("```bash");
    lines.push('find . -name "*.sh" -exec chmod +x {} \\\\;');
    lines.push("# Edit env.sh and arguments.sh before running.");
    lines.push("./scripts/deploy.sh");
    lines.push("./scripts/flows/flow.example.sh");
    lines.push("```");
  }

  lines.push("");
  lines.push(
    "Use `workspace.manifest.json` or each `manifest.json` in the Sorobuild Flow UI."
  );
  lines.push("");
  return lines.join("\n");
}

function writeFileAt(root, relativePath, content) {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function chmodScripts(root) {
  const scriptPaths = [
    "env.sh",
    "arguments.sh",
    ...walk(path.join(root, "scripts")),
  ];
  for (const p of scriptPaths) {
    const full = path.isAbsolute(p) ? p : path.join(root, p);
    if (fs.existsSync(full) && full.endsWith(".sh")) fs.chmodSync(full, 0o755);
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return fs.statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function toSafeName(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function envName(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
