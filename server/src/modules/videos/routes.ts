import { FastifyInstance } from "fastify";
import { db } from "../../db";
import { videos } from "../../db/schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { storage } from "../../lib/storage";
import { S3Keys } from "../../lib/s3-keys";
import { videoQueue } from "../../lib/queue";
import { MULTIPART_CHUNK_SIZE } from "../../lib/constants";

export async function videoRoutes(fastify: FastifyInstance) {
  fastify.get("/", async (request, reply) => {
    const allVideos = await db
      .select()
      .from(videos)
      .where(and(ne(videos.status, "deleted"), isNull(videos.deletedAt)))
      .orderBy(desc(videos.createdAt));

    return {
      videos: allVideos.map((video) => ({
        id: video.id,
        title: video.title,
        status: video.status,
        duration: video.duration,
        width: video.width,
        height: video.height,
        createdAt: video.createdAt,
      })),
    };
  });

  fastify.get("/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };

    const video = await db
      .select()
      .from(videos)
      .where(eq(videos.id, id))
      .limit(1);

    if (!video || video.length === 0) {
      return reply.status(404).send({ error: "Video not found" });
    }

    return {
      videoId: video[0].id,
      status: video[0].status,
      title: video[0].title,
    };
  });

  fastify.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const video = await db
      .select()
      .from(videos)
      .where(eq(videos.id, id))
      .limit(1);

    if (!video || video.length === 0) {
      return reply.status(404).send({ error: "Video not found" });
    }

    const videoData = video[0];

    try {
      const jobs = await videoQueue.getJobs(["waiting", "active", "delayed"]);
      const videoJobs = jobs.filter((job) => job.data.videoId === id);

      for (const job of videoJobs) {
        await job.remove();
        console.log(`[Delete] Cancelled job ${job.id} for video ${id}`);
      }
    } catch (error) {
      console.error(`[Delete] Failed to cancel jobs for video ${id}:`, error);
    }

    if (videoData.sourceUrl) {
      try {
        const s3Key = S3Keys.parseS3Url(
          videoData.sourceUrl,
          storage.bucketName
        );
        await storage.deleteFile(s3Key);
        console.log(`[Delete] Deleted source file: ${s3Key}`);
      } catch (error) {
        console.error(`[Delete] Failed to delete source:`, error);
      }
    }

    await db
      .update(videos)
      .set({
        status: "deleted",
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(videos.id, id));

    console.log(`[Delete] Video ${id} marked as deleted`);

    return { success: true, videoId: id };
  });

  fastify.post("/:id/retry", async (request, reply) => {
    const { id } = request.params as { id: string };

    const video = await db
      .select()
      .from(videos)
      .where(eq(videos.id, id))
      .limit(1);

    if (!video || video.length === 0) {
      return reply.status(404).send({ error: "Video not found" });
    }

    const videoData = video[0];

    if (videoData.status !== "failed") {
      return reply.status(400).send({
        error: "Can only retry failed videos",
        currentStatus: videoData.status,
      });
    }

    if ((videoData.processingAttempts || 0) >= 3) {
      return reply.status(400).send({
        error: "Maximum retry attempts reached",
        attempts: videoData.processingAttempts,
        maxAttempts: 3,
      });
    }

    if (!videoData.sourceUrl) {
      return reply.status(400).send({
        error: "Source file not found",
        message: "Cannot retry without source file",
      });
    }

    console.log(`[Retry] Retrying failed video ${id}`);

    await db
      .update(videos)
      .set({
        status: "processing",
        lastError: null,
        processingAttempts: (videoData.processingAttempts || 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(videos.id, id));

    if (
      videoData.partChecksums &&
      Array.isArray(videoData.partChecksums) &&
      !videoData.checksumValidatedAt
    ) {
      await videoQueue.add("validate-checksums", {
        videoId: videoData.id,
        sourceUrl: videoData.sourceUrl,
        partChecksums: videoData.partChecksums,
        chunkSize: MULTIPART_CHUNK_SIZE,
      });
      console.log(`[Retry] Queued checksum validation for ${id}`);
    } else if (videoData.checksumValidatedAt) {
      console.log(
        `[Retry] Skipping checksum validation for ${id} (already validated at ${videoData.checksumValidatedAt})`
      );
    }

    await videoQueue.add("transcode", {
      videoId: videoData.id,
      sourceUrl: videoData.sourceUrl,
    });

    console.log(`[Retry] Queued transcode for ${id}`);

    return {
      videoId: videoData.id,
      status: "processing",
      attempt: (videoData.processingAttempts || 0) + 1,
      checksumValidated: !!videoData.checksumValidatedAt,
    };
  });
}
