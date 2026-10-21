import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useCreateProject, useOrgs } from "../api/queries";
import { ErrorState, Loading } from "../components/States";

const PLATFORMS = [
  ["javascript", "JavaScript (browser)"],
  ["node", "Node.js"],
  ["react", "React"],
  ["other", "Other"],
] as const;

export function NewProjectPage() {
  const orgs = useOrgs();
  const navigate = useNavigate();
  // Creating projects needs the admin role
  const allowed = (orgs.data ?? []).filter((org) => org.role !== "member");
  const [orgId, setOrgId] = useState("");
  const selectedOrg = orgId || allowed[0]?.id || "";
  const create = useCreateProject(selectedOrg);

  if (orgs.isLoading) return <Loading />;
  if (orgs.error) return <ErrorState error={orgs.error} retry={() => orgs.refetch()} />;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    create.mutate(
      { name: String(data.get("name")), platform: String(data.get("platform")) },
      { onSuccess: ({ project }) => navigate(`/projects/${project.id}/settings`) },
    );
  };

  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide">
        <h1>Create a project</h1>
        <p className="muted">A project is one app you want to watch, like your website or API.</p>
        {allowed.length === 0 ? (
          <p className="form-error">
            You need the admin role in an organization to create projects.
          </p>
        ) : (
          <form className="form" onSubmit={onSubmit}>
            {allowed.length > 1 && (
              <label>
                Organization
                <select value={selectedOrg} onChange={(e) => setOrgId(e.target.value)}>
                  {allowed.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Project name
              <input name="name" required maxLength={100} placeholder="e.g. Shop website" />
            </label>
            <label>
              Platform
              <select name="platform" defaultValue="node">
                {PLATFORMS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {create.error && (
              <p className="form-error" role="alert">
                {create.error.message}
              </p>
            )}
            <button type="submit" className="button button-primary" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create project"}
            </button>
          </form>
        )}
        <p className="muted">
          <Link to="/">← Back</Link>
        </p>
      </div>
    </div>
  );
}
