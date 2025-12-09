export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3003";

export const UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024;

export const UPLOAD_RETRY_ATTEMPTS = 3;
export const UPLOAD_RETRY_DELAY = 1000;

export const VIDEO_QUALITIES = ["360p", "720p", "1080p"] as const;
export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

export const STORAGE_KEY = "streamforge_uploads";

export const ROUTES = {
  home: "/",
  video: (id: string) => `/video/${id}`,
  upload: "/upload",
} as const;
