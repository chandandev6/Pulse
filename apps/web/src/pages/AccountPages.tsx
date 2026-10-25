import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  tokenFromHash,
  useAcceptInvitation,
  useForgotPassword,
  useInvitationPreview,
  useResetPassword,
  useVerifyEmail,
} from "../api/account";
import { useMe } from "../api/queries";
import { Loading } from "../components/States";
import { AuthCard, field } from "./AuthPages";

// Reads the token from "#token=..." once, then removes it from the address bar,
// so it isn't left in the browser history or shared by copying the URL.
function useHashToken() {
  const location = useLocation();
  const [token] = useState(() => tokenFromHash(location.hash));
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, []);
  return token;
}

export function ForgotPasswordPage() {
  const forgot = useForgotPassword();
  const [sentTo, setSentTo] = useState<string | null>(null);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = field(e.currentTarget, "email");
    forgot.mutate(email, { onSuccess: () => setSentTo(email) });
  };

  if (sentTo) {
    return (
      <AuthCard title="Check your inbox">
        <p>
          If <strong>{sentTo}</strong> has a Pulse account, we just sent it a link to choose a new
          password. It works once, for 1 hour.
        </p>
        <p className="muted">
          Nothing after a few minutes? Check your spam folder, or{" "}
          <button type="button" className="link-button" onClick={() => setSentTo(null)}>
            try another address
          </button>
          .
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password">
      <p className="muted">Enter your account's email and we'll send you a link.</p>
      <form className="form" onSubmit={onSubmit}>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        {forgot.error && (
          <p className="form-error" role="alert">
            {forgot.error.message}
          </p>
        )}
        <button type="submit" className="button button-primary" disabled={forgot.isPending}>
          {forgot.isPending ? "Sending…" : "Send the link"}
        </button>
      </form>
      <p className="muted">
        <Link to="/login">← Back to log in</Link>
      </p>
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const token = useHashToken();
  const reset = useResetPassword();
  const navigate = useNavigate();
  const [mismatch, setMismatch] = useState(false);

  if (!token) {
    return (
      <AuthCard title="Link incomplete">
        <p>Open the link from the email again, or ask for a new one.</p>
        <Link to="/forgot-password" className="button">
          Send a new link
        </Link>
      </AuthCard>
    );
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const password = field(form, "password");
    const same = password === field(form, "confirm");
    setMismatch(!same);
    if (!same) return;
    reset.mutate({ token, password }, { onSuccess: () => navigate("/app", { replace: true }) });
  };

  return (
    <AuthCard title="Choose a new password">
      <p className="muted">This also logs you out on every other device.</p>
      <form className="form" onSubmit={onSubmit}>
        <label>
          New password
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
          Repeat it
          <input name="confirm" type="password" autoComplete="new-password" required />
        </label>
        {(mismatch || reset.error) && (
          <p className="form-error" role="alert">
            {mismatch ? "The passwords don't match" : reset.error?.message}
          </p>
        )}
        <button type="submit" className="button button-primary" disabled={reset.isPending}>
          {reset.isPending ? "Saving…" : "Save and log in"}
        </button>
      </form>
      {reset.error && (
        <p className="muted">
          <Link to="/forgot-password">Send a new link</Link>
        </p>
      )}
    </AuthCard>
  );
}

export function VerifyEmailPage() {
  const token = useHashToken();
  const verify = useVerifyEmail();
  const me = useMe();
  const started = useRef(false);

  // Once only: React runs effects twice in development, and a token works once
  useEffect(() => {
    if (token && !started.current) {
      started.current = true;
      verify.mutate(token);
    }
  }, [token, verify]);

  const next = me.data ? "/app" : "/login";

  if (verify.isSuccess) {
    return (
      <AuthCard title="Email confirmed">
        <p>Thanks! Pulse can now send you alerts and invitations.</p>
        <Link to={next} className="button button-primary">
          {me.data ? "Open the dashboard" : "Log in"}
        </Link>
      </AuthCard>
    );
  }
  if (!token || verify.isError) {
    return (
      <AuthCard title="This link doesn't work">
        <p>
          {verify.error?.message ?? "The link is incomplete."} Log in and ask for a new one from the
          banner at the top of the dashboard.
        </p>
        <Link to={next} className="button">
          {me.data ? "Open the dashboard" : "Log in"}
        </Link>
      </AuthCard>
    );
  }
  return <Loading />;
}

const INVITE_KEY = "pulse:invite";

// Keeps the token while they log in or sign up first (the "#token" doesn't survive that)
function rememberedInvite(fromHash: string | null) {
  try {
    if (fromHash) sessionStorage.setItem(INVITE_KEY, fromHash);
    return fromHash ?? sessionStorage.getItem(INVITE_KEY);
  } catch {
    return fromHash; // storage blocked (private mode): the link still works when logged in
  }
}

function forgetInvite() {
  try {
    sessionStorage.removeItem(INVITE_KEY);
  } catch {
    // ignore
  }
}

export function InvitePage() {
  const fromHash = useHashToken();
  const [token] = useState(() => rememberedInvite(fromHash));
  const preview = useInvitationPreview(token);
  const accept = useAcceptInvitation();
  const me = useMe();
  const navigate = useNavigate();

  if (!token || preview.isError) {
    return (
      <AuthCard title="Invitation not found">
        <p>This invitation has expired or was already used. Ask for a new one.</p>
        <Link to="/" className="button">
          Go to Pulse
        </Link>
      </AuthCard>
    );
  }
  if (preview.isLoading || me.isLoading || !preview.data) return <Loading />;

  const { orgName, inviterName, email, role } = preview.data;
  const onAccept = () =>
    accept.mutate(token, {
      onSuccess: () => {
        forgetInvite();
        navigate("/app", { replace: true });
      },
    });

  return (
    <AuthCard title={`Join ${orgName}`}>
      <p>
        {inviterName ?? "Someone"} invited <strong>{email}</strong> to <strong>{orgName}</strong> on
        Pulse, as {role === "member" ? "a member" : `an ${role}`}.
      </p>
      {me.data ? (
        <>
          {me.data.email !== email && (
            <p className="muted">
              You're logged in as {me.data.email}. Accepting adds this account instead.
            </p>
          )}
          {accept.error && (
            <p className="form-error" role="alert">
              {accept.error.message}
            </p>
          )}
          <button
            type="button"
            className="button button-primary"
            disabled={accept.isPending}
            onClick={onAccept}
          >
            {accept.isPending ? "Joining…" : `Join ${orgName}`}
          </button>
        </>
      ) : (
        <div className="actions">
          <Link
            to={`/signup?next=/invite&email=${encodeURIComponent(email)}`}
            className="button button-primary"
          >
            Create an account
          </Link>
          <Link to="/login?next=/invite" className="button">
            Log in
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
