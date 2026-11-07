// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { db, schema } from "../src/db/index.ts";
import {
  buildExportZip,
  hardDeleteUser,
  purgeExpiredAiRawResponses,
  sweepExpiredDeletions,
  toCsv,
} from "../src/server/compliance.server.ts";
import { storage } from "../src/server/storage.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Seed a user with one row in every user-owned table plus a stored image. */
async function seedFullUser(userId: string) {
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    email: `${userId}@example.com`,
    password_hash: "x",
  });
  await db.insert(schema.accounts).values({
    id: `${userId}-acc`,
    user_id: userId,
    name: "Checking",
    currency: "PLN",
  });
  await db.insert(schema.categories).values({
    id: `${userId}-cat`,
    user_id: userId,
    name: "Groceries",
  });
  await db.insert(schema.budgets).values({
    id: `${userId}-budget`, user_id: userId, category_id: `${userId}-cat`, limit_minor: 1000,
  });
  await db.insert(schema.budget_notifications).values({
    id: `${userId}-notification`, budget_id: `${userId}-budget`, month: "2026-07",
    recipient_email: `${userId}@example.com`, limit_minor: 1000, spent_minor: 1234,
    status: "failed", attempt_count: 2, next_retry_at: new Date("2026-07-02T12:00:00Z"),
    processing_at: new Date("2026-07-02T11:59:00Z"), first_attempt_at: new Date("2026-07-02T11:00:00Z"),
    email_provider: "test", email_from: "sender@example.com", email_subject: "Saved alert",
    email_text: "Saved spending snapshot", last_error: "delivery_unconfirmed",
  });
  await db.insert(schema.import_batches).values({
    id: `${userId}-batch`,
    user_id: userId,
    account_id: `${userId}-acc`,
    filename: "statement.csv",
    row_count: 1,
  });
  await db.insert(schema.transactions).values({
    id: `${userId}-txn`,
    user_id: userId,
    account_id: `${userId}-acc`,
    date: "2026-07-01",
    amount_minor: -1234,
    description: "Grocery store",
    category_id: `${userId}-cat`,
    import_batch_id: `${userId}-batch`,
  });
  await db.insert(schema.categorization_rules).values({
    id: `${userId}-rule`,
    user_id: userId,
    pattern: "grocery",
    category_id: `${userId}-cat`,
  });
  const imageKey = `receipts/${userId}/test.jpg`;
  await storage.put(imageKey, new Uint8Array([0xff, 0xd8, 0xff, 0x42]));
  await db.insert(schema.receipts).values({
    id: `${userId}-rcpt`,
    user_id: userId,
    transaction_id: `${userId}-txn`,
    image_path: imageKey,
    ai_raw_response: '{"items":[]}',
  });
  await db.insert(schema.receipt_items).values({
    id: `${userId}-item`,
    receipt_id: `${userId}-rcpt`,
    name: "Milk",
    total_price_minor: 599,
    category_id: `${userId}-cat`,
  });
  await db.insert(schema.ai_usage).values({
    id: `${userId}-usage`,
    user_id: userId,
    kind: "receipt_scan",
    provider: "fake",
    model: "fake",
  });
  await db.insert(schema.subscriptions).values({
    user_id: userId,
    plan: "free",
    status: "active",
  });
  return { imageKey };
}

async function wipeUser(userId: string) {
  // hardDeleteUser is itself under test — clean up with it, it's idempotent.
  await hardDeleteUser(userId);
}

describe("compliance: CSV writer", () => {
  it("quotes every field and escapes embedded quotes", () => {
    const csv = toCsv(
      ["id", "name"],
      [
        ["1", 'say "hi"'],
        ["2", null],
      ],
    );
    expect(csv).toBe('"id","name"\n"1","say ""hi"""\n"2",""');
  });
});

