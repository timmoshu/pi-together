import type { PresenceParticipant, PrincipalIdentity } from "../../../shared/protocol";
import { samePrincipal } from "../principal";

/** Show ephemeral presence only when another person or browser is actually noteworthy. */
export function CollaborationBanner({
  principal,
  participants,
}: {
  principal: PrincipalIdentity;
  participants: PresenceParticipant[];
}) {
  const collaborative = participants.some((participant) =>
    !samePrincipal(participant.actor, principal) || participant.viewerCount > 1,
  );
  if (!collaborative) return null;

  return (
    <section className="collaboration-banner" aria-label="Session participants">
      <div className="presence-row" role="status">
        <strong>Here now</strong>
        <ul aria-label={`${participants.length} present participant${participants.length === 1 ? "" : "s"}`}>
          {participants.map((participant) => (
            <li key={`${participant.actor.provider}:${participant.actor.subject}`}>
              {samePrincipal(participant.actor, principal) ? "You" : participant.actor.login}
              {participant.viewerCount > 1 && <span> · {participant.viewerCount} viewers</span>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
