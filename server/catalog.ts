// server/catalog.ts — assembles the "what can I open / where" catalog the dashboard shows.
import type { CatalogEntry, PiAdapter } from "../shared/protocol.js";

export interface Catalog {
  catalog: CatalogEntry[];
  workspaces: string[];
}

export async function buildCatalog(adapter: PiAdapter): Promise<Catalog> {
  const [catalog, workspaces] = await Promise.all([adapter.catalog(), adapter.listWorkspaces()]);
  return { catalog, workspaces: [...new Set(workspaces)].sort() };
}
