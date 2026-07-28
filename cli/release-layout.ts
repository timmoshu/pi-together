import { isAbsolute, join } from "node:path";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Pure layout selection: callers stage immutable content here before any later activation step. */
export function versionedReleasePath(prefix: string, version: string): string {
  if (!isAbsolute(prefix)) throw new Error("installation prefix must be absolute");
  if (!VERSION.test(version)) throw new Error("release version is invalid");
  return join(prefix, "releases", version);
}
