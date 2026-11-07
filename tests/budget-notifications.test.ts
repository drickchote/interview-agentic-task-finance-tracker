// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "#/db";
import {
  createBudgetInternal,
  updateBudgetLimitInternal,
  budgetMonth,
} from "#/server/budgets.server";
import * as notifications from "#/server/budget-notifications.server";
import { EmailDeliveryError } from "#/server/email";

const now = new Date();
const date = now.toISOString().slice(0, 10);
const rows = () => db.select().from(schema.budget_notifications);
const expense = (amount = -1100) =>
  db.insert(schema.transactions).values({
    id: crypto.randomUUID(),
    user_id: "owner",
    account_id: "account",
    category_id: "child",
    amount_minor: amount,
    date,
  });
const queue = () => notifications.queueBudgetNotifications("owner", now);

beforeEach(async () => {
  await db.delete(schema.budgets);
  await db.delete(schema.transactions);
  await db.delete(schema.categories);
  await db.delete(schema.accounts);
  await db.delete(schema.users);
  await db
    .insert(schema.users)
    .values({ id: "owner", username: "owner", password_hash: "x", email: "owner@example.com" });
  await db.insert(schema.accounts).values({ id: "account", user_id: "owner", name: "Main" });
  await db.insert(schema.categories).values([
    { id: "root", user_id: "owner", name: "Groceries" },
    { id: "child", user_id: "owner", parent_id: "root", name: "Fruit" },
  ]);
  await db
    .insert(schema.budgets)
    .values({ id: "budget", user_id: "owner", category_id: "root", limit_minor: 1000 });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("budget alert triggering", () => {
  it("ignores income/refunds and exact-limit spending, then queues descendants only above the limit", async () => {
    await expense(-1000);
    await expense(5000);
    await queue();
    expect(await rows()).toEqual([]);
    await expense(-1);
    await queue();
    expect(await rows()).toEqual([
      expect.objectContaining({
        budget_id: "budget",
        month: budgetMonth(now).month,
        limit_minor: 1000,
        spent_minor: 1001,
        recipient_email: "owner@example.com",
        status: "pending",
      }),
    ]);
  });

  it("queues on already-exceeded creation and limit reduction, and handles missing email", async () => {
    await db.delete(schema.budgets);
    await expense();
    expect(
      await createBudgetInternal("owner", { categoryId: "root", limitMinor: 1000 }),
    ).toMatchObject({ success: true });
    expect(await rows()).toHaveLength(1);
    await db.delete(schema.budgets);
    const result = await createBudgetInternal("owner", { categoryId: "root", limitMinor: 2000 });
    if (!result.data) throw new Error("Expected budget");
    expect(await rows()).toHaveLength(0);
    await db.update(schema.users).set({ email: null }).where(eq(schema.users.id, "owner"));
    await updateBudgetLimitInternal("owner", { id: result.data.id, limitMinor: 1000 });
    expect(await rows()).toHaveLength(0);
    await db
      .update(schema.users)
      .set({ email: "new@example.com" })
      .where(eq(schema.users.id, "owner"));
    await queue();
    expect((await rows())[0].recipient_email).toBe("new@example.com");
  });

  it("deduplicates concurrent checks and repeated crossings, with a fresh slot next month", async () => {
    await expense();
    await Promise.all(Array.from({ length: 8 }, queue));
    expect(await rows()).toHaveLength(1);
    await db.update(schema.transactions).set({ amount_minor: -1 });
    await queue();
    await db.update(schema.transactions).set({ amount_minor: -1200 });
    await queue();
    expect(await rows()).toHaveLength(1);
    const next = new Date(budgetMonth(now).to + "T12:00:00Z");
    await db.update(schema.transactions).set({ date: next.toISOString().slice(0, 10) });
    await notifications.queueBudgetNotifications("owner", next);
    expect(await rows()).toHaveLength(2);
  });

  it("does not fail a persisted financial change when queueing fails", async () => {
    await expense();
    vi.spyOn(notifications, "queueBudgetNotifications").mockRejectedValue(
      new Error("database unavailable"),
    );
    const result = await updateBudgetLimitInternal("owner", { id: "budget", limitMinor: 500 });
    expect(result).toMatchObject({ success: true, data: { limit_minor: 500 } });
    expect(await rows()).toHaveLength(0);
    vi.restoreAllMocks();
    await notifications.runBudgetNotificationMaintenance();
    expect((await rows())[0].status).toBe("sent");
  });

  it("captures aggregate spending beyond a signed 32-bit integer", async () => {
    await expense(-2147483648);
    await expense(-1000);
    await queue();
    expect((await rows())[0].spent_minor).toBe(2147484648);
  });
});

describe("durable budget email delivery", () => {
  beforeEach(async () => {
    await expense();
    await queue();
  });

  it("claims atomically across workers, sends once, and keeps completed records deduplicated", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await Promise.all([
      notifications.processBudgetNotifications({ send, now: () => now }),
      notifications.processBudgetNotifications({ send, now: () => now }),
    ]);
    await queue();
    await notifications.processBudgetNotifications({ send, now: () => now });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await rows())[0]).toMatchObject({
      status: "sent",
      attempt_count: 1,
      next_retry_at: null,
      sent_at: now,
    });
  });

  it("persists retries and reuses frozen payload/key after edits and a new worker", async () => {
    const first = vi.fn().mockRejectedValue(new Error("timeout after provider accepted"));
    await notifications.processBudgetNotifications({ send: first, now: () => now });
    const failed = (await rows())[0];
    expect(failed).toMatchObject({
      status: "failed",
      attempt_count: 1,
      last_error: "delivery_unconfirmed",
    });
    expect(failed.next_retry_at).toBeInstanceOf(Date);
    await db.update(schema.categories).set({ name: "Renamed" });
    await db.update(schema.users).set({ email: "changed@example.com" });
    await updateBudgetLimitInternal("owner", { id: "budget", limitMinor: 1 });
    const restarted = vi.fn().mockResolvedValue(undefined);
    await notifications.processBudgetNotifications({ send: restarted, now: () => now });
    expect(restarted).not.toHaveBeenCalled();
    await notifications.processBudgetNotifications({
      send: restarted,
      now: () => failed.next_retry_at!,
    });
    expect(restarted.mock.calls[0]).toEqual(first.mock.calls[0]);
    expect(restarted.mock.calls[0][0].text).toContain("Groceries");
    expect(restarted.mock.calls[0][0].to).toBe("owner@example.com");
    expect((await rows())[0]).toMatchObject({
      status: "sent",
      attempt_count: 2,
      first_attempt_at: now,
    });
  });

  it("recovers a crashed processing lease without resetting the delivery window", async () => {
    const firstAttempt = new Date(now.getTime() - 5 * 60_000);
    await db.update(schema.budget_notifications).set({
      status: "processing",
      attempt_count: 1,
      first_attempt_at: firstAttempt,
      processing_at: firstAttempt,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    await notifications.processBudgetNotifications({ send, now: () => now });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await rows())[0]).toMatchObject({
      status: "sent",
      attempt_count: 2,
      first_attempt_at: firstAttempt,
    });
  });

  it("does not steal an active lease", async () => {
    await db
      .update(schema.budget_notifications)
      .set({ status: "processing", attempt_count: 1, first_attempt_at: now, processing_at: now });
    const send = vi.fn();
    await notifications.processBudgetNotifications({ send, now: () => now });
    expect(send).not.toHaveBeenCalled();
  });

  it("fences a late worker so it cannot overwrite a recovered delivery", async () => {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const lateSend = vi.fn(async () => {
      started();
      await waiting;
      throw new Error("late timeout");
    });
    const lateWorker = notifications.processBudgetNotifications({
      send: lateSend,
      now: () => now,
      limit: 1,
    });
    await sending;
    await db
      .update(schema.budget_notifications)
      .set({ processing_at: new Date(now.getTime() - 5 * 60_000) });
    const recoveredSend = vi.fn().mockResolvedValue(undefined);
    await notifications.processBudgetNotifications({ send: recoveredSend, now: () => now });
    release();
    await lateWorker;
    expect((await rows())[0]).toMatchObject({
      status: "sent",
      attempt_count: 2,
      next_retry_at: null,
      last_error: null,
    });
    expect(recoveredSend.mock.calls[0]).toEqual(lateSend.mock.calls[0]);
  });

  it.each([429, 503])("persists a retry after provider HTTP %s", async (status) => {
    await notifications.processBudgetNotifications({
      send: vi.fn().mockRejectedValue(new EmailDeliveryError(status)),
      now: () => now,
    });
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      last_error: "delivery_unconfirmed",
    });
    expect((await rows())[0].next_retry_at!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("holds uncertain deliveries after the deduplication window instead of blindly resending", async () => {
    const old = new Date(now.getTime() - 24 * 60 * 60_000);
    await db
      .update(schema.budget_notifications)
      .set({ status: "processing", attempt_count: 1, first_attempt_at: old, processing_at: old });
    const send = vi.fn();
    await notifications.processBudgetNotifications({ send, now: () => now });
    expect(send).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      next_retry_at: null,
      last_error: "delivery_window_expired_review_required",
    });
    await notifications.processBudgetNotifications({
      send,
      now: () => new Date(now.getTime() + 86400000),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("can send an old queued notification if no attempt has ever occurred", async () => {
    await db
      .update(schema.budget_notifications)
      .set({ created_at: new Date(now.getTime() - 3 * 86400000) });
    const send = vi.fn().mockResolvedValue(undefined);
    await notifications.processBudgetNotifications({ send, now: () => now });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stops at the 23-hour safety boundary and handles permanent provider rejection", async () => {
    await db.update(schema.budget_notifications).set({
      first_attempt_at: new Date(now.getTime() - 23 * 60 * 60_000),
    });
    const send = vi.fn();
    await notifications.processBudgetNotifications({ send, now: () => now });
    expect(send).not.toHaveBeenCalled();
    await db.update(schema.budget_notifications).set({ status: "pending", first_attempt_at: null });
    send.mockRejectedValue(new EmailDeliveryError(422));
    await notifications.processBudgetNotifications({ send, now: () => now });
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      next_retry_at: null,
      last_error: "provider_rejected",
    });
  });

  it("holds rows with missing snapshots or a different provider", async () => {
    await db.update(schema.budget_notifications).set({ email_text: null });
    const send = vi.fn();
    await notifications.processBudgetNotifications({ send, now: () => now });
    expect((await rows())[0].last_error).toBe("missing_payload_review_required");
    await db
      .update(schema.budget_notifications)
      .set({ status: "pending", email_text: "saved", email_provider: "resend" });
    await notifications.processBudgetNotifications({ send, now: () => now });
    expect((await rows())[0].last_error).toBe("provider_changed_review_required");
    expect(send).not.toHaveBeenCalled();
  });
});
