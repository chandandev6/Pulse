import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  type AlertCondition,
  type ConditionType,
  type RuleInput,
  useAlertRule,
  useDeleteRule,
  usePreviewRule,
  useProjectRole,
  useSaveRule,
} from "../api/alerts";
import { useEnvironments } from "../api/releases";
import type { Severity } from "../api/types";
import { ErrorState, Loading } from "../components/States";
import { timeAgo } from "../format";

const CONDITION_LABELS: Record<ConditionType, string> = {
  new_issue: "A new issue appears",
  regression: "A resolved issue comes back (regression)",
  severity_critical: "The issue is critical",
  event_frequency: "More than N events in X minutes",
  user_count: "More than N users are affected",
};

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

// A new condition of each type starts with sensible numbers
function defaultCondition(type: ConditionType): AlertCondition {
  switch (type) {
    case "event_frequency":
      return { type, count: 100, minutes: 10 };
    case "user_count":
      return { type, count: 10 };
    default:
      return { type };
  }
}

const EMPTY_RULE: RuleInput = {
  name: "",
  enabled: true,
  environment: null,
  match: "any",
  conditions: [{ type: "new_issue" }],
  severity: "high",
  cooldownMinutes: 30,
};

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  return (
    <label className="inline-label">
      {label}
      <input
        type="number"
        className="number-input"
        value={value}
        min={min}
        max={max}
        required
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function ConditionRow({
  condition,
  index,
  onChange,
  onRemove,
  disabled,
}: {
  condition: AlertCondition;
  index: number;
  onChange: (condition: AlertCondition) => void;
  onRemove?: () => void;
  disabled: boolean;
}) {
  return (
    <li className="condition-row">
      <select
        aria-label={`Condition ${index + 1}`}
        value={condition.type}
        disabled={disabled}
        onChange={(e) => onChange(defaultCondition(e.target.value as ConditionType))}
      >
        {Object.entries(CONDITION_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {condition.type === "event_frequency" && (
        <>
          <NumberField
            label="N ="
            value={condition.count}
            min={1}
            max={1_000_000}
            disabled={disabled}
            onChange={(count) => onChange({ ...condition, count })}
          />
          <NumberField
            label="X ="
            value={condition.minutes}
            min={1}
            max={1440}
            disabled={disabled}
            onChange={(minutes) => onChange({ ...condition, minutes })}
          />
        </>
      )}
      {condition.type === "user_count" && (
        <NumberField
          label="N ="
          value={condition.count}
          min={1}
          max={10_000_000}
          disabled={disabled}
          onChange={(count) => onChange({ ...condition, count })}
        />
      )}
      {onRemove && !disabled && (
        <button type="button" className="link-button" onClick={onRemove}>
          Remove
        </button>
      )}
    </li>
  );
}

function RuleForm({
  projectId,
  ruleId,
  initial,
}: {
  projectId: string;
  ruleId?: string;
  initial: RuleInput;
}) {
  const [rule, setRule] = useState<RuleInput>(initial);
  const environments = useEnvironments(projectId);
  const save = useSaveRule(projectId, ruleId);
  const remove = useDeleteRule(projectId);
  const preview = usePreviewRule(projectId);
  const role = useProjectRole(projectId);
  const navigate = useNavigate();
  const readOnly = role === "member";
  const back = `/projects/${projectId}/alerts`;

  const set = <K extends keyof RuleInput>(key: K, value: RuleInput[K]) =>
    setRule((current) => ({ ...current, [key]: value }));
  const setCondition = (index: number, condition: AlertCondition) =>
    set(
      "conditions",
      rule.conditions.map((c, i) => (i === index ? condition : c)),
    );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(rule, { onSuccess: () => navigate(back) });
  };

  const environmentNames = environments.data?.map((env) => env.name) ?? [];
  if (rule.environment && !environmentNames.includes(rule.environment)) {
    environmentNames.unshift(rule.environment);
  }

  return (
    <form className="form rule-form" onSubmit={onSubmit}>
      {readOnly && <p className="muted">Only admins can change alert rules.</p>}

      <section className="panel">
        <label>
          Name
          <input
            value={rule.name}
            required
            maxLength={100}
            disabled={readOnly}
            placeholder="e.g. Checkout is on fire"
            onChange={(e) => set("name", e.target.value)}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={rule.enabled}
            disabled={readOnly}
            onChange={(e) => set("enabled", e.target.checked)}
          />
          Enabled
        </label>
      </section>

      <section className="panel">
        <h2>When</h2>
        <div className="form-row">
          <label className="inline-label">
            Only in environment
            <select
              value={rule.environment ?? ""}
              disabled={readOnly}
              onChange={(e) => set("environment", e.target.value || null)}
            >
              <option value="">Any environment</option>
              {environmentNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {rule.conditions.length > 1 && (
            <label className="inline-label">
              Fire when
              <select
                value={rule.match}
                disabled={readOnly}
                onChange={(e) => set("match", e.target.value as RuleInput["match"])}
              >
                <option value="any">any condition is true</option>
                <option value="all">all conditions are true</option>
              </select>
            </label>
          )}
        </div>
        <ol className="conditions">
          {rule.conditions.map((condition, index) => (
            <ConditionRow
              // Conditions have no id; their position is their identity while editing
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              index={index}
              condition={condition}
              disabled={readOnly}
              onChange={(next) => setCondition(index, next)}
              onRemove={
                rule.conditions.length > 1
                  ? () =>
                      set(
                        "conditions",
                        rule.conditions.filter((_, i) => i !== index),
                      )
                  : undefined
              }
            />
          ))}
        </ol>
        {!readOnly && rule.conditions.length < 10 && (
          <button
            type="button"
            className="button button-small"
            onClick={() =>
              set("conditions", [...rule.conditions, defaultCondition("severity_critical")])
            }
          >
            + Add condition
          </button>
        )}
      </section>

      <section className="panel">
        <h2>Then</h2>
        <div className="form-row">
          <label className="inline-label">
            Open an incident with severity
            <select
              value={rule.severity}
              disabled={readOnly}
              onChange={(e) => set("severity", e.target.value as Severity)}
            >
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {severity}
                </option>
              ))}
            </select>
          </label>
          <NumberField
            label="Cooldown after resolving (minutes)"
            value={rule.cooldownMinutes}
            min={0}
            max={10_080}
            disabled={readOnly}
            onChange={(value) => set("cooldownMinutes", value)}
          />
        </div>
        <p className="muted">
          While an incident for an issue is open, this rule won't open another one for the same
          issue.
        </p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Test this rule</h2>
          <button
            type="button"
            className="button button-small"
            disabled={preview.isPending}
            onClick={() =>
              preview.mutate({
                environment: rule.environment,
                match: rule.match,
                conditions: rule.conditions,
              })
            }
          >
            {preview.isPending ? "Testing…" : "Test rule"}
          </button>
        </div>
        {!preview.data && !preview.error && (
          <p className="muted">
            See which issues from the last 24 hours this rule would have caught.
          </p>
        )}
        {preview.error && <ErrorState error={preview.error} />}
        {preview.data && (
          <div role="status">
            <p>
              <strong>{preview.data.total}</strong> recent issue
              {preview.data.total === 1 ? "" : "s"} would match.
            </p>
            <ul className="preview-list">
              {preview.data.matches.map((issue) => (
                <li key={issue.id}>
                  <Link to={`/projects/${projectId}/issues/${issue.id}`}>{issue.title}</Link>{" "}
                  <span className="muted">· last seen {timeAgo(issue.lastSeen)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {save.error && (
        <p className="form-error" role="alert">
          {save.error.message}
        </p>
      )}
      <div className="actions">
        {!readOnly && (
          <button type="submit" className="button button-primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : ruleId ? "Save rule" : "Create rule"}
          </button>
        )}
        <Link to={back} className="button">
          Cancel
        </Link>
        {ruleId && !readOnly && (
          <button
            type="button"
            className="link-button danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete the rule "${rule.name}"? Its incidents are kept.`)) {
                remove.mutate(ruleId, { onSuccess: () => navigate(back) });
              }
            }}
          >
            Delete rule
          </button>
        )}
      </div>
    </form>
  );
}

// /alerts/new and /alerts/:ruleId share this page
export function AlertRulePage() {
  const { projectId = "", ruleId } = useParams();
  const existing = useAlertRule(projectId, ruleId);

  return (
    <>
      <nav className="breadcrumbs">
        <Link to={`/projects/${projectId}/alerts`}>Alerts</Link> /
      </nav>
      <header className="page-header">
        <h1>{ruleId ? (existing.data?.name ?? "Alert rule") : "New alert rule"}</h1>
      </header>
      {ruleId && existing.isLoading && <Loading />}
      {ruleId && existing.error && (
        <ErrorState error={existing.error} retry={() => existing.refetch()} />
      )}
      {!ruleId && <RuleForm projectId={projectId} initial={EMPTY_RULE} />}
      {ruleId && existing.data && (
        // key: start fresh if you navigate from one rule to another
        <RuleForm key={ruleId} projectId={projectId} ruleId={ruleId} initial={existing.data} />
      )}
    </>
  );
}
