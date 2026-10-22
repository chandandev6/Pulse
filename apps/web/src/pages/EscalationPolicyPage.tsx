import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useProjectRole } from "../api/alerts";
import {
  formatMinutes,
  type PolicyTarget,
  useDeletePolicy,
  usePolicy,
  useSavePolicy,
} from "../api/escalation";
import { useProject } from "../api/queries";
import { useMembers, useSchedules } from "../api/schedules";
import { ErrorState, Loading } from "../components/States";

// A level while it's being edited. `key` keeps React's rows stable while they move.
type DraftLevel = { key: string; timeoutMinutes: number; targets: PolicyTarget[] };

const newLevel = (): DraftLevel => ({ key: crypto.randomUUID(), timeoutMinutes: 15, targets: [] });

// Moves one item of a list to another position
function move<T>(list: T[], from: number, to: number): T[] {
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  if (item !== undefined) copy.splice(to, 0, item);
  return copy;
}

type Option = PolicyTarget;

function LevelEditor({
  index,
  level,
  count,
  options,
  readOnly,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  level: DraftLevel;
  count: number;
  options: Option[];
  readOnly: boolean;
  onChange: (level: DraftLevel) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const chosen = new Set(level.targets.map((t) => `${t.type}:${t.id}`));
  const available = options.filter((option) => !chosen.has(`${option.type}:${option.id}`));

  const add = (value: string) => {
    const option = options.find((o) => `${o.type}:${o.id}` === value);
    if (option) onChange({ ...level, targets: [...level.targets, option] });
  };

  return (
    <>
      <div className="level-header">
        {!readOnly && (
          <span className="drag-handle" aria-hidden="true" title="Drag to reorder">
            ⋮⋮
          </span>
        )}
        <h3>Level {index + 1}</h3>
        {!readOnly && (
          <div className="level-buttons">
            <button
              type="button"
              className="button button-small"
              disabled={index === 0}
              aria-label={`Move level ${index + 1} up`}
              onClick={() => onMove(index - 1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="button button-small"
              disabled={index === count - 1}
              aria-label={`Move level ${index + 1} down`}
              onClick={() => onMove(index + 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="link-button danger"
              disabled={count === 1}
              onClick={onRemove}
            >
              Remove level
            </button>
          </div>
        )}
      </div>

      <ul className="target-list" aria-label={`Level ${index + 1} targets`}>
        {level.targets.map((target) => (
          <li key={`${target.type}:${target.id}`} className="target-chip">
            {target.type === "schedule" ? `${target.name} (whoever is on call)` : target.name}
            {!readOnly && (
              <button
                type="button"
                className="link-button"
                aria-label={`Remove ${target.name}`}
                onClick={() =>
                  onChange({
                    ...level,
                    targets: level.targets.filter((t) => t !== target),
                  })
                }
              >
                ×
              </button>
            )}
          </li>
        ))}
        {level.targets.length === 0 && <li className="muted">Nobody yet</li>}
      </ul>

      <div className="form-row">
        {!readOnly && (
          <label className="inline-label">
            Add
            <select
              aria-label={`Add to level ${index + 1}`}
              value=""
              onChange={(e) => add(e.target.value)}
            >
              <option value="">Person or schedule…</option>
              <optgroup label="Schedules (whoever is on call)">
                {available
                  .filter((o) => o.type === "schedule")
                  .map((o) => (
                    <option key={o.id} value={`schedule:${o.id}`}>
                      {o.name}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="People">
                {available
                  .filter((o) => o.type === "user")
                  .map((o) => (
                    <option key={o.id} value={`user:${o.id}`}>
                      {o.name}
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>
        )}
        <label className="inline-label">
          {index === count - 1 ? "Then wait (minutes)" : "Escalate after (minutes)"}
          <input
            type="number"
            min={1}
            max={1440}
            required
            disabled={readOnly}
            value={level.timeoutMinutes}
            onChange={(e) => onChange({ ...level, timeoutMinutes: Number(e.target.value) })}
          />
        </label>
      </div>
    </>
  );
}

// Create or edit one policy. Levels are reordered by dragging or with the ↑ ↓ buttons.
export function EscalationPolicyPage() {
  const { projectId = "", policyId } = useParams();
  const navigate = useNavigate();
  const orgId = useProject(projectId).data?.project.orgId ?? "";
  const role = useProjectRole(projectId);
  const readOnly = role === "member"; // like the rule form: editable while the role loads

  const existing = usePolicy(policyId ?? "");
  const members = useMembers(orgId || undefined);
  const schedules = useSchedules(orgId || undefined);
  const save = useSavePolicy(orgId, policyId);
  const remove = useDeletePolicy();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repeatCount, setRepeatCount] = useState(0);
  const [levels, setLevels] = useState<DraftLevel[]>([newLevel()]);
  const [dragging, setDragging] = useState<number | null>(null);

  // Fill the form once the saved policy arrives
  const loaded = policyId ? existing.data?.policy : undefined;
  useEffect(() => {
    if (!loaded) return;
    setName(loaded.name);
    setDescription(loaded.description ?? "");
    setRepeatCount(loaded.repeatCount);
    setLevels(
      loaded.levels.map((level) => ({
        key: level.id,
        timeoutMinutes: level.timeoutMinutes,
        targets: level.targets,
      })),
    );
  }, [loaded]);

  if (policyId && existing.isLoading) return <Loading />;
  if (policyId && existing.error) {
    return <ErrorState error={existing.error} retry={() => existing.refetch()} />;
  }

  const options: Option[] = [
    ...(schedules.data ?? []).map((s) => ({ type: "schedule" as const, id: s.id, name: s.name })),
    ...(members.data ?? []).map((m) => ({ type: "user" as const, id: m.userId, name: m.name })),
  ];
  const back = `/projects/${projectId}/escalation`;
  const setLevel = (index: number, level: DraftLevel) =>
    setLevels(levels.map((l, i) => (i === index ? level : l)));
  const total = levels.reduce((sum, level) => sum + level.timeoutMinutes, 0) * (repeatCount + 1);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      {
        name,
        description: description.trim() || null,
        repeatCount,
        levels: levels.map((level) => ({
          timeoutMinutes: level.timeoutMinutes,
          targets: level.targets.map(({ type, id }) => ({ type, id })),
        })),
      },
      { onSuccess: () => navigate(back) },
    );
  };

  return (
    <form className="form rule-form" onSubmit={onSubmit}>
      <header className="page-header">
        <div>
          <p className="muted">
            <Link to={back}>Escalation</Link>
          </p>
          <h1>{policyId ? name || "Escalation policy" : "New escalation policy"}</h1>
        </div>
      </header>

      <section className="panel">
        <label>
          Name
          <input
            required
            maxLength={100}
            disabled={readOnly}
            value={name}
            placeholder="Checkout team"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Description
          <input
            maxLength={500}
            disabled={readOnly}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </section>

      <section className="panel">
        <h2>Levels</h2>
        <p className="muted">
          Level 1 is told first. If nobody acknowledges before its time runs out, the next level is
          told, and so on.
        </p>
        <ol className="levels">
          {levels.map((level, index) => (
            <li
              key={level.key}
              className={dragging === index ? "level dragging" : "level"}
              draggable={!readOnly}
              onDragStart={() => setDragging(index)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null && dragging !== index) {
                  setLevels(move(levels, dragging, index));
                }
                setDragging(null);
              }}
            >
              <LevelEditor
                index={index}
                level={level}
                count={levels.length}
                options={options}
                readOnly={readOnly}
                onChange={(next) => setLevel(index, next)}
                onMove={(to) => setLevels(move(levels, index, to))}
                onRemove={() => setLevels(levels.filter((_, i) => i !== index))}
              />
            </li>
          ))}
        </ol>
        {!readOnly && levels.length < 10 && (
          <button
            type="button"
            className="button"
            onClick={() => setLevels([...levels, newLevel()])}
          >
            + Add level
          </button>
        )}
      </section>

      <section className="panel">
        <h2>After the last level</h2>
        <label className="inline-label">
          Start again from level 1
          <select
            disabled={readOnly}
            value={repeatCount}
            onChange={(e) => setRepeatCount(Number(e.target.value))}
          >
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "Never" : `${n} more time${n === 1 ? "" : "s"}`}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          If nobody ever acknowledges, escalation stops after {formatMinutes(total)}.
        </p>
      </section>

      {policyId && existing.data && (
        <section className="panel">
          <h2>Used by</h2>
          {existing.data.rules.length === 0 ? (
            <p className="muted">No alert rules use this policy yet.</p>
          ) : (
            <ul>
              {existing.data.rules.map((rule) => (
                <li key={rule.id}>
                  <Link to={`/projects/${rule.project.id}/alerts/${rule.id}`}>{rule.name}</Link>{" "}
                  <span className="muted">({rule.project.name})</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {save.error && (
        <p className="form-error" role="alert">
          {save.error.message}
        </p>
      )}
      {!readOnly && (
        <div className="form-row">
          <button type="submit" className="button button-primary" disabled={save.isPending}>
            {policyId ? "Save policy" : "Create policy"}
          </button>
          {policyId && (
            <button
              type="button"
              className="link-button danger"
              onClick={() => {
                const used = existing.data?.rules.length ?? 0;
                const warning = used
                  ? `${used} alert rule(s) use this policy and will notify the project's on-call person instead. Delete it?`
                  : "Delete this policy?";
                if (window.confirm(warning)) {
                  remove.mutate(policyId, { onSuccess: () => navigate(back) });
                }
              }}
            >
              Delete policy
            </button>
          )}
        </div>
      )}
    </form>
  );
}
