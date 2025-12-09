"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { SmartVideo } from "@/components/smart-video";
import { VideoManifest } from "@/app/lib/mse-controller";
import { useQuery } from "@tanstack/react-query";
import { useSocket, VideoStatus } from "@/app/contexts/socket-context";
import { API_URL } from "@/app/lib/constants";
import { LoaderIcon } from "@/icons/loader";
import { useRouter } from "next/navigation";

interface VideoData {
  id: string;
  title: string;
  status: VideoStatus;
  manifestUrl?: string;
  duration?: number;
  width?: number;
  height?: number;
  manifest?: VideoManifest;
}

async function fetchVideo(id: string): Promise<VideoData> {
  const res = await fetch(`${API_URL}/api/v1/videos/${id}`);
  if (!res.ok) throw new Error("Failed to fetch video");
  return res.json();
}

export default function VideoPage() {
  const { id } = useParams();
  const { push } = useRouter();
  const videoId = Array.isArray(id) ? id[0] : id;
  const { subscribeToVideo, unsubscribeFromVideo, onVideoStatus } = useSocket();

  const [currentStatus, setCurrentStatus] = useState<VideoStatus | null>(null);

  const {
    data: video,
    isPending,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["video", videoId],
    queryFn: () => fetchVideo(videoId!),
    enabled: !!videoId,
    retry: (failureCount, error) => {
      if (error instanceof Error && error.message.includes("404")) {
        return false;
      }
      return failureCount < 2;
    },
  });

  const manifest = video?.manifest;

  const displayStatus = currentStatus || video?.status;

  useEffect(() => {
    if (!videoId) return;

    subscribeToVideo(videoId);

    const cleanup = onVideoStatus((event) => {
      if (event.videoId === videoId) {
        console.log("[Video Page] Status update:", event);

        setCurrentStatus(event.status);

        if (event.status === "ready") {
          refetch();
        }
      }
    });

    return () => {
      unsubscribeFromVideo(videoId);
      cleanup();
    };
  }, [videoId, subscribeToVideo, unsubscribeFromVideo, onVideoStatus, refetch]);

  if (isPending) {
    return (
      <div className="min-h-screen bg-black text-white p-6 flex flex-col items-center justify-center">
        <LoaderIcon size={24} />
        <p className="text-lg">Loading video...</p>
      </div>
    );
  }

  if (isError) {
    const is404 =
      error?.message?.includes("404") || error?.message?.includes("not found");

    return (
      <div className="min-h-screen bg-black text-white p-6 flex flex-col items-center justify-center">
        <div className="text-center space-y-4 max-w-md">
          <svg
            className="w-16 h-16 text-red-500 mx-auto"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d={
                is404
                  ? "M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  : "M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              }
            />
          </svg>
          <h2 className="text-xl font-semibold text-red-500">
            {is404 ? "Video not found" : "Something went wrong"}
          </h2>
          <p className="text-zinc-400">
            {is404
              ? "This video may have been deleted or does not exist."
              : "We couldn't load this video. Please try again."}
          </p>
          <div className="flex gap-3 justify-center">
            {!is404 && (
              <button
                onClick={() => refetch()}
                className="px-4 py-2 bg-primary hover:bg-primary/90 rounded transition-colors"
              >
                Try Again
              </button>
            )}
            <button
              onClick={() => push("/")}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
            >
              Go Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white p-6 flex flex-col items-center">
      <div className="w-full max-w-5xl space-y-4">
        <h1 className="text-2xl font-bold">{video.title}</h1>

        {video.status === "ready" && manifest ? (
          <SmartVideo
            baseUrl={`${API_URL}/files/${videoId}`}
            manifest={manifest}
          />
        ) : (
          <div className="aspect-video bg-zinc-900 flex flex-col items-center justify-center rounded border border-zinc-800">
            {displayStatus === "processing" && (
              <>
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mb-4"></div>
                <p className="text-lg">Processing video...</p>
                <p className="text-sm text-zinc-500 mt-2">
                  Generating multiple quality variants (360p, 720p, 1080p)
                </p>
              </>
            )}
            {displayStatus === "pending_upload" && <p>Upload pending...</p>}
            {displayStatus === "uploading" && (
              <>
                <div className="animate-pulse">
                  <svg
                    className="w-12 h-12 text-blue-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                    />
                  </svg>
                </div>
                <p className="text-lg mt-4">Uploading...</p>
              </>
            )}
            {displayStatus === "failed" && (
              <>
                <p className="text-red-500 text-lg">Processing failed</p>
                <p className="text-sm text-zinc-500 mt-2">
                  Please try uploading again
                </p>
              </>
            )}
          </div>
        )}

        <div className="p-4 bg-zinc-900 rounded">
          <h2 className="font-semibold text-lg">Details</h2>
          <div className="mt-2 space-y-1 text-sm">
            <p>
              <span className="text-zinc-500">Status:</span>{" "}
              <span className="capitalize">
                {displayStatus && displayStatus.replace("_", " ")}
              </span>
            </p>
            {video.duration && (
              <p>
                <span className="text-zinc-500">Duration:</span>{" "}
                {Math.floor(video.duration / 60)}:
                {String(Math.floor(video.duration % 60)).padStart(2, "0")}
              </p>
            )}
            {video.width && video.height && (
              <p>
                <span className="text-zinc-500">Resolution:</span> {video.width}
                x{video.height}
              </p>
            )}
            {manifest && (
              <p>
                <span className="text-zinc-500">Available Qualities:</span>{" "}
                {manifest.qualities.map((q) => q.quality).join(", ")}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
