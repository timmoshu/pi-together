import { expect, test, type Page } from "@playwright/test";

// Runs against the built client + a fake-adapter server (see playwright.config.ts webServer).
// The fake streams a fixed sequence (FAKE_STEP_MS), so no paid model request is ever made.
//
// The fake server is a single shared, stateful process and controller-leases persist for minutes,
// so send-tests each create their OWN isolated chat (whose lease the creating tab holds) to stay
// independent. Seeded chats are used only for read/resume flows.

async function newChat(page: Page) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".detailhead h1")).toBeVisible();
}

test("desktop: create chat, send, stream text + tool, expand preview", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");

  await expect(page.locator(".brand")).toContainText("Together");
  await expect(page.locator(".badge-fake")).toBeVisible();
  await expect(page.locator(".conn-connected")).toBeVisible();
  await expect(page.getByText("Signed in as alice", { exact: true })).toBeVisible();
  await expect(page.locator(".chatrow")).toHaveCount(2); // two seeded sessions

  await newChat(page);
  const historyMenu = page.locator(".detailhead .control-history");
  await expect(historyMenu.locator("summary")).toBeVisible();
  await expect(historyMenu.locator("ol")).toBeHidden();
  await historyMenu.locator("summary").click();
  await expect(historyMenu.locator("ol")).toBeVisible();

  // model + thinking + tools controls are present; new web chats default to Full tools
  await expect(page.locator(".controls select").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Full" })).toHaveClass(/on/);

  // send a prompt (Enter to send on desktop)
  const box = page.getByRole("textbox", { name: "Message input" });
  await box.fill("please list the files");
  await box.press("Enter");

  await expect(page.locator(".turns")).toContainText("please list the files");
  await expect(page.locator(".turns")).toContainText("Done.", { timeout: 6000 });

  // user message appears as exactly one user turn (no duplicate)
  await expect(page.locator(".role-user")).toHaveCount(1);
  await expect(page.locator(".role-user")).toHaveClass(/author-own/);
  await expect(page.locator(".role-user .turn-author")).toContainText("You");
  await expect(page.locator(".role-user .turn-author")).not.toContainText("prompt");

  // Completed process activity condenses into one historical accordion, collapsed by default.
  await expect(page.locator(".trace-group-head")).toContainText("Work trace");
  await expect(page.locator(".turn.trace.tool")).toBeHidden();
  await page.locator(".trace-group-head").click();
  await expect(page.locator(".turn.trace.tool")).toBeVisible();
  await expect(page.locator(".turn.trace .thinking-head")).toBeVisible();
  await expect(page.locator(".msg-agent .md")).toBeVisible(); // pi's message rendered as markdown

  // Individual tool output remains nested and bounded inside the expanded work trace.
  await page.locator(".tool-head").first().click();
  await expect(page.locator(".tool-preview")).toBeVisible();
});

test("sessions without an available model cannot send messages", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route("**/api/models", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { models: [] } });
  });
  await page.route("**/api/chats", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.models = [];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await newChat(page);
  await expect(page.getByText("No model is available", { exact: false })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("workspace picker collapses branch worktrees to the main repo", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route("**/api/bootstrap*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const seed = body.chats[0];
    body.chats = [
      {
        ...seed,
        id: "branch-a",
        workspaceRoot: "/home/example/.kandev/tasks/a/atlas",
        repoRoot: "/home/example/projects/atlas",
        updatedAt: 200,
      },
      {
        ...seed,
        id: "branch-b",
        workspaceRoot: "/home/example/.kandev/tasks/b/atlas",
        repoRoot: "/home/example/projects/atlas",
        updatedAt: 100,
      },
    ];
    body.catalog = [
      { workspaceRoot: "/home/example/.kandev/tasks/a/atlas", label: "a/atlas", source: "session", sessionCount: 1 },
      { workspaceRoot: "/home/example/.kandev/tasks/b/atlas", label: "b/atlas", source: "session", sessionCount: 1 },
    ];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");

  const workspace = page.getByRole("combobox", { name: "Workspace for new chat" });
  await expect(workspace.locator('option[value="/home/example/projects/atlas"]')).toHaveText("atlas · 2 sessions");
  await expect(workspace.locator('option[value*="/.kandev/tasks/"]')).toHaveCount(0);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".dh-ws")).toHaveText("/home/example/projects/atlas");
});

