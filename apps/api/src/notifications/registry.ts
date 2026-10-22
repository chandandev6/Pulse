import { createEmailNotifier } from "./email.js";
import type { NotifierRegistry } from "./notifier.js";
import { createPushNotifier } from "./push.js";
import { createSmsNotifier } from "./sms.js";
import { createWebhookNotifier } from "./webhook.js";

let registry: NotifierRegistry | undefined;

// Created on first use, so the API process (which only enqueues) never opens an SMTP connection
export function defaultNotifiers(): NotifierRegistry {
  registry ??= {
    email: createEmailNotifier(),
    sms: createSmsNotifier(),
    push: createPushNotifier(),
    webhook: createWebhookNotifier(),
  };
  return registry;
}
