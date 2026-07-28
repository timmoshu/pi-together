// pi-adapter/index.ts — pick the adapter implementation from config.
import type { PiAdapter } from "../shared/protocol.js";
import { FakeAdapter } from "./fake.js";
import { RealAdapter } from "./real.js";
import { RepositoryDiscovery } from "../server/workspace-policy.js";
import { WorkspacePolicyAdapter } from "./workspace-policy-adapter.js";

export function createAdapter(
  kind: "real" | "fake",
  options: {
    collaboration?: boolean;
    attributionExtensionPath?: string;
    gitCommitterName?: string;
    gitCommitterEmail?: string;
    gitLauncherPath?: string;
    sharedRepositoryFolders?: string[];
  } = {},
): PiAdapter {
  const adapter: PiAdapter = kind === "fake" ? new FakeAdapter() : new RealAdapter(options);
  return options.sharedRepositoryFolders
    ? new WorkspacePolicyAdapter(adapter, new RepositoryDiscovery(options.sharedRepositoryFolders))
    : adapter;
}

export { FakeAdapter } from "./fake.js";
export { RealAdapter } from "./real.js";
