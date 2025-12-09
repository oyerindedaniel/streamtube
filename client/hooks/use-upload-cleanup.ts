"use client";
import { useEffect, useRef } from "react";
import { STORAGE_KEY } from "@/app/lib/constants";

const CLEANUP_INTERVAL = 60 * 1000;

interface SavedSession {
  uploadId: string;
  filename: string;
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  status: "uploading" | "processing" | "complete" | "error" | "paused";
  error?: string;
  uploadedChunks: number[];
  sessionId?: string;
  urlsExpiresAt?: string;
}

let cleanupIntervalId: NodeJS.Timeout | null = null;
let instanceCount = 0;

const cleanupExpiredSessions = () => {
  if (typeof window === "undefined") return;

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;

    const sessions = JSON.parse(saved) as Record<string, SavedSession>;
    const now = Date.now();
    let hasChanges = false;

    const validSessions: Record<string, SavedSession> = {};

    for (const [id, session] of Object.entries(sessions)) {
      if (
        session.status === "complete" ||
        session.status === "processing" ||
        session.status === "error"
      ) {
        hasChanges = true;
        continue;
      }

      if (session.urlsExpiresAt) {
        const expiresAt = new Date(session.urlsExpiresAt).getTime();

        if (now >= expiresAt) {
          console.log(
            `[UploadCleanup] Removing expired session: ${session.filename}`
          );
          hasChanges = true;
          continue;
        }
      }

      validSessions[id] = session;
    }

    if (hasChanges) {
      if (Object.keys(validSessions).length === 0) {
        localStorage.removeItem(STORAGE_KEY);
        console.log("[UploadCleanup] Cleared all sessions");
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(validSessions));
        console.log(
          `[UploadCleanup] Kept ${
            Object.keys(validSessions).length
          } valid session(s)`
        );
      }
    }
  } catch (error) {
    console.error("[UploadCleanup] Error during cleanup:", error);
  }
};

const startCleanupInterval = () => {
  if (cleanupIntervalId === null) {
    console.log("[UploadCleanup] Starting cleanup interval");

    cleanupExpiredSessions();

    cleanupIntervalId = setInterval(() => {
      cleanupExpiredSessions();
    }, CLEANUP_INTERVAL);
  }
};

const stopCleanupInterval = () => {
  if (cleanupIntervalId !== null) {
    console.log("[UploadCleanup] Stopping cleanup interval");
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
};

export function useUploadCleanup() {
  const isMounted = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    instanceCount++;
    isMounted.current = true;

    startCleanupInterval();

    console.log(
      `[UploadCleanup] Hook mounted (${instanceCount} active instance(s))`
    );

    return () => {
      if (!isMounted.current) return;

      instanceCount--;
      isMounted.current = false;

      console.log(
        `[UploadCleanup] Hook unmounted (${instanceCount} remaining instance(s))`
      );

      if (instanceCount === 0) {
        stopCleanupInterval();
      }
    };
  }, []);

  return {
    cleanupNow: cleanupExpiredSessions,
  };
}
