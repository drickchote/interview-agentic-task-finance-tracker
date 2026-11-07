import { env } from "#/server/env";

//
// Minimal provider abstraction for transactional email. Three modes, chosen
// once at startup by src/server/env.ts:
//   - "console": logs the message to stdout (development default)
//   - "test":    captures messages in memory for E2E assertions (TEST_MODE)
//   - "resend":  sends via the Resend HTTP API
// Handlers must never depend on which mode is active.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Snapshot sender for durable deliveries; other callers use configuration. */
  from?: string;
}

export class EmailDeliveryError extends Error {
  constructor(public readonly status: number) {
    super(`Email provider returned HTTP ${status}`);
  }
}

// In-memory capture for TEST_MODE — read back by the /test-emails route so
// E2E tests can extract verification/reset links.
const capturedEmails: EmailMessage[] = [];

export function getCapturedEmails(to?: string): EmailMessage[] {
  return to ? capturedEmails.filter((e) => e.to === to) : [...capturedEmails];
}

export async function sendEmail(
  message: EmailMessage,
  options?: { idempotencyKey: string },
): Promise<void> {
  switch (env.email.provider) {
    case "test":
      capturedEmails.push(message);
      return;
    case "console":
      // Deliberately raw console output, not the structured logger: printing
      // the full body (with its verification/reset link) to the dev terminal
      // IS the delivery mechanism for this provider, and it never runs in
      // production.
      console.log(
        `[email] To: ${message.to}\n[email] Subject: ${message.subject}\n${message.text}`,
      );
      return;
    case "resend": {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.email.resendApiKey}`,
          "Content-Type": "application/json",
          ...(options ? { "Idempotency-Key": options.idempotencyKey } : {}),
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          from: message.from ?? env.email.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
        }),
      });
      if (!response.ok) {
        // Avoid persisting provider bodies, which can contain recipient data.
        throw new EmailDeliveryError(response.status);
      }
      return;
    }
  }
}
