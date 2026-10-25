import { type FormEvent, useState } from "react";
import { useInvitationActions, useInvitations, useMembers } from "../api/account";
import { useMe } from "../api/queries";
import type { Role } from "../api/types";
import { fullDate, timeAgo } from "../format";

// The org's people: who's in, who's invited, and an invite form for admins
export function TeamPanel({ orgId, role }: { orgId: string; role: Role | undefined }) {
  const isAdmin = role === "owner" || role === "admin";
  const members = useMembers(orgId);
  const invitations = useInvitations(orgId, isAdmin);
  const { invite, revoke } = useInvitationActions(orgId);
  const me = useMe();
  const [sentTo, setSentTo] = useState<string | null>(null);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email"));
    invite.mutate(
      { email, role: String(data.get("role")) as Role },
      {
        onSuccess: () => {
          setSentTo(email);
          form.reset();
        },
      },
    );
  };

  return (
    <section className="panel">
      <h2>Team</h2>
      <table className="issue-table">
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {(members.data ?? []).map((member) => (
            <tr key={member.userId}>
              <td>
                {member.name}
                {member.userId === me.data?.id && <span className="muted"> (you)</span>}
                <div className="muted">{member.email}</div>
              </td>
              <td className="capitalize">{member.role}</td>
              <td title={fullDate(member.joinedAt)}>{timeAgo(member.joinedAt)}</td>
            </tr>
          ))}
          {(invitations.data ?? []).map((invitation) => (
            <tr key={invitation.id}>
              <td>
                {invitation.email}
                <div className="muted">Invited, expires {timeAgo(invitation.expiresAt)}</div>
              </td>
              <td className="capitalize">{invitation.role}</td>
              <td>
                <button
                  type="button"
                  className="link-button danger"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(invitation.id)}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {isAdmin ? (
        <form className="form-row invite-form" onSubmit={onSubmit}>
          <label className="inline-label">
            <span className="sr-only">Email</span>
            <input
              name="email"
              type="email"
              className="invite-email"
              required
              placeholder="teammate@example.com"
            />
          </label>
          <label className="inline-label">
            <span className="sr-only">Role</span>
            <select name="role" defaultValue="member">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              {role === "owner" && <option value="owner">Owner</option>}
            </select>
          </label>
          <button type="submit" className="button button-primary" disabled={invite.isPending}>
            {invite.isPending ? "Sending…" : "Send invitation"}
          </button>
          {invite.error && (
            <p className="form-error" role="alert">
              {invite.error.message}
            </p>
          )}
          {sentTo && !invite.error && (
            <p className="muted" role="status">
              Invitation sent to {sentTo}. The link works for 7 days.
            </p>
          )}
        </form>
      ) : (
        <p className="muted">Ask an admin to invite people.</p>
      )}
    </section>
  );
}
