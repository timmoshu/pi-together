import { useCallback, useEffect, useRef, useState } from "react";
import { useChatApp } from "./store";
import { applyTheme, getTheme, nextTheme, type Theme } from "./theme";
import { ChatView, LoadingScreen } from "./ui/ChatView";
import { AutoIcon, MenuIcon, MoonIcon, SunIcon } from "./ui/icons";
import { useIsDesktop } from "./ui/hooks";
import { trapFocus } from "./ui/focus";
import { EmptyState, Sidebar } from "./ui/Sidebar";
import { controlLostMessage } from "./ui/presentation";

export function App() {
  const { state, error, clearError, actions } = useChatApp();
  const { boot, connection, chats, models, selected, controlNotice } = state;
  const connectionLoading = connection === "reconnecting"
    ? "Reconnecting…"
    : connection === "reattaching"
      ? "Reattaching…"
      : null;
  const loadingLabel = connectionLoading ?? state.pending;
  const isDesktop = useIsDesktop();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);

  useEffect(() => {
    if (isDesktop) setDrawerOpen(false);
  }, [isDesktop]);

  useEffect(() => {
    if (!drawerOpen || isDesktop) return;
    // Focus the navigation container rather than its small form controls. Mobile Safari zooms the
    // viewport when a sub-16px control receives programmatic focus as the drawer opens.
    drawer.current?.focus({ preventScroll: true });
  }, [drawerOpen, isDesktop]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    requestAnimationFrame(() => menuButton.current?.focus());
  }, []);
  const selectAndClose = useCallback(
    (id: string) => {
      void actions.select(id);
      closeDrawer();
    },
    [actions, closeDrawer],
  );

  const sidebar = (
    <Sidebar
      chats={chats}
      selectedId={selected?.id ?? null}
      query={query}
      onQuery={setQuery}
      onSelect={selectAndClose}
      catalog={boot?.catalog ?? []}
      principal={boot?.principal ?? null}
      onRefresh={() => { void actions.refreshWorkspaces(); }}
      discoveryTruncated={state.workspaceDiscoveryTruncated}
      onCreate={(root) => {
        void actions.create(root);
        closeDrawer();
      }}
    />
  );

  return (
    <div className={`app${drawerOpen ? " drawer-open" : ""}`}>
      <header className="topbar">
        {!isDesktop && (
          <button ref={menuButton} className="menu-btn" aria-label="Open chat list" aria-expanded={drawerOpen} onClick={() => setDrawerOpen((value) => !value)}>
            <MenuIcon />
          </button>
        )}
        <span className="brand"><span className="brand-mark">π</span> Together</span>
        {boot && (
          <span className="meta">
            {boot.adapter === "fake" && <span className="badge badge-fake">fake</span>}
            <span className="identity-chip" title={boot.principal.login}>
              {boot.principal.provider === "github" ? `Signed in as ${boot.principal.login}` : "Local user"}
            </span>
          </span>
        )}
        <span className={`conn conn-${connection}`} title={`event stream: ${connection}`}>
          <span className="conn-dot" />
          {connection === "connected"
            ? "Connected"
            : connection === "reconnecting"
              ? "Reconnecting"
              : connection === "reattaching"
                ? "Reattaching"
                : "Connecting"}
        </span>
        <ThemeToggle />
      </header>

      {error && (
        <div className="error" role="alert">
          <span>{error}</span>
          <button className="error-x" aria-label="Dismiss error" onClick={clearError}>✕</button>
        </div>
      )}

      {controlNotice && controlNotice.chatId === selected?.id && (
        <div className="control-notice" role="status" aria-live="polite">
          <span>{controlLostMessage(controlNotice)}</span>
          <button onClick={actions.dismissControlNotice}>Dismiss</button>
        </div>
      )}

      <div className="layout">
        {isDesktop ? (
          <aside className="sidebar">{sidebar}</aside>
        ) : (
          <>
            <div className={`scrim${drawerOpen ? " show" : ""}`} onClick={closeDrawer} aria-hidden={!drawerOpen} />
            <aside
              ref={drawer}
              className={`sidebar drawer${drawerOpen ? " open" : ""}`}
              aria-hidden={!drawerOpen}
              aria-label="Session navigation"
              tabIndex={-1}
              inert={!drawerOpen}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeDrawer();
                trapFocus(event, drawer.current);
              }}
            >
              {sidebar}
            </aside>
          </>
        )}

        <main className="detail">
          {selected ? (
            <ChatView key={selected.id} state={state} actions={actions} models={models} />
          ) : (
            <EmptyState hasChats={chats.length > 0} />
          )}
          {loadingLabel && <LoadingScreen label={loadingLabel} />}
        </main>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => getTheme());
  const cycle = () => {
    const next = nextTheme(theme);
    applyTheme(next);
    setTheme(next);
  };
  const label = theme === "system" ? "System theme" : theme === "light" ? "Light theme" : "Dark theme";
  return (
    <button className="theme-toggle" onClick={cycle} title={`${label} (click to change)`} aria-label={`${label}. Click to change theme.`}>
      {theme === "system" ? <AutoIcon /> : theme === "light" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
