import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { config } from "../config";

const base = {
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  // Newer SDKs add checksum headers that R2 / third-party S3 servers reject.
  requestChecksumCalculation: "WHEN_REQUIRED" as const,
  responseChecksumValidation: "WHEN_REQUIRED" as const,
};

// Server-side calls (create/complete/head/get) use the internal endpoint.
export const s3 = new S3Client({ ...base, endpoint: config.s3.endpoint });
// Presigned URLs are handed to browsers, so they embed the public endpoint.
const signer = new S3Client({ ...base, endpoint: config.s3.publicEndpoint });
const Bucket = config.s3.bucket;

export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket }));
  }
}

/** Browsers PUT parts directly to the bucket, so it needs CORS and must expose ETag. */
export async function ensureCors(origins: string[] = ["*"]) {
  await s3.send(
    new PutBucketCorsCommand({
      Bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedMethods: ["PUT", "GET", "HEAD"],
            AllowedOrigins: origins,
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
}

export async function createMultipart(key: string, contentType: string) {
  const r = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType }));
  return r.UploadId!;
}

export const presignPart = (key: string, uploadId: string, partNumber: number, expiresIn: number) =>
  getSignedUrl(signer, new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), {
    expiresIn,
  });

export const presignGet = (key: string, expiresIn = 300) =>
  getSignedUrl(signer, new GetObjectCommand({ Bucket, Key: key }), { expiresIn });

export async function completeMultipart(
  key: string,
  uploadId: string,
  parts: { n: number; etag: string }[],
) {
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: [...parts].sort((a, b) => a.n - b.n).map((p) => ({ PartNumber: p.n, ETag: p.etag })),
      },
    }),
  );
}

export const abortMultipart = (key: string, uploadId: string) =>
  s3.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId })).catch(() => undefined);

export async function headObject(key: string) {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    return { size: r.ContentLength ?? 0, contentType: r.ContentType };
  } catch {
    return null;
  }
}

export async function getObjectStream(key: string, range?: string): Promise<Readable> {
  const r = await s3.send(new GetObjectCommand({ Bucket, Key: key, Range: range }));
  return r.Body as Readable;
}

export const putObject = (key: string, body: Buffer, contentType: string) =>
  s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
