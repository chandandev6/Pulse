import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router";
import { useProjectRole } from "../api/alerts";
import {
  type Channel,
  type ChannelType,
  type Delivery,
  SEVERITY_CHOICES,
  useChannelActions,
  useDeliveries,
  useMyChannels,
  useOrgChannels,
} from "../api/notifications";
import { useOrgs, useProject } from "../api/queries";
import type { Severity } from "../api/types";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { fullDate, timeAgo } from "../format";
import { pushSupported, subscribeThisBrowser } from "../push";

const TYPE_LABEL: Record<ChannelType, string> = {
  email: "Email",
  sms: "SMS",
  push: "Browser push",
  webhook: "Webhook",
  slack: "Slack",
  discord: "Discord",
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : null);

// A new email address or phone number gets a 6-digit code; nothing else is sent there
// until it's typed in here (so nobody can make Pulse message a stranger)
function VerifyChannel({ channel, orgId }: { channel: Channel; orgId: string | null }) {
  const { verify, resendCode } = useChannelActions(orgId);
  const [code, setCode] = useState("");
  const where = channel.type === "sms" ? "this number" : "this address";

  function submit(event: FormEvent) {
    event.preventDefault();
    verify.mutate({ id: channel.id, code });
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <label className="inline-label">
        Code sent to {where}
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          aria-label={`Verification code for ${channel.name}`}
        />
      </label>
      <button type="submit" className="button button-small" disabled={verify.isPending}>
        Verify
      </button>
      <button
        type="button"
        className="link-button"
        disabled={resendCode.isPending}
        onClick={() => resendCode.mutate(channel.id)}
      >
        Send a new code
      </button>
      {resendCode.isSuccess && (
        <span className="muted" role="status">
          New code sent.
        </span>
      )}
      {(verify.error ?? resendCode.error) && (
        <p className="form-error">{errorText(verify.error ?? resendCode.error)}</p>
      )}
    </form>
  );
}

