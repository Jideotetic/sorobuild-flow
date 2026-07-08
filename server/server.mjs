#!/usr/bin/env node
import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import flowStatsRouter, {
  incrementFlowStats,
  trackFlowUser,
} from "../routes/flowStats.mjs";
import { connectMongo } from "../db/mongo.js";

const execFileAsync = promisify(execFile);
const app = express();

const PORT = Number(process.env.PORT || 4307);
const ROOT = path.resolve(
  process.env.SOROBUILD_FLOW_STORAGE || ".storage/workflows"
);
const cliPath = path.resolve("bin/sorobuild-flow-generate.mjs");
const MAX_UPLOAD_MB = Number(process.env.SOROBUILD_FLOW_MAX_UPLOAD_MB || 80);
const DEFAULT_OWNER_ID = "anonymous";

// Local cleanup settings.
// Default: delete workflows that have not been opened/updated/downloaded in 24h.
const WORKFLOW_TTL_HOURS = Number(process.env.WORKFLOW_TTL_HOURS || 24);
const CLEANUP_INTERVAL_MS = Number(
  process.env.WORKFLOW_CLEANUP_INTERVAL_MS || 30 * 60 * 1000
);
const CLEANUP_UPLOADS_TTL_HOURS = Number(
  process.env.WORKFLOW_UPLOADS_TTL_HOURS || 6
);

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(path.join(ROOT, ".uploads"), { recursive: true });

const upload = multer({
  dest: path.join(ROOT, ".uploads"),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

app.use(
  cors({
    origin: ["https://flow.soro.build", "http://localhost:5173"],
  })
);
app.use(express.json({ limit: "20mb" }));

await connectMongo();
app.use("/api", flowStatsRouter);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "sorobuild-flow-api",
    storage: "local",
    cleanup: {
      workflowTtlHours: WORKFLOW_TTL_HOURS,
      cleanupIntervalMs: CLEANUP_INTERVAL_MS,
      uploadsTtlHours: CLEANUP_UPLOADS_TTL_HOURS,
    },
  });
});

app.post("/api/workflows/generate", upload.single("file"), async (req, res) => {
  const workflowId = `wf_${Date.now()}_${crypto
    .randomBytes(4)
    .toString("hex")}`;
  const ownerId = getOwnerId(req);
  const local = getLocalPaths(workflowId, ownerId);
  const workflowDir = local.workflowDir;
  const inputDir = path.join(workflowDir, "input");
  const outDir = local.outDir;
  const mode = String(req.body.mode || "wasm");
  const network = String(req.body.network || "testnet");
  const source = String(req.body.source || "default");
  const name = String(req.body.name || workflowId);

  try {
    cleanupExpiredLocalWorkflows({ silent: true });

    if (!req.file) {
      return res.status(400).json({
        error: "Missing file. Upload a .wasm file or a .zip project.",
      });
    }

    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    const now = new Date().toISOString();
    const originalName = safeBaseName(req.file.originalname || "upload");
    const savedInput = path.join(inputDir, originalName);
    fs.renameSync(req.file.path, savedInput);

    const metadata = {
      workflowId,
      ownerId,
      name,
      mode,
      network,
      source,
      status: "generating",
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      lastDownloadedAt: null,
      inputFile: originalName,
      storage: { provider: "local", path: workflowDir },
    };

    writeJson(local.workflowPath, metadata);

    const cliArgs = buildCliArgs({
      mode,
      savedInput,
      inputDir,
      outDir,
      network,
      source,
    });

    const { stdout, stderr } = await execFileAsync(process.execPath, cliArgs, {
      cwd: path.resolve("."),
      timeout: Number(process.env.SOROBUILD_FLOW_TIMEOUT_MS || 180000),
      maxBuffer: 1024 * 1024 * 20,
    });

    const result = readWorkflowResultLocal({
      workflowId,
      workflowDir,
      outDir,
      metadata: {
        ...metadata,
        status: "generated",
        stdout,
        stderr,
        updatedAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
      },
    });

    writeJson(local.workflowPath, result.workflow);

    await trackFlowUser(ownerId, { workflowCreated: true });
    await incrementFlowStats({
      action: "generate",
      fileType: mode === "project" ? "zip" : "wasm",
      deployScripts: result.stats?.deployScripts || 0,
      invokeScripts: result.stats?.invokeScripts || 0,
      totalScripts: result.stats?.generatedWorkflows || 0,
      functionsDetected: result.stats?.functionCount || 0,
    });

    res.json(result);
  } catch (error) {
    const now = new Date().toISOString();
    const failed = {
      workflowId,
      ownerId,
      name,
      mode,
      network,
      source,
      status: "failed",
      error: error?.message || String(error),
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      lastDownloadedAt: null,
      storage: { provider: "local", path: workflowDir },
    };

    fs.mkdirSync(workflowDir, { recursive: true });
    writeJson(local.workflowPath, failed);

    await trackFlowUser(ownerId);
    await incrementFlowStats({ failed: true });

    res.status(500).json(failed);
  }
});

