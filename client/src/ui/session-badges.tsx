import type { ChatSummary } from "../../../shared/protocol";

/** read-only vs full tool access for a live session. */
export function ToolPill({ c }: { c: ChatSummary }) {
  if (!c.live) return null; // no runtime attached here
  return c.toolMode === "full" ? (
    <span className="pill pill-full" title="live · full tools">full</span>
  ) : (
    <span className="pill pill-read" title="live · read-only tools">read</span>
  );
}

/** provenance: web (created here) vs external (terminal / tmux / kandev). */
export function OriginChip({ origin, compact }: { origin: "web" | "external"; compact?: boolean }) {
  if (origin === "web")
    return <span className="pill pill-web" title="created in Pi Together — safe to drive">web</span>;
  if (compact) return null; // keep the sidebar quiet; external is the default
  return (
    <span className="pill pill-ext" title="external session (terminal / tmux / kandev) — take over to drive it here">
      external
    </span>
  );
}
