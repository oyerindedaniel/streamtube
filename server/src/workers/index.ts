import { Worker, Job } from "bullmq";
import { VIDEO_PROCESSING_QUEUE } from "../lib/queue";
import { redisPrimary } from "../lib/redis";
import { videos, segments } from "../db/schema";
import { db } from "../db";
import { eq } from "drizzle-orm";
import { spawn } from "child_process";
import { promisify } from "util";
import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { storage } from "../lib/storage";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { S3Keys } from "../lib/s3-keys";
import { VIDEO_QUALITIES } from "../lib/constants";
// import ffmpegPath from "ffmpeg-static";
// import ffprobePath from "ffprobe-static";
import { validateS3PartChecksums } from "../lib/checksum";

const execPromise = promisify(exec);

const TMP_DIR = path.join(process.cwd(), "tmp");
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// if (!ffmpegPath) {
//   throw new Error("ffmpeg-static path not found");
// }
// if (!ffprobePath?.path) {
//   throw new Error("ffprobe-static path not found");
// }

// const FFMPEG_PATH = ffmpegPath;
// const FFPROBE_PATH = ffprobePath.path;

const FFMPEG_PATH = "ffmpeg";
const FFPROBE_PATH = "ffprobe";

console.log("[Worker] Using FFmpeg:", FFMPEG_PATH);
console.log("[Worker] Using FFprobe:", FFPROBE_PATH);

interface ProbeData {
  streams: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    [key: string]: any;
  }>;
  format: {
    duration?: string;
    [key: string]: any;
  };
}

async function probeVideo(filePath: string): Promise<ProbeData> {
  try {
    const { stdout } = await execPromise(
      `"${FFPROBE_PATH}" -v quiet -print_format json -show_format -show_streams "${filePath}"`
    );
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `FFprobe failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

async function transcodeVideo(
  inputPath: string,
  outputPath: string,
  options: string[],
  onProgress?: (progress: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-i", inputPath, ...options, outputPath];
    const ffmpegProcess = spawn(FFMPEG_PATH, args);

    let stderr = "";

    ffmpegProcess.stderr.on("data", (data) => {
      const output = data.toString();
      stderr += output;
      if (onProgress) {
        onProgress(output);
      }
    });

    ffmpegProcess.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}\nError: ${stderr}`));
      }
    });

    ffmpegProcess.on("error", (error) => {
      reject(new Error(`FFmpeg process error: ${error.message}`));
    });
  });
}

async function generateThumbnails(
  inputPath: string,
  outputPattern: string,
  interval: number = 4
): Promise<void> {
  return transcodeVideo(inputPath, outputPattern, [
    "-vf",
    `fps=1/${interval},scale=320:-1`,
    "-q:v",
    "2",
  ]);
}

function cleanupTempFiles(paths: string[]): void {
  paths.forEach((p) => {
    try {
      if (fs.existsSync(p)) {
        if (fs.lstatSync(p).isDirectory()) {
          fs.rmSync(p, { recursive: true, force: true });
        } else {
          fs.unlinkSync(p);
        }
      }
    } catch (error) {
      console.error(`[Cleanup] Failed to remove ${p}:`, error);
    }
  });
}