app.get("/api/workflows", async (req, res) => {
  try {
    const ownerId = getOwnerId(req);
    await trackFlowUser(ownerId);
    const workflows = await listWorkflowsForOwner(ownerId);
    res.json({ workflows });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get("/api/workflows/:workflowId", async (req, res) => {
  try {
    const workflowId = safeId(req.params.workflowId);
    const ownerId = getOwnerId(req);
    await trackFlowUser(ownerId);
    const local = getLocalPaths(workflowId, ownerId);

    if (!fs.existsSync(local.workflowPath)) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    const workflow = readJsonSafe(local.workflowPath);
    assertWorkflowOwner(workflow, ownerId);

    const nextWorkflow = {
      ...workflow,
      lastOpenedAt: new Date().toISOString(),
      updatedAt:
        workflow.updatedAt || workflow.createdAt || new Date().toISOString(),
    };

    await saveWorkflowMetadata(workflowId, nextWorkflow);

    res.json(
      readWorkflowResultLocal({
        workflowId,
        workflowDir: local.workflowDir,
        outDir: local.outDir,
        metadata: nextWorkflow,
      })
    );
  } catch (error) {
    res.status(404).json({ error: error?.message || "Workflow not found" });
  }
});

app.get("/api/workflows/:workflowId/file", async (req, res) => {
  try {
    const workflowId = safeId(req.params.workflowId);
    const ownerId = getOwnerId(req);
    const requested = normalizeKey(String(req.query.path || "manifest.json"));
    const workflow = await readWorkflowMetadata(workflowId, ownerId);
    assertWorkflowOwner(workflow, ownerId);

    const local = getLocalPaths(workflowId, ownerId);
    const localPath = safeJoin(local.outDir, requested);

    if (
      localPath &&
      fs.existsSync(localPath) &&
      fs.statSync(localPath).isFile()
    ) {
      return res.sendFile(localPath);
    }

    res.status(404).json({ error: "File not found" });
  } catch (error) {
    res.status(404).json({ error: error?.message || "File not found" });
  }
});

app.patch("/api/workflows/:workflowId", async (req, res) => {
  try {
    const workflowId = safeId(req.params.workflowId);
    const ownerId = getOwnerId(req);
    await trackFlowUser(ownerId);
    const workflow = await readWorkflowMetadata(workflowId, ownerId);
    assertWorkflowOwner(workflow, ownerId);

    const editedFiles =
      req.body.editedFiles && typeof req.body.editedFiles === "object"
        ? req.body.editedFiles
        : workflow.editedFiles || {};

    const next = {
      ...workflow,
      ownerId,
      name: typeof req.body.name === "string" ? req.body.name : workflow.name,
      selectedSteps: Array.isArray(req.body.selectedSteps)
        ? req.body.selectedSteps
        : workflow.selectedSteps,
      customFlowScript:
        typeof req.body.customFlowScript === "string"
          ? req.body.customFlowScript
          : workflow.customFlowScript,
      editedFiles,
      updatedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
    };

    await saveWorkflowMetadata(workflowId, next);

    // Persist edited generated files locally so download/load uses the latest edits.
    if (editedFiles && typeof editedFiles === "object") {
      const local = getLocalPaths(workflowId, ownerId);
      for (const [relativePath, content] of Object.entries(editedFiles)) {
        if (typeof content !== "string") continue;
        const normalized = normalizeKey(relativePath);
        if (!normalized || normalized.includes("..")) continue;
        const outputPath = safeJoin(local.outDir, normalized);
        if (!outputPath) continue;
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, content);
      }
    }

    res.json({ workflow: next });
  } catch (error) {
    res.status(404).json({ error: error?.message || "Workflow not found" });
  }
});

app.delete("/api/workflows/:workflowId", async (req, res) => {
  try {
    const workflowId = safeId(req.params.workflowId);
    const ownerId = getOwnerId(req);
    const workflow = await readWorkflowMetadata(workflowId, ownerId);
    assertWorkflowOwner(workflow, ownerId);

    const local = getLocalPaths(workflowId, ownerId);

    if (fs.existsSync(local.workflowDir)) {
      fs.rmSync(local.workflowDir, { recursive: true, force: true });
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(404).json({ error: error?.message || "Workflow not found" });
  }
});

app.post("/api/workflows/:workflowId/download", async (req, res) => {
  try {
    const workflowId = safeId(req.params.workflowId);
    const ownerId = getOwnerId(req);
    const workflow = await readWorkflowMetadata(workflowId, ownerId);
    assertWorkflowOwner(workflow, ownerId);

    const selectedSteps = Array.isArray(req.body.selectedSteps)
      ? req.body.selectedSteps
      : [];
    const editedFiles =
      req.body.editedFiles && typeof req.body.editedFiles === "object"
        ? req.body.editedFiles
        : {};
    const customFlowScript =
      typeof req.body.customFlowScript === "string"
        ? req.body.customFlowScript
        : "";

    const now = new Date().toISOString();
    await saveWorkflowMetadata(workflowId, {
      ...workflow,
      updatedAt: now,
      lastOpenedAt: now,
      lastDownloadedAt: now,
      selectedSteps,
      customFlowScript: customFlowScript || workflow.customFlowScript,
      editedFiles: Object.keys(editedFiles).length
        ? editedFiles
        : workflow.editedFiles,
    });

    await trackFlowUser(ownerId, { download: true });
    await incrementFlowStats({ action: "download" });

    const zip = await buildWorkflowZip({
      workflowId,
      ownerId,
      selectedSteps,
      editedFiles,
      customFlowScript,
    });
    const buffer = zip.toBuffer();

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${workflowId}-sorobuild-flow.zip"`
    );
    res.send(buffer);
  } catch (error) {
    res
      .status(500)
      .json({ error: error?.message || "Failed to create workflow ZIP" });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Sorobuild Flow API listening on http://localhost:${PORT}`);
  console.log("Storage provider: local filesystem");
  console.log(`Workflow TTL: ${WORKFLOW_TTL_HOURS} hour(s)`);

  cleanupExpiredLocalWorkflows();
});

const cleanupTimer = setInterval(
  () => cleanupExpiredLocalWorkflows(),
  CLEANUP_INTERVAL_MS
);
cleanupTimer.unref?.();

function shutdown() {
  clearInterval(cleanupTimer);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function buildCliArgs({ mode, savedInput, inputDir, outDir, network, source }) {
  if (mode === "wasm") {
    return [
      cliPath,
      "--wasm",
      savedInput,
      "--out",
      outDir,
      "--network",
      network,
      "--source",
      source,
      "--no-build",
    ];
  }

  if (mode === "project") {
    if (process.env.ALLOW_PROJECT_BUILD !== "true") {
      throw new Error(
        "Project ZIP build is disabled by default. Set ALLOW_PROJECT_BUILD=true for local MVP testing. Use Docker sandboxing before enabling this in production."
      );
    }

    const projectRoot = path.join(inputDir, "project");
    const actualProjectRoot = unzipProject(savedInput, projectRoot);
    return [
      cliPath,
      "--project",
      actualProjectRoot,
      "--out",
      outDir,
      "--network",
      network,
      "--source",
      source,
    ];
  }

  throw new Error("Invalid mode. Use mode=wasm or mode=project.");
}

async function readWorkflowMetadata(workflowId, ownerId = DEFAULT_OWNER_ID) {
  const local = getLocalPaths(workflowId, ownerId);
  if (fs.existsSync(local.workflowPath)) {
    const workflow = readJsonSafe(local.workflowPath);
    if (workflow) return workflow;
  }

  throw new Error("Workflow not found");
}

async function saveWorkflowMetadata(workflowId, workflow) {
  const ownerId = safeOwnerId(workflow.ownerId || DEFAULT_OWNER_ID);
  const local = getLocalPaths(workflowId, ownerId);
  fs.mkdirSync(local.workflowDir, { recursive: true });
  writeJson(local.workflowPath, workflow);
}

function readWorkflowResultLocal({
  workflowId,
  workflowDir,
  outDir,
  metadata,
}) {
  const workspaceManifest = readJsonSafe(
    path.join(outDir, "workspace.manifest.json")
  );
  const manifestFiles = listFiles(outDir)
    .filter((file) => path.basename(file) === "manifest.json")
    .map((file) => ({
      absolute: file,
      relative: path.relative(outDir, file).replace(/\\/g, "/"),
      manifest: readJsonSafe(file),
    }))
    .filter((item) => item.manifest);

  const primaryManifest =
    readJsonSafe(path.join(outDir, "manifest.json")) ||
    manifestFiles[0]?.manifest ||
    null;
  const contracts = manifestFiles.map((item) => ({
    contractName: item.manifest.contractName,
    manifestPath: item.relative,
    rootDir:
      path.dirname(item.relative) === "."
        ? ""
        : path.dirname(item.relative).replace(/\\/g, "/"),
    functionCount: item.manifest.functions?.length || 0,
    functions: item.manifest.functions || [],
    scripts: item.manifest.scripts || {},
  }));

  const allFunctions = contracts.flatMap((contract) =>
    contract.functions.map((fn) => ({
      ...fn,
      contractName: contract.contractName,
      contractRoot: contract.rootDir,
    }))
  );

  const files = listFiles(outDir).map((absolute) =>
    path.relative(outDir, absolute).replace(/\\/g, "/")
  );
  const scripts = Object.fromEntries(
    files
      .filter((file) => file.endsWith(".sh"))
      .map((file) => [file, fs.readFileSync(path.join(outDir, file), "utf8")])
  );

  const workflow = normalizeWorkflow({
    metadata,
    workflowId,
    primaryManifest,
    contracts,
    allFunctions,
    workspaceManifest,
    workflowDir,
  });
  return buildResultPayload({
    workflow,
    manifest: primaryManifest,
    workspaceManifest,
    contracts,
    files,
    scripts,
  });
}

function normalizeWorkflow({
  metadata,
  workflowId,
  primaryManifest,
  contracts,
  allFunctions,
  workspaceManifest,
  workflowDir,
}) {
  return {
    ...metadata,
    workflowId,
    status: metadata.status || "generated",
    contractName:
      primaryManifest?.contractName ||
      (contracts.length === 1 ? contracts[0].contractName : "workspace"),
    contractCount: contracts.length,
    functionCount: allFunctions.length,
    functions: allFunctions,
    contracts,
    workspaceManifest,
    filesPath: workflowDir,
    storage: { provider: "local", path: workflowDir },
    updatedAt: metadata.updatedAt || new Date().toISOString(),
  };
}

function buildResultPayload({
  workflow,
  manifest,
  workspaceManifest,
  contracts,
  files,
  scripts,
}) {
  const deployScripts = files.filter((file) =>
    file.endsWith("scripts/deploy.sh")
  );
  const invokeScripts = files.filter((file) =>
    /(^|\/)scripts\/invoke\/[^/]+\.sh$/.test(file)
  );
  const flowScripts = files.filter((file) =>
    /(^|\/)scripts\/flows\/[^/]+\.sh$/.test(file)
  );

  return {
    workflow,
    manifest,
    workspaceManifest,
    contracts,
    files,
    scripts,
    stats: {
      generatedWorkflows:
        deployScripts.length + invokeScripts.length + flowScripts.length,
      deployScripts: deployScripts.length,
      invokeScripts: invokeScripts.length,
      flowScripts: flowScripts.length,
      contractCount: contracts.length,
      functionCount: workflow.functionCount || 0,
      hasDeploy: deployScripts.length > 0,
    },
  };
}

async function buildWorkflowZip({
  workflowId,
  ownerId,
  selectedSteps,
  editedFiles,
  customFlowScript,
}) {
  const zip = new AdmZip();
  const local = getLocalPaths(workflowId, ownerId);
  const files = await listWorkflowGeneratedFiles(workflowId, ownerId);
  const envFiles = files.filter((file) => file.endsWith("env.sh"));
  const argumentFiles = files.filter((file) => file.endsWith("arguments.sh"));
  const wasmFiles = files.filter((file) =>
    file.toLowerCase().endsWith(".wasm")
  );

  const addedFiles = new Set();

  async function addTextFile(relativePath, content) {
    const normalized = normalizeKey(relativePath);
    if (!normalized || addedFiles.has(normalized)) return;
    zip.addFile(normalized, Buffer.from(content, "utf8"));
    addedFiles.add(normalized);
  }

  async function addBinaryFile(relativePath, buffer) {
    const normalized = normalizeKey(relativePath);
    if (!normalized || addedFiles.has(normalized)) return;
    zip.addFile(normalized, buffer);
    addedFiles.add(normalized);
  }

  const selected = selectedSteps.map(normalizeKey).filter(Boolean);

  for (const relativePath of selected) {
    const content =
      editedFiles[relativePath] ||
      (await readGeneratedFileText(workflowId, ownerId, relativePath));
    await addTextFile(relativePath, content);
  }

  for (const relativePath of [...envFiles, ...argumentFiles]) {
    const normalized = normalizeKey(relativePath);
    const content =
      editedFiles[normalized] ||
      (await readGeneratedFileText(workflowId, ownerId, normalized));
    await addTextFile(normalized, content);
  }

  for (const relativePath of wasmFiles) {
    const normalized = normalizeKey(relativePath);
    const buffer = await readGeneratedFileBuffer(
      workflowId,
      ownerId,
      normalized
    );
    await addBinaryFile(normalized, buffer);
  }

  await addTextFile(
    "flow.selected.sh",
    customFlowScript || renderDownloadFlow(selected)
  );

  await addTextFile(
    "README.md",
    renderRunInstructions({
      selectedSteps: selected,
      envFiles,
      argumentFiles,
      wasmFiles,
    })
  );

  if (fs.existsSync(local.workflowDir)) {
    fs.mkdirSync(path.join(local.workflowDir, "exports"), { recursive: true });
    fs.writeFileSync(
      path.join(local.workflowDir, "exports", "latest.zip"),
      zip.toBuffer()
    );
  }

  return zip;
}

async function listWorkflowGeneratedFiles(
  workflowId,
  ownerId = DEFAULT_OWNER_ID
) {
  const local = getLocalPaths(workflowId, ownerId);

  if (fs.existsSync(local.outDir)) {
    return listFiles(local.outDir).map((absolute) =>
      path.relative(local.outDir, absolute).replace(/\\/g, "/")
    );
  }

  return [];
}

async function readGeneratedFileText(
  workflowId,
  ownerId = DEFAULT_OWNER_ID,
  relativePath
) {
  const normalized = normalizeKey(relativePath);
  const local = getLocalPaths(workflowId, ownerId);
  const localPath = safeJoin(local.outDir, normalized);

  if (
    localPath &&
    fs.existsSync(localPath) &&
    fs.statSync(localPath).isFile()
  ) {
    return fs.readFileSync(localPath, "utf8");
  }

  throw new Error(`Generated file not found: ${normalized}`);
}

async function readGeneratedFileBuffer(
  workflowId,
  ownerId = DEFAULT_OWNER_ID,
  relativePath
) {
  const normalized = normalizeKey(relativePath);
  const local = getLocalPaths(workflowId, ownerId);
  const localPath = safeJoin(local.outDir, normalized);

  if (
    localPath &&
    fs.existsSync(localPath) &&
    fs.statSync(localPath).isFile()
  ) {
    return fs.readFileSync(localPath);
  }

  throw new Error(`Generated file not found: ${normalized}`);
}

function renderDownloadFlow(selectedSteps) {
  const steps = selectedSteps
    .map(
      (step, index) =>
        `echo "\\n▶ Step ${index + 1}: ${step}"\nrun_step ${JSON.stringify(
          step
        )}`
    )
    .join("\n\n");

  return `#!/usr/bin/env bash
set -euo pipefail

# Generated by Sorobuild Flow
# Run this from the generated workflow folder.

export FLOW_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

run_step() {
  local script_path="$1"
  local script_dir
  local full_path

  script_dir="$(dirname "$script_path")"

  if [[ "$script_dir" == */scripts/* || "$script_dir" == scripts/* ]]; then
    local contract_root="\${script_dir%%/scripts/*}"
    if [[ "$contract_root" == "$script_dir" ]]; then contract_root="."; fi

    local relative_script="\${script_path#\${contract_root}/}"
    full_path="$FLOW_ROOT/$contract_root/$relative_script"

    if [ ! -f "$full_path" ]; then
      echo "❌ Missing workflow step: $script_path"
      exit 1
    fi

    chmod +x "$full_path"
    (cd "$FLOW_ROOT/$contract_root" && ./"$relative_script")
  else
    full_path="$FLOW_ROOT/$script_path"

    if [ ! -f "$full_path" ]; then
      echo "❌ Missing workflow step: $script_path"
      exit 1
    fi

    chmod +x "$full_path"
    (cd "$FLOW_ROOT" && ./"$script_path")
  fi
}

${steps}
`;
}

function renderRunInstructions({
  selectedSteps,
  envFiles,
  argumentFiles = [],
  wasmFiles = [],
}) {
  return `# Sorobuild Flow Export

This ZIP contains the selected executable workflow files generated by Sorobuild Flow.

## Files included

- \`flow.selected.sh\` — runnable workflow entrypoint
${wasmFiles.map((file) => `- \`${file}\` — contract WASM`).join("\n")}
${envFiles.map((file) => `- \`${file}\` — environment config`).join("\n")}
${argumentFiles.map((file) => `- \`${file}\` — method arguments`).join("\n")}
${selectedSteps.map((file) => `- \`${file}\``).join("\n")}

## How to run

\`\`\`bash
unzip ${"${workflowId}"}-sorobuild-flow.zip
cd <unzipped-folder>
find . -name "*.sh" -exec chmod +x {} \\;
./flow.selected.sh
\`\`\`

## Before running

Review and update these files:

- \`env.sh\` — network, source identity, Stellar CLI, WASM path
- \`arguments.sh\` — deploy and invoke arguments

The exported WASM is included at the root of the workflow folder, and \`env.sh\` resolves it through \`FLOW_ROOT\`.
`;
}

function getOwnerId(req) {
  return safeOwnerId(
    req.body?.ownerId ||
      req.query?.ownerId ||
      req.headers["x-sorobuild-owner-id"] ||
      DEFAULT_OWNER_ID
  );
}

function safeOwnerId(id) {
  return String(id || DEFAULT_OWNER_ID)
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 160);
}

function assertWorkflowOwner(workflow, ownerId) {
  if (!workflow) throw new Error("Workflow not found");
  if (workflow.ownerId !== ownerId) throw new Error("Workflow not found");
}

function workflowListItem(workflow) {
  return {
    workflowId: workflow.workflowId,
    ownerId: workflow.ownerId,
    name: workflow.name,
    mode: workflow.mode,
    network: workflow.network,
    source: workflow.source,
    status: workflow.status,
    contractName: workflow.contractName,
    contractCount: workflow.contractCount || 0,
    functionCount: workflow.functionCount || 0,
    inputFile: workflow.inputFile,
    storage: workflow.storage,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    lastOpenedAt: workflow.lastOpenedAt,
    lastDownloadedAt: workflow.lastDownloadedAt,
  };
}

async function listWorkflowsForOwner(ownerId) {
  const ownerWorkflowRoot = path.join(
    ROOT,
    "owners",
    safeOwnerId(ownerId),
    "workflows"
  );

  if (!fs.existsSync(ownerWorkflowRoot)) return [];

  return fs
    .readdirSync(ownerWorkflowRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("wf_"))
    .map((d) =>
      readJsonSafe(path.join(ownerWorkflowRoot, d.name, "workflow.json"))
    )
    .filter((workflow) => workflow?.ownerId === ownerId)
    .map(workflowListItem)
    .sort(sortWorkflowsNewestFirst);
}

function sortWorkflowsNewestFirst(a, b) {
  return String(
    b.lastOpenedAt || b.updatedAt || b.createdAt || ""
  ).localeCompare(String(a.lastOpenedAt || a.updatedAt || a.createdAt || ""));
}

function getLocalPaths(workflowId, ownerId = DEFAULT_OWNER_ID) {
  const workflowDir = path.join(
    ROOT,
    "owners",
    safeOwnerId(ownerId),
    "workflows",
    safeId(workflowId)
  );
  return {
    workflowDir,
    workflowPath: path.join(workflowDir, "workflow.json"),
    outDir: path.join(workflowDir, "generated"),
  };
}

function cleanupExpiredLocalWorkflows({ silent = false } = {}) {
  try {
    const workflowTtlMs = WORKFLOW_TTL_HOURS * 60 * 60 * 1000;
    const uploadTtlMs = CLEANUP_UPLOADS_TTL_HOURS * 60 * 60 * 1000;
    const workflowCutoff = Date.now() - workflowTtlMs;
    const uploadCutoff = Date.now() - uploadTtlMs;
    let deletedWorkflows = 0;
    let deletedUploads = 0;

    const ownersRoot = path.join(ROOT, "owners");

    if (fs.existsSync(ownersRoot)) {
      for (const owner of fs.readdirSync(ownersRoot)) {
        const workflowsRoot = path.join(ownersRoot, owner, "workflows");
        if (!fs.existsSync(workflowsRoot)) continue;

        for (const workflowId of fs.readdirSync(workflowsRoot)) {
          const workflowDir = path.join(workflowsRoot, workflowId);
          const workflowPath = path.join(workflowDir, "workflow.json");

          if (!fs.statSync(workflowDir).isDirectory()) continue;

          const workflow = readJsonSafe(workflowPath);
          const lastTouched = Date.parse(
            workflow?.lastDownloadedAt ||
              workflow?.lastOpenedAt ||
              workflow?.updatedAt ||
              workflow?.createdAt ||
              0
          );

          if (!lastTouched || lastTouched < workflowCutoff) {
            fs.rmSync(workflowDir, { recursive: true, force: true });
            deletedWorkflows++;
          }
        }
      }
    }

    const uploadsRoot = path.join(ROOT, ".uploads");
    if (fs.existsSync(uploadsRoot)) {
      for (const file of fs.readdirSync(uploadsRoot)) {
        const full = path.join(uploadsRoot, file);
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.mtimeMs < uploadCutoff) {
          fs.rmSync(full, { force: true });
          deletedUploads++;
        }
      }
    }

    if (!silent && (deletedWorkflows || deletedUploads)) {
      console.log(
        `Cleanup complete: deleted ${deletedWorkflows} workflow(s), ${deletedUploads} upload temp file(s).`
      );
    }
  } catch (error) {
    console.warn(`Workflow cleanup failed: ${error?.message || error}`);
  }
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function unzipProject(zipPath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(targetDir, true);
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(targetDir, entries[0].name);
  }
  return targetDir;
}

function normalizeKey(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function safeBaseName(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}
function safeId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
}
function safeJoin(root, child) {
  const full = path.resolve(root, child);
  const resolvedRoot = path.resolve(root);
  return full.startsWith(resolvedRoot) ? full : null;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
