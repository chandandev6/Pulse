import { Navigate } from "react-router";
import { useAllProjects } from "../api/queries";
import { ErrorState, Loading } from "../components/States";
import { lastProject } from "../lastProject";

// "/app" → the project you looked at last, else the first one, else "create your first project"
export function HomePage() {
  const { groups, isLoading, error } = useAllProjects();

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} />;

  const projects = groups.flatMap((group) => group.projects);
  const remembered = lastProject();
  const target = projects.find((p) => p.id === remembered) ?? projects[0];

  return <Navigate to={target ? `/projects/${target.id}` : "/projects/new"} replace />;
}
