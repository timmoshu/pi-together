import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogEntry, ChatSummary, PrincipalIdentity } from "../../../shared/protocol";
import { Chevron, LockIcon, PlusIcon, SearchIcon } from "./icons";
import { OriginChip } from "./session-badges";
import { controllerPresentation } from "./presentation";

const SESSION_PAGE_SIZE = 20;
const wsLabel = (root: string) => root.split("/").filter(Boolean).pop() ?? root;
const repoLabels = (roots: string[]) => {
  const baseCount = new Map<string, number>();
  for (const root of roots) baseCount.set(wsLabel(root), (baseCount.get(wsLabel(root)) ?? 0) + 1);
  return new Map(roots.map((root) => {
    const base = wsLabel(root);
    const parts = root.split("/").filter(Boolean);
    const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
    return [root, (baseCount.get(base) ?? 0) > 1 && parent ? `${parent}/${base}` : base];
  }));
};
export function Sidebar(props: {
  chats: ChatSummary[];
  selectedId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  catalog: CatalogEntry[];
  onCreate: (root: string) => void;
  onRefresh: () => void;
  discoveryTruncated?: boolean;
  principal: PrincipalIdentity | null;
}) {
  const q = props.query.trim().toLowerCase();
  const match = (c: ChatSummary) =>
    !q || c.name.toLowerCase().includes(q) || c.workspaceRoot.toLowerCase().includes(q);
  const filtered = props.chats.filter(match);

  const active = filtered.filter((c) => c.live || c.lease);
  const rest = filtered.filter((c) => !(c.live || c.lease));

  // group the on-disk sessions by underlying REPO (worktrees/branches of one repo blend together),
  // most-recent group first
  const groups = useMemo(() => {
    const m = new Map<string, ChatSummary[]>();
    for (const c of rest) (m.get(c.repoRoot) ?? m.set(c.repoRoot, []).get(c.repoRoot)!).push(c);
    const entries = [...m.entries()].map(([root, list]) => ({ root, list: list.sort((a, b) => b.updatedAt - a.updatedAt) }));
    // disambiguate colliding basenames (e.g. several `.../<task>/mobile-arpg`) with a parent segment
    const labels = repoLabels(entries.map((entry) => entry.root));
    return entries
      .map((entry) => ({ ...entry, label: labels.get(entry.root) ?? wsLabel(entry.root) }))
      .sort((a, b) => (b.list[0]?.updatedAt ?? 0) - (a.list[0]?.updatedAt ?? 0));
  }, [rest]);

  return (
    <div className="sidebar-inner">
      <WorkspacePicker catalog={props.catalog} chats={props.chats} onCreate={props.onCreate} onRefresh={props.onRefresh} discoveryTruncated={props.discoveryTruncated} />

      <div className="search">
        <SearchIcon />
        <input
          type="search"
          placeholder="Search sessions…"
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          aria-label="Search sessions"
        />
      </div>

      <div className="sidebar-scroll">
        {active.length > 0 && (
          <section className="ses-section">
            <h2 className="ses-h">Active <span className="count">{active.length}</span></h2>
            <ul className="chatlist">
              {active.map((c) => (
                <ChatRow key={c.id} c={c} selected={c.id === props.selectedId} onSelect={props.onSelect} principal={props.principal} />
              ))}
            </ul>
          </section>
        )}

        {groups.length === 0 && active.length === 0 && (
          <p className="hint">{q ? "No sessions match." : "No sessions yet — start one above."}</p>
        )}

        {groups.map((g) => (
          <WorkspaceGroup
            key={g.root}
            root={g.root}
            label={g.label}
            list={g.list}
            selectedId={props.selectedId}
            onSelect={props.onSelect}
            defaultOpen={!!q || g.list.some((c) => c.id === props.selectedId)}
            principal={props.principal}
          />
        ))}
      </div>
    </div>
  );
}

