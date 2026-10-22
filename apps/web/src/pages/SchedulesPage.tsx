import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useProjectRole } from "../api/alerts";
import { useProject } from "../api/queries";
import { useCreateSchedule, useOnCallNow, useSchedules } from "../api/schedules";
import { OnCallWidget } from "../components/OnCall";
import { EmptyState, ErrorState, Loading } from "../components/States";

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const allZones = () => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [browserZone(), "UTC"]; // very old browsers
  }
};

function NewScheduleForm({ orgId, projectId }: { orgId: string; projectId: string }) {
  const create = useCreateSchedule(orgId);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(browserZone());

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { name, timezone },
      {
        onSuccess: ({ schedule }) => navigate(`/projects/${projectId}/schedules/${schedule.id}`),
      },
    );
  };

  return (
    <form className="form-row add-channel" onSubmit={onSubmit}>
      <label className="inline-label">
        Name
        <input
          required
          value={name}
          placeholder="Backend on-call"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="inline-label">
        Timezone
        <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {allZones().map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="button button-primary" disabled={create.isPending}>
        Create schedule
      </button>
      {create.error && <p className="form-error">{create.error.message}</p>}
    </form>
  );
}

// The org's on-call schedules, and who is on call right now
export function SchedulesPage() {
  const { projectId = "" } = useParams();
  const orgId = useProject(projectId).data?.project.orgId;
  const role = useProjectRole(projectId);
  const isAdmin = role === "owner" || role === "admin";
  const schedules = useSchedules(orgId);
  const oncall = useOnCallNow(orgId);
  const scheduleLink = (id: string) => `/projects/${projectId}/schedules/${id}`;

  return (
    <>
      <header className="page-header">
        <h1>On-call</h1>
      </header>

      <section className="panel">
        <h2>Who's on call now</h2>
        <OnCallWidget oncall={oncall.data} isLoading={oncall.isLoading} linkTo={scheduleLink} />
      </section>

      <section className="panel">
        <h2>Schedules</h2>
        <p className="muted">
          A schedule says who is responsible when: people take turns (rotations), and anyone can
          cover a shift (overrides). Schedules belong to the whole organization.
        </p>
        {schedules.isLoading && <Loading />}
        {schedules.error && (
          <ErrorState error={schedules.error} retry={() => schedules.refetch()} />
        )}
        {schedules.data?.length === 0 && (
          <EmptyState title="No schedules yet">
            <span>Create one, then add the people who take turns.</span>
          </EmptyState>
        )}
        {schedules.data && schedules.data.length > 0 && (
          <table className="issue-table">
            <thead>
              <tr>
                <th>Schedule</th>
                <th>Timezone</th>
                <th>On call now</th>
              </tr>
            </thead>
            <tbody>
              {schedules.data.map((schedule) => (
                <tr key={schedule.id}>
                  <td>
                    <Link className="issue-title" to={scheduleLink(schedule.id)}>
                      {schedule.name}
                    </Link>
                  </td>
                  <td>{schedule.timezone}</td>
                  <td>{schedule.onCall?.user.name ?? <span className="muted">nobody</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {isAdmin && orgId && <NewScheduleForm orgId={orgId} projectId={projectId} />}
      </section>
    </>
  );
}
