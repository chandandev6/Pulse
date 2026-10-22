import type { ChannelType, ConfigFor } from "./channels.js";
import type { NotificationMessage } from "./message.js";

// Every channel looks the same to the worker: "send this message to this recipient".
// Adding a channel (Slack, Telegram...) = one new Notifier + one entry in the registry.
export interface Notifier<T extends ChannelType = ChannelType> {
  // False when the server isn't set up for it (e.g. no Twilio account): deliveries are skipped
  isConfigured(): boolean;
  send(recipient: ConfigFor[T], message: NotificationMessage): Promise<void>;
}

export type NotifierRegistry = { [T in ChannelType]: Notifier<T> };

// Trying again won't help (bad phone number, webhook says 404...): don't retry.
// disableChannel: the channel is gone for good (e.g. the browser unsubscribed).
export class PermanentError extends Error {
  disableChannel: boolean;

  constructor(message: string, { disableChannel = false } = {}) {
    super(message);
    this.name = "PermanentError";
    this.disableChannel = disableChannel;
  }
}
