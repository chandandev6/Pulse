import type { RouteObject } from "react-router";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { AlertRulePage } from "./pages/AlertRulePage";
import { AlertsPage } from "./pages/AlertsPage";
import { LoginPage, SignupPage } from "./pages/AuthPages";
import { ComparePage } from "./pages/ComparePage";
import { HomePage } from "./pages/HomePage";
import { IssuePage } from "./pages/IssuePage";
import { IssuesPage } from "./pages/IssuesPage";
import { NewProjectPage } from "./pages/NewProjectPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ReleasePage } from "./pages/ReleasePage";
import { ReleasesPage } from "./pages/ReleasesPage";
import { SchedulePage } from "./pages/SchedulePage";
import { SchedulesPage } from "./pages/SchedulesPage";
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
          { path: "releases", element: <ReleasesPage /> },
          { path: "releases/compare", element: <ComparePage /> },
          { path: "releases/:version", element: <ReleasePage /> },
          { path: "alerts", element: <AlertsPage /> },
          { path: "alerts/new", element: <AlertRulePage /> },
          { path: "alerts/:ruleId", element: <AlertRulePage /> },
          { path: "notifications", element: <NotificationsPage /> },
          { path: "schedules", element: <SchedulesPage /> },
          { path: "schedules/:scheduleId", element: <SchedulePage /> },
        ],
      },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
];
