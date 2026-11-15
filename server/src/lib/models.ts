import mongoose, { Schema, InferSchemaType, Types } from "mongoose";

export const VERSION_STATUSES = [
  "uploading", // upload session open, bytes not yet complete
  "queued", // upload done, waiting for a worker
  "checking", // a worker is processing it
  "accepted",
  "needs_fix",
  "failed", // checks could not run (infrastructure) after retries
] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    role: { type: String, enum: ["team", "organizer"], default: "team" },
    teamId: { type: Schema.Types.ObjectId, ref: "Team", default: null },
  },
  { timestamps: true },
);

const teamSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    memberIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    versionSeq: { type: Number, default: 0 }, // atomic counter for versionNo
  },
  { timestamps: true },
);
teamSchema.index({ memberIds: 1 });

const versionSchema = new Schema({
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true, index: true },
  versionNo: { type: Number, required: true },
  title: { type: String, required: true },
  description: { type: String, default: "" },
  links: [{ type: String }],
  status: { type: String, enum: VERSION_STATUSES, required: true },
  file: {
    key: String,
    name: String,
    size: Number,
    sha256: String,
    contentType: String,
  },
  createdAt: { type: Date, required: true }, // server clock
  completedAt: { type: Date, default: null }, // when the upload finished (server clock)
  problems: [{ type: String }],
  previewKey: { type: String, default: null },
});
versionSchema.index({ teamId: 1, versionNo: 1 }, { unique: true });
versionSchema.index({ status: 1 });

const uploadSchema = new Schema({
  versionId: { type: Schema.Types.ObjectId, ref: "Version", required: true, unique: true },
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  s3UploadId: { type: String, required: true },
  key: { type: String, required: true },
  fileName: String,
  fileSize: { type: Number, required: true },
  partSize: { type: Number, required: true },
  partCount: { type: Number, required: true },
  // Source of truth for resume: parts the client has acknowledged.
  parts: [{ n: Number, etag: String, size: Number, _id: false }],
  status: { type: String, enum: ["open", "completing", "completed", "aborted"], default: "open" },
  completingAt: { type: Date, default: null },
  startedAt: { type: Date, required: true }, // server clock
});

// One row per version, ever. The unique index is what makes processing exactly-once:
// a retried job can only ever (re)write this single row.
const checkResultSchema = new Schema({
  versionId: { type: Schema.Types.ObjectId, ref: "Version", required: true, unique: true },
  teamId: { type: Schema.Types.ObjectId, required: true },
  passed: { type: Boolean, required: true },
  detectedType: String,
  sha256: String,
  problems: [String],
  linkResults: [{ url: String, ok: Boolean, status: Number, error: String, _id: false }],
  previewKey: String,
  attempts: { type: Number, default: 1 },
  processedAt: { type: Date, required: true },
});

const attemptSchema = new Schema({
  teamId: { type: Schema.Types.ObjectId, index: true },
  userId: { type: Schema.Types.ObjectId },
  type: { type: String, required: true }, // create_version | init_upload | presign | complete_upload | ...
  accepted: { type: Boolean, required: true },
  reason: String,
  late: { type: Boolean, default: false },
  ts: { type: Date, required: true },
});
attemptSchema.index({ late: 1 });

const settingsSchema = new Schema({
  key: { type: String, unique: true, required: true },
  deadlineAt: { type: Date, required: true },
  graceSeconds: { type: Number, required: true },
});

export const User = mongoose.model("User", userSchema);
export const Team = mongoose.model("Team", teamSchema);
export const Version = mongoose.model("Version", versionSchema);
export const Upload = mongoose.model("Upload", uploadSchema);
export const CheckResult = mongoose.model("CheckResult", checkResultSchema);
export const Attempt = mongoose.model("Attempt", attemptSchema);
export const Settings = mongoose.model("Settings", settingsSchema);

export type VersionDoc = InferSchemaType<typeof versionSchema> & { _id: Types.ObjectId };
export type UploadDoc = InferSchemaType<typeof uploadSchema> & { _id: Types.ObjectId };

export async function syncAllIndexes() {
  await Promise.all(
    [User, Team, Version, Upload, CheckResult, Attempt, Settings].map((m) => m.syncIndexes()),
  );
}
