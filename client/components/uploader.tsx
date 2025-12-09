"use client";
import { useState, useRef } from "react";
import { API_URL } from "@/app/lib/constants";
import { UPLOAD_CHUNK_SIZE } from "@/app/lib/constants";
import { createSHA256 } from "hash-wasm";
import { STORAGE_KEY } from "@/app/lib/constants";

export function Uploader() {
  const [uploads, setUploads] = useState<Record<string, UploadProgress>>(() => {
    if (typeof window === "undefined") return {};
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return {};
    try {
      const sessions = JSON.parse(saved) as Record<string, SavedSession>;
      const restored: Record<string, UploadProgress> = {};
      Object.values(sessions).forEach((session) => {
        if (session.status === "uploading" || session.status === "paused") {
          restored[session.uploadId] = {
            ...session,
            status: "paused",
            uploadedChunks: new Set(session.uploadedChunks || []),
          };
        }
      });
      return restored;
    } catch {
      return {};
    }
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadSessionsRef = useRef<Record<string, UploadSession>>({});
  const uploadsPausedRef = useRef<Record<string, boolean>>({});
  const abortControllersRef = useRef<Record<string, AbortController>>({});

  const saveSessions = (currentUploads: Record<string, UploadProgress>) => {
    const toSave = Object.fromEntries(
      Object.entries(currentUploads).map(([id, upload]) => [
        id,
        {
          ...upload,
          uploadedChunks: Array.from(upload.uploadedChunks),
        },
      ])
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      uploadFile(file);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const uploadFile = async (file: File, resumeId?: string) => {
    const tempId = resumeId || crypto.randomUUID();

    abortControllersRef.current[tempId] = new AbortController();

    const initialProgress: UploadProgress = {
      uploadId: tempId,
      filename: file.name,
      progress: 0,
      uploadedBytes: 0,
      totalBytes: file.size,
      status: "uploading",
      uploadedChunks: new Set(),
    };

    setUploads((prev) => {
      const updated = { ...prev, [tempId]: initialProgress };
      saveSessions(updated);
      return updated;
    });

    try {
      const initResponse = await fetch(`${API_URL}/api/v1/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          size: file.size,
          metadata: { title: file.name },
          checksum: await calculateChecksum(file).catch((e) => {
            console.warn("Checksum calculation failed:", e);
            return undefined;
          }),
        }),
      });

      if (!initResponse.ok) {
        throw new Error("Failed to initialize upload");
      }

      const initData = (await initResponse.json()) as UploadAPIResponse;

      if (initData.type === "multipart") {
        const totalChunks = initData.partUrls.length;

        uploadSessionsRef.current[tempId] = {
          type: "multipart",
          uploadId: initData.uploadId,
          multipartUploadId: initData.multipartUploadId,
          partUrls: initData.partUrls,
          totalChunks,
          uploadedParts: null,
          urlsExpiresAt: initData.expiresAt,
        };

        setUploads((prev) => {
          const updated = {
            ...prev,
            [tempId]: {
              ...prev[tempId],
              uploadId: initData.uploadId,
              sessionId: initData.multipartUploadId,
              urlsExpiresAt: initData.expiresAt,
            },
          };
          saveSessions(updated);
          return updated;
        });

        await uploadChunked(tempId, file, initData.partUrls, initData.partSize);
      } else {
        uploadSessionsRef.current[tempId] = {
          type: "single",
          uploadId: initData.uploadId,
          uploadUrl: initData.uploadUrl,
          totalChunks: 1,
        };

        setUploads((prev) => {
          const updated = {
            ...prev,
            [tempId]: {
              ...prev[tempId],
              uploadId: initData.uploadId,
            },
          };
          saveSessions(updated);
          return updated;
        });

        await uploadDirect(tempId, file, initData.uploadUrl);
      }

      const session = uploadSessionsRef.current[tempId];
      const completeBody: {
        multipartUploadId?: string;
        parts?: UploadedParts;
      } = {};

      if (
        initData.type === "multipart" &&
        initData.multipartUploadId &&
        session.type === "multipart" &&
        session.uploadedParts
      ) {
        completeBody.multipartUploadId = initData.multipartUploadId;
        completeBody.parts = session.uploadedParts;
      }

      const completeResponse = await fetch(
        `${API_URL}/api/v1/uploads/${initData.uploadId}/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(completeBody),
        }
      );

      if (!completeResponse.ok) {
        throw new Error("Failed to complete upload");
      }

      setUploads((prev) => {
        const updated = {
          ...prev,
          [tempId]: {
            ...prev[tempId],
            status: "complete" as UploadStatus,
            progress: 100,
          },
        };
        saveSessions(updated);
        return updated;
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log("Upload cancelled by user");
        return;
      }

      console.error("Upload error:", error);
      setUploads((prev) => {
        const updated = {
          ...prev,
          [tempId]: {
            ...prev[tempId],
            status: "error" as UploadStatus,
            error: error instanceof Error ? error.message : "Upload failed",
          },
        };
        saveSessions(updated);
        return updated;
      });
    } finally {
      delete abortControllersRef.current[tempId];
    }
  };

  const uploadChunked = async (
    tempId: string,
    file: File,
    partUrls: string[],
    chunkSize: number
  ) => {
    const uploadState = uploads[tempId];
    const uploadedParts: UploadedParts = [];

    const session = uploadSessionsRef.current[tempId];
    if (session.type !== "multipart") {
      console.error(`Session type is "${session.type}", expected "multipart"`);
      return;
    }

    const abortController = abortControllersRef.current[tempId];
    if (!abortController) {
      throw new Error("Upload aborted before starting");
    }

    for (let i = 0; i < partUrls.length; i++) {
      if (uploadsPausedRef.current[tempId]) {
        return;
      }

      if (uploadState.uploadedChunks.has(i)) {
        continue;
      }

      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunk = file.slice(start, end);

      let retries = 3;
      while (retries > 0) {
        try {
          const response = await fetch(partUrls[i], {
            method: "PUT",
            body: chunk,
            signal: abortController.signal,
          });

          if (!response.ok) {
            throw new Error(`Failed to upload chunk ${i + 1}`);
          }

          const etag = response.headers.get("ETag");
          if (!etag) {
            throw new Error(`No ETag returned for part ${i + 1}`);
          }

          uploadedParts.push({
            PartNumber: i + 1,
            ETag: etag.replace(/"/g, ""),
          });

          setUploads((prev) => {
            const newChunks = new Set(prev[tempId].uploadedChunks);
            newChunks.add(i);
            const uploadedBytes = Array.from(newChunks).reduce((sum, idx) => {
              const chunkStart = idx * chunkSize;
              const chunkEnd = Math.min(chunkStart + chunkSize, file.size);
              return sum + (chunkEnd - chunkStart);
            }, 0);

            const updated = {
              ...prev,
              [tempId]: {
                ...prev[tempId],
                uploadedChunks: newChunks,
                uploadedBytes,
                progress: (uploadedBytes / file.size) * 100,
              },
            };
            saveSessions(updated);
            return updated;
          });

          break;
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            throw error;
          }

          retries--;
          if (retries === 0) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * (4 - retries))
          );
        }
      }
    }

    session.uploadedParts = uploadedParts;
  };

  const uploadDirect = async (
    tempId: string,
    file: File,
    uploadUrl: string
  ) => {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          setUploads((prev) => {
            const updated = {
              ...prev,
              [tempId]: {
                ...prev[tempId],
                progress: (e.loaded / e.total) * 100,
                uploadedBytes: e.loaded,
              },
            };
            saveSessions(updated);
            return updated;
          });
        }
      });

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new Error("Upload failed"));

      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", file.type);
      xhr.send(file);
    });
  };

  const pauseUpload = (tempId: string) => {
    uploadsPausedRef.current[tempId] = true;
    setUploads((prev) => {
      const updated = {
        ...prev,
        [tempId]: { ...prev[tempId], status: "paused" as UploadStatus },
      };
      saveSessions(updated);
      return updated;
    });
  };

  const resumeUpload = async (tempId: string) => {
    uploadsPausedRef.current[tempId] = false;
    abortControllersRef.current[tempId] = new AbortController();
    const upload = uploads[tempId];

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*";
    input.onchange = async (e: Event) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file || file.name !== upload.filename) {
        return;
      }

      setUploads((prev) => ({
        ...prev,
        [tempId]: { ...prev[tempId], status: "uploading" as UploadStatus },
      }));

      try {
        const session = uploadSessionsRef.current[tempId];
        if (!session) {
          throw new Error("Upload session not found");
        }

        if (session.type === "multipart" && session.multipartUploadId) {
          const now = new Date().getTime();
          const expiresAt = session.urlsExpiresAt
            ? new Date(session.urlsExpiresAt).getTime()
            : 0;
          const urlsExpired = !session.urlsExpiresAt || now >= expiresAt;

          let partUrls = session.partUrls;
          let partSize = UPLOAD_CHUNK_SIZE;

          if (urlsExpired) {
            const refreshResponse = await fetch(
              `${API_URL}/api/v1/uploads/${session.uploadId}/refresh-urls`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  multipartUploadId: session.multipartUploadId,
                }),
              }
            );

            if (!refreshResponse.ok) {
              throw new Error("Failed to refresh upload URLs");
            }

            const refreshData = await refreshResponse.json();
            partUrls = refreshData.partUrls;
            partSize = refreshData.partSize;

            session.partUrls = partUrls;
            session.urlsExpiresAt = refreshData.expiresAt;

            setUploads((prev) => {
              const updated = {
                ...prev,
                [tempId]: {
                  ...prev[tempId],
                  urlsExpiresAt: refreshData.expiresAt,
                },
              };
              saveSessions(updated);
              return updated;
            });
          }

          await uploadChunked(tempId, file, partUrls, partSize);
        } else {
          // For direct upload, we re-initialize
          uploadFile(file, tempId);
          return;
        }

        const completeBody: {
          multipartUploadId?: string;
          parts?: UploadedParts;
        } = {};

        if (session.multipartUploadId && session.uploadedParts) {
          completeBody.multipartUploadId = session.multipartUploadId;
          completeBody.parts = session.uploadedParts;
        }

        const completeResponse = await fetch(
          `${API_URL}/api/v1/uploads/${session.uploadId}/complete`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(completeBody),
          }
        );

        if (!completeResponse.ok) {
          throw new Error("Failed to complete upload");
        }

        setUploads((prev) => ({
          ...prev,
          [tempId]: {
            ...prev[tempId],
            status: "processing" as UploadStatus,
            progress: 100,
          },
        }));
      } catch (error) {
        console.error("Resume error:", error);
        setUploads((prev) => ({
          ...prev,
          [tempId]: {
            ...prev[tempId],
            status: "error" as UploadStatus,
            error: error instanceof Error ? error.message : "Resume failed",
          },
        }));
      }
    };
    input.click();
  };

  const cancelUpload = async (tempId: string) => {
    const session = uploadSessionsRef.current[tempId];
    const abortController = abortControllersRef.current[tempId];

    if (abortController) {
      abortController.abort();
      delete abortControllersRef.current[tempId];
    }

    if (session?.type === "multipart" && session.multipartUploadId) {
      try {
        await fetch(`${API_URL}/api/v1/uploads/${session.uploadId}/abort`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            multipartUploadId: session.multipartUploadId,
          }),
        });
      } catch (error) {
        console.error("Failed to abort S3 upload:", error);
      }
    }

    setUploads((prev) => {
      const { [tempId]: removed, ...rest } = prev;
      saveSessions(rest);
      return rest;
    });

    delete uploadSessionsRef.current[tempId];
    delete uploadsPausedRef.current[tempId];
  };

  return (
    <div className="space-y-4">
      <div
        className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary transition-colors"
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />
        <svg
          className="mx-auto h-12 w-12 text-muted-foreground"
          stroke="currentColor"
          fill="none"
          viewBox="0 0 48 48"
        >
          <path
            d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <p className="mt-2 text-sm text-muted-foreground">
          Click to upload or drag and drop
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Video files only • Resumable uploads for files over 100MB
        </p>
      </div>

      {Object.entries(uploads).map(([id, upload]) => (
        <div key={id} className="border border-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{upload.filename}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {(upload.uploadedBytes / 1024 / 1024).toFixed(1)} MB /{" "}
                {(upload.totalBytes / 1024 / 1024).toFixed(1)} MB
              </p>
            </div>
            <div className="flex gap-2 ml-4">
              {upload.status === "uploading" && (
                <button
                  onClick={() => pauseUpload(id)}
                  className="text-xs px-2 py-1 hover:bg-secondary rounded"
                >
                  Pause
                </button>
              )}
              {upload.status === "paused" && (
                <button
                  onClick={() => resumeUpload(id)}
                  className="text-xs px-2 py-1 bg-primary text-primary-foreground hover:opacity-90 rounded"
                >
                  Resume
                </button>
              )}
              {(upload.status === "uploading" ||
                upload.status === "paused") && (
                <button
                  onClick={() => cancelUpload(id)}
                  className="text-xs px-2 py-1 text-destructive hover:bg-destructive/10 rounded"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          <div className="w-full bg-secondary rounded-full h-2 mb-2">
            <div
              className={`h-2 rounded-full transition-all ${
                upload.status === "error"
                  ? "bg-destructive"
                  : upload.status === "paused"
                  ? "bg-muted-foreground"
                  : "bg-primary"
              }`}
              style={{ width: `${upload.progress}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="capitalize">{upload.status}</span>
            <span>{Math.round(upload.progress)}%</span>
          </div>

          {upload.error && (
            <p className="text-xs text-destructive mt-2">{upload.error}</p>
          )}
        </div>
      ))}
    </div>
  );
}

async function calculateChecksum(file: File): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  const chunkSize = UPLOAD_CHUNK_SIZE;
  const totalChunks = Math.ceil(file.size / chunkSize);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunk = file.slice(start, end);
    const buffer = await chunk.arrayBuffer();

    hasher.update(new Uint8Array(buffer));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const digest = hasher.digest("binary");
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

type UploadStatus =
  | "uploading"
  | "processing"
  | "complete"
  | "error"
  | "paused";

interface UploadProgress {
  uploadId: string;
  filename: string;
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  status: UploadStatus;
  error?: string;
  uploadedChunks: Set<number>;
  sessionId?: string;
  urlsExpiresAt?: string;
}

interface SavedSession {
  uploadId: string;
  filename: string;
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  status: UploadStatus;
  error?: string;
  uploadedChunks: number[];
  sessionId?: string;
  urlsExpiresAt?: string;
}

type UploadedPart = {
  PartNumber: number;
  ETag: string;
};

type UploadedParts = UploadedPart[];

interface MultipartUploadSession {
  type: "multipart";
  uploadId: string;
  multipartUploadId: string;
  partUrls: string[];
  totalChunks: number;
  uploadedParts: UploadedParts | null;
  urlsExpiresAt?: string;
}

interface SingleUploadSession {
  type: "single";
  uploadId: string;
  uploadUrl: string;
  totalChunks: 1;
}

type UploadSession = MultipartUploadSession | SingleUploadSession;

type SingleUploadResponse = {
  type: "single";
  uploadId: string;
  uploadUrl: string;
  expiresAt: string;
};

type MultipartUploadResponse = {
  type: "multipart";
  uploadId: string;
  multipartUploadId: string;
  numParts: number;
  partUrls: string[];
  partSize: number;
  expiresAt: string;
};

type UploadAPIResponse = SingleUploadResponse | MultipartUploadResponse;