test("empty approved folders explain Git eligibility and exact-path fallback", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route("**/api/bootstrap*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.chats = [];
    body.catalog = [{ workspaceRoot: "/home/example/testing", label: "testing", source: "folder", sessionCount: 0 }];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  const workspace = page.getByRole("combobox", { name: "Workspace for new chat" });
  const workspaceBox = await workspace.boundingBox();
  const refreshBox = await page.getByRole("button", { name: "Refresh repositories" }).boundingBox();
  expect(workspaceBox?.width).toBeGreaterThan(180);
  expect(refreshBox?.y).toBeGreaterThan((workspaceBox?.y ?? 0) + (workspaceBox?.height ?? 0));
  await workspace.selectOption("/home/example/testing");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "No Git repository yet" })).toContainText("git init --initial-branch=main");
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Repository not listed?" }).click();
  await expect(page.getByRole("dialog", { name: "Find an existing repository by path" })).toContainText("exact Git worktree");
});

test("workspace groups progressively reveal older sessions", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route("**/api/bootstrap*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const seed = body.chats[0];
    body.chats = Array.from({ length: 45 }, (_, index) => ({
      ...seed,
      id: `rail-limit-${index}`,
      name: `rail limit ${index}`,
      workspaceRoot: "/home/example/projects/atlas",
      repoRoot: "/home/example/projects/atlas",
      updatedAt: index,
      lease: null,
      live: false,
      status: "idle",
    }));
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");

  const group = page.locator(".ses-section").filter({
    has: page.locator('.ws-name[title="/home/example/projects/atlas"]'),
  });
  await expect(group.locator(".chatrow")).toHaveCount(20);
  const search = page.getByRole("searchbox", { name: "Search sessions" });
  await search.fill("rail limit 0");
  await expect(group.locator(".chatrow")).toHaveCount(1);
  await search.fill("");
  await expect(group.locator(".chatrow")).toHaveCount(20);
  await group.getByRole("button", { name: "Show 20 more…" }).click();
  await expect(group.locator(".chatrow")).toHaveCount(40);
  await group.getByRole("button", { name: "Show 5 more…" }).click();
  await expect(group.locator(".chatrow")).toHaveCount(45);
  await expect(group.getByRole("button", { name: /Show .* more/ })).toHaveCount(0);
});

test("refresh restores process traces and shows web-session attach loading", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await newChat(page);

  const box = page.getByRole("textbox", { name: "Message input" });
  await box.fill("preserve this trace");
  await box.press("Enter");
  await expect(page.locator(".turns")).toContainText("Done.", { timeout: 6000 });

  await page.reload();
  await expect(page.locator(".conn-connected")).toBeVisible();
  await page.route("**/api/chats/*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });

  // The list summary can still be transitioning from running to waiting after the visible final
  // message. Either way, selecting the attached web session must explain the snapshot delay.
  await page.locator(".chatrow").filter({ has: page.locator(".pill-web") }).first().click();
  await expect(page.locator(".freeze")).toContainText(/Attaching to (?:active|running) session/);

  // Thinking and tool output come from the adapter snapshot now, not the lost pre-refresh SSE stream.
  await expect(page.locator(".trace-group-head")).toContainText("Work trace");
  await page.locator(".trace-group-head").click();
  await expect(page.locator(".turn.trace .thinking-head")).toBeVisible();
  await expect(page.locator(".turn.trace.tool")).toBeVisible();
  await page.locator(".tool-head").first().click();
  await expect(page.locator(".tool-preview")).toContainText("README.md");
  await page.unroute("**/api/chats/*");
});

