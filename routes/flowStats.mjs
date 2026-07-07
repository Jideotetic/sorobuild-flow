import express from "express";
import { connectMongo, isMongoConnected } from "../db/mongo.js";
import { FlowStats } from "../models/FlowStats.mjs";
import { FlowUser } from "../models/FlowUser.mjs";

const router = express.Router();
const GLOBAL_KEY = "global";

function nowMinusDays(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

async function ensureMongo() {
  if (isMongoConnected()) return true;
  const connection = await connectMongo();
  return Boolean(connection && isMongoConnected());
}

export async function trackFlowUser(ownerId, options = {}) {
  try {
    if (!ownerId) return null;
    if (!(await ensureMongo())) return null;

    const inc = {};
    if (options.workflowCreated) inc.workflowCreatedCount = 1;
    if (options.download) inc.downloadCount = 1;

    return FlowUser.findOneAndUpdate(
      { ownerId },
      {
        $set: { lastSeenAt: new Date() },
        $setOnInsert: { ownerId, firstSeenAt: new Date() },
        ...(Object.keys(inc).length ? { $inc: inc } : {}),
      },
      { upsert: true, returnDocument: "after" }
    );
  } catch (error) {
    console.warn(`trackFlowUser failed: ${error?.message || error}`);
    return null;
  }
}

export async function incrementFlowStats(update = {}) {
  try {
    if (!(await ensureMongo())) return null;

    const inc = {};

    if (update.action === "generate") {
      inc["actions.generate"] = 1;
      inc["workflows.created"] = 1;
    }

    if (update.action === "download") {
      inc["actions.download"] = 1;
      inc["workflows.downloaded"] = 1;
    }

    if (update.failed) inc["workflows.failed"] = 1;

    if (update.fileType === "wasm") inc["files.wasm_uploaded"] = 1;
    if (update.fileType === "zip" || update.fileType === "project") {
      inc["files.zip_uploaded"] = 1;
    }

    if (Number.isFinite(Number(update.deployScripts))) {
      inc["generated.deploy_scripts"] = numberOrZero(update.deployScripts);
    }
    if (Number.isFinite(Number(update.invokeScripts))) {
      inc["generated.invoke_scripts"] = numberOrZero(update.invokeScripts);
    }
    if (Number.isFinite(Number(update.totalScripts))) {
      inc["generated.total_scripts"] = numberOrZero(update.totalScripts);
    }
    if (Number.isFinite(Number(update.functionsDetected))) {
      inc["generated.functions_detected"] = numberOrZero(
        update.functionsDetected
      );
    }

    if (!Object.keys(inc).length) return null;

    return FlowStats.findOneAndUpdate(
      { key: GLOBAL_KEY },
      { $inc: inc, $setOnInsert: { key: GLOBAL_KEY } },
      {
        upsert: true,
        returnDocument: "after",
      }
    );
  } catch (error) {
    console.warn(`incrementFlowStats failed: ${error?.message || error}`);
    return null;
  }
}

export async function getFlowStatsPayload() {
  if (!(await ensureMongo())) {
    return {
      enabled: false,
      stats: null,
      users: { total: 0, active_7d: 0, active_30d: 0 },
      lastUpdated: null,
    };
  }

  const [statsDoc, totalUsers, active7d, active30d] = await Promise.all([
    FlowStats.findOne({ key: GLOBAL_KEY }).lean(),
    FlowUser.countDocuments(),
    FlowUser.countDocuments({ lastSeenAt: { $gte: nowMinusDays(7) } }),
    FlowUser.countDocuments({ lastSeenAt: { $gte: nowMinusDays(30) } }),
  ]);

  const stats =
    statsDoc ||
    (await FlowStats.findOneAndUpdate(
      { key: GLOBAL_KEY },
      { $setOnInsert: { key: GLOBAL_KEY } },
      {
        upsert: true,
        returnDocument: "after",
      }
    ).lean());

  return {
    enabled: true,
    stats: {
      ...stats,
      users: {
        total: totalUsers,
        active_7d: active7d,
        active_30d: active30d,
      },
    },
    users: {
      total: totalUsers,
      active_7d: active7d,
      active_30d: active30d,
    },
    lastUpdated: stats?.updatedAt || null,
  };
}

// Kept for compatibility with older server imports. Active users are calculated live.
export async function refreshFlowActiveUsers() {
  return getFlowStatsPayload();
}

router.get("/stats/flow", async (_req, res) => {
  try {
    res.json(await getFlowStatsPayload());
  } catch (error) {
    res
      .status(500)
      .json({ error: error?.message || "Failed to load Flow stats" });
  }
});

export default router;