describe("compliance: data export", () => {
  const userId = "export-test-user";
  const otherId = "export-other-user";
  afterEach(async () => { await wipeUser(userId); await wipeUser(otherId); });

  it("builds a zip with export.json, CSVs, and receipt images", async () => {
    await seedFullUser(userId);
    const zip = await buildExportZip(userId);
    const files = unzipSync(zip);

    const json = JSON.parse(strFromU8(files["export.json"]));
    expect(json.user.id).toBe(userId);
    expect(json.transactions).toHaveLength(1);
    expect(json.transactions[0].amount_minor).toBe(-1234);
    expect(json.receipts).toHaveLength(1);
    expect(json.receipts[0].items).toHaveLength(1);
    expect(json.receipts[0].image_file).toBe(`receipts/${userId}-rcpt.jpg`);
    expect(json.categorizationRules).toHaveLength(1);
    expect(json.subscription.plan).toBe("free");
    expect(json.budgets).toEqual([expect.objectContaining({
      id: `${userId}-budget`, user_id: userId, category_id: `${userId}-cat`, limit_minor: 1000,
    })]);
    expect(json.budgetNotifications).toEqual([expect.objectContaining({
      id: `${userId}-notification`, budget_id: `${userId}-budget`, month: "2026-07",
      recipient_email: `${userId}@example.com`, limit_minor: 1000, spent_minor: 1234,
      delivery_idempotency_key: `budget-alert:${userId}-budget:2026-07`,
      status: "failed", attempt_count: 2, next_retry_at: "2026-07-02T12:00:00.000Z",
      first_attempt_at: "2026-07-02T11:00:00.000Z", last_error: "delivery_unconfirmed",
      email_text: "Saved spending snapshot",
    })]);
    expect(strFromU8(files["budgets.csv"])).toContain(`"${userId}-budget"`);
    const notificationsCsv = strFromU8(files["budget_notifications.csv"]);
    expect(notificationsCsv).toContain('"attempt_count"');
    expect(notificationsCsv).toContain(`"budget-alert:${userId}-budget:2026-07"`);
    expect(notificationsCsv).toContain('"2026-07-02T12:00:00.000Z"');

    const txnCsv = strFromU8(files["transactions.csv"]);
    expect(txnCsv).toContain('"Grocery store"');
    expect(txnCsv).toContain('"-12.34"');
    expect(txnCsv).toContain('"Checking"');
    expect(strFromU8(files["receipt_items.csv"])).toContain('"Milk"');
    expect(strFromU8(files["accounts.csv"])).toContain('"Checking"');
    expect(strFromU8(files["categories.csv"])).toContain('"Groceries"');
    expect(strFromU8(files["categorization_rules.csv"])).toContain('"grocery"');

    expect(Array.from(files[`receipts/${userId}-rcpt.jpg`])).toEqual([
      0xff, 0xd8, 0xff, 0x42,
    ]);
  });

  it("exports only the requesting user's budgets and notification snapshots", async () => {
    await seedFullUser(userId);
    await seedFullUser(otherId);
    const files = unzipSync(await buildExportZip(userId));
    const json = JSON.parse(strFromU8(files["export.json"]));
    expect(json.budgets.map((row: { id: string }) => row.id)).toEqual([`${userId}-budget`]);
    expect(json.budgetNotifications.map((row: { id: string }) => row.id)).toEqual([`${userId}-notification`]);
    expect(strFromU8(files["budgets.csv"])).not.toContain(otherId);
    expect(strFromU8(files["budget_notifications.csv"])).not.toContain(otherId);
  });

  it("includes empty budget arrays and CSV headers for users without budgets", async () => {
    await db.insert(schema.users).values({ id: userId, username: userId, password_hash: "x" });
    const files = unzipSync(await buildExportZip(userId));
    const json = JSON.parse(strFromU8(files["export.json"]));
    expect(json.budgets).toEqual([]);
    expect(json.budgetNotifications).toEqual([]);
    expect(strFromU8(files["budgets.csv"]).split("\n")).toHaveLength(1);
    expect(strFromU8(files["budget_notifications.csv"])).toContain('"delivery_idempotency_key"');
  });
});

