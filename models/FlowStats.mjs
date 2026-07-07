import mongoose from "mongoose";

const { Schema } = mongoose;

const flowStatsSchema = new Schema(
  {
    key: { type: String, default: "global", unique: true, index: true },

    workflows: {
      created: { type: Number, default: 0 },
      downloaded: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },

    files: {
      wasm_uploaded: { type: Number, default: 0 },
      zip_uploaded: { type: Number, default: 0 },
    },

    generated: {
      deploy_scripts: { type: Number, default: 0 },
      invoke_scripts: { type: Number, default: 0 },
      total_scripts: { type: Number, default: 0 },
      functions_detected: { type: Number, default: 0 },
    },

    actions: {
      generate: { type: Number, default: 0 },
      download: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

export const FlowStats =
  mongoose.models.FlowStats || mongoose.model("FlowStats", flowStatsSchema);