function WorkspacePicker({
  catalog,
  chats,
  onCreate,
  onRefresh,
  discoveryTruncated,
}: {
  catalog: CatalogEntry[];
  chats: ChatSummary[];
  onCreate: (root: string) => void;
  onRefresh: () => void;
  discoveryTruncated?: boolean;
}) {
  // Match the session rail: worktrees/branches collapse into their underlying main repo. Selecting
  // one starts the new session at that main repo root, not at an arbitrary branch worktree.
  const { used, roots, emptyFolders } = useMemo(() => {
    const counts = new Map<string, { count: number; latest: number }>();
    for (const chat of chats) {
      const value = counts.get(chat.repoRoot) ?? { count: 0, latest: 0 };
      value.count++;
      value.latest = Math.max(value.latest, chat.updatedAt);
      counts.set(chat.repoRoot, value);
    }
    const labels = repoLabels([...counts.keys()]);
    const used = [...counts].map(([workspaceRoot, value]) => ({
      workspaceRoot,
      label: labels.get(workspaceRoot) ?? wsLabel(workspaceRoot),
      sessionCount: value.count,
      latest: value.latest,
    })).sort((a, b) => b.latest - a.latest || a.label.localeCompare(b.label));
    // Session-sourced catalog entries are individual cwds and may be branch worktrees; the grouped
    // entries above replace them. Keep only explicitly configured roots as fallback choices.
    const roots = catalog
      .filter((entry) => entry.source === "root" && !counts.has(entry.workspaceRoot))
      .sort((a, b) => a.label.localeCompare(b.label));
    const emptyFolders = catalog.filter((entry) => entry.source === "folder").sort((a, b) => a.label.localeCompare(b.label));
    return { used, roots, emptyFolders };
  }, [catalog, chats]);

  const [selection, setSelection] = useState("");
  const [pathDialog, setPathDialog] = useState(false);
  const [emptyModal, setEmptyModal] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const customInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Bootstrap arrives after the first render. Keep the placeholder selected until it does, then
    // prefer the most recently used repository. Empty policy folders remain visible but unselected.
    const initial = used[0]?.workspaceRoot ?? roots[0]?.workspaceRoot;
    const available = [...used, ...roots, ...emptyFolders].some((entry) => entry.workspaceRoot === selection);
    if ((!selection || !available) && initial) setSelection(initial);
    else if (selection && !available) setSelection("");
  }, [emptyFolders, roots, selection, used]);
  useEffect(() => { if (pathDialog) customInput.current?.focus(); }, [pathDialog]);
  const emptySelection = emptyFolders.find((entry) => entry.workspaceRoot === selection);
  const create = () => {
    if (!selection || emptySelection) return;
    onCreate(selection);
  };
  return (
    <>
    <div className="newchat">
      <div className="ws-field">
        <label className="sr-only" htmlFor="ws-select">Workspace for new chat</label>
        <select
          id="ws-select"
          value={selection}
          onChange={(e) => { setSelection(e.target.value); setEmptyModal(false); }}
          aria-label="Workspace for new chat"
        >
          {!selection && <option value="">Choose a workspace…</option>}
          {used.length > 0 && (
            <optgroup label="Workspaces with sessions">
              {used.map((workspace) => (
                <option key={workspace.workspaceRoot} value={workspace.workspaceRoot}>
                  {workspace.label} · {workspace.sessionCount} session{workspace.sessionCount === 1 ? "" : "s"}
                </option>
              ))}
            </optgroup>
          )}
          {roots.length > 0 && (
            <optgroup label="Repositories">
              {roots.map((workspace) => (
                <option key={workspace.workspaceRoot} value={workspace.workspaceRoot}>
                  {workspace.label} · {workspace.sessionCount} session{workspace.sessionCount === 1 ? "" : "s"}
                </option>
              ))}
            </optgroup>
          )}
          {emptyFolders.length > 0 && (
            <optgroup label="Approved folders without repositories">
              {emptyFolders.map((folder) => <option key={folder.workspaceRoot} value={folder.workspaceRoot}>{folder.label} · no Git repository</option>)}
            </optgroup>
          )}
        </select>
      </div>
      {used.length === 0 && roots.length === 0 && (
        <p className="hint">No repositories found. Initialize or clone one beneath an approved folder, then refresh.</p>
      )}
      {discoveryTruncated && <p className="hint" role="status">Repository scan was truncated. Enter an exact eligible path or refresh again.</p>}
      <button className="primary" disabled={!selection.trim()} onClick={emptySelection ? () => setEmptyModal(true) : create}>
        <PlusIcon /> New
      </button>
      <div className="workspace-actions">
        <button type="button" className="subtle" aria-label="Refresh repositories" onClick={onRefresh}>Refresh repositories</button>
        <button type="button" className="subtle" onClick={() => setPathDialog(true)}>Repository not listed?</button>
      </div>
    </div>
    {emptySelection && emptyModal && (
      <div className="modal-scrim" role="presentation" onClick={() => setEmptyModal(false)}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="empty-folder-title" onClick={(event) => event.stopPropagation()}>
          <h3 id="empty-folder-title">No Git repository yet</h3>
          <p><code>{emptySelection.workspaceRoot}</code> is an approved folder, but Pi sessions can start only at an eligible Git worktree.</p>
          <p>On the host, initialize this folder with <code>git init --initial-branch=main</code>, or clone a repository beneath it. Then refresh repositories.</p>
          <div className="modal-actions"><button onClick={() => setEmptyModal(false)}>Close</button><button className="primary" onClick={() => { onRefresh(); setEmptyModal(false); }}>Refresh repositories</button></div>
        </div>
      </div>
    )}
    {pathDialog && (
      <div className="modal-scrim" role="presentation" onClick={() => setPathDialog(false)}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="repo-path-title" onClick={(event) => event.stopPropagation()}>
          <h3 id="repo-path-title">Find an existing repository by path</h3>
          <p>Use this only for an existing exact Git worktree beneath an approved folder, or an authorized linked worktree missed by bounded discovery.</p>
          <input ref={customInput} value={customPath} spellCheck={false} placeholder="/home/example/projects/my-app" onChange={(event) => setCustomPath(event.target.value)} aria-label="Exact Git worktree path" />
          <div className="modal-actions"><button onClick={() => setPathDialog(false)}>Cancel</button><button className="primary" disabled={!customPath.trim()} onClick={() => { onCreate(customPath.trim()); setPathDialog(false); }}>Start session</button></div>
        </div>
      </div>
    )}
    </>
  );
}

