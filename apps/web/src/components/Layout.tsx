import { useEffect } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router";
import { useAllProjects, useLogout, useMe } from "../api/queries";
import { EnvironmentProvider, EnvironmentSelector } from "../environment";
import { rememberProject } from "../lastProject";
import { Logo } from "./Logo";
import { VerifyEmailBanner } from "./VerifyEmailBanner";

function ProjectSwitcher({ projectId }: { projectId: string }) {
  const { groups, isLoading } = useAllProjects();
  const navigate = useNavigate();

  return (
    <label className="switcher">
      <span className="sr-only">Project</span>
      <select
        value={projectId}
        disabled={isLoading}
        onChange={(e) => navigate(`/projects/${e.target.value}`)}
      >
        {groups.map(({ org, projects }) => (
          <optgroup key={org.id} label={org.name}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

// The frame around every project page: sidebar on the left, the page on the right
export function Layout() {
  const { projectId = "" } = useParams();
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

  useEffect(() => rememberProject(projectId), [projectId]);

  const link = ({ isActive }: { isActive: boolean }) => (isActive ? "nav-link active" : "nav-link");

  return (
    <EnvironmentProvider key={projectId} projectId={projectId}>
      <div className="shell">
        <aside className="sidebar">
          <Link to="/app" className="brand">
            <Logo /> Pulse
          </Link>
          <ProjectSwitcher projectId={projectId} />
          <EnvironmentSelector />
          <nav className="nav">
            <NavLink to={`/projects/${projectId}`} end className={link}>
              Overview
            </NavLink>
            <NavLink to={`/projects/${projectId}/issues`} className={link}>
              Issues
            </NavLink>
            <NavLink to={`/projects/${projectId}/releases`} className={link}>
              Releases
            </NavLink>
            <NavLink to={`/projects/${projectId}/incidents`} className={link}>
              Incidents
            </NavLink>
            <NavLink to={`/projects/${projectId}/alerts`} className={link}>
              Alerts
            </NavLink>
            <NavLink to={`/projects/${projectId}/schedules`} className={link}>
              On-call
            </NavLink>
            <NavLink to={`/projects/${projectId}/escalation`} className={link}>
              Escalation
            </NavLink>
            <NavLink to={`/projects/${projectId}/notifications`} className={link}>
              Notifications
            </NavLink>
            <NavLink to={`/projects/${projectId}/settings`} className={link}>
              Settings
            </NavLink>
            <NavLink to="/projects/new" className={link}>
              + New project
            </NavLink>
          </nav>
          <div className="sidebar-footer">
            <span className="muted">{me.data?.name}</span>
            <button
              type="button"
              className="link-button"
              onClick={() => logout.mutate(undefined, { onSuccess: () => navigate("/login") })}
            >
              Log out
            </button>
          </div>
        </aside>
        <main className="content">
          <VerifyEmailBanner />
          <Outlet />
        </main>
      </div>
    </EnvironmentProvider>
  );
}
