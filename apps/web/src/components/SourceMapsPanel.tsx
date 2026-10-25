import { type FormEvent, useState } from "react";
import { useSourceMapReleases, useUploadTokenActions, useUploadTokens } from "../api/account";
import { fullDate, timeAgo } from "../format";

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;

// Source maps turn minified browser stack traces back into real files and lines.
// CI uploads them with an upload token; this panel makes tokens and shows what arrived.
export function SourceMapsPanel({
  projectId,
  origin,
  isAdmin,
}: {
  projectId: string;
  origin: string;
  isAdmin: boolean;
}) {
  const releases = useSourceMapReleases(projectId);
  const tokens = useUploadTokens(projectId, isAdmin);
  const { create, revoke } = useUploadTokenActions(projectId);
  const [secret, setSecret] = useState<string | null>(null);

  const onCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name"));
    create.mutate(name, {
      onSuccess: (result) => {
        setSecret(result.secret);
        form.reset();
      },
    });
  };

  return (
    <section className="panel">
      <h2>Source maps</h2>
      <p className="muted">
        For browser apps: upload your build's <code>.map</code> files for each release, and stack
        traces show your real files, lines and functions instead of{" "}
        <code>index-a1b2.js:1:48213</code>. Events must send the same <code>release</code> you
        upload for.
      </p>

      <pre className="json">
        <code>{`# in CI, after building (vite: build.sourcemap = "hidden")
PULSE_UPLOAD_TOKEN=pulse_ut_... node scripts/upload-sourcemaps.mjs \\
  --url ${origin} --project ${projectId} --release 1.4.2 --delete dist`}</code>
      </pre>

      {isAdmin && (
        <>
          <h3 className="subheading">Upload tokens</h3>
          {secret && (
            <div className="secret-box" role="status">
              <strong>Copy this token now. It won't be shown again.</strong>
              <code>{secret}</code>
            </div>
          )}
          {(tokens.data ?? []).length > 0 && (
            <ul className="token-list">
              {(tokens.data ?? []).map((token) => (
                <li key={token.id}>
                  <span>
                    {token.name}
                    <span className="muted">
                      {" "}
                      · {token.lastUsedAt ? `used ${timeAgo(token.lastUsedAt)}` : "never used"}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="link-button danger"
                    onClick={() => revoke.mutate(token.id)}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="form-row" onSubmit={onCreate}>
            <label className="inline-label">
              <span className="sr-only">Token name</span>
              <input name="name" required maxLength={100} placeholder="e.g. GitHub Actions" />
            </label>
            <button type="submit" className="button" disabled={create.isPending}>
              Create token
            </button>
          </form>
        </>
      )}

      <h3 className="subheading">Uploaded</h3>
      {(releases.data ?? []).length === 0 ? (
        <p className="muted">Nothing uploaded yet.</p>
      ) : (
        <table className="issue-table">
          <thead>
            <tr>
              <th>Release</th>
              <th className="num">Files</th>
              <th className="num">Size</th>
              <th>Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {(releases.data ?? []).map((release) => (
              <tr key={release.release}>
                <td>
                  <code>{release.release}</code>
                </td>
                <td className="num">{release.files}</td>
                <td className="num">{kb(release.bytes)}</td>
                <td title={fullDate(release.uploadedAt)}>{timeAgo(release.uploadedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
