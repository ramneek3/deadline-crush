import mongoose from "mongoose";
import { config } from "../config";
import { syncAllIndexes } from "./models";

export async function connectDb(url = config.mongoUrl) {
  mongoose.set("strictQuery", true);
  await mongoose.connect(url, { maxPoolSize: 50, serverSelectionTimeoutMS: 10_000 });
  await syncAllIndexes();
}
export const disconnectDb = () => mongoose.disconnect();
