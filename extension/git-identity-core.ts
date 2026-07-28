import { GitHubActorSchema, type AttributionData } from "../pi-adapter/collaboration-entries.js";

export interface GitIdentity { name: string; email: string }
export type BotGitIdentity = GitIdentity;
export interface ManagedGitIdentity { author: GitIdentity; committer: GitIdentity }

const CONTROLS_OR_IDENT_DELIMITERS = /[\u0000-\u001f\u007f<>\r\n]/;
const MAX_PENDING_TURN_IDENTITIES = 128;

function safeIdentity(identity: GitIdentity): GitIdentity {
  if (!identity.name || identity.name.length > 128 || CONTROLS_OR_IDENT_DELIMITERS.test(identity.name)) {
    throw new Error("Git identity name is invalid");
  }
  if (identity.email.length > 320 || CONTROLS_OR_IDENT_DELIMITERS.test(identity.email)) {
    throw new Error("Git identity email is invalid");
  }
  if (identity.email) {
    const match = identity.email.match(/^([1-9]\d{0,31})\+(.+)@users\.noreply\.github\.com$/);
    if (!match || !GitHubActorSchema.safeParse({ provider: "github", subject: match[1], login: match[2] }).success) {
      throw new Error("Git identity email must be a verified GitHub noreply form or absent");
    }
  }
  return { name: identity.name, email: identity.email };
}

/** Human email exists only for an actor that passes the durable verified-GitHub schema. */
export function gitIdentityForActor(actor: unknown, configuredBot: BotGitIdentity): ManagedGitIdentity {
  const bot = safeIdentity(configuredBot);
  const parsed = GitHubActorSchema.safeParse(actor);
  if (!parsed.success) return { author: bot, committer: bot };
  const { subject, login } = parsed.data;
  return {
    author: { name: login, email: `${subject}+${login}@users.noreply.github.com` },
    committer: bot,
  };
}

/**
 * Bounded delivery-order state. Lease changes are intentionally absent: only a consumed signed
 * message can enqueue an identity, and only Pi delivering a user message can make it active.
 */
export class TurnGitIdentityState {
  private readonly prompt: AttributionData[] = [];
  private readonly steer: AttributionData[] = [];
  private readonly followUp: AttributionData[] = [];
  private active: ManagedGitIdentity;

  constructor(private readonly bot: BotGitIdentity, private readonly maxPending = MAX_PENDING_TURN_IDENTITIES) {
    safeIdentity(bot);
    if (!Number.isSafeInteger(maxPending) || maxPending <= 0) throw new Error("Git identity queue cap must be positive");
    this.active = gitIdentityForActor(undefined, bot);
  }

  get identity(): ManagedGitIdentity {
    return {
      author: { ...this.active.author },
      committer: { ...this.active.committer },
    };
  }

  get pendingCount(): number { return this.prompt.length + this.steer.length + this.followUp.length; }

  reserve(data: AttributionData): false | (() => void) {
    if (this.pendingCount >= this.maxPending) return false;
    const queue = data.action === "prompt" ? this.prompt : data.action === "steer" ? this.steer : this.followUp;
    queue.push(data);
    return () => {
      const index = queue.lastIndexOf(data);
      if (index >= 0) queue.splice(index, 1);
    };
  }

  accept(data: AttributionData): boolean {
    return this.reserve(data) !== false;
  }

  deliverUserMessage(): ManagedGitIdentity {
    // Reset first: an exception or unmatched native input must never reuse a previous human.
    this.active = gitIdentityForActor(undefined, this.bot);
    const delivered = this.prompt.shift() ?? this.steer.shift() ?? this.followUp.shift();
    if (delivered) this.active = gitIdentityForActor(delivered.actor, this.bot);
    return this.identity;
  }

  settle(): void {
    this.prompt.length = 0;
    this.steer.length = 0;
    this.followUp.length = 0;
    this.active = gitIdentityForActor(undefined, this.bot);
  }
}

const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C", "-c", "--config-env", "--exec-path", "--git-dir", "--namespace", "--super-prefix", "--work-tree",
]);

function commandIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") return -1;
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) { index++; continue; }
    if (/^-C.+/.test(arg) || /^-c.+/.test(arg) || /^--(?:config-env|exec-path|git-dir|namespace|super-prefix|work-tree)=/.test(arg)) continue;
    if (arg.startsWith("-")) continue;
    return index;
  }
  return -1;
}

function formatAuthor(identity: GitIdentity): string {
  const safe = safeIdentity(identity);
  return `${safe.name} <${safe.email}>`;
}

/** Pure argv/env projection used by the fixed launcher and synthetic Git integration tests. */
export function managedGitInvocation(
  inputArgs: readonly string[],
  inputEnv: NodeJS.ProcessEnv,
  identity: ManagedGitIdentity,
  agentTrailer: string,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const author = safeIdentity(identity.author);
  const committer = safeIdentity(identity.committer);
  if (!agentTrailer || agentTrailer.length > 256 || CONTROLS_OR_IDENT_DELIMITERS.test(agentTrailer)) {
    throw new Error("Git agent trailer is invalid");
  }
  const env = {
    ...inputEnv,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  };
  const args = [...inputArgs];
  const subcommand = commandIndex(args);
  if (subcommand < 0 || args[subcommand] !== "commit") return { args, env };
  // Git trailer policy is command-scoped and leaves repository/global configuration untouched.
  const trailerConfig = [
    "-c", "trailer.Agent.key=Agent",
    "-c", "trailer.Agent.ifexists=replace",
    "-c", "trailer.Agent.ifmissing=add",
  ];
  args.splice(subcommand, 0, ...trailerConfig);
  const managedCommit = subcommand + trailerConfig.length;
  const separator = args.indexOf("--", managedCommit + 1);
  const insertion = separator < 0 ? args.length : separator;
  args.splice(insertion, 0,
    `--author=${formatAuthor(author)}`,
    "--no-gpg-sign",
    `--trailer=Agent: ${agentTrailer}`,
  );
  return { args, env };
}
