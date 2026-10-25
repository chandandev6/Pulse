import { escapeHtml } from "../notifications/message.js";

// Account emails (reset, verify, invite): one short message and one button.
// Every value that came from a person (names, org names) is escaped in the HTML.
function layout({ heading, body, button, url, footer }: Record<string, string>) {
  const text = [heading, "", body, "", `${button}: ${url}`, "", footer].join("\n");
  const html = `<!doctype html>
<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#06303f">
  <p style="font-weight:800;font-size:18px;margin:0 0 24px">Pulse</p>
  <h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(heading)}</h1>
  <p style="line-height:1.5;margin:0 0 24px">${escapeHtml(body)}</p>
  <p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="background:#ff6a13;color:#06303f;padding:12px 20px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(button)}</a></p>
  <p style="font-size:13px;color:#4b5e66;line-height:1.5;margin:0">${escapeHtml(footer)}<br>Or paste this link into your browser: ${escapeHtml(url)}</p>
</div>`;
  return { text, html };
}

export function passwordResetMail(to: string, url: string) {
  return {
    to,
    subject: "Reset your Pulse password",
    ...layout({
      heading: "Reset your password",
      body: "Someone (hopefully you) asked to reset the password of your Pulse account. The link works once, for 1 hour.",
      button: "Choose a new password",
      url,
      footer: "Didn't ask for this? Ignore this email: your password stays the same.",
    }),
  };
}

export function verifyEmailMail(to: string, name: string, url: string) {
  return {
    to,
    subject: "Confirm your email for Pulse",
    ...layout({
      heading: `Welcome to Pulse, ${name}`,
      body: "Confirm this is your email address, so Pulse can send you alerts and invitations. The link works for 24 hours.",
      button: "Confirm my email",
      url,
      footer: "Didn't sign up for Pulse? Ignore this email and nothing happens.",
    }),
  };
}

export function invitationMail(to: string, inviter: string, org: string, url: string) {
  return {
    to,
    subject: `${inviter} invited you to ${org} on Pulse`,
    ...layout({
      heading: `Join ${org} on Pulse`,
      body: `${inviter} invited you to ${org}, where your team tracks errors and handles incidents. The invitation works for 7 days.`,
      button: "Accept the invitation",
      url,
      footer: "Not expecting this? Ignore this email and you won't be added.",
    }),
  };
}

// A code, not a link: the person types it into the page where they added this address
export function channelCodeMail(to: string, code: string) {
  const text = [
    "Your Pulse verification code",
    "",
    `Someone added this address to Pulse to receive alerts. To confirm it's you, enter this code: ${code}`,
    "",
    "It works for 15 minutes. Didn't expect this? Ignore this email and you won't get any alerts.",
  ].join("\n");
  const html = `<!doctype html>
<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#06303f">
  <p style="font-weight:800;font-size:18px;margin:0 0 24px">Pulse</p>
  <h1 style="font-size:20px;margin:0 0 12px">Your verification code</h1>
  <p style="line-height:1.5;margin:0 0 16px">Someone added this address to Pulse to receive alerts. To confirm it's you, enter this code:</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 24px">${code}</p>
  <p style="font-size:13px;color:#4b5e66;line-height:1.5;margin:0">It works for 15 minutes. Didn't expect this? Ignore this email and you won't get any alerts.</p>
</div>`;
  return { to, subject: `${code} is your Pulse verification code`, text, html };
}
