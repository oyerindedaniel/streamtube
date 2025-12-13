import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
  jsonb,
  primaryKey,
  boolean,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

export const videoStatusEnum = pgEnum("video_status", [
  "pending_upload",
  "uploading",
  "processing",
  "ready",
  "failed",
  "cancelled",
  "deleted",
]);

export const uploadSessionStatusEnum = pgEnum("upload_session_status", [
  "active",
  "completed",
  "failed",
  "expired",
]);

export const videos = pgTable(
  "videos",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: videoStatusEnum("status").notNull().default("pending_upload"),

    sourceUrl: text("source_url").notNull(),
    sourceSize: integer("source_size").notNull(),
    partChecksums: jsonb("part_checksums").$type<
      Array<{
        partNumber: number;
        checksum: string;
        size: number;
      }>
    >(),
    checksumValidatedAt: timestamp("checksum_validated_at", {
      withTimezone: true,
    }),

    manifestUrl: text("manifest_url"),
    initSegmentUrl: text("init_segment_url"),
    keyframeIndexUrl: text("keyframe_index_url"),

    thumbnails: jsonb("thumbnails").$type<{
      pattern?: string;
      interval?: number;
      sprite?: string;
    }>(),

    duration: real("duration"),
    width: integer("width"),
    height: integer("height"),
    codec: text("codec"),
    bitrate: integer("bitrate"),
    fps: integer("fps"),

    uploadSessionId: text("upload_session_id"),
    uploadedParts: jsonb("uploaded_parts").$type<number[]>(),

    processingAttempts: integer("processing_attempts").default(0),
    lastError: text("last_error"),

    isPublic: boolean("is_public").default(false),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("videos_status_idx").on(table.status),
    index("videos_created_at_idx").on(table.createdAt),
    index("videos_is_public_idx").on(table.isPublic),
    index("videos_status_created_idx").on(table.status, table.createdAt),
    index("videos_deleted_at_idx").on(table.deletedAt),
  ]
);

export const segments = pgTable(
  "segments",
  {
    videoId: text("video_id")
      .references(() => videos.id, { onDelete: "cascade" })
      .notNull(),
    idx: integer("idx").notNull(),
    url: text("url").notNull(),
    start: real("start").notNull(),
    duration: real("duration").notNull(),
    size: integer("size"),
    keyframe: boolean("keyframe").default(false),
  },
  (table) => [
    primaryKey({ columns: [table.videoId, table.idx] }),
    index("segments_video_id_idx").on(table.videoId),
  ]
);

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: text("id").primaryKey(),
    videoId: text("video_id")
      .references(() => videos.id, { onDelete: "cascade" })
      .notNull(),
    multipartUploadId: text("multipart_upload_id"),
    totalParts: integer("total_parts"),
    uploadedParts:
      jsonb("uploaded_parts").$type<
        Array<{ PartNumber: number; ETag: string }>
      >(),
    status: uploadSessionStatusEnum("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("upload_sessions_video_id_idx").on(table.videoId),
    index("upload_sessions_status_idx").on(table.status),
    index("upload_sessions_expires_at_idx").on(table.expiresAt),
  ]
);

export type Video = typeof videos.$inferSelect;
export type NewVideo = typeof videos.$inferInsert;
export type Segment = typeof segments.$inferSelect;
export type NewSegment = typeof segments.$inferInsert;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type NewUploadSession = typeof uploadSessions.$inferInsert;

export type VideoStatus = (typeof videoStatusEnum.enumValues)[number];
export type UploadSessionStatus =
  (typeof uploadSessionStatusEnum.enumValues)[number];
