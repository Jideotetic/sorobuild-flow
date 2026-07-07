import mongoose from "mongoose";

let connectionPromise = null;

export function isMongoConfigured() {
  return Boolean(
    process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_PASSWORD
  );
}

export function getMongoUri() {
  if (process.env.MONGO_URI) return process.env.MONGO_URI;
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  if (process.env.DB_PASSWORD) {
    return `mongodb+srv://sorobuild:${process.env.DB_PASSWORD}@sorobuild.htver3p.mongodb.net/users?appName=sorobuild`;
  }

  return "";
}

export async function connectMongo() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connectionPromise) return connectionPromise;

  const uri = getMongoUri();

  if (!uri) {
    console.warn(
      "MongoDB not configured. Flow stats will run in disabled mode."
    );
    return null;
  }

  connectionPromise = mongoose
    .connect(uri, {
      dbName: process.env.MONGO_DB_NAME || process.env.MONGO_DB || undefined,
      serverSelectionTimeoutMS: Number(
        process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 8000
      ),
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 10),
    })
    .then(() => {
      console.log("MongoDB connected for Sorobuild Flow stats");
      return mongoose.connection;
    })
    .catch((error) => {
      connectionPromise = null;
      console.warn(
        `MongoDB connection failed. Flow stats disabled: ${
          error?.message || error
        }`
      );
      return null;
    });

  return connectionPromise;
}

export function isMongoConnected() {
  return mongoose.connection.readyState === 1;
}
