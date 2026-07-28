import type {
  BootstrapPayload,
  ChatConfig,
  ChatDetail,
  ChatSummary,
  ChatTimelineItem,
  ExtensionUiRequest,
  ModelInfo,
  PrincipalIdentity,
  PresenceSnapshot,
  RunState,
} from "../../shared/protocol";

export type Connection = "connecting" | "connected" | "reconnecting" | "reattaching";
export type ToolCard = Extract<ChatTimelineItem, { kind: "tool" }>;
export type TimelineItem = ChatTimelineItem | { kind: "notice"; id: string; noticeKind: string; text: string };

export type ExtRequest = ExtensionUiRequest;

export interface Live {
  itemId: string | null;
  assistant: string;
  thinking: string;
  active: boolean;
}

export interface SelectedState {
  id: string;
  summary: ChatSummary;
  config: ChatConfig | null;
  queue: { steering: string[]; followUp: string[] };
  runState: RunState;
  timeline: TimelineItem[];
  live: Live;
  ext: ExtRequest | null;
  leaseHistory: NonNullable<ChatDetail["leaseHistory"]>;
}

export interface ControlNotice {
  chatId: string;
  leaseId: string;
  actor: PrincipalIdentity;
  samePrincipal: boolean;
}

export interface AppState {
  boot: BootstrapPayload | null;
  connection: Connection;
  chats: ChatSummary[];
  models: ModelInfo[];
  workspaceDiscoveryTruncated?: boolean;
  presence: Record<string, PresenceSnapshot>;
  selected: SelectedState | null;
  error: string | null;
  pending: string | null;
  controlNotice: ControlNotice | null;
}
