import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Page not found</h1>
        <p className="muted">This page doesn't exist, or you don't have access to it.</p>
        <Link to="/" className="button">
          Go home
        </Link>
      </div>
    </div>
  );
}
