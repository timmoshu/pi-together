import { isAbsolute, relative, resolve, sep } from "node:path";

export function resolvePrivilegedPath(root: string, logical: string, boundary: string): string {
  if (!isAbsolute(logical) || logical.includes("\0")) throw new Error(`${boundary} path must be absolute`);
  if (logical.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${boundary} path escapes root`);
  }
  const canonicalRoot = resolve(root);
  const physical = resolve(canonicalRoot, `.${logical}`);
  const displacement = relative(canonicalRoot, physical);
  if (displacement === ".." || displacement.startsWith(`..${sep}`) || isAbsolute(displacement)) {
    throw new Error(`${boundary} path escapes root`);
  }
  return physical;
}
