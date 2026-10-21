import { Navigate, Outlet, useLocation } from "react-router";
import { useMe } from "../api/queries";
import { ErrorState, Loading } from "./States";

// Wraps every logged-in page. Not logged in → off to /login, then back here afterwards.
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.isLoading) return <Loading />;
  if (me.error) return <ErrorState error={me.error} retry={() => me.refetch()} />;
  if (!me.data) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <Outlet />;
}
