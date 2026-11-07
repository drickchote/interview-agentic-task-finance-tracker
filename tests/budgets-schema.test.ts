// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "#/db/migrate";
import { budgets, budget_notifications, categories, users } from "#/db/schema";

const client = new PGlite();
const db = drizzle(client);

beforeAll(async () => {
  await runMigrations(db, "pglite");
  await db.insert(users).values([
    { id: "owner", username: "owner", password_hash: "unused" },
    { id: "other", username: "other", password_hash: "unused" },
  ]);
  await db.insert(categories).values([
    { id: "food", user_id: "owner", name: "Food" },
    { id: "travel", user_id: "owner", name: "Travel" },
  ]);
});

beforeEach(async () => {
  await db.delete(budgets);
  await db.insert(budgets).values({
    id: "budget",
    user_id: "owner",
    category_id: "food",
    limit_minor: 10000,
  });
});

afterAll(async () => {
  await client.close();
});

const notification = (extra: Partial<typeof budget_notifications.$inferInsert> = {}) => ({
  id: crypto.randomUUID(),
  budget_id: "budget",
  month: "2026-11",
  recipient_email: "owner@example.com",
  limit_minor: 10000,
  spent_minor: 12000,
  ...extra,
});

describe("budget database constraints", () => {
  it("allows only one budget per user/category, with independent pairs", async () => {
    await expect(
      db.insert(budgets).values({
        id: "duplicate",
        user_id: "owner",
        category_id: "food",
        limit_minor: 1,
      }),
    ).rejects.toThrow();
    await db
      .insert(budgets)
      .values([
        { id: "another-category", user_id: "owner", category_id: "travel", limit_minor: 1 },
      ]);
    // A category belonging to another user is checked by the future server
    // operation; this test only exercises the database pair uniqueness.
    await db
      .insert(categories)
      .values({
        id: "other-food",
        user_id: "other",
        name: "Food",
      })
      .onConflictDoNothing();
    await db.insert(budgets).values({
      id: "another-user",
      user_id: "other",
      category_id: "other-food",
      limit_minor: 1,
    });
  });

  it("rejects zero, negative and fractional budget limits", async () => {
    for (const limit of [0, -1, 1.5]) {
      await expect(
        db.insert(budgets).values({
          id: crypto.randomUUID(),
          user_id: "owner",
          category_id: "travel",
          limit_minor: limit,
        }),
      ).rejects.toThrow();
    }
  });

  it("requires real user and category foreign keys", async () => {
    for (const pair of [
      { user_id: "missing", category_id: "food" },
      { user_id: "owner", category_id: "missing" },
    ]) {
      await expect(
        db.insert(budgets).values({
          id: crypto.randomUUID(),
          limit_minor: 1,
          ...pair,
        }),
      ).rejects.toThrow();
    }
  });

  it("defaults delivery state and preserves snapshots and the key across retries", async () => {
    const [row] = await db.insert(budget_notifications).values(notification()).returning();
    expect(row).toMatchObject({
      status: "pending",
      attempt_count: 0,
      next_retry_at: null,
      processing_at: null,
      sent_at: null,
      delivery_idempotency_key: "budget-alert:budget:2026-11",
    });
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
    await db.update(budgets).set({ limit_minor: 5000 }).where(eq(budgets.id, "budget"));
    for (const status of ["processing", "failed", "pending", "sent"] as const) {
      const [updated] = await db
        .update(budget_notifications)
        .set({
          status,
          attempt_count: 1,
          next_retry_at: new Date(),
          processing_at: new Date(),
          sent_at: new Date(),
        })
        .where(eq(budget_notifications.id, row.id))
        .returning();
      expect(updated.delivery_idempotency_key).toBe(row.delivery_idempotency_key);
      expect(updated.limit_minor).toBe(10000);
      expect(updated.spent_minor).toBe(12000);
      expect(updated.recipient_email).toBe("owner@example.com");
      expect(updated.updated_at.getTime()).toBeGreaterThanOrEqual(row.updated_at.getTime());
    }
  });

  it("deduplicates each budget/month while keeping different years and budgets independent", async () => {
    await db.insert(budget_notifications).values(notification());
    await expect(db.insert(budget_notifications).values(notification())).rejects.toThrow();
    await db.insert(budgets).values({
      id: "second",
      user_id: "owner",
      category_id: "travel",
      limit_minor: 1,
    });
    const rows = await db
      .insert(budget_notifications)
      .values([notification({ month: "2027-11" }), notification({ budget_id: "second" })])
      .returning();
    expect(new Set(rows.map((r) => r.delivery_idempotency_key)).size).toBe(2);
  });

  it("rejects invalid months, snapshots, attempt counts, statuses and budget references", async () => {
    for (const month of ["2026-00", "2026-13", "2026-1", "26-11", "0000-01", "2026-11-01"]) {
      await expect(
        db.insert(budget_notifications).values(notification({ month })),
      ).rejects.toThrow();
    }
    for (const extra of [
      { limit_minor: 0 },
      { limit_minor: -1 },
      { spent_minor: -1 },
      { attempt_count: -1 },
      { budget_id: "missing" },
    ]) {
      await expect(db.insert(budget_notifications).values(notification(extra))).rejects.toThrow();
    }
    await expect(
      db.execute(sql`INSERT INTO budget_notifications
      (id, budget_id, month, recipient_email, limit_minor, spent_minor, status)
      VALUES ('invalid', 'budget', '2026-11', 'owner@example.com', 1, 2, 'unknown')`),
    ).rejects.toThrow();
  });

  it("cascades notification deletion only for the deleted budget", async () => {
    await db.insert(budgets).values({
      id: "second",
      user_id: "owner",
      category_id: "travel",
      limit_minor: 1,
    });
    await db
      .insert(budget_notifications)
      .values([notification(), notification({ budget_id: "second" })]);
    await db.delete(budgets).where(eq(budgets.id, "budget"));
    const rows = await db.select().from(budget_notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0].budget_id).toBe("second");
  });
});
