export const PORT = parseInt(process.env.PORT || "3003");
export const CORS_ORIGIN = process.env.CORS_ORIGIN;
export const NODE_ENV = process.env.NODE_ENV || "development";

export const DATABASE_URL = process.env.DATABASE_URL || "";

export const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const AWS_REGION = process.env.AWS_REGION || "us-east-1";
export const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "";
export const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "";
export const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || "";
export const S3_ENDPOINT = process.env.S3_ENDPOINT; // For MinIO/R2
export const CDN_URL = process.env.CDN_URL;

// Upload limits
export const MAX_FILE_SIZE = 1 * 1024 * 1024 * 1024; // 1GB
export const MULTIPART_CHUNK_SIZE = 16 * 1024 * 1024; // 16MB
export const MULTIPART_THRESHOLD = 50 * 1024 * 1024; // 50MB
export const PRESIGNED_URL_EXPIRATION = 7200; // 2 hour
export const MAX_MULTIPART_PARTS = 10000; // AWS S3 limit

// Rate Limiting
export const RATE_LIMIT_UPLOAD_MAX = parseInt(
  process.env.RATE_LIMIT_UPLOAD_MAX || "10"
);
export const RATE_LIMIT_UPLOAD_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_UPLOAD_WINDOW_MS || "3600000"
); // 1 hour

export const RATE_LIMIT_API_MAX = parseInt(
  process.env.RATE_LIMIT_API_MAX || "100"
);
export const RATE_LIMIT_API_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_API_WINDOW_MS || "60000"
); // 1 minute

// Video processing
export const VIDEO_PROCESSING_QUEUE = "video-processing";
export const MAX_PROCESSING_ATTEMPTS = 3;

export const VIDEO_QUALITIES = [
  { name: "360p", height: 360, bitrate: "800k", audioBitrate: "96k" },
  { name: "720p", height: 720, bitrate: "2500k", audioBitrate: "128k" },
  { name: "1080p", height: 1080, bitrate: "5000k", audioBitrate: "192k" },
] as const;

export type VideoQualityConfig = (typeof VIDEO_QUALITIES)[number];
export type VideoQualityName = (typeof VIDEO_QUALITIES)[number]["name"];

// Logging
export const LOG_LEVEL =
  process.env.LOG_LEVEL || (NODE_ENV === "production" ? "info" : "debug");

// Helper function to check if bucket is configured
export const isS3Configured = (): boolean => {
  return !!(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && S3_BUCKET_NAME);
};
