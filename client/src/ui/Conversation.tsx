import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../Markdown";
import type { PrincipalIdentity } from "../../../shared/protocol";
import type { SelectedState, TimelineItem, ToolCard } from "../store";
import { BrainIcon, Chevron, ToolIcon } from "./icons";
import { authorPresentation, formatTime, isBusy } from "./presentation";

type TraceItem = Extract<TimelineItem, { kind: "thinking" }> | Extract<TimelineItem, { kind: "tool" }>;
type ConversationRow = TimelineItem | { kind: "trace-group"; id: string; items: TraceItem[]; active: boolean };

/** Collapse each uninterrupted run of thinking/tool activity into one stable presentation group. */
function groupTraceItems(items: TimelineItem[], busy: boolean): ConversationRow[] {
  const rows: ConversationRow[] = [];
  let traces: TraceItem[] = [];
  const flush = () => {
    if (!traces.length) return;
    rows.push({ kind: "trace-group", id: `trace-group-${traces[0]!.id}`, items: traces, active: false });
    traces = [];
  };

  for (const item of items) {
    if (item.kind === "thinking" || item.kind === "tool") traces.push(item);
    else {
      flush();
      rows.push(item);
    }
  }
  flush();

  if (busy) {
    const groupIndex = rows.findLastIndex((row) => row.kind === "trace-group");
    if (groupIndex >= 0 && !rows.slice(groupIndex + 1).some((row) => row.kind === "turn")) {
      const group = rows[groupIndex]!;
      if (group.kind === "trace-group") group.active = true;
    }
  }
  return rows;
}

export function Conversation({ sel, principal }: { sel: SelectedState; principal: PrincipalIdentity }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const items = sel.timeline;
  const rows = useMemo(() => groupTraceItems(items, isBusy(sel)), [items, sel.runState]);
  const live = sel.live;

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 96);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !stick) return;
    el.scrollTop = el.scrollHeight;
  }, [items, live.assistant, live.thinking, live.active, stick]);

  const empty = items.length === 0 && !live.active;

  return (
    <div className="convo-wrap">
      <div className="convo" ref={scroller} onScroll={onScroll}>
        {empty && (
          <div className="convo-empty">
            <p>No messages yet.</p>
            <p className="hint">Send one below to start the run.</p>
          </div>
        )}
        <ol className="turns">
          {rows.map((row) =>
            row.kind === "trace-group"
              ? <TraceGroupRow key={row.id} group={row} />
              : <TimelineRow key={row.id} item={row} principal={principal} />,
          )}
          {live.active && (live.assistant || live.thinking) && (
            <li className="turn role-agent live msg-agent">
              <div className="bubble">
                {live.thinking && <ThinkingBlock text={live.thinking} defaultOpen streaming />}
                {live.assistant && <div className="text streaming">{live.assistant}<span className="cursor" aria-hidden /></div>}
                {!live.assistant && !live.thinking && <span className="cursor" aria-hidden />}
              </div>
            </li>
          )}
        </ol>
      </div>
      {!stick && (
        <button className="jump" onClick={() => setStick(true)}>↓ Jump to latest</button>
      )}
    </div>
  );
}

function TraceGroupRow({ group }: { group: Extract<ConversationRow, { kind: "trace-group" }> }) {
  const [open, setOpen] = useState(group.active);
  const manuallyChanged = useRef(false);
  const wasActive = useRef(group.active);
  const tools = group.items.filter((item) => item.kind === "tool");
  const errors = tools.filter((tool) => tool.state === "error").length;
  const incomplete = tools.filter((tool) => tool.state === "running").length;

  useEffect(() => {
    if (group.active !== wasActive.current && !manuallyChanged.current) setOpen(group.active);
    wasActive.current = group.active;
  }, [group.active]);

  const toggle = () => {
    manuallyChanged.current = true;
    setOpen((value) => !value);
  };
  const detail = [
    `${group.items.length} step${group.items.length === 1 ? "" : "s"}`,
    tools.length ? `${tools.length} tool${tools.length === 1 ? "" : "s"}` : "thinking",
  ].join(" · ");
  const state = group.active || incomplete ? "running" : errors ? "error" : "success";

  return (
    <li className={`trace-group${group.active ? " active" : ""}`}>
      <button className="trace-group-head" onClick={toggle} aria-expanded={open}>
        <span className={`tool-state tool-state-${state}`} aria-hidden />
        <span className="trace-group-title">{group.active ? "Working…" : "Work trace"}</span>
        <span className="trace-group-summary">{detail}</span>
        {errors > 0 && <span className="trace-group-error">{errors} failed</span>}
        <Chevron open={open} />
      </button>
      {open && (
        <ol className="trace-group-items">
          {group.items.map((item) => <TimelineRow key={item.id} item={item} />)}
        </ol>
      )}
    </li>
  );
}

function TimelineRow({ item, principal }: { item: TimelineItem; principal?: PrincipalIdentity }) {
  if (item.kind === "tool") return <ToolRow tool={item} />;
  if (item.kind === "thinking")
    return (
      <li className="turn trace">
        <span className="trace-rail" aria-hidden />
        <div className="bubble"><ThinkingBlock text={item.text} /></div>
      </li>
    );
  if (item.kind === "notice")
    return (
      <li className={`turn notice notice-${item.noticeKind}`}>
        <span className="notice-dot" aria-hidden />
        <div className="notice-body">{item.text}</div>
      </li>
    );
  if (item.role === "user") {
    const author = authorPresentation(item.attribution, principal ?? { provider: "local", subject: "local", login: "Local user" });
    return (
      <li className={`turn role-user author-${author.kind}`}>
        <div className="bubble user-bubble">
          <div className="turn-author">
            <span className="author-name">{author.author}</span>
            {author.action && <span className="author-action">{author.action}</span>}
            <time dateTime={new Date(item.ts).toISOString()} title={new Date(item.ts).toLocaleString()}>
              {formatTime(item.ts)}
            </time>
          </div>
          <div className="text">{item.text}</div>
        </div>
      </li>
    );
  }
  return (
    <li className={`turn role-${item.role} ${item.role === "agent" ? "msg-agent" : ""}`}>
      <div className="bubble">
        {item.role === "agent" ? <Markdown text={item.text} /> : <div className="text">{item.text}</div>}
      </div>
    </li>
  );
}

function ToolRow({ tool }: { tool: ToolCard }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="turn trace tool">
      <span className="trace-rail" aria-hidden />
      <div className="bubble tool-bubble">
        <button className="tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="trace-icon" aria-hidden><ToolIcon /></span>
          <span className={`tool-state tool-state-${tool.state}`} aria-hidden />
          <code>{tool.argsSummary || tool.name}</code>
          <Chevron open={open} />
        </button>
        {open && tool.preview && (
          <div className="tool-preview"><pre>{tool.preview}</pre></div>
        )}
      </div>
    </li>
  );
}

function ThinkingBlock({ text, defaultOpen, streaming }: { text: string; defaultOpen?: boolean; streaming?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="thinking">
      <button className="thinking-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="trace-icon" aria-hidden><BrainIcon /></span>
        <span>Thinking{streaming ? "…" : ""}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="thinking-body">
          {streaming ? text : <Markdown text={text} />}
        </div>
      )}
    </div>
  );
}
