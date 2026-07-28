import { useCallback, useEffect, useRef, useState } from "react";
import type { SelectedState } from "../store";
import type { useChatApp } from "../store";
import { SendIcon, StopIcon } from "./icons";
import { useIsDesktop, useSoftwareKeyboardOpen } from "./hooks";

export function Composer(props: {
  selId: string;
  busy: boolean;
  runState: SelectedState["runState"];
  queued: number;
  modelReady: boolean;
  noModels: boolean;
  actions: ReturnType<typeof useChatApp>["actions"];
}) {
  const { selId, busy, runState, queued, modelReady, noModels, actions } = props;
  const draftKey = `pi-together:draft:${selId}`;
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [submitting, setSubmitting] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const isDesktop = useIsDesktop();
  const keyboardOpen = useSoftwareKeyboardOpen();

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  const submit = useCallback(async (mode: "normal" | "steer" | "followUp") => {
    const draft = text;
    const value = draft.trim();
    if (!value || submitting || !modelReady) return;
    setSubmitting(true);
    try {
      const accepted = await actions.send(value, mode);
      if (!accepted) return;
      setText((current) => {
        if (current !== draft) return current;
        localStorage.removeItem(draftKey);
        return "";
      });
    } finally {
      setSubmitting(false);
    }
  }, [actions, draftKey, modelReady, submitting, text]);

  return (
    <div className={`composer${keyboardOpen ? " keyboard-open" : ""}`}>
      {!modelReady && (
        <div className="composer-blocked" role="status">
          <strong>{noModels ? "No model is available." : "No model is selected."}</strong>{" "}
          {noModels ? <>Run <code>pi</code>, use <code>/login</code>, then restart Pi Together.</> : "Select a model above before sending a message."}
        </div>
      )}
      {busy && (
        <div className="runbar">
          <span className={`runstate runstate-${runState}`}><span className="rs-dot" />{runState}</span>
          {queued > 0 && <span className="queued">{queued} queued</span>}
          <div className="spacer" />
          <button className="steer" disabled={!modelReady || !text.trim() || submitting} onClick={() => void submit("steer")}>Steer</button>
          <button className="followup" disabled={!modelReady || !text.trim() || submitting} onClick={() => void submit("followUp")}>Follow-up</button>
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={textarea}
          value={text}
          rows={1}
          disabled={!modelReady}
          placeholder={!modelReady ? (noModels ? "Configure a Pi model with /login before messaging" : "Select a model before messaging") : busy
            ? (isDesktop ? "Steer or queue a follow-up…" : "Steer or follow up…")
            : (isDesktop ? "Message Pi…  (Enter to send, Shift+Enter for newline)" : "Message Pi…")}
          onChange={(event) => {
            setText(event.target.value);
            localStorage.setItem(draftKey, event.target.value);
          }}
          onKeyDown={(event) => {
            if (isDesktop && event.key === "Enter" && !event.shiftKey && !busy) {
              event.preventDefault();
              void submit("normal");
            }
          }}
          aria-label="Message input"
        />
        {busy ? (
          <button className="send stop" disabled={runState === "stopping"} onClick={() => void actions.abort()}>
            <StopIcon /> {runState === "stopping" ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button className="send" disabled={!modelReady || !text.trim() || submitting} onClick={() => void submit("normal")}><SendIcon /> Send</button>
        )}
      </div>
    </div>
  );
}