test("desktop: Send becomes Stop while running and aborts", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await newChat(page);

  const box = page.getByRole("textbox", { name: "Message input" });
  await box.fill("a longer task to interrupt");
  await box.press("Enter");

  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  await page.route("**/api/chats/*/abort", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await stop.click();
  const stopping = page.getByRole("button", { name: "Stopping…" });
  await expect(stopping).toBeVisible();
  await expect(stopping).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 6000 });
  await page.unroute("**/api/chats/*/abort");
});

test("close detaches a web session and keeps its transcript", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await newChat(page);

  const box = page.getByRole("textbox", { name: "Message input" });
  await box.fill("keep this after close");
  await box.press("Enter");
  await expect(page.locator(".turns")).toContainText("Done.", { timeout: 6000 });

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText("Session idle", { exact: true })).toBeVisible();
  await expect(page.locator(".turns")).toContainText("keep this after close");
  await expect(page.getByRole("button", { name: "Resume session" })).toBeVisible();
});

test("explicit takeover transfers control between principals and browser devices", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await newChat(page);
  const sessionName = await page.locator(".detailhead h1").innerText();
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible();

  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { "x-pi-together-test-login": "bob" },
  });
  const phone = await phoneContext.newPage();
  await phone.goto("/");
  await expect(phone.getByText("Signed in as bob", { exact: true })).toBeVisible();
  await phone.getByRole("button", { name: "Open chat list" }).click();
  await phone.locator(".chatrow").filter({ hasText: sessionName }).first().click();
  await expect(phone.getByText("alice is controlling", { exact: true })).toBeVisible();
  const takeover = phone.getByRole("button", { name: "Take over here" });
  await takeover.click();
  const dialog = phone.getByRole("alertdialog", { name: "Take over from alice?" });
  await expect(dialog).toContainText("host user's permissions");
  await expect(phone.getByRole("button", { name: "Confirm takeover" })).toBeFocused();
  await phone.keyboard.press("Shift+Tab");
  await expect(phone.getByRole("button", { name: "Cancel" })).toBeFocused();
  await phone.keyboard.press("Escape");
  await expect(takeover).toBeFocused();
  await takeover.click();
  await phone.getByRole("button", { name: "Confirm takeover" }).click();

  const phoneComposer = phone.getByRole("textbox", { name: "Message input" });
  await expect(phoneComposer).toBeVisible();
  await phoneComposer.fill("prompt from bob");
  await phone.getByRole("button", { name: "Send" }).click();
  await expect(phone.locator(".role-user").last()).toHaveClass(/author-own/);
  await expect(phone.locator(".role-user .turn-author").last()).toContainText("You");
  await phone.getByRole("button", { name: "Session settings" }).click();
  await phone.locator(".control-history summary").click();
  await expect(phone.locator(".control-history")).toContainText("You took control from alice.");
  await expect(phone.locator(".control-history")).toContainText("retained when the session is copied");
  const rawViewer = await phone.evaluate(() => sessionStorage.getItem("pi-together:viewer"));
  expect(rawViewer).toBeTruthy();
  expect(await phone.locator(".control-history").innerText()).not.toContain(rawViewer!);
  await expect(page.getByText("bob is controlling", { exact: true })).toBeVisible();
  const displaced = page.locator(".control-notice");
  await expect(displaced).toContainText("bob took over this session");
  await expect(displaced).toContainText("Your draft is saved");
  await displaced.getByRole("button", { name: "Dismiss" }).click();
  await expect(displaced).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message input" })).toHaveCount(0);
  await expect(page.locator(".role-user").last()).toHaveClass(/author-other/);
  await expect(page.locator(".role-user .turn-author").last()).toContainText("bob");
  await phoneContext.close();
});

