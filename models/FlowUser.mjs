import mongoose from "mongoose";

const { Schema } = mongoose;

const flowUserSchema = new Schema(
  {
    ownerId: { type: String, required: true, unique: true, index: true },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now, index: true },
    workflowCreatedCount: { type: Number, default: 0 },
    downloadCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const FlowUser =
  mongoose.models.FlowUser || mongoose.model("FlowUser", flowUserSchema);
