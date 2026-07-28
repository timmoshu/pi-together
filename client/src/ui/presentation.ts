import type {
  LeaseHistoryEvent,
  LeaseInfo,
  PrincipalIdentity,
  TurnAttribution,
} from "../../../shared/protocol";
import type { SelectedState } from "../store";
import { samePrincipal } from "../principal";

export const isBusy = (state: SelectedState | null) =>
  !!state && (state.runState === "running" || state.runState === "stopping" || state.runState === "retrying" || state.runState === "compacting");

export const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const delta = new Date(iso).getTime() - now;
  const absolute = Math.abs(delta);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60 * 1000],
    ["month", 30 * 24 * 60 * 60 * 1000],
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
  ];
  const [unit, size] = units.find(([, candidate]) => absolute >= candidate) ?? ["second", 1000];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(delta / size), unit);
}

export function authorPresentation(attribution: TurnAttribution | undefined, principal: PrincipalIdentity) {
  if (!attribution) return {
    kind: "unattributed" as const,
    author: principal.provider === "local" ? "Local input" : "Local / unknown",
    action: null,
  };
  const own = samePrincipal(attribution.actor, principal);
  const action = attribution.action === "steer"
    ? "steered"
    : attribution.action === "followUp"
      ? "follow-up"
      : null;
  return { kind: own ? "own" as const : "other" as const, author: own ? "You" : attribution.actor.login, action };
}

export function canRespondToExtension(lease: LeaseInfo | null): boolean {
  return !lease || lease.isHolder === true;
}

export function controllerPresentation(lease: LeaseInfo | null, principal: PrincipalIdentity) {
  if (!lease) return { relation: "none" as const, text: "No one is controlling this session." };
  if (lease.isHolder) return { relation: "mine" as const, text: "You’re controlling this session in this tab." };
  if (samePrincipal(lease.actor, principal)) {
    return { relation: "mine-elsewhere" as const, text: "You’re controlling this session in another tab or device." };
  }
  return { relation: "other" as const, text: `${lease.actor.login} is controlling this session.` };
}

function actorLabel(actor: LeaseHistoryEvent["previous"], principal: PrincipalIdentity, sentenceStart = false): string {
  if (!actor) return sentenceStart ? "Unknown" : "unknown";
  if (samePrincipal(actor.actor, principal)) return sentenceStart ? "You" : "you";
  return actor.actor.login;
}

export function historySentence(event: LeaseHistoryEvent, principal: PrincipalIdentity): string {
  const previous = actorLabel(event.previous, principal);
  const next = actorLabel(event.next, principal, true);
  if (event.event === "takenOver" && event.sameActorViewerChanged && event.previous) {
    return samePrincipal(event.previous.actor, principal)
      ? "You moved control to another tab or device."
      : `${event.previous.actor.login} moved control to another tab or device.`;
  }
  switch (event.event) {
    case "acquired": return `${next} acquired control.`;
    case "released": return `${actorLabel(event.previous, principal, true)} released control.`;
    case "expired": return samePrincipal(event.previous?.actor, principal)
      ? "Your control expired."
      : `${actorLabel(event.previous, principal, true)}’s control expired.`;
    case "takenOver": return `${next} took control from ${previous}.`;
    case "recovered": return `${next} recovered control after a server restart.`;
  }
}


export function controlLostMessage(notice: { samePrincipal: boolean; actor: PrincipalIdentity }): string {
  const lead = notice.samePrincipal
    ? "This session was taken over in another tab or device."
    : `${notice.actor.login} took over this session.`;
  return `${lead} You’re now viewing read-only. Your draft is saved.`;
}