describe("compliance: account hard delete", () => {
  const userId = "delete-test-user";
  const otherId = "delete-other-user";
  afterEach(async () => { await wipeUser(userId); await wipeUser(otherId); });

  it("removes every row and the stored receipt images", async () => {
    const { imageKey } = await seedFullUser(userId);
    await hardDeleteUser(userId);

    const remaining = await Promise.all([
      db.select().from(schema.users).where(eq(schema.users.id, userId)),
      db.select().from(schema.accounts).where(eq(schema.accounts.user_id, userId)),
      db.select().from(schema.categories).where(eq(schema.categories.user_id, userId)),
      db.select().from(schema.transactions).where(eq(schema.transactions.user_id, userId)),
      db.select().from(schema.import_batches).where(eq(schema.import_batches.user_id, userId)),
      db.select().from(schema.categorization_rules).where(eq(schema.categorization_rules.user_id, userId)),
      db.select().from(schema.receipts).where(eq(schema.receipts.user_id, userId)),
      db.select().from(schema.receipt_items).where(eq(schema.receipt_items.receipt_id, `${userId}-rcpt`)),
      db.select().from(schema.ai_usage).where(eq(schema.ai_usage.user_id, userId)),
      db.select().from(schema.subscriptions).where(eq(schema.subscriptions.user_id, userId)),
      db.select().from(schema.budgets).where(eq(schema.budgets.user_id, userId)),
      db.select().from(schema.budget_notifications).where(eq(schema.budget_notifications.budget_id, `${userId}-budget`)),
    ]);
    for (const rows of remaining) {
      expect.soft(rows).toHaveLength(0);
    }
    expect(await storage.get(imageKey)).toBeNull();
  });

  it("preserves another user's budgets and notifications during account removal", async () => {
    await seedFullUser(userId);
    await seedFullUser(otherId);
    const budgetsBefore = await db.select().from(schema.budgets).where(eq(schema.budgets.user_id, otherId));
    const noticesBefore = await db.select().from(schema.budget_notifications)
      .where(eq(schema.budget_notifications.budget_id, `${otherId}-budget`));
    await hardDeleteUser(userId);
    expect(await db.select().from(schema.budgets).where(eq(schema.budgets.user_id, otherId))).toEqual(budgetsBefore);
    expect(await db.select().from(schema.budget_notifications)
      .where(eq(schema.budget_notifications.budget_id, `${otherId}-budget`))).toEqual(noticesBefore);
  });

  it("rolls back budgets and notifications if account removal fails", async () => {
    const { imageKey } = await seedFullUser(userId);
    await db.insert(schema.users).values({ id: otherId, username: otherId, password_hash: "x" });
    await db.insert(schema.categorization_rules).values({
      id: "foreign-blocker", user_id: otherId, category_id: `${userId}-cat`, pattern: "block",
    });
    try {
      await expect(hardDeleteUser(userId)).rejects.toThrow();
      expect(await db.select().from(schema.users).where(eq(schema.users.id, userId))).toHaveLength(1);
      expect(await db.select().from(schema.budgets).where(eq(schema.budgets.user_id, userId))).toHaveLength(1);
      expect(await db.select().from(schema.budget_notifications)
        .where(eq(schema.budget_notifications.budget_id, `${userId}-budget`))).toHaveLength(1);
      expect(await storage.get(imageKey)).not.toBeNull();
    } finally {
      await db.delete(schema.categorization_rules).where(eq(schema.categorization_rules.id, "foreign-blocker"));
    }
  });
});

describe("compliance: retention and grace-period sweep", () => {
  const userId = "sweep-test-user";
  afterEach(() => wipeUser(userId));

  it("purges ai_raw_response older than 90 days but keeps fresh ones", async () => {
    await seedFullUser(userId);
    await db.insert(schema.receipts).values({
      id: `${userId}-old`,
      user_id: userId,
      ai_raw_response: '{"old":true}',
      created_at: new Date(Date.now() - 91 * DAY_MS),
    });

    const purged = await purgeExpiredAiRawResponses();
    expect(purged).toBe(1);

    const receipts = await db
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.user_id, userId));
    const old = receipts.find((r) => r.id === `${userId}-old`);
    const fresh = receipts.find((r) => r.id === `${userId}-rcpt`);
    expect(old?.ai_raw_response).toBeNull();
    expect(fresh?.ai_raw_response).toBe('{"items":[]}');
  });

  it("hard-deletes only accounts whose grace period has elapsed", async () => {
    await seedFullUser(userId);

    // Pending but inside the grace window: untouched.
    await db
      .update(schema.users)
      .set({ deletion_requested_at: new Date(Date.now() - 1 * DAY_MS) })
      .where(eq(schema.users.id, userId));
    expect(await sweepExpiredDeletions()).toBe(0);
    expect(
      await db.select().from(schema.users).where(eq(schema.users.id, userId)),
    ).toHaveLength(1);

    // Past the 14-day grace window: gone.
    await db
      .update(schema.users)
      .set({ deletion_requested_at: new Date(Date.now() - 15 * DAY_MS) })
      .where(eq(schema.users.id, userId));
    expect(await sweepExpiredDeletions()).toBe(1);
    expect(
      await db.select().from(schema.users).where(eq(schema.users.id, userId)),
    ).toHaveLength(0);
  });
});
