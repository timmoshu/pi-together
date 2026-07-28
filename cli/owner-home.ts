import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

/** Resolve the invoking non-root user's home from trusted local account facts, never cwd/request input. */
export async function canonicalOwnerHome(uid = process.getuid?.()): Promise<string> {
  if (uid === undefined || uid === 0) throw new Error("owner home requires a non-root invoking UID");
  const passwd = await readFile("/etc/passwd", "utf8");
  const records = passwd.split("\n").filter(Boolean).map((line) => line.split(":"));
  const record = records.find((fields) => Number(fields[2]) === uid);
  const home = record?.[5];
  if (!home || !isAbsolute(home) || home === "/" || normalize(home) !== home) throw new Error("invoking user's canonical home is unavailable");
  const canonical = await realpath(home);
  if (canonical !== home) throw new Error("invoking user's home must be canonical and must not resolve through a symbolic link");
  return canonical;
}
