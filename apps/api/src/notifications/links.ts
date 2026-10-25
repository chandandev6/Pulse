import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

// Links inside notifications point at the dashboard
export const issueUrl = (projectId: string, issueId: string) =>
  `${config.WEB_PUBLIC_URL}/projects/${projectId}/issues/${issueId}`;

// ---------- One-click "acknowledge" links ----------
//
// The person reading the email isn't logged in, so the link itself must prove
// it came from us: it carries a signature (HMAC) made with APP_SECRET.
// Nobody can make a valid one for another incident without knowing the secret.
// Token: "<userId or ->.<expires (unix seconds)>.<signature>"
// Anyone holding a personal link can acknowledge as that person, so it works for
// 2 days only: plenty for an incident, short if an email is forwarded or leaks.

const ACK_LINK_TTL_SECONDS = 2 * 24 * 60 * 60;

const sign = (incidentId: string, userPart: string, expires: number) =>
  createHmac("sha256", config.APP_SECRET)
    .update(`ack|${incidentId}|${userPart}|${expires}`)
    .digest("base64url");

// userId: who the link was sent to (null for team channels like webhooks)
export function createAckToken(incidentId: string, userId: string | null, now = Date.now()) {
  const expires = Math.floor(now / 1000) + ACK_LINK_TTL_SECONDS;
  const userPart = userId ?? "-";
  return `${userPart}.${expires}.${sign(incidentId, userPart, expires)}`;
}

// Returns who the link was for, or null if it's forged, for another incident or expired
export function verifyAckToken(incidentId: string, token: string, now = Date.now()) {
  const [userPart, expiresText, signature] = token.split(".");
  if (!userPart || !expiresText || !signature) return null;

  const expires = Number(expiresText);
  if (!Number.isInteger(expires) || expires * 1000 < now) return null;

  const expected = Buffer.from(sign(incidentId, userPart, expires));
  const given = Buffer.from(signature);
  // timingSafeEqual takes the same time however many characters match,
  // so an attacker can't guess the signature one character at a time
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  return { userId: userPart === "-" ? null : userPart };
}

// The token goes after "#": browsers never send that part to the server, so it can't end
// up in nginx or Cloudflare logs or leak through the Referer header
export const ackUrl = (incidentId: string, userId: string | null) =>
  `${config.WEB_PUBLIC_URL}/incidents/${incidentId}/acknowledge#token=${createAckToken(incidentId, userId)}`;