test("external session is gated behind take-over, then drivable", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route("**/api/chats/*?viewer=*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.chat) body.chat.leaseHistory = [];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  // a seeded on-disk session (untouched by other tests) shows "external" + take-over, not a composer
  await page.getByText("atlas refactor").click();
  await expect(page.locator(".dh-sub .pill-ext")).toBeVisible();
  await expect(page.locator(".takeover")).toBeVisible();
  await expect(page.locator(".role-user").first()).toHaveClass(/author-unattributed/);
  await expect(page.locator(".role-user .turn-author").first()).toContainText("Local / unknown");
  await expect(page.getByRole("textbox", { name: "Message input" })).toHaveCount(0);
  await expect(page.locator(".control-history")).toHaveCount(0); // empty audit UI does not consume composer space
  // take over → drivable (composer + controls), but it stays external (no claiming of provenance)
  await page.getByRole("button", { name: "Take over & drive here" }).click();
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({ timeout: 6000 });
  await expect(page.locator(".controls select").first()).toBeEnabled();
  await expect(page.locator(".dh-sub .pill-ext")).toBeVisible(); // still external, just now driven here
});

test("mobile: drawer opens, create chat, send with explicit button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const menu = page.getByRole("button", { name: "Open chat list" });
  await expect(menu).toBeVisible();
  await menu.click();
  const openDrawer = page.locator(".sidebar.drawer.open");
  await expect(openDrawer).toBeVisible();
  await expect(openDrawer).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await expect(page.locator(".sidebar.drawer")).toHaveAttribute("inert", "");
  await menu.click();

  // The native select is populated from real session workspaces. Native selects dispatch the same
  // change event after a touch-picker choice on mobile, unlike the old datalist implementation.
  const workspace = page.getByRole("combobox", { name: "Workspace for new chat" });
  const search = page.getByRole("searchbox", { name: "Search sessions" });
  expect(await workspace.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await search.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  await expect(workspace.locator('option[value="/home/example/projects/beacon"]')).toContainText("session");
  await workspace.selectOption("/home/example/projects/beacon");
  await expect(workspace).toHaveValue("/home/example/projects/beacon");

  // create from inside the drawer; it closes on create and uses the tapped workspace
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".sidebar.drawer.open")).toHaveCount(0);
  await expect(page.locator(".sidebar.drawer")).toHaveAttribute("inert", "");
  await expect(menu).toBeFocused();
  await expect(page.locator(".detailhead h1")).toBeVisible();
  await expect(page.locator(".dh-ws")).toHaveText("/home/example/projects/beacon");
  await expect(page.locator(".control-history")).toHaveCount(0);
  await page.getByRole("button", { name: "Session settings" }).click();
  const mobileActions = page.locator(".detailhead .actions");
  await expect(mobileActions.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(mobileActions.locator(".control-history")).toBeVisible();

  const box = page.getByRole("textbox", { name: "Message input" });
  await expect(box).toHaveAttribute("placeholder", "Message Pi…"); // short enough to keep the mobile composer one line
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
  const bottomPadding = await page.locator(".composer").evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  expect(bottomPadding).toBeGreaterThanOrEqual(14); // plus env(safe-area-inset-bottom) on notched iPhones
  await box.fill("hi from mobile");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".turns")).toContainText("hi from mobile");
  await expect(page.locator(".turns")).toContainText("Done.", { timeout: 6000 });
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("browser without crypto.randomUUID can create a session", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, "randomUUID", { configurable: true, value: undefined });
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");

  await newChat(page);
  await expect(page.locator(".detailhead h1")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const viewer = await page.evaluate(() => sessionStorage.getItem("pi-together:viewer"));
  expect(viewer).toMatch(/^v_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("keyboard: search box is focusable and filters the list", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search sessions" });
  await search.click();
  await expect(search).toBeFocused();
  await search.fill("beacon pulse");
  await expect(page.locator(".chatrow")).toHaveCount(1);
});

test("reconnect recovery: stream works again after an SSE drop", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await newChat(page);
  const sessionName = `reconnect-${Date.now()}`;
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename session" });
  await rename.getByRole("textbox", { name: "Session name" }).fill(sessionName);
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".detailhead h1")).toHaveText(sessionName);

  // Simulate a transient network blip, then hold the recovery snapshot long enough to verify both
  // loading phases. The chat must remain frozen until that authoritative snapshot is attached.
  await page.route("**/api/bootstrap*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.route("**/events*", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".conn-reconnecting")).toBeVisible({ timeout: 6000 });
  await expect(page.locator(".freeze")).toContainText("Reconnecting");
  await page.unroute("**/events*");

  await expect(page.locator(".conn-reattaching")).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".freeze")).toContainText("Reattaching");
  await expect(page.locator(".conn-connected")).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".freeze")).toHaveCount(0);
  await page.unroute("**/api/bootstrap*");
  await page.locator(".chatrow").filter({ hasText: sessionName }).first().click();
  const box = page.getByRole("textbox", { name: "Message input" });
  await box.fill("after reconnect");
  await box.press("Enter");
  await expect(page.locator(".turns")).toContainText("after reconnect");
  await expect(page.locator(".turns")).toContainText("Done.", { timeout: 6000 });
});

