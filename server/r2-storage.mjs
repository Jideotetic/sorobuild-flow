import fs from "node:fs";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_BUCKET = process.env.R2_BUCKET || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";

export function isR2Enabled() {
  return Boolean(
    R2_ACCOUNT_ID && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
  );
}

function assertR2Enabled() {
  if (!isR2Enabled()) {
    throw new Error(
      "Cloudflare R2 is not configured. Set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY."
    );
  }
}

export const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

export function workflowPrefix(workflowId) {
  return `workflows/${safeId(workflowId)}/`;
}

export function workflowJsonKey(workflowId) {
  return `${workflowPrefix(workflowId)}workflow.json`;
}

export function generatedKey(workflowId, relativePath) {
  return `${workflowPrefix(workflowId)}generated/${normalizeKey(relativePath)}`;
}

export function inputKey(workflowId, filename) {
  return `${workflowPrefix(workflowId)}input/${safeBaseName(filename)}`;
}

export function stripGeneratedPrefix(workflowId, key) {
  const prefix = `${workflowPrefix(workflowId)}generated/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export function normalizeKey(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

export async function putFile(
  key,
  filePath,
  contentType = "application/octet-stream"
) {
  assertR2Enabled();

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: normalizeKey(key),
      Body: fs.createReadStream(filePath),
      ContentType: contentType,
    })
  );
}

export async function putText(
  key,
  text,
  contentType = "text/plain; charset=utf-8"
) {
  assertR2Enabled();

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: normalizeKey(key),
      Body: Buffer.from(String(text), "utf8"),
      ContentType: contentType,
    })
  );
}

export async function putBuffer(
  key,
  buffer,
  contentType = "application/octet-stream"
) {
  assertR2Enabled();

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: normalizeKey(key),
      Body: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
      ContentType: contentType,
    })
  );
}

export async function putJson(key, value) {
  await putText(
    key,
    JSON.stringify(value, null, 2),
    "application/json; charset=utf-8"
  );
}

export async function getObjectBuffer(key) {
  assertR2Enabled();

  const result = await r2.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: normalizeKey(key),
    })
  );

  return streamToBuffer(result.Body);
}

export async function getObjectText(key) {
  return (await getObjectBuffer(key)).toString("utf8");
}

export async function getJson(key) {
  return JSON.parse(await getObjectText(key));
}

export async function listKeys(prefix) {
  assertR2Enabled();

  const out = [];
  let ContinuationToken;

  do {
    const result = await r2.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: normalizeKey(prefix),
        ContinuationToken,
      })
    );

    for (const item of result.Contents || []) {
      if (item.Key) out.push(item.Key);
    }

    ContinuationToken = result.IsTruncated
      ? result.NextContinuationToken
      : undefined;
  } while (ContinuationToken);

  return out.sort();
}

export async function listWorkflowMetas() {
  const keys = await listKeys("workflows/");
  const workflowKeys = keys.filter((key) => key.endsWith("/workflow.json"));
  const workflows = [];

  for (const key of workflowKeys) {
    try {
      workflows.push(await getJson(key));
    } catch {
      // Ignore corrupted or partially written metadata.
    }
  }

  return workflows.sort((a, b) =>
    String(b.createdAt || b.updatedAt || "").localeCompare(
      String(a.createdAt || a.updatedAt || "")
    )
  );
}

export async function deletePrefix(prefix) {
  assertR2Enabled();

  const keys = await listKeys(prefix);
  const chunks = chunk(keys, 1000);

  for (const group of chunks) {
    if (!group.length) continue;

    await r2.send(
      new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: {
          Objects: group.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    );
  }
}

export async function uploadDirectory({
  workflowId,
  localDir,
  remoteSubdir = "generated",
}) {
  assertR2Enabled();

  const files = walk(localDir);
  const uploads = files.map((filePath) => {
    const relative = path.relative(localDir, filePath).replace(/\\/g, "/");
    const key = `${workflowPrefix(workflowId)}${normalizeKey(
      remoteSubdir
    )}/${relative}`;
    return putFile(key, filePath, contentTypeForKey(relative));
  });

  await Promise.all(uploads);
}

export function contentTypeForKey(key) {
  const clean = String(key).toLowerCase();

  if (clean.endsWith(".json")) return "application/json; charset=utf-8";
  if (clean.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (clean.endsWith(".sh")) return "text/x-shellscript; charset=utf-8";
  if (clean.endsWith(".wasm")) return "application/wasm";
  if (clean.endsWith(".zip")) return "application/zip";
  if (clean.endsWith(".txt")) return "text/plain; charset=utf-8";

  return "application/octet-stream";
}

function walk(root) {
  if (!fs.existsSync(root)) return [];

  const out = [];

  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, item.name);
    if (item.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }

  return out.sort();
}

async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function safeId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function safeBaseName(name) {
  return path
    .basename(String(name || "upload"))
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function chunk(items, size) {
  const out = [];

  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }

  return out;
}
