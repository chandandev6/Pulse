import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useProjectRole } from "../api/alerts";
import { useMe, useProject } from "../api/queries";
import {
  DAY_NAMES,
  describeRestriction,
  describeRotation,
  type Layer,
  type Member,
  type RotationType,
  useMembers,
  useSchedule,
  useScheduleActions,
  useShifts,
} from "../api/schedules";
import { DAY_MS, ShiftList, ShiftTimeline } from "../components/OnCall";
import { ErrorState, Loading } from "../components/States";
import { fullDate } from "../format";

const TIMELINE_DAYS = 14;
const today = () => new Date().toISOString().slice(0, 10);
// <input type="datetime-local"> gives local time without a zone; Date reads it as local
const toIso = (local: string) => new Date(local).toISOString();

// Picks people in order: the order is the rotation order
function ParticipantPicker({
  members,
  value,
  onChange,
}: {
  members: Member[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const name = (id: string) => members.find((m) => m.userId === id)?.name ?? id;
  const left = members.filter((m) => !value.includes(m.userId));

  return (
    <div className="participants">
      <ol>
        {value.map((id, index) => (
          <li key={id}>
            {name(id)}
            <button
              type="button"
              className="link-button"
              aria-label={`Move ${name(id)} up`}
              disabled={index === 0}
              onClick={() => {
                const next = [...value];
                [next[index - 1], next[index]] = [id, next[index - 1] as string];
                onChange(next);
              }}
            >
              ↑
            </button>
            <button
              type="button"
              className="link-button danger"
              aria-label={`Remove ${name(id)}`}
              onClick={() => onChange(value.filter((v) => v !== id))}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      {left.length > 0 && (
        <label className="inline-label">
          Add person
          <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
            <option value="">Choose…</option>
            {left.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name} ({m.email})
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function AddLayerForm({
  scheduleId,
  members,
  isFirst,
}: {
  scheduleId: string;
  members: Member[];
  isFirst: boolean;
}) {
  const { addLayer } = useScheduleActions(scheduleId);
  const [name, setName] = useState(isFirst ? "Primary" : "");
  const [rotationType, setRotationType] = useState<RotationType>("weekly");
  const [shiftLengthHours, setShiftLengthHours] = useState(12);
  const [handoffTime, setHandoffTime] = useState("09:00");
  const [startDate, setStartDate] = useState(today());
  const [participants, setParticipants] = useState<string[]>([]);
  const [restricted, setRestricted] = useState(false);
  const [days, setDays] = useState([1, 2, 3, 4, 5]);
  const [hours, setHours] = useState({ start: "09:00", end: "17:00" });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    addLayer.mutate(
      {
        name,
        rotationType,
        shiftLengthHours: rotationType === "custom" ? shiftLengthHours : null,
        handoffTime,
        startDate,
        participants,
        restriction: restricted ? { days, ...hours } : null,
      },
      {
        onSuccess: () => {
          setParticipants([]);
          setName("");
        },
      },
    );
  };

  return (
    <form className="form layer-form" onSubmit={onSubmit}>
      <h3>{isFirst ? "Add the first rotation" : "Add a layer on top"}</h3>
      <div className="form-row">
        <label>
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Hand over
          <select
            value={rotationType}
            onChange={(e) => setRotationType(e.target.value as RotationType)}
          >
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="custom">Every N hours</option>
          </select>
        </label>
        {rotationType === "custom" && (
          <label>
            Hours per shift
            <input
              type="number"
              className="number-input"
              min={1}
              max={672}
              value={shiftLengthHours}
              onChange={(e) => setShiftLengthHours(Number(e.target.value))}
            />
          </label>
        )}
        <label>
          At (schedule time)
          <input
            type="time"
            required
            value={handoffTime}
            onChange={(e) => setHandoffTime(e.target.value)}
          />
        </label>
        <label>
          First shift on
          <input
            type="date"
            required
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
      </div>

      <span className="field-label">People, in turn order</span>
      <ParticipantPicker members={members} value={participants} onChange={setParticipants} />

      {!isFirst && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={restricted}
            onChange={(e) => setRestricted(e.target.checked)}
          />
          Only active at certain times (e.g. business hours)
        </label>
      )}
      {restricted && (
        <div className="form-row">
          {DAY_NAMES.map((dayName, index) => (
            <label key={dayName} className="inline-label">
              <input
                type="checkbox"
                checked={days.includes(index + 1)}
                onChange={(e) =>
                  setDays(
                    e.target.checked
                      ? [...days, index + 1].sort((a, b) => a - b)
                      : days.filter((d) => d !== index + 1),
                  )
                }
              />
              {dayName}
            </label>
          ))}
          <label className="inline-label">
            from
            <input
              type="time"
              value={hours.start}
              onChange={(e) => setHours({ ...hours, start: e.target.value })}
            />
          </label>
          <label className="inline-label">
            to
            <input
              type="time"
              value={hours.end}
              onChange={(e) => setHours({ ...hours, end: e.target.value })}
            />
          </label>
        </div>
      )}

      <div>
        <button
          type="submit"
          className="button button-primary"
          disabled={addLayer.isPending || participants.length === 0}
        >
          Add layer
        </button>
      </div>
      {addLayer.error && <p className="form-error">{addLayer.error.message}</p>}
    </form>
  );
}

function LayerCard({
  layer,
  isBottom,
  canEdit,
  onRemove,
}: {
  layer: Layer;
  isBottom: boolean;
  canEdit: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="layer-card">
      <div className="layer-head">
        <strong>{layer.name}</strong>
        {isBottom && <span className="badge">base layer</span>}
        {canEdit && (
          <button type="button" className="link-button danger" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      <div className="muted">
        {describeRotation(layer)} · starting {layer.startDate}
        {layer.restriction && ` · only ${describeRestriction(layer.restriction)}`}
      </div>
      <ol className="participant-names">
        {layer.participants.map((person) => (
          <li key={person.id}>{person.name}</li>
        ))}
      </ol>
    </li>
  );
}

function AddOverrideForm({
  scheduleId,
  members,
  meId,
  isAdmin,
}: {
  scheduleId: string;
  members: Member[];
  meId: string;
  isAdmin: boolean;
}) {
  const { addOverride } = useScheduleActions(scheduleId);
  const [userId, setUserId] = useState(meId);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    addOverride.mutate(
      { userId, startsAt: toIso(startsAt), endsAt: toIso(endsAt) },
      {
        onSuccess: () => {
          setStartsAt("");
          setEndsAt("");
        },
      },
    );
  };

  return (
    <form className="form-row add-channel" onSubmit={onSubmit}>
      {isAdmin ? (
        <label className="inline-label">
          Who
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.userId === meId ? `${m.name} (you)` : m.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="muted">You'll cover:</span>
      )}
      <label className="inline-label">
        From
        <input
          type="datetime-local"
          required
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
        />
      </label>
      <label className="inline-label">
        Until
        <input
          type="datetime-local"
          required
          value={endsAt}
          onChange={(e) => setEndsAt(e.target.value)}
        />
      </label>
      <button type="submit" className="button" disabled={addOverride.isPending}>
        Add override
      </button>
      {addOverride.error && <p className="form-error">{addOverride.error.message}</p>}
    </form>
  );
}

// One schedule: who's on call, the timeline, the rotations and the overrides
export function SchedulePage() {
  const { projectId = "", scheduleId = "" } = useParams();
  const navigate = useNavigate();
  const orgId = useProject(projectId).data?.project.orgId;
  const role = useProjectRole(projectId);
  const isAdmin = role === "owner" || role === "admin";
  const me = useMe();
  const members = useMembers(orgId);
  const detail = useSchedule(scheduleId);
  const actions = useScheduleActions(scheduleId);

  // Fixed for this visit, so the timeline query key doesn't change on every render
  const [range] = useState(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    return {
      from,
      fromIso: from.toISOString(),
      toIso: new Date(from.getTime() + TIMELINE_DAYS * DAY_MS).toISOString(),
    };
  });
  const shifts = useShifts(scheduleId, range.fromIso, range.toIso);

  if (detail.isLoading) return <Loading />;
  if (detail.error) return <ErrorState error={detail.error} retry={() => detail.refetch()} />;
  if (!detail.data) return null;

  const { schedule, layers, overrides } = detail.data;
  const topFirst = [...layers].reverse();
  const upcoming = (shifts.data ?? []).filter((s) => new Date(s.end).getTime() > Date.now());

  return (
    <>
      <nav className="breadcrumbs">
        <Link to={`/projects/${projectId}/schedules`}>On-call</Link> / {schedule.name}
      </nav>
      <header className="page-header">
        <h1>{schedule.name}</h1>
        {isAdmin && (
          <button
            type="button"
            className="link-button danger"
            onClick={() => {
              if (window.confirm(`Delete the schedule "${schedule.name}"?`)) {
                actions.remove.mutate(undefined, {
                  onSuccess: () => navigate(`/projects/${projectId}/schedules`),
                });
              }
            }}
          >
            Delete schedule
          </button>
        )}
      </header>

      <section className="panel">
        <p className="oncall-now">
          On call now:{" "}
          {schedule.onCall ? (
            <strong>{schedule.onCall.user.name}</strong>
          ) : (
            <strong className="form-error">nobody (add a rotation below)</strong>
          )}
          {schedule.onCallUntil && (
            <span className="muted"> until {fullDate(schedule.onCallUntil)}</span>
          )}
        </p>
        <p className="muted">Rotations follow the schedule's timezone: {schedule.timezone}.</p>
      </section>

      <section className="panel">
        <h2>Next {TIMELINE_DAYS} days</h2>
        {shifts.isLoading && <Loading />}
        {shifts.error && <ErrorState error={shifts.error} retry={() => shifts.refetch()} />}
        {shifts.data && (
          <ShiftTimeline shifts={shifts.data} from={range.from} days={TIMELINE_DAYS} />
        )}
        {upcoming.length > 0 && (
          <>
            <h3>Upcoming shifts</h3>
            <ShiftList shifts={upcoming} />
          </>
        )}
      </section>

      <section className="panel">
        <h2>Rotations</h2>
        <p className="muted">
          Layers stack: the highest layer that is active wins. The bottom layer is always active, so
          someone is always on call.
        </p>
        {topFirst.length > 0 && (
          <ol className="layers">
            {topFirst.map((layer) => (
              <LayerCard
                key={layer.id}
                layer={layer}
                isBottom={layer.id === layers[0]?.id}
                canEdit={isAdmin}
                onRemove={() => {
                  if (window.confirm(`Remove the layer "${layer.name}"?`)) {
                    actions.removeLayer.mutate(layer.id);
                  }
                }}
              />
            ))}
          </ol>
        )}
        {actions.removeLayer.error && (
          <p className="form-error">{actions.removeLayer.error.message}</p>
        )}
        {isAdmin && members.data && (
          <AddLayerForm
            scheduleId={scheduleId}
            members={members.data}
            isFirst={layers.length === 0}
          />
        )}
      </section>

      <section className="panel">
        <h2>Overrides</h2>
        <p className="muted">Covering for someone? An override beats every rotation.</p>
        {overrides.length === 0 && <p className="muted">No upcoming overrides.</p>}
        {overrides.length > 0 && (
          <ul className="override-list">
            {overrides.map((o) => (
              <li key={o.id}>
                <strong>{o.user.name}</strong> {fullDate(o.startsAt)} → {fullDate(o.endsAt)}
                {(isAdmin || o.user.id === me.data?.id) && (
                  <button
                    type="button"
                    className="link-button danger"
                    onClick={() => actions.removeOverride.mutate(o.id)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {me.data && members.data && (
          <AddOverrideForm
            scheduleId={scheduleId}
            members={members.data}
            meId={me.data.id}
            isAdmin={isAdmin}
          />
        )}
      </section>
    </>
  );
}