// One row of the channel list: preference, on/off, test, remove
function ChannelRow({
  channel,
  orgId,
  canEdit,
}: {
  channel: Channel;
  orgId: string | null;
  canEdit: boolean;
}) {
  const { update, remove, test } = useChannelActions(orgId);
  const error = errorText(update.error ?? remove.error ?? test.error);

  return (
    <tr>
      <td>
        <strong>{channel.name}</strong>
        <div className="issue-meta">
          <span>{TYPE_LABEL[channel.type]}</span>
          {channel.target !== channel.name && <span>{channel.target}</span>}
        </div>
        {!channel.verified && canEdit && <VerifyChannel channel={channel} orgId={orgId} />}
        {error && <p className="form-error">{error}</p>}
        {test.data && (
          <p className="muted" role="status">
            Test sent. It shows up under "Recent deliveries".
          </p>
        )}
      </td>
      <td>
        <select
          aria-label={`Which incidents reach ${channel.name}`}
          value={channel.minSeverity}
          disabled={!canEdit}
          onChange={(e) =>
            update.mutate({ id: channel.id, minSeverity: e.target.value as Severity })
          }
        >
          {SEVERITY_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </td>
      <td>
        <label className="inline-label">
          <input
            type="checkbox"
            checked={channel.enabled}
            disabled={!canEdit}
            onChange={(e) => update.mutate({ id: channel.id, enabled: e.target.checked })}
          />
          {channel.enabled ? "On" : "Off"}
        </label>
        {!channel.verified && <div className="muted">Not verified yet</div>}
      </td>
      {canEdit && (
        <td className="actions">
          <button
            type="button"
            className="button button-small"
            disabled={!channel.enabled || !channel.verified || test.isPending}
            onClick={() => test.mutate(channel.id)}
          >
            Send test
          </button>
          <button
            type="button"
            className="link-button danger"
            onClick={() => {
              if (window.confirm(`Remove "${channel.name}"?`)) remove.mutate(channel.id);
            }}
          >
            Remove
          </button>
        </td>
      )}
    </tr>
  );
}

function ChannelTable({
  channels,
  orgId,
  canEdit,
}: {
  channels: Channel[];
  orgId: string | null;
  canEdit: boolean;
}) {
  return (
    <table className="issue-table">
      <thead>
        <tr>
          <th>Channel</th>
          <th>Notify for</th>
          <th>Status</th>
          {canEdit && <th />}
        </tr>
      </thead>
      <tbody>
        {channels.map((channel) => (
          <ChannelRow key={channel.id} channel={channel} orgId={orgId} canEdit={canEdit} />
        ))}
      </tbody>
    </table>
  );
}

// "Add an email / phone number / webhook" in one small form
function AddChannelForm({
  orgId,
  types,
  onSecret,
}: {
  orgId: string | null;
  types: ChannelType[];
  onSecret?: (secret: string) => void;
}) {
  const { create } = useChannelActions(orgId);
  const [type, setType] = useState<ChannelType>(types[0] ?? "email");
  const [value, setValue] = useState("");
  const [minSeverity, setMinSeverity] = useState<Severity>("low");

  const field = {
    email: { label: "Email address", input: "email", placeholder: "you@example.com" },
    sms: { label: "Phone number", input: "tel", placeholder: "+919876543210" },
    webhook: { label: "Webhook URL", input: "url", placeholder: "https://example.com/pulse" },
    slack: {
      label: "Slack webhook URL",
      input: "url",
      placeholder: "https://hooks.slack.com/services/…",
    },
    discord: {
      label: "Discord webhook URL",
      input: "url",
      placeholder: "https://discord.com/api/webhooks/…",
    },
    push: { label: "", input: "text", placeholder: "" },
  }[type];

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const config =
      type === "email" ? { address: value } : type === "sms" ? { phone: value } : { url: value };
    create.mutate(
      { type, minSeverity, config },
      {
        onSuccess: (result) => {
          setValue("");
          if (result.secret) onSecret?.(result.secret);
        },
      },
    );
  };

  return (
    <form className="form-row add-channel" onSubmit={onSubmit}>
      {types.length > 1 && (
        <label className="inline-label">
          Type
          <select value={type} onChange={(e) => setType(e.target.value as ChannelType)}>
            {types.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="inline-label">
        {field.label}
        <input
          type={field.input}
          required
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <label className="inline-label">
        Notify for
        <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as Severity)}>
          {SEVERITY_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="button button-primary" disabled={create.isPending}>
        Add
      </button>
      {create.error && <p className="form-error">{errorText(create.error)}</p>}
    </form>
  );
}

function PushButton({ publicKey }: { publicKey: string }) {
  const { create } = useChannelActions(null);
  const [error, setError] = useState<string | null>(null);

  const enable = async () => {
    setError(null);
    try {
      const config = await subscribeThisBrowser(publicKey);
      await create.mutateAsync({ type: "push", name: navigator.platform || "Browser", config });
    } catch (err) {
      setError(errorText(err) ?? "Couldn't turn on notifications");
    }
  };

  return (
    <div>
      <button type="button" className="button" onClick={enable} disabled={create.isPending}>
        Get push notifications on this browser
      </button>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

const STATUS_CLASS: Record<Delivery["status"], string> = {
  pending: "badge",
  sent: "badge badge-resolved",
  failed: "badge severity-critical",
  skipped: "badge badge-ignored",
};

function DeliveryLog({ orgId }: { orgId: string }) {
  const deliveries = useDeliveries(orgId);

  if (deliveries.isLoading) return <Loading />;
  if (deliveries.error) {
    return <ErrorState error={deliveries.error} retry={() => deliveries.refetch()} />;
  }
  if (!deliveries.data?.length) {
    return <p className="muted">Nothing sent yet. Use "Send test" to try a channel.</p>;
  }

  return (
    <table className="issue-table">
      <thead>
        <tr>
          <th>What</th>
          <th>To</th>
          <th>Status</th>
          <th>When</th>
        </tr>
      </thead>
      <tbody>
        {deliveries.data.map((delivery) => (
          <tr key={delivery.id}>
            <td>
              {delivery.incident ? (
                <Link
                  className="issue-title"
                  to={`/projects/${delivery.incident.projectId}/alerts`}
                >
                  {delivery.incident.title}
                </Link>
              ) : (
                <span>Test notification</span>
              )}
            </td>
            <td>
              {TYPE_LABEL[delivery.channelType]} · {delivery.recipient}
            </td>
            <td>
              <span className={STATUS_CLASS[delivery.status]}>{delivery.status}</span>
              {delivery.attempts > 1 && (
                <span className="muted"> after {delivery.attempts} tries</span>
              )}
              {delivery.error && <div className="muted">{delivery.error}</div>}
            </td>
            <td title={fullDate(delivery.createdAt)}>{timeAgo(delivery.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Where incidents reach people: your own contact methods, and the team's channels
export function NotificationsPage() {
  const { projectId = "" } = useParams();
  const project = useProject(projectId);
  const orgId = project.data?.project.orgId;
  const org = useOrgs().data?.find((o) => o.id === orgId);
  const role = useProjectRole(projectId);
  const isAdmin = role === "owner" || role === "admin";

  const mine = useMyChannels();
  const team = useOrgChannels(orgId);
  const [secret, setSecret] = useState<string | null>(null);

  const myTypes: ChannelType[] = mine.data?.available.sms ? ["email", "sms"] : ["email"];
  const canPush = Boolean(mine.data?.available.push && mine.data.pushPublicKey && pushSupported());

  return (
    <>
      <header className="page-header">
        <h1>Notifications</h1>
      </header>

      <section className="panel">
        <h2>Your contact methods</h2>
        <p className="muted">
          When an incident opens, Pulse tells you on every channel below that wants its severity.
          These follow you across all your organizations.
        </p>
        {mine.isLoading && <Loading />}
        {mine.error && <ErrorState error={mine.error} retry={() => mine.refetch()} />}
        {mine.data && mine.data.channels.length === 0 && (
          <EmptyState title="No contact methods">
            <span>Add one, or you won't hear about incidents.</span>
          </EmptyState>
        )}
        {mine.data && mine.data.channels.length > 0 && (
          <ChannelTable channels={mine.data.channels} orgId={null} canEdit />
        )}
        {mine.data && <AddChannelForm orgId={null} types={myTypes} />}
        {mine.data && !mine.data.available.sms && (
          <p className="muted">SMS isn't set up on this server (it needs a Twilio account).</p>
        )}
        {canPush && mine.data?.pushPublicKey && <PushButton publicKey={mine.data.pushPublicKey} />}
      </section>

      <section className="panel">
        <h2>Team channels{org ? ` · ${org.name}` : ""}</h2>
        <p className="muted">
          Shared inboxes, Slack and Discord channels, and webhooks that get every incident of this
          organization. For Slack, add an "Incoming Webhook" to your workspace; for Discord, open a
          channel's settings → Integrations → Webhooks. Webhooks receive a signed JSON POST (header{" "}
          <code>X-Pulse-Signature</code>).
        </p>
        {team.isLoading && <Loading />}
        {team.error && <ErrorState error={team.error} retry={() => team.refetch()} />}
        {team.data && team.data.length === 0 && <p className="muted">No team channels yet.</p>}
        {team.data && team.data.length > 0 && orgId && (
          <ChannelTable channels={team.data} orgId={orgId} canEdit={isAdmin} />
        )}
        {secret && (
          <div className="secret-box" role="status">
            <strong>Webhook secret: save it now, it won't be shown again.</strong>
            <code>{secret}</code>
            <span className="muted">
              Your server checks each request with it: HMAC-SHA256 of "timestamp.body".
            </span>
            <button type="button" className="link-button" onClick={() => setSecret(null)}>
              I saved it
            </button>
          </div>
        )}
        {isAdmin && orgId && (
          <AddChannelForm
            orgId={orgId}
            types={["slack", "discord", "webhook", "email"]}
            onSecret={setSecret}
          />
        )}
        {role && !isAdmin && <p className="muted">Only admins can change team channels.</p>}
      </section>

      <section className="panel">
        <h2>Recent deliveries</h2>
        {orgId && <DeliveryLog orgId={orgId} />}
      </section>
    </>
  );
}
