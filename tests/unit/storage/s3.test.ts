import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectCommandOutput,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Handler } from "../../../src/storage/handlers/s3.js";
import type { S3Config } from "../../../src/storage/handlers/s3.js";
import type { StorageBackend } from "../../../src/storage/types.js";

/**
 * All S3 calls go through the mocked S3Client — no live credentials or
 * network. A separate live check against local MinIO is documented in the
 * task report.
 */

const s3Mock = mockClient(S3Client);
const CONFIG = {
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  bucket: "test-bucket",
  accessKeyId: "key",
  secretAccessKey: "secret",
  forcePathStyle: true,
};

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "vsync-s3-test-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// No response defined for a command → the mock rejects with a stub error;
// keep every test fully self-contained.
beforeEach(() => {
  s3Mock.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const KEY = "some/nested/hello.txt";
const CONTENT = "top secret contents\n"; // 20 bytes
const LOCAL = () => join(workDir, "hello.txt");

describe("s3 handler config validation", () => {
  it("throws a clear error listing every missing required setting", () => {
    expect(() => new S3Handler({} as unknown as S3Config)).toThrow(
      /s3 backend missing required settings: region, bucket, accessKeyId, secretAccessKey/,
    );
  });
});

describe("s3 handler (mocked client)", () => {
  it("testConnection succeeds on HeadBucket", async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    await expect(new S3Handler(CONFIG).testConnection()).resolves.toEqual({
      ok: true,
      message: "bucket 'test-bucket' reachable (http://localhost:9000)",
    });
  });

  it("testConnection fails gracefully (never throws) on error", async () => {
    s3Mock
      .on(HeadBucketCommand)
      .rejects(Object.assign(new Error("forbidden"), { name: "AccessDenied" }));
    await expect(new S3Handler(CONFIG).testConnection()).resolves.toEqual({
      ok: false,
      message: "cannot access bucket 'test-bucket': AccessDenied",
    });
  });

  it("push streams the file with the given remote key", async () => {
    await writeFile(LOCAL(), CONTENT, "utf8");
    s3Mock.on(PutObjectCommand).resolves({});
    await new S3Handler(CONFIG).push(LOCAL(), KEY);
    const call = s3Mock.commandCalls(PutObjectCommand)[0];
    // mock v4: args is a tuple holding the command itself.
    expect(call.args[0].input).toMatchObject({ Bucket: "test-bucket", Key: KEY });
  });

  it("pull streams the object to disk", async () => {
    const stream = Readable.from(CONTENT);
    s3Mock.on(GetObjectCommand).resolves({
      // v4.1.0 typings want SdkStream<IncomingMessage|Readable>; a plain
      // Readable is exactly what Node sends at runtime.
      Body: stream as unknown as GetObjectCommandOutput["Body"],
    });
    const dest = join(workDir, "restored", "hello-copy.txt");
    await new S3Handler(CONFIG).pull(KEY, dest);
    await expect(readFile(dest, "utf8")).resolves.toBe(CONTENT);
  });

  it("pull throws a clear not-found error for a missing key", async () => {
    s3Mock
      .on(GetObjectCommand)
      .rejects(Object.assign(new Error("key not found"), { name: "NoSuchKey" }));
    await expect(new S3Handler(CONFIG).pull(KEY, join(workDir, "gone.txt"))).rejects.toThrow(
      `Remote file not found: ${KEY}`,
    );
  });

  it("list maps, sorts, and trims ETag quotes; paginates on truncation", async () => {
    s3Mock
      .on(ListObjectsV2Command, { Bucket: "test-bucket", Prefix: undefined })
      .resolvesOnce({
        IsTruncated: true,
        NextContinuationToken: "token-1",
        Contents: [
          {
            Key: "b.txt",
            Size: 2,
            ETag: '"etag-b"',
            LastModified: new Date("2026-01-02T03:04:05Z"),
          },
        ],
      })
      .resolvesOnce({
        IsTruncated: false,
        Contents: [
          {
            Key: "a/a.txt",
            Size: 1,
            ETag: '"etag-a"',
            LastModified: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      });
    const files = await new S3Handler(CONFIG).list();
    expect(files).toEqual([
      {
        path: "a/a.txt",
        size: 1,
        etagOrHash: "etag-a",
        modifiedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        path: "b.txt",
        size: 2,
        etagOrHash: "etag-b",
        modifiedAt: "2026-01-02T03:04:05.000Z",
      },
    ]);
    // both pages fetched
    expect(
      s3Mock.commandCalls(ListObjectsV2Command).map((c) => c.args[0].input.ContinuationToken),
    ).toEqual([undefined, "token-1"]);
  });

  it("list sends the prefix and returns what the server gives back", async () => {
    // The mock does no server-side filtering — match the Prefix input so a
    // handler that drops the prefix would not match this stub at all.
    s3Mock.on(ListObjectsV2Command, { Prefix: "prefix" }).resolves({
      Contents: [{ Key: "prefix/x" }, { Key: "other/y" }],
    });
    await expect(new S3Handler(CONFIG).list("prefix")).resolves.toEqual([
      // handler sorts by key, like every other backend
      { path: "other/y", size: 0, etagOrHash: undefined, modifiedAt: undefined },
      { path: "prefix/x", size: 0, etagOrHash: undefined, modifiedAt: undefined },
    ]);
    expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe("prefix");
  });

  it("delete sends the DeleteObject command (S3 delete is idempotent)", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    await new S3Handler(CONFIG).delete(KEY);
    const call = s3Mock.commandCalls(DeleteObjectCommand)[0];
    expect(call.args[0].input).toMatchObject({ Bucket: "test-bucket", Key: KEY });
  });

  it("push/pull/list/delete satisfy the StorageBackend contract structurally", () => {
    const backend: StorageBackend = new S3Handler(CONFIG);
    for (const method of ["push", "pull", "list", "delete", "testConnection"] as const) {
      expect(typeof backend[method]).toBe("function");
    }
  });
});
