import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";
import type { Notifier } from "./notifier.js";

// What we need from nodemailer: tests pass a fake with the same shape
type MailTransport = Pick<Transporter, "sendMail">;

// SMTP is the standard way programs send email. Locally it goes to Mailpit,
// a fake mail server that catches everything: open http://localhost:8025 to read it.
export function createEmailNotifier(
  transport: MailTransport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  }),
): Notifier<"email"> {
  return {
    isConfigured: () => true,
    async send({ address }, message) {
      // A failure here (server down, timeout) throws, and the job is retried
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: address,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: { "X-Pulse-Delivery": message.deliveryId },
      });
    },
  };
}
