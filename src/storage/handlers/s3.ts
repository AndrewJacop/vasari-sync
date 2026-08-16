import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RemoteFile, StorageBackend } from "../types.js";

/**
 * S3-compatible backend. Works against AWS S3 and any S3-compatible store
 * (MinIO, Cloudflare R2, Backblaze B2, DO Spaces) via an overridable
 * `endpoint` + `forcePathStyle`.
 */
export interface S3Config {
  /** Custom endpoint for S3-compatible stores (e.g. http://localhost:9000 for MinIO). */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing (required by MinIO/R2 and friends); AWS defaults to virtual-host style. */
  forcePathStyle?: boolean;
}

const REQUIRED: (keyof S3Config)[] = ["region", "bucket", "accessKeyId", "secretAccessKey"];

function notFound(remoteKey: string): Error {
  return new Error(`Remote file not found: ${remoteKey}`);
}

/** S3 SDK error with a `name` code ("NoSuchKey", "AccessDenied", ...) */
function errName(err: unknown): string | undefined {
  return (err as { name?: string })?.name;
}

export class S3Handler implements StorageBackend {
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    const missing = REQUIRED.filter((key) => !this.config[key]);
    if (missing.length > 0) {
      throw new Error(`s3 backend missing required settings: ${missing.join(", ")}`);
    }
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async push(localPath: string, remoteKey: string): Promise<void> {
    // S3 has no directories — the key is the whole path. Stream so huge
    // files never sit in memory.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: remoteKey,
        Body: createReadStream(localPath),
      }),
    );
  }

  async pull(remoteKey: string, localPath: string): Promise<void> {
    let output;
    try {
      output = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: remoteKey }),
      );
    } catch (err) {
      if (errName(err) === "NoSuchKey") throw notFound(remoteKey);
      throw err;
    }
    if (!output.Body) throw notFound(remoteKey);
    // On Node, smithy's streaming blob is always a Node Readable (the
    // union's Blob/ReadableStream members are browser-runtime-only).
    await mkdir(dirname(localPath), { recursive: true });
    await pipeline(output.Body as unknown as Readable, createWriteStream(localPath));
  }

  async list(prefix?: string): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    let token: string | undefined;
    do {
      const output = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of output.Contents ?? []) {
        if (obj.Key === undefined) continue;
        files.push({
          path: obj.Key,
          size: obj.Size ?? 0,
          // S3 returns ETags double-quoted ("\"abc\"") — store them bare.
          etagOrHash: obj.ETag?.replaceAll('"', ""),
          modifiedAt: obj.LastModified?.toISOString(),
        });
      }
      token = output.IsTruncated ? output.NextContinuationToken : undefined;
    } while (token);
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async delete(remoteKey: string): Promise<void> {
    // S3 DeleteObject is idempotent: deleting a missing key succeeds with
    // no error (unlike local-fs, which throws). Native semantics kept.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: remoteKey }));
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
      const where = this.config.endpoint ?? "AWS S3";
      return { ok: true, message: `bucket '${this.config.bucket}' reachable (${where})` };
    } catch (err) {
      const name = errName(err) ?? "error";
      return { ok: false, message: `cannot access bucket '${this.config.bucket}': ${name}` };
    }
  }
}
