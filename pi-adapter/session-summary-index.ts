// pi-adapter/session-summary-index.ts — persistent, incremental metadata index for Pi JSONL sessions.
// The session rail needs only this bounded summary. Full thinking/tool/message payloads stay on disk
// until getChat() opens one selected conversation.
import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { deriveNameFromTurns, renderContent, type RawSessionEntry } from "./normalize.js";

const INDEX_VERSION = 1;

export interface IndexedSession {
  file: string;
  id: string;
  cwd: string;
  repoRoot: string;
  name: string;
  updatedAt: number;
  turnCount: number;
  size: number;
  mtimeMs: number;
}

interface IndexRecord extends IndexedSession {
  ino: number;
  indexedBytes: number;
  explicitName: string | null;
  derivedName: string | null;
}

interface PersistedIndex {
  version: typeof INDEX_VERSION;
  records: IndexRecord[];
}

function epoch(value: string | number | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value < 1e12 ? Math.round(value * 1000) : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function validRecord(value: unknown): value is IndexRecord {
  const r = value as Partial<IndexRecord> | null;
  return !!r
    && typeof r.file === "string"
    && typeof r.id === "string"
    && typeof r.cwd === "string"
    && typeof r.repoRoot === "string"
    && typeof r.name === "string"
    && typeof r.updatedAt === "number"
    && typeof r.turnCount === "number"
    && typeof r.size === "number"
    && typeof r.mtimeMs === "number"
    && typeof r.ino === "number"
    && typeof r.indexedBytes === "number"
    && (typeof r.explicitName === "string" || r.explicitName === null)
    && (typeof r.derivedName === "string" || r.derivedName === null);
}

function updateRecord(record: IndexRecord, entry: RawSessionEntry): void {
  const outerTs = epoch(entry.timestamp);
  if (outerTs && outerTs > record.updatedAt) record.updatedAt = outerTs;

  if (entry.type === "session") {
    if (typeof entry.id === "string") record.id = entry.id;
    if (typeof entry.cwd === "string") record.cwd = entry.cwd;
    return;
  }
  if (entry.type === "session_info") {
    if (typeof entry.name === "string") record.explicitName = entry.name;
    return;
  }
  if (entry.type !== "message" || !entry.message) return;

  const messageTs = epoch(entry.message.timestamp);
  if (messageTs && messageTs > record.updatedAt) record.updatedAt = messageTs;
  const role = String(entry.message.role ?? "").toLowerCase();
  const text = renderContent(entry.message.content);
  if ((role === "user" || role === "system" || role === "tool") && (text || role === "user")) record.turnCount++;
  else if (role === "assistant" && text) record.turnCount++;

  if (!record.derivedName && role === "user") {
    record.derivedName = deriveNameFromTurns([{ id: String(entry.id ?? "summary"), role: "user", text, ts: messageTs ?? outerTs ?? 0 }]);
  }
}

function displayName(record: IndexRecord): string {
  if (record.explicitName !== null) return record.explicitName;
  if (record.derivedName) return record.derivedName;
  const day = new Date(record.updatedAt || Date.now()).toISOString().slice(0, 10);
  return `${basename(record.cwd)} · ${day}`;
}

export class SessionSummaryIndex {
  private readonly indexFile: string;
  private records = new Map<string, IndexRecord>();
  private loaded = false;
  private refreshInFlight: Promise<IndexedSession[]> | null = null;

  constructor(
    sessionsDir: string,
    indexName: string,
    private readonly fallbackCwd: string,
    private readonly resolveRepoRoot: (cwd: string) => Promise<string>,
  ) {
    this.indexFile = join(sessionsDir, indexName);
  }

  refresh(files: string[]): Promise<IndexedSession[]> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh(files).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.indexFile, "utf8")) as Partial<PersistedIndex>;
      if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.records)) return;
      for (const record of parsed.records) if (validRecord(record)) this.records.set(record.file, record);
    } catch {
      // Missing/corrupt indexes are rebuilt from the authoritative JSONL files.
    }
  }

  private async doRefresh(files: string[]): Promise<IndexedSession[]> {
    await this.load();
    const present = new Set(files);
    let changed = false;
    for (const file of this.records.keys()) {
      if (!present.has(file)) {
        this.records.delete(file);
        changed = true;
      }
    }

    await Promise.all(files.map(async (file) => {
      let fileStat;
      try {
        fileStat = await stat(file);
      } catch {
        return;
      }
      const old = this.records.get(file);
      if (old && old.size === fileStat.size && old.mtimeMs === fileStat.mtimeMs && old.ino === fileStat.ino) return;

      // Equal-size mtime changes may be in-place rewrites, not appends; rebuild those defensively.
      const canAppend = !!old && old.ino === fileStat.ino && fileStat.size > old.size && fileStat.size >= old.indexedBytes;
      const record: IndexRecord = canAppend
        ? { ...old }
        : {
            file,
            id: basename(file).replace(/\.jsonl$/, ""),
            cwd: this.fallbackCwd,
            repoRoot: "",
            name: "",
            updatedAt: 0,
            turnCount: 0,
            size: 0,
            mtimeMs: 0,
            ino: fileStat.ino,
            indexedBytes: 0,
            explicitName: null,
            derivedName: null,
          };
      const start = canAppend ? record.indexedBytes : 0;
      const length = Math.max(0, fileStat.size - start);
      if (length) {
        const handle = await open(file, "r");
        try {
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, start);
          const chunk = buffer.subarray(0, bytesRead);
          const finalNewline = chunk.lastIndexOf(0x0a);
          if (finalNewline >= 0) {
            for (const line of chunk.subarray(0, finalNewline).toString("utf8").split("\n")) {
              if (!line.trim()) continue;
              try {
                updateRecord(record, JSON.parse(line) as RawSessionEntry);
              } catch {
                // Ignore malformed physical lines, matching full transcript loading.
              }
            }
            record.indexedBytes = start + finalNewline + 1;
          }
        } finally {
          await handle.close();
        }
      }
      record.size = fileStat.size;
      record.mtimeMs = fileStat.mtimeMs;
      record.ino = fileStat.ino;
      if (!record.repoRoot) record.repoRoot = await this.resolveRepoRoot(record.cwd);
      record.name = displayName(record);
      this.records.set(file, record);
      changed = true;
    }));

    if (changed) await this.persist();
    const byId = new Map<string, IndexRecord>();
    for (const record of this.records.values()) {
      if (!record.id) continue;
      const previous = byId.get(record.id);
      if (!previous || record.updatedAt > previous.updatedAt) byId.set(record.id, record);
    }
    return [...byId.values()].map((record) => ({
      file: record.file,
      id: record.id,
      cwd: record.cwd,
      repoRoot: record.repoRoot,
      name: record.name,
      updatedAt: record.updatedAt,
      turnCount: record.turnCount,
      size: record.size,
      mtimeMs: record.mtimeMs,
    }));
  }

  private async persist(): Promise<void> {
    const temp = `${this.indexFile}.${process.pid}.${randomUUID()}.tmp`;
    const body: PersistedIndex = { version: INDEX_VERSION, records: [...this.records.values()] };
    try {
      await writeFile(temp, JSON.stringify(body), { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.indexFile);
    } catch {
      await unlink(temp).catch(() => undefined);
      // The index is only an optimization; read-only session directories remain supported.
    }
  }
}
