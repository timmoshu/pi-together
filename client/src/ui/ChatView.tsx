import { useEffect, useRef, useState } from "react";
import type { ChatSummary, ModelInfo, PrincipalIdentity } from "../../../shared/protocol";
import type { ExtRequest, SelectedState } from "../store";
import type { useChatApp } from "../store";
import { Conversation } from "./Conversation";
import { GearIcon, HistoryIcon } from "./icons";
import { useIsDesktop } from "./hooks";
import { Composer } from "./Composer";
import { trapFocus } from "./focus";
import { canRespondToExtension, controllerPresentation, formatRelativeTime, historySentence, isBusy } from "./presentation";
import { OriginChip, ToolPill } from "./session-badges";
import { CollaborationBanner } from "./CollaborationBanner";

export function ChatView(props: {
  state: ReturnType<typeof useChatApp>["state"];
  actions: ReturnType<typeof useChatApp>["actions"];
  models: ModelInfo[];
}) {
  const { state, actions, models } = props;
  const sel = state.selected!;
  const principal = state.boot!.principal;
  const busy = isBusy(sel);
  const queued = sel.queue.steering.length + sel.queue.followUp.length;
  // a session needs a live runtime attached here to be driven. Web sessions go idle after a server
  // restart; external ones are gated behind an explicit take-over (concurrent-writer risk).
  const notLive = !sel.summary.live;
  const isExternal = sel.summary.origin === "external";
  const heldElsewhere = !!sel.summary.lease && sel.summary.lease.isHolder !== true;
  const isDesktop = useIsDesktop();
  // on mobile the actions + controls are collapsed by default so the chat gets the room
  const [panelOpen, setPanelOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  useEffect(() => {
    if (heldElsewhere) setRenaming(false);
  }, [heldElsewhere]);
  const showPanel = isDesktop || panelOpen;
  const selectedModelAvailable = Boolean(sel.config?.model && models.some((model) =>
    model.provider === sel.config?.model?.provider && model.id === sel.config?.model?.id));

  return (
    <>
      <div className="detailhead">
        <div className="dh-title">
          <h1 title={sel.summary.name}>{sel.summary.name}</h1>
          <div className="dh-sub">
            <span className="dh-ws" title={sel.summary.workspaceRoot}>{sel.summary.workspaceRoot}</span>
            <OriginChip origin={sel.summary.origin} />
            <ToolPill c={sel.summary} />
          </div>
        </div>
        {!isDesktop && (
          <button
            className={`panel-toggle${panelOpen ? " on" : ""}`}
            onClick={() => setPanelOpen((v) => !v)}
            aria-expanded={panelOpen}
            aria-label="Session settings"
          >
            <GearIcon />
          </button>
        )}
        {showPanel && (
          <div className="actions">
            <button disabled={busy || heldElsewhere} onClick={() => setRenaming(true)}>Rename</button>
            <button disabled={busy || notLive || heldElsewhere} onClick={() => void actions.compact()}>Compact</button>
            <button
              disabled={busy || heldElsewhere || (!sel.summary.live && !sel.summary.lease)}
              onClick={() => void actions.close()}
              title="Detach the live runtime and move this session out of Active; the transcript is preserved"
            >
              Close
            </button>
            {!isDesktop && sel.leaseHistory.length > 0 && <ControlHistory events={sel.leaseHistory} principal={principal} />}
          </div>
        )}
        {isDesktop && sel.leaseHistory.length > 0 && <ControlHistory events={sel.leaseHistory} principal={principal} />}
      </div>

      {showPanel && (
        <CollaborationBanner
          principal={principal}
          participants={state.presence[sel.id]?.participants ?? []}
        />
      )}

      {showPanel && <Controls sel={sel} models={models} busy={busy} locked={notLive || heldElsewhere} actions={actions} />}

      <Conversation sel={sel} principal={principal} />

      {renaming && (
        <RenameDialog
          currentName={sel.summary.name}
          onCancel={() => setRenaming(false)}
          onSave={(name) => { setRenaming(false); void actions.rename(name); }}
        />
      )}

      {sel.ext && (canRespondToExtension(sel.summary.lease)
        ? <ExtensionDialog ext={sel.ext} onRespond={actions.respondExtension} />
        : <div className="extension-waiting" role="status">Waiting for {sel.summary.lease?.actor.login ?? "the controller"} to respond to Pi.</div>
      )}

      {heldElsewhere ? (
        <DeviceTakeover summary={sel.summary} principal={principal} busy={busy} queued={queued} actions={actions} />
      ) : notLive ? (
        <ActivateBar id={sel.id} external={isExternal} actions={actions} />
      ) : (
        <Composer
          selId={sel.id}
          busy={busy}
          runState={sel.runState}
          queued={queued}
          modelReady={selectedModelAvailable}
          noModels={models.length === 0}
          actions={actions}
        />
      )}

    </>
  );
}

export function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="freeze" role="status" aria-live="polite">
      <div className="freeze-card">
        <span className="spinner" aria-hidden />
        <span>{label}</span>
      </div>
    </div>
  );
}

