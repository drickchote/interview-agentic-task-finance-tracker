// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { env } from "#/server/env";
import { sendEmail, EmailDeliveryError } from "#/server/email";

const originalProvider = env.email.provider;
afterEach(() => {
  env.email.provider = originalProvider;
  vi.unstubAllGlobals();
});

it("sends the stable snapshot and idempotency key to Resend with a timeout", async () => {
  env.email.provider = "resend";
  const fetch = vi.fn().mockResolvedValue(new Response('{"id":"provider-id"}', { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await sendEmail(
    {
      from: "saved@example.com",
      to: "owner@example.com",
      subject: "Saved subject",
      text: "Saved body",
    },
    { idempotencyKey: "budget-alert:budget:2026-11" },
  );
  const request = fetch.mock.calls[0][1];
  expect(request.headers["Idempotency-Key"]).toBe("budget-alert:budget:2026-11");
  expect(request.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(request.body)).toEqual({
    from: "saved@example.com",
    to: "owner@example.com",
    subject: "Saved subject",
    text: "Saved body",
  });
});

it("reports HTTP rejection without copying provider contents into errors", async () => {
  env.email.provider = "resend";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("private recipient", { status: 429 })),
  );
  await expect(
    sendEmail({ to: "owner@example.com", subject: "Test", text: "Test" }),
  ).rejects.toEqual(new EmailDeliveryError(429));
});