function WorkspaceGroup(props: {
  root: string;
  label: string;
  list: ChatSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  defaultOpen: boolean;
  principal: PrincipalIdentity | null;
}) {
  const [open, setOpen] = useState(true); // groups open by default; collapsible
  const [visibleCount, setVisibleCount] = useState(SESSION_PAGE_SIZE);
  const selectedIndex = props.list.findIndex((chat) => chat.id === props.selectedId);
  const limit = Math.max(visibleCount, selectedIndex >= 0 ? selectedIndex + 1 : 0);
  const visible = props.list.slice(0, limit);
  const remaining = props.list.length - visible.length;
  useEffect(() => {
    if (props.defaultOpen) setOpen(true);
  }, [props.defaultOpen]);
  return (
    <section className="ses-section">
      <button className="ses-h group-h" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Chevron open={open} />
        <span className="ws-name" title={props.root}>{props.label}</span>
        <span className="count">{props.list.length}</span>
      </button>
      {open && (
        <ul className="chatlist chatlist-sub">
          {visible.map((c) => (
            <ChatRow key={c.id} c={c} selected={c.id === props.selectedId} onSelect={props.onSelect} principal={props.principal} />
          ))}
          {remaining > 0 && (
            <li className="session-more">
              <button className="session-more-button" onClick={() => setVisibleCount((count) => count + SESSION_PAGE_SIZE)}>
                Show {Math.min(SESSION_PAGE_SIZE, remaining)} more…
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function ChatRow({
  c,
  selected,
  onSelect,
  principal,
}: {
  c: ChatSummary;
  selected: boolean;
  onSelect: (id: string) => void;
  principal: PrincipalIdentity | null;
}) {
  const controller = principal ? controllerPresentation(c.lease, principal) : null;
  const controllerLabel = controller?.relation === "mine"
    ? "You"
    : controller?.relation === "mine-elsewhere"
      ? "You elsewhere"
      : c.lease?.actor.login;
  return (
    <li className={selected ? "sel" : ""}>
      <button className="chatrow" onClick={() => onSelect(c.id)}>
        <span className={`dot status-${c.status}`} aria-hidden />
        <span className="sr-only">{c.status}{controller ? `. ${controller.text}` : ""}</span>
        <span className="crow-main">
          <span className="cname">{c.name}</span>
        </span>
        <OriginChip origin={c.origin} compact />
        {c.lease && controllerLabel && (
          <span className={`controller-tag controller-tag-${controller?.relation}`} title={controller?.text} aria-hidden="true">
            {c.lease.isHolder !== true && <LockIcon />}<span>{controllerLabel}</span>
          </span>
        )}
      </button>
    </li>
  );
}

export function EmptyState({ hasChats }: { hasChats: boolean }) {
  return (
    <div className="empty">
      <div className="empty-mark">π</div>
      <h1>Pi Together</h1>
      <p>{hasChats ? "Select a session, or start a new one." : "Start a new session to begin."}</p>
      <p className="fineprint">
        The browser is only a control surface. Pi remains the agent and the source of truth for models,
        auth, tools, and sessions.
      </p>
    </div>
  );
}
