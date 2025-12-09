import { Queue } from "bullmq";
import { redisPrimary } from "./redis";

export const VIDEO_PROCESSING_QUEUE = "video-processing";

export const videoQueue = new Queue(VIDEO_PROCESSING_QUEUE, {
  connection: redisPrimary,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: {
      count: 100,
      age: 24 * 3600,
    },
    removeOnFail: {
      count: 1000,
      age: 7 * 24 * 3600,
    },
  },
});

export interface VideoJobData {
  videoId: string;
  sourceUrl: string;
  priority?: "high" | "normal" | "low";
}

export async function addVideoJob(data: VideoJobData) {
  return videoQueue.add("transcode", data, {
    priority: data.priority === "high" ? 1 : data.priority === "low" ? 10 : 5,
    jobId: data.videoId,
  });
}

process.on("SIGTERM", async () => {
  await videoQueue.close();
});
