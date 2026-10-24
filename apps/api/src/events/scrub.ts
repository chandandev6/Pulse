import type { PulseEvent } from "@pulse/shared";

export const FILTERED = "[Filtered]";

// Key names that usually hold secrets. Matched anywhere in the name, ignoring case,
// so "password", "userPassword" and "x-api-key" are all caught.
const DEFAULT_SENSITIVE = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "api-key",
  "auth",
  "authorization",
  "cookie",
  "session",
  "csrf",
  "xsrf",
  "credit_card",
  "creditcard",
  "card_number",
  "cvv",
  "ssn",
  "private_key",
];

const BEARER = /\bBearer\s+[\w\-.~+/]+=*/gi; // Authorization headers pasted into messages
const CARD_LIKE = /\b\d(?:[ -]?\d){12,18}\b/g; // 13–19 digits, maybe with spaces or dashes

// The Luhn checksum every card number passes. It keeps us from hiding
// ordinary long numbers like millisecond timestamps (most fail it).
function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export type ScrubOptions = {
  fields: readonly string[]; // extra key names from the project's settings
  ipAddresses: boolean; // also drop the user's IP address
};

const MAX_DEPTH = 10;

function makeIsSensitive(extra: readonly string[]) {
  const needles = [...DEFAULT_SENSITIVE, ...extra.map((f) => f.toLowerCase())];
  return (key: string) => {
    const lower = key.toLowerCase();
    return needles.some((needle) => lower.includes(needle));
  };
}

// Values that look like secrets no matter which key they are under
function scrubString(value: string): string {
  return value
    .replace(BEARER, FILTERED)
    .replace(CARD_LIKE, (match) => (passesLuhn(match.replace(/\D/g, "")) ? FILTERED : match));
}

// Walks objects and arrays: sensitive keys lose their value, strings lose secret-looking parts
function scrubValue(value: unknown, isSensitive: (key: string) => boolean, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, isSensitive, depth + 1));

  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      isSensitive(key) ? FILTERED : scrubValue(inner, isSensitive, depth + 1),
    ]),
  );
}

// "?token=abc&page=2" → "?token=[Filtered]&page=2"
function scrubUrl(url: string, isSensitive: (key: string) => boolean): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return scrubString(url);
  const [query, hash = ""] = url.slice(queryStart + 1).split("#", 2);
  const params = (query ?? "").split("&").map((pair) => {
    const [key = "", ...rest] = pair.split("=");
    return rest.length && isSensitive(decodeURIComponent(key)) ? `${key}=${FILTERED}` : pair;
  });
  return `${scrubString(url.slice(0, queryStart))}?${params.join("&")}${hash ? `#${hash}` : ""}`;
}

// Runs in the API before the event is queued, so secrets never reach Redis or Postgres.
// Stack frames and the exception type are left alone: grouping depends on them.
export function scrubEvent(event: PulseEvent, options: ScrubOptions): PulseEvent {
  const isSensitive = makeIsSensitive(options.fields);
  const scrubbed: PulseEvent = { ...event };

  if (event.message) scrubbed.message = scrubString(event.message);
  if (event.exception?.value) {
    scrubbed.exception = { ...event.exception, value: scrubString(event.exception.value) };
  }
  if (event.request) {
    scrubbed.request = {
      ...event.request,
      url: event.request.url && scrubUrl(event.request.url, isSensitive),
      headers:
        event.request.headers &&
        (scrubValue(event.request.headers, isSensitive) as Record<string, string>),
    };
  }
  if (event.tags) scrubbed.tags = scrubValue(event.tags, isSensitive) as Record<string, string>;
  if (event.context) {
    scrubbed.context = scrubValue(event.context, isSensitive) as Record<string, unknown>;
  }
  if (event.user?.ip && options.ipAddresses) {
    const { ip: _ip, ...user } = event.user;
    scrubbed.user = user;
  }
  return scrubbed;
}
