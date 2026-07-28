import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

export async function hashBoundedHandle(handle: FileHandle, maximumBytes: number): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: maximumBytes })) hash.update(chunk);
  return hash.digest("hex");
}

export interface BoundedFile {
  bytes: Buffer;
  info: Stats;
}

export async function readBoundedHandle(handle: FileHandle, maximumBytes: number, errorMessage: string): Promise<BoundedFile> {
  const before = await handle.stat();
  if (!before.isFile() || before.size > maximumBytes) throw new Error(errorMessage);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of handle.createReadStream({ autoClose: false, start: 0 })) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > maximumBytes) throw new Error(errorMessage);
    chunks.push(chunk);
  }
  const after = await handle.stat();
  if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || total !== after.size) {
    throw new Error(errorMessage);
  }
  return { bytes: Buffer.concat(chunks, total), info: after };
}

export async function readBoundedRegular(path: string, maximumBytes: number, errorMessage: string): Promise<BoundedFile> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await readBoundedHandle(handle, maximumBytes, errorMessage);
  } finally {
    await handle.close();
  }
}