test("opened tabs get distinct active viewer identities", async ({ page, context }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await newChat(page);
  await page.getByRole("textbox", { name: "Message input" }).fill("unsent draft survives");
  const sessionName = await page.locator(".detailhead h1").innerText();
  const firstViewer = await page.evaluate(() => sessionStorage.getItem("pi-together:viewer"));

  const popupPromise = context.waitForEvent("page");
  await page.evaluate(() => window.open("/", "_blank"));
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await expect(popup.locator(".conn-connected")).toBeVisible();
  const secondViewer = await popup.evaluate(() => sessionStorage.getItem("pi-together:viewer"));

  expect(firstViewer).toBeTruthy();
  expect(secondViewer).toBeTruthy();
  expect(secondViewer).not.toBe(firstViewer);
  const visibleLocks = await page.evaluate(async () => {
    const locks = await navigator.locks.query();
    return JSON.stringify(locks);
  });
  expect(visibleLocks).not.toContain(firstViewer!);
  expect(visibleLocks).not.toContain(secondViewer!);
  await popup.locator(".chatrow").filter({ hasText: sessionName }).first().click();
  await expect(popup.getByText("Controlled in another tab or device", { exact: true })).toBeVisible();
  await expect(popup.getByRole("textbox", { name: "Message input" })).toHaveCount(0);
  await popup.getByRole("button", { name: "Take over here" }).click();
  await popup.getByRole("button", { name: "Confirm takeover" }).click();
  await expect(page.locator(".control-notice")).toContainText("another tab or device");
  await page.getByRole("button", { name: "Take over here" }).click();
  await page.getByRole("button", { name: "Confirm takeover" }).click();
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible();
  await expect(page.locator(".control-notice")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message input" })).toHaveValue("unsent draft survives");
});

test("rename uses an accessible dialog instead of a browser prompt", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await newChat(page);
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rename session" });
  const input = dialog.getByRole("textbox", { name: "Session name" });
  await expect(input).toBeFocused();
  await input.fill("multiplayer polish");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".detailhead h1")).toHaveText("multiplayer polish");
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "Rename", exact: true }).click();
  const cancelDialog = page.getByRole("dialog", { name: "Rename session" });
  await cancelDialog.getByRole("textbox", { name: "Session name" }).fill("must not save");
  await cancelDialog.getByRole("button", { name: "Cancel" }).press("Enter");
  await expect(page.locator(".detailhead h1")).toHaveText("multiplayer polish");
});

test("routine controller metadata stays out of the chat while presence still connects", async ({ page }) => {
  const eventUrls: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/events")) eventUrls.push(request.url()); });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Workspace for new chat" }).selectOption("/home/example/projects/atlas");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByText("Controller", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Session participants" })).toHaveCount(0);
  await expect.poll(() => eventUrls).toEqual(expect.arrayContaining([expect.stringContaining("chatId=")]));
});

test("failed sends preserve the local draft", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await newChat(page);
  await page.route("**/api/chats/*/messages", (route) => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ error: "chat is controlled by another viewer" }),
  }));
  const input = page.getByRole("textbox", { name: "Message input" });
  await input.fill("keep this draft");
  await input.press("Enter");
  await expect(input).toHaveValue("keep this draft");
  await expect(page.getByRole("alert")).toContainText("Control changed");
});
