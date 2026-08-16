import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Streaming sha256 of a file's contents — never loads the whole file into
 * memory. Returns the hash prefixed with the algorithm ("sha256:<hex>") so
 * manifests stay self-describing.
 */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}
