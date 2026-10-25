import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { notificationChannels } from "../db/schema.js";
import { AppError } from "../errors.js";
import { channelCodeMail } from "../mail/templates.js";
import { assertUnderLimit, countUse, resetUses } from "../rate-limit.js";
import { redis } from "../redis.js";
import { testMessage } from "./message.js";
import { enqueueMail } from "./queue.js";
import { defaultNotifiers } from "./registry.js";

type Channel = typeof notificationChannels.$inferSelect;

// Before Pulse sends alerts to an email address or phone number, its owner proves it's theirs
// by typing a 6-digit code sent there. Otherwise anyone could sign up, add a stranger's number
// and make your server text them (spam, and SMS that costs you money).
const CODE_TTL = 15 * 60; // seconds
const MAX_TRIES = 5; // wrong codes per code: 5 guesses out of a million
const CODES_PER_HOUR = 5; // per channel owner, so "resend" can't be used to spam either

const codeKey = (channelId: string) => `pulse-channel-code:${channelId}`;
const triesKey = (channelId: string) => `channel-code-tries:${channelId}`;
const ownerKey = (channel: Channel) => `channel-codes:${channel.userId ?? channel.orgId}`;
const hash = (code: string) => createHash("sha256").update(code).digest();

// Email and SMS go to a person who has to agree; push, webhooks and chat apps don't
export function needsVerification(channel: Pick<Channel, "type">) {
  return channel.type === "email" || channel.type === "sms";
}

export async function sendChannelCode(channel: Channel) {
  await assertUnderLimit(ownerKey(channel), CODES_PER_HOUR, 60 * 60);
  await countUse(ownerKey(channel), 60 * 60);

  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await redis.set(codeKey(channel.id), hash(code).toString("hex"), "EX", CODE_TTL);
  await resetUses(triesKey(channel.id));

  if (channel.type === "email" && "address" in channel.config) {
    await enqueueMail(channelCodeMail(channel.config.address, code));
  } else if (channel.type === "sms" && "phone" in channel.config) {
    const sms = defaultNotifiers().sms;
    if (!sms.isConfigured()) {
      throw new AppError(409, "SMS_NOT_CONFIGURED", "SMS is not set up on this server");
    }
    const text = `Your Pulse code is ${code}. It expires in 15 minutes.`;
    // SMS only uses `short`; the rest of the message shape comes from the test message
    await sms.send(channel.config, { ...testMessage("verification", channel.name), short: text });
  }
}

const wrongCode = () =>
  new AppError(400, "INVALID_CODE", "That code is wrong or has expired. Ask for a new one.");

export async function verifyChannelCode(channel: Channel, code: string) {
  if (channel.verifiedAt) return channel;
  await assertUnderLimit(triesKey(channel.id), MAX_TRIES, CODE_TTL);

  const stored = await redis.get(codeKey(channel.id));
  const given = hash(code.trim());
  if (!stored || !timingSafeEqual(Buffer.from(stored, "hex"), given)) {
    await countUse(triesKey(channel.id), CODE_TTL);
    throw wrongCode();
  }

  await redis.del(codeKey(channel.id));
  const [updated] = await db
    .update(notificationChannels)
    .set({ verifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(notificationChannels.id, channel.id))
    .returning();
  if (!updated) throw wrongCode();
  return updated;
}
