import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";

export type Mail = { to: string; subject: string; text: string; html: string };

// One SMTP connection setup for the whole process, made on first use
let transport: Transporter | undefined;

export function mailTransport(): Transporter {
  transport ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });
  return transport;
}

export async function sendMail(mail: Mail) {
  await mailTransport().sendMail({ from: config.SMTP_FROM, ...mail });
}
