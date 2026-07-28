import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { AdapterEvent, ChatSummary, PiAdapter } from "../shared/protocol.js";
import { RepositoryDiscovery } from "../server/workspace-policy.js";
import { WorkspacePolicyAdapter } from "../pi-adapter/workspace-policy-adapter.js";
import { RuntimeRegistry } from "../server/runtime-registry.js";

const exec = promisify(execFile);
async function repo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await exec("git", ["init", "-q"], { cwd: path });
  await writeFile(join(path, "README.md"), "fixture\n");
}
const summary = (id: string, cwd: string): ChatSummary => ({
  id, name: id, status: "idle", workspaceRoot: cwd, repoRoot: cwd,
  updatedAt: 1, turnCount: 0, lease: null, live: false, toolMode: null, origin: "external",
});

function adapter(chats: ChatSummary[]) {
  const listeners = new Set<(event: AdapterEvent) => void>();
  const calls = { resume: vi.fn(async (id: string) => chats.find((chat) => chat.id === id)!), send: vi.fn(async () => ({ accepted: true, queued: false })) };
  const value = {
    kind: "fake", listChats: vi.fn(async () => chats), getChat: vi.fn(async () => null), resume: calls.resume,
    detach: vi.fn(), compact: vi.fn(), rename: vi.fn(), listWorkspaces: vi.fn(), openWorkspace: vi.fn(), createChat: vi.fn(), catalog: vi.fn(), models: vi.fn(async () => []),
    send: calls.send, abort: vi.fn(), getConfig: vi.fn(), setConfig: vi.fn(), extensionUiResponse: vi.fn(), recordLeaseEvent: vi.fn(),
    subscribe: (listener: (event: AdapterEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    close: vi.fn(async () => undefined),
  } as unknown as PiAdapter;
  return { value, calls, emit: (event: AdapterEvent) => { for (const listener of listeners) listener(event); } };
}

describe("WorkspacePolicyAdapter", () => {
  it("omits outside sessions and guards every ID operation before delegating", async () => {
    const home = await mkdtemp(join(tmpdir(), "pt-policy-adapter-"));
    const shared = join(home, "projects");
    const inside = join(shared, "atlas");
    const outside = join(home, "private", "secret");
    await repo(inside); await repo(outside);
    const mock = adapter([summary("inside", inside), summary("outside-sensitive", outside)]);
    const policy = new WorkspacePolicyAdapter(mock.value, new RepositoryDiscovery([shared]));

    expect((await policy.listChats()).map((chat) => chat.id)).toEqual(["inside"]);
    await expect(policy.resume("outside-sensitive")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(policy.send("outside-sensitive", "mutate", "normal")).rejects.toMatchObject({ code: "ENOENT" });
    expect(mock.calls.resume).not.toHaveBeenCalled();
    expect(mock.calls.send).not.toHaveBeenCalled();
  });

  it("catalogs an approved empty folder without making it an eligible repository", async () => {
    const home = await mkdtemp(join(tmpdir(), "pt-policy-empty-"));
    const empty = join(home, "testing");
    await mkdir(empty, { recursive: true });
    const mock = adapter([]);
    const policy = new WorkspacePolicyAdapter(mock.value, new RepositoryDiscovery([empty]));
    expect(await policy.catalog()).toEqual([{ workspaceRoot: empty, label: "testing", source: "folder", sessionCount: 0 }]);
    await expect(policy.createChat(empty)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mock.value.createChat).not.toHaveBeenCalled();
  });

  it("drops unauthorized adapter events before subscribers can record or replay them", async () => {
    const home = await mkdtemp(join(tmpdir(), "pt-policy-events-"));
    const shared = join(home, "projects");
    const inside = join(shared, "atlas");
    const outside = join(home, "private", "secret");
    await repo(inside); await repo(outside);
    const mock = adapter([summary("inside", inside), summary("outside-sensitive", outside)]);
    const policy = new WorkspacePolicyAdapter(mock.value, new RepositoryDiscovery([shared]));
    const received: AdapterEvent[] = [];
    policy.subscribe((event) => received.push(event));
    mock.emit({ type: "chat.status", chatId: "outside-sensitive", status: "running" });
    mock.emit({ type: "chat.status", chatId: "inside", status: "running" });
    for (let attempt = 0; attempt < 40 && received.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(received).toEqual([{ type: "chat.status", chatId: "inside", status: "running" }]);
    expect(JSON.stringify(received)).not.toContain("outside-sensitive");

    const registry = new RuntimeRegistry(policy);
    const first: AdapterEvent[] = [];
    registry.add({ id: "first", send: (_id, event) => first.push(event) });
    mock.emit({ type: "chat.status", chatId: "outside-sensitive", status: "running" });
    mock.emit({ type: "chat.status", chatId: "inside", status: "running" });
    for (let attempt = 0; attempt < 40 && !first.some((event) => event.type === "chat.status"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const replay: AdapterEvent[] = [];
    registry.add({ id: "replay", send: (_id, event) => replay.push(event) }, 1);
    expect(JSON.stringify([...first, ...replay])).not.toContain("outside-sensitive");
    expect([...first, ...replay].some((event) => event.type === "chat.status" && event.chatId === "inside")).toBe(true);
    registry.close();
  });
});
