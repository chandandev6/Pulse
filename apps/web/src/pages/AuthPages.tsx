import { type FormEvent, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { useLogin, useMe, useSignup } from "../api/queries";
import { Logo } from "../components/Logo";

// Only allow going back to our own pages after login (never to another website)
function safeNext(next: string | null) {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/app";
}

function field(form: HTMLFormElement, name: string) {
  return String(new FormData(form).get(name) ?? "");
}

function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <Link to="/" className="brand">
          <Logo /> Pulse
        </Link>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));

  if (me.data) return <Navigate to={next} replace />;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    login.mutate(
      { email: field(form, "email"), password: field(form, "password") },
      { onSuccess: () => navigate(next, { replace: true }) },
    );
  };

  return (
    <AuthCard title="Log in">
      <form className="form" onSubmit={onSubmit}>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {login.error && (
          <p className="form-error" role="alert">
            {login.error.message}
          </p>
        )}
        <button type="submit" className="button button-primary" disabled={login.isPending}>
          {login.isPending ? "Logging in…" : "Log in"}
        </button>
      </form>
      <p className="muted">
        New here? <Link to="/signup">Create an account</Link>
      </p>
    </AuthCard>
  );
}

export function SignupPage() {
  const me = useMe();
  const signup = useSignup();
  const navigate = useNavigate();
  const [mismatch, setMismatch] = useState(false);

  if (me.data) return <Navigate to="/app" replace />;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const password = field(form, "password");
    setMismatch(password !== field(form, "confirm"));
    if (password !== field(form, "confirm")) return;
    signup.mutate(
      { name: field(form, "name"), email: field(form, "email"), password },
      { onSuccess: () => navigate("/app", { replace: true }) },
    );
  };

  return (
    <AuthCard title="Create your account">
      <form className="form" onSubmit={onSubmit}>
        <label>
          Name
          <input name="name" autoComplete="name" required maxLength={100} />
        </label>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={128}
          />
        </label>
        <label>
          Repeat password
          <input name="confirm" type="password" autoComplete="new-password" required />
        </label>
        {(mismatch || signup.error) && (
          <p className="form-error" role="alert">
            {mismatch ? "The passwords don't match" : signup.error?.message}
          </p>
        )}
        <button type="submit" className="button button-primary" disabled={signup.isPending}>
          {signup.isPending ? "Creating…" : "Create account"}
        </button>
      </form>
      <p className="muted">
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </AuthCard>
  );
}
