import { useResendVerification } from "../api/account";
import { useMe } from "../api/queries";

// Shown while the server requires a verified email and this account hasn't clicked the link yet
export function VerifyEmailBanner() {
  const me = useMe();
  const resend = useResendVerification();
  if (!me.data?.mustVerifyEmail) return null;

  return (
    <div className="notice" role="status">
      <span>
        <strong>Confirm your email.</strong> We sent a link to {me.data.email}. Until then you can't
        create projects, add notification channels or invite people.
      </span>
      {resend.isSuccess ? (
        <span className="muted">Sent. Check your inbox (and spam).</span>
      ) : (
        <button
          type="button"
          className="button button-small"
          disabled={resend.isPending}
          onClick={() => resend.mutate()}
        >
          {resend.isPending ? "Sending…" : "Send it again"}
        </button>
      )}
      {resend.error && <span className="form-error">{resend.error.message}</span>}
    </div>
  );
}