function ControlHistory({ events, principal }: { events: SelectedState["leaseHistory"]; principal: PrincipalIdentity }) {
  return (
    <details className="control-history">
      <summary aria-label={`Control history, ${events.length} event${events.length === 1 ? "" : "s"}`}>
        <HistoryIcon />
        <span className="history-title">History</span>
        <span className="history-count">{events.length}</span>
      </summary>
      <div className="history-popover">
        <strong>Control history</strong>
        <ol>
          {events.map((event) => {
            const occurred = new Date(event.occurredAt);
            return <li key={event.requestId}><span>{historySentence(event, principal)}</span><time dateTime={event.occurredAt} title={occurred.toLocaleString()}>{formatRelativeTime(event.occurredAt)}</time></li>;
          })}
        </ol>
        <p>Stored in the Pi session and retained when the session is copied.</p>
      </div>
    </details>
  );
}

function DeviceTakeover({
  summary,
  principal,
  busy,
  queued,
  actions,
}: {
  summary: ChatSummary;
  principal: PrincipalIdentity;
  busy: boolean;
  queued: number;
  actions: ReturnType<typeof useChatApp>["actions"];
}) {
  const controller = controllerPresentation(summary.lease, principal);
  const sameUser = controller.relation === "mine-elsewhere";
  const controllerName = sameUser ? "another tab or device" : summary.lease?.actor.login ?? "another user";
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = () => {
    setConfirming(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <div className="takeover web">
      <div className="takeover-inner">
        <strong>{sameUser ? "Controlled in another tab or device" : `${controllerName} is controlling`}</strong>
        <p>This session remains readable. Taking over transfers its single mutating controller to this tab.</p>
        <button ref={trigger} className="primary" onClick={() => setConfirming(true)}>Take over here</button>
      </div>
      {confirming && (
        <div className="modal-scrim" role="presentation">
          <div ref={dialog} className="modal" role="alertdialog" aria-modal="true" aria-labelledby="takeover-title" onKeyDown={(event) => {
            if (event.key === "Escape") close();
            trapFocus(event, dialog.current);
          }}>
            <h3 id="takeover-title">{sameUser ? "Take over in this tab?" : `Take over from ${controllerName}?`}</h3>
            <p>{sameUser ? "The other tab or device" : controllerName} will become read-only. {busy
              ? `Pi is still running${queued ? ` with ${queued} queued instruction${queued === 1 ? "" : "s"}` : ""}; that work will continue after takeover. `
              : ""}Pi runs with the host user's permissions, so your actions can change the host.</p>
            <div className="modal-actions">
              <button className="primary" autoFocus onClick={() => { setConfirming(false); void actions.resume(summary.id); }}>Confirm takeover</button>
              <button onClick={close}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivateBar({
  id,
  external,
  actions,
}: {
  id: string;
  external: boolean;
  actions: ReturnType<typeof useChatApp>["actions"];
}) {
  if (external)
    return (
      <div className="takeover">
        <div className="takeover-inner">
          <strong>External session</strong>
          <p>
            This session was created outside Pi Together (for example, in a terminal or another tool). It may be
            running in another process — driving it here at the same time can corrupt its transcript.
          </p>
          <button className="primary" onClick={() => void actions.resume(id)}>Take over &amp; drive here</button>
        </div>
      </div>
    );
  return (
    <div className="takeover web">
      <div className="takeover-inner">
        <strong>Session idle</strong>
        <p>
          Not connected to a live Pi runtime (web sessions go idle when the server restarts). Resume to reattach
          and load its model, thinking, and tools — your transcript is preserved.
        </p>
        <button className="primary" onClick={() => void actions.resume(id)}>Resume session</button>
      </div>
    </div>
  );
}

function Controls(props: {
  sel: SelectedState;
  models: ModelInfo[];
  busy: boolean;
  locked: boolean;
  actions: ReturnType<typeof useChatApp>["actions"];
}) {
  const { sel, models, busy, locked, actions } = props;
  const disabled = busy || locked;
  const cfg = sel.config;
  const modelKey = cfg?.model ? `${cfg.model.provider}/${cfg.model.id}` : "";
  const levels = cfg?.thinkingLevels ?? ["off"];

  return (
    <div className="controls" aria-label="Session controls">
      <label className="ctl">
        <span>Model</span>
        {models.length === 0 ? (
          <span className="ctl-empty">none — run <code>pi</code> &amp; <code>/login</code></span>
        ) : (
          <select
            value={modelKey}
            disabled={disabled}
            onChange={(e) => {
              const [provider, ...rest] = e.target.value.split("/");
              void actions.setModel(provider!, rest.join("/"));
            }}
          >
            {!modelKey && <option value="">—</option>}
            {models.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.name}</option>
            ))}
          </select>
        )}
      </label>

      <label className="ctl">
        <span>Thinking</span>
        <select value={cfg?.thinking ?? "off"} disabled={disabled || levels.length <= 1} onChange={(e) => void actions.setThinking(e.target.value)}>
          {levels.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </label>

      <div className="ctl">
        <span>Tools</span>
        <div className="segmented" role="group" aria-label="Tool access">
          <button
            className={cfg?.toolMode === "read-only" ? "on" : ""}
            disabled={disabled}
            onClick={() => void actions.setToolMode("read-only")}
            title="read, grep, find, ls — a model-tool allowlist, not an OS sandbox"
          >
            Read-only
          </button>
          <button
            className={cfg?.toolMode === "full" ? "on" : ""}
            disabled={disabled}
            onClick={() => void actions.setToolMode("full")}
            title="Pi's full tool set, including extension tools"
          >
            Full
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameDialog({
  currentName,
  onCancel,
  onSave,
}: {
  currentName: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(currentName);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.select();
    return () => previous?.focus();
  }, []);
  const submit = () => {
    const value = name.trim();
    if (value && value !== currentName) onSave(value);
    else onCancel();
  };
  return (
    <div className="modal-scrim" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        ref={ref}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
          if (event.key === "Enter" && event.target === input.current) submit();
          trapFocus(event, ref.current);
        }}
      >
        <h3 id="rename-title">Rename session</h3>
        <input ref={input} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} aria-label="Session name" />
        <div className="modal-actions">
          <button className="primary" disabled={!name.trim()} onClick={submit}>Save</button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ExtensionDialog({
  ext,
  onRespond,
}: {
  ext: ExtRequest;
  onRespond: (reply: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
}) {
  const [text, setText] = useState(ext.prefill ?? "");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, input, textarea")?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div className="modal-scrim" role="presentation" onClick={() => onRespond({ cancelled: true })}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={ext.title || "Extension request"}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onRespond({ cancelled: true });
          trapFocus(e, ref.current);
        }}
      >
        <h3>{ext.title || "Extension request"}</h3>
        {ext.message && <p>{ext.message}</p>}
        {ext.method === "select" && (
          <div className="modal-actions col">
            {(ext.options ?? []).map((o) => (
              <button key={o} onClick={() => onRespond({ value: o })}>{o}</button>
            ))}
          </div>
        )}
        {ext.method === "confirm" && (
          <div className="modal-actions">
            <button className="primary" onClick={() => onRespond({ confirmed: true })}>Yes</button>
            <button onClick={() => onRespond({ confirmed: false })}>No</button>
          </div>
        )}
        {(ext.method === "input" || ext.method === "editor") && (
          <>
            {ext.method === "input" ? (
              <input value={text} placeholder={ext.placeholder} onChange={(e) => setText(e.target.value)} />
            ) : (
              <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
            )}
            <div className="modal-actions">
              <button className="primary" onClick={() => onRespond({ value: text })}>Submit</button>
              <button onClick={() => onRespond({ cancelled: true })}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
