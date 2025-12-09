import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ChecksumAlgorithm,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "stream";
import {
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  S3_ENDPOINT,
  S3_BUCKET_NAME,
  isS3Configured,
  CDN_URL,
} from "./constants";

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
  endpoint: S3_ENDPOINT,
  forcePathStyle: !!S3_ENDPOINT,
});

export const storage = {
  s3Client: s3,
  bucketName: S3_BUCKET_NAME,
  bucketIsConfigured: isS3Configured(),

  async getUploadUrl(
    key: string,
    contentType: string,
    checksumSHA256: string | undefined,
    expiresIn = 3600
  ) {
    const params: {
      Bucket: string;
      Key: string;
      ContentType: string;
      ChecksumSHA256?: string;
      ChecksumAlgorithm?: ChecksumAlgorithm;
    } = {
      Bucket: S3_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    };

    if (checksumSHA256) {
      params.ChecksumSHA256 = checksumSHA256;
      params.ChecksumAlgorithm = "SHA256";
    }

    const command = new PutObjectCommand(params);
    return getSignedUrl(s3, command, { expiresIn });
  },

  async getDownloadUrl(key: string, expiresIn = 3600) {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
    });
    return getSignedUrl(s3, command, { expiresIn });
  },

  getPublicUrl(key: string) {
    if (CDN_URL) {
      return `${CDN_URL}/${key}`;
    }
    if (process.env.S3_ENDPOINT) {
      return `${process.env.S3_ENDPOINT}/${S3_BUCKET_NAME}/${key}`;
    }
    return `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${key}`;
  },

  async fileExists(key: string): Promise<boolean> {
    try {
      await s3.send(
        new HeadObjectCommand({
          Bucket: S3_BUCKET_NAME,
          Key: key,
        })
      );
      return true;
    } catch {
      return false;
    }
  },

  async deleteFile(key: string) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key,
      })
    );
  },

  async uploadStream(key: string, stream: Readable, contentType: string) {
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: S3_BUCKET_NAME,
        Key: key,
        Body: stream,
        ContentType: contentType,
      },
      queueSize: 4,
      partSize: 50 * 1024 * 1024,
      leavePartsOnError: false,
    });

    upload.on("httpUploadProgress", (progress) => {
      console.log(`Upload progress for ${key}:`, progress);
    });

    await upload.done();
  },

  async uploadBuffer(key: string, buffer: Buffer, contentType: string) {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );
  },

  async getFileAsJson(key: string) {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
    });
    const response = await s3.send(command);
    const str = await response.Body?.transformToString();
    return JSON.parse(str || "{}");
  },

  async createMultipartUpload(
    key: string,
    contentType: string,
    checksumAlgorithm?: ChecksumAlgorithm
  ) {
    const params: {
      Bucket: string;
      Key: string;
      ContentType: string;
      ChecksumAlgorithm?: ChecksumAlgorithm;
    } = {
      Bucket: S3_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    };

    if (checksumAlgorithm) {
      params.ChecksumAlgorithm = checksumAlgorithm;
    }

    const command = new CreateMultipartUploadCommand(params);
    return s3.send(command);
  },

  async abortMultipartUpload(key: string, uploadId: string) {
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key,
        UploadId: uploadId,
      })
    );
  },
};

export type StorageService = typeof storage;
