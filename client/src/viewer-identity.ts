import { createViewerId } from "./browser-random";

// A viewer ID coordinates one active browser page with the server-side lease. sessionStorage gives
// reload continuity but is cloned into window.open/duplicated tabs, so an active Web Lock arbitrates
// cloned IDs before any API call. The value is never a user- or device-facing identity.
const STORAGE_KEY = "pi-together:viewer";
const LOCK_PREFIX = "pi-together:active-viewer:";

type LockResult = "held" | "contended" | "unavailable";

function freshId(): string {
  return createViewerId(crypto);
}

async function privateLockName(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${LOCK_PREFIX}${hex}`;
}

async function holdActiveLock(id: string): Promise<LockResult> {
  if (!navigator.locks) return "unavailable";
  let name: string;
  try {
    name = await privateLockName(id);
  } catch {
    return "unavailable";
  }
  return new Promise<LockResult>((resolve) => {
    void navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        resolve("contended");
        return;
      }
      resolve("held");
      // The browser releases this lock when the page goes away. It deliberately remains pending for
      // the page lifetime so a cloned tab must rotate before it can use the same controller tuple.
      await new Promise<void>(() => undefined);
    }).catch(() => resolve("unavailable"));
  });
}

async function initializeViewerId(): Promise<string> {
  let candidate = sessionStorage.getItem(STORAGE_KEY) || freshId();
  for (;;) {
    const result = await holdActiveLock(candidate);
    if (result === "held") break;
    // Safe fallback for an unsupported/denied Web Locks implementation: page uniqueness wins over
    // reload continuity. A contended cloned ID also rotates before another lock attempt.
    candidate = freshId();
    if (result === "unavailable") break;
  }
  sessionStorage.setItem(STORAGE_KEY, candidate);
  return candidate;
}

const activeViewerId = initializeViewerId();
export const getViewerId = (): Promise<string> => activeViewerId;