async function handleValidationJob(job: Job) {
  console.log(
    `[Validation Worker] Starting validation for video ${job.data.videoId}`
  );

  const { videoId, sourceUrl, partChecksums, chunkSize } = job.data;

  try {
    const s3Key = S3Keys.parseS3Url(sourceUrl, storage.bucketName);

    console.log(
      `[Validation Worker] Validating ${partChecksums.length} parts for ${videoId}`
    );

    const validation = await validateS3PartChecksums(
      storage.bucketName,
      s3Key,
      partChecksums,
      chunkSize
    );

    if (!validation.valid) {
      console.error(
        `[Validation Worker] Validation FAILED for ${videoId}:`,
        validation.failures
      );

      await db
        .update(videos)
        .set({
          status: "failed",
          lastError: `Checksum validation failed for parts: ${validation.failures
            .map((f) => f.partNumber)
            .join(", ")}`,
          updatedAt: new Date(),
        })
        .where(eq(videos.id, videoId));

      throw new Error(
        `Checksum validation failed: ${validation.failures.length} part(s) corrupted`
      );
    }

    await db
      .update(videos)
      .set({
        checksumValidatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(videos.id, videoId));

    console.log(
      `[Validation Worker] ✓ All ${partChecksums.length} parts validated successfully for ${videoId}`
    );
  } catch (error) {
    console.error(`[Validation Worker] Error validating ${videoId}:`, error);

    await db
      .update(videos)
      .set({
        status: "failed",
        lastError: error instanceof Error ? error.message : "Validation error",
        updatedAt: new Date(),
      })
      .where(eq(videos.id, videoId));

    throw error;
  }
}

async function handleTranscodeJob(job: Job) {
  console.log(
    `[Worker] Processing video job ${job.id} for videoId: ${job.data.videoId}`
  );
  const { videoId, sourceUrl } = job.data;

  const videoCheck = await db
    .select()
    .from(videos)
    .where(eq(videos.id, videoId))
    .limit(1);

  if (!videoCheck || videoCheck.length === 0 || videoCheck[0].deletedAt) {
    console.log(`[Worker] Video ${videoId} was deleted, skipping processing`);
    return;
  }

  const sourcePath = path.join(TMP_DIR, `${videoId}_source.mp4`);
  const outputDir = path.join(TMP_DIR, videoId);
  const tempPaths = [sourcePath, outputDir];

  try {
    await db
      .update(videos)
      .set({ status: "processing" })
      .where(eq(videos.id, videoId));

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    if (!fs.existsSync(sourcePath)) {
      console.log(`[Worker] Downloading from S3: ${sourceUrl}`);
      const s3Key = S3Keys.parseS3Url(sourceUrl, storage.bucketName);

      const command = new GetObjectCommand({
        Bucket: storage.bucketName,
        Key: s3Key,
      });

      const response = await storage.s3Client.send(command);
      const writeStream = fs.createWriteStream(sourcePath);

      await new Promise<void>((resolve, reject) => {
        if (response.Body) {
          const body = response.Body as NodeJS.ReadableStream;
          body.pipe(writeStream);
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
        } else {
          reject(new Error("No body in S3 response"));
        }
      });

      console.log("[Worker] Download complete");
    }

    console.log("[Worker] Probing video metadata...");
    const probeData = await probeVideo(sourcePath);

    const videoStream = probeData.streams.find((s) => s.codec_type === "video");
    const duration = parseFloat(probeData.format.duration || "0");
    const sourceWidth = videoStream?.width || 1920;
    const sourceHeight = videoStream?.height || 1080;

    console.log(
      `[Worker] Source: ${sourceWidth}x${sourceHeight}, duration: ${duration}s`
    );

    // No upscaling
    const applicableQualities = VIDEO_QUALITIES.filter(
      (quality) => quality.height <= sourceHeight
    );
    if (applicableQualities.length === 0) {
      applicableQualities.push(VIDEO_QUALITIES[0]);
    }

    const qualityManifests: Record<string, unknown>[] = [];

    for (const quality of applicableQualities) {
      console.log(`[Worker] Transcoding ${quality.name}...`);
      const qualityDir = path.join(outputDir, quality.name);
      if (!fs.existsSync(qualityDir)) {
        fs.mkdirSync(qualityDir, { recursive: true });
      }

      //TODO: fix duplicate transcode currently having a rename issue

      const initPath = path.join(qualityDir, "init.mp4");
      await transcodeVideo(sourcePath, initPath, [
        "-y",
        "-t",
        "0.1",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-vf",
        `scale=-2:${quality.height}`,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-b:v",
        quality.bitrate,
        "-c:a",
        "aac",
        "-b:a",
        quality.audioBitrate,
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
      ]);

      await transcodeVideo(
        sourcePath,
        path.join(qualityDir, "seg_%d.m4s"),
        [
          "-y",
          "-map",
          "0:v:0",
          "-map",
          "0:a:0",
          "-vf",
          `scale=-2:${quality.height}`,
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "23",
          "-b:v",
          quality.bitrate,
          "-c:a",
          "aac",
          "-b:a",
          quality.audioBitrate,
          "-g",
          "48",
          "-keyint_min",
          "48",
          "-sc_threshold",
          "0",
          "-f",
          "segment",
          "-segment_time",
          "4",
          "-segment_format",
          "mp4",
          "-movflags",
          "+frag_keyframe+empty_moov+default_base_moof",
          "-reset_timestamps",
          "1",
          "-segment_start_number",
          "1",
        ],
        (progress) => {
          if (progress.includes("time=")) {
            console.log(`[Worker] ${quality.name} progress:`, progress.trim());
          }
        }
      );

      const files = fs.readdirSync(qualityDir);
      const segmentFiles = files
        .filter((f) => f.startsWith("seg_") && f.endsWith(".m4s"))
        .sort((a, b) => {
          const numA = parseInt(a.match(/seg_(\d+)/)?.[1] || "0");
          const numB = parseInt(b.match(/seg_(\d+)/)?.[1] || "0");
          return numA - numB;
        });

      qualityManifests.push({
        quality: quality.name,
        height: quality.height,
        bitrate: quality.bitrate,
        codec: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
        initSegmentUrl: `${quality.name}/init.mp4`,
        segments: segmentFiles.map((f, i) => ({
          url: `${quality.name}/${f}`,
          start: i * 4,
          duration: 4,
          index: i,
        })),
      });

      console.log(
        `[Worker] ${quality.name} done: ${segmentFiles.length} segments`
      );
    }

    console.log("[Worker] Generating thumbnails...");
    const thumbDir = path.join(outputDir, "thumbnails");
    if (!fs.existsSync(thumbDir)) {
      fs.mkdirSync(thumbDir, { recursive: true });
    }

    await generateThumbnails(
      sourcePath,
      path.join(thumbDir, "thumb_%03d.jpg"),
      4
    );

    const manifest = {
      videoId,
      duration,
      width: sourceWidth,
      height: sourceHeight,
      qualities: qualityManifests,
      thumbnails: {
        pattern: "thumbnails/thumb_%03d.jpg",
        interval: 4,
      },
    };

    fs.writeFileSync(
      path.join(outputDir, "manifest.json"),
      JSON.stringify(manifest, null, 2)
    );

    console.log("[Worker] Uploading to S3...");
    const allFiles: string[] = ["manifest.json"];

    for (const quality of applicableQualities) {
      const qualityDir = path.join(outputDir, quality.name);
      const qualityFiles = fs.readdirSync(qualityDir);
      allFiles.push(...qualityFiles.map((f) => `${quality.name}/${f}`));
    }

    const thumbFiles = fs.readdirSync(path.join(outputDir, "thumbnails"));
    allFiles.push(...thumbFiles.map((f) => `thumbnails/${f}`));

    for (const file of allFiles) {
      const filePath = path.join(outputDir, file);
      if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath);
        let s3Key: string;

        if (file === "manifest.json") {
          s3Key = S3Keys.manifest(videoId);
        } else if (file.startsWith("thumbnails/")) {
          const thumbMatch = file.match(/thumb_(\d+)\.jpg/);
          if (thumbMatch) {
            s3Key = S3Keys.thumbnail(videoId, parseInt(thumbMatch[1]));
          } else {
            s3Key = `processed/${videoId}/${file}`;
          }
        } else if (file.includes("/init.mp4")) {
          const quality = file.split("/")[0];
          s3Key = S3Keys.initSegment(videoId, quality);
        } else if (file.includes("/seg_")) {
          const [quality, segFile] = file.split("/");
          const segMatch = segFile.match(/seg_(\d+)\.m4s/);
          if (segMatch) {
            s3Key = S3Keys.mediaSegment(
              videoId,
              quality,
              parseInt(segMatch[1])
            );
          } else {
            s3Key = `processed/${videoId}/${file}`;
          }
        } else {
          s3Key = `processed/${videoId}/${file}`;
        }

        const contentType = file.endsWith(".json")
          ? "application/json"
          : file.endsWith(".jpg")
          ? "image/jpeg"
          : "video/mp4";

        await storage.uploadBuffer(s3Key, fileContent, contentType);
      }
    }

    const allSegments: Array<{
      videoId: string;
      idx: number;
      url: string;
      start: number;
      duration: number;
    }> = [];

    qualityManifests.forEach((qm) => {
      const segments = qm.segments as Array<{
        url: string;
        start: number;
        duration: number;
        index: number;
      }>;
      segments.forEach((seg) => {
        allSegments.push({
          videoId,
          idx: seg.index,
          url: seg.url,
          start: seg.start,
          duration: seg.duration,
        });
      });
    });

    if (allSegments.length > 0) {
      await db.insert(segments).values(allSegments);
    }

    await db
      .update(videos)
      .set({
        status: "ready",
        manifestUrl: S3Keys.manifest(videoId),
        width: sourceWidth,
        height: sourceHeight,
        duration: duration,
        thumbnails: {
          pattern: `processed/${videoId}/thumbnails/thumb_%03d.jpg`,
          interval: 4,
        },
      })
      .where(eq(videos.id, videoId));

    console.log("[Worker] Job finished successfully");

    cleanupTempFiles(tempPaths);
  } catch (err) {
    console.error("[Worker] Job failed:", err);

    await db
      .update(videos)
      .set({
        status: "failed",
        lastError: err instanceof Error ? err.message : "Unknown error",
      })
      .where(eq(videos.id, videoId));

    cleanupTempFiles(tempPaths);

    throw err;
  }
}

export const worker = new Worker(
  VIDEO_PROCESSING_QUEUE,
  async (job: Job) => {
    if (job.name === "validate-checksums") {
      return handleValidationJob(job);
    } else if (job.name === "transcode") {
      return handleTranscodeJob(job);
    } else {
      throw new Error(`Unknown job type: ${job.name}`);
    }
  },
  {
    connection: redisPrimary,
    concurrency: 2,
  }
);
