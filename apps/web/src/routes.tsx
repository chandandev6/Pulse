import type { RouteObject } from "react-router";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { LoginPage, SignupPage } from "./pages/AuthPages";
import { HomePage } from "./pages/HomePage";
import { IssuePage } from "./pages/IssuePage";
import { IssuesPage } from "./pages/IssuesPage";
import { NewProjectPage } from "./pages/NewProjectPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SettingsPage } from "./pages/SettingsPage";

// Shared by the real app (browser URLs) and the tests (in-memory URLs)
export const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  { path: "/signup", element: <SignupPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/projects/new", element: <NewProjectPage /> },
      {
        path: "/projects/:projectId",
        element: <Layout />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: "issues", element: <IssuesPage /> },
          { path: "issues/:issueId", element: <IssuePage /> },
          { path: "settings", element: <SettingsPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
];
