// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "#/db";
import { deleteCategoryInternal } from "#/server/categories.server";

beforeEach(async () => {
  await db.delete(schema.budgets);
  await db.delete(schema.receipt_items);
  await db.delete(schema.receipts);
  await db.delete(schema.categorization_rules);
  await db.delete(schema.transactions);
  await db.delete(schema.categories);
  await db.delete(schema.accounts);
  await db.delete(schema.users);
  await db.insert(schema.users).values([
    { id: "owner", username: "owner", password_hash: "x" },
    { id: "other", username: "other", password_hash: "x" },
  ]);
  await db.insert(schema.accounts).values({ id: "account", user_id: "owner", name: "Main" });
  await db.insert(schema.categories).values([
    { id: "root", user_id: "owner", name: "Root" },
    { id: "child", user_id: "owner", name: "Child", parent_id: "root" },
    { id: "grandchild", user_id: "owner", name: "Grandchild", parent_id: "child" },
    { id: "keep", user_id: "owner", name: "Keep" },
    { id: "foreign", user_id: "other", name: "Foreign", parent_id: "root" },
  ]);
  for (const [i, category] of ["root", "child", "grandchild", "keep", "foreign"].entries()) {
    await db.insert(schema.budgets).values({
      id: `budget-${category}`,
      category_id: category,
      user_id: category === "foreign" ? "other" : "owner",
      limit_minor: 1000,
    });
    await db.insert(schema.budget_notifications).values({
      id: `notice-${category}`,
      budget_id: `budget-${category}`,
      month: "2026-11",
      recipient_email: "saved@example.com",
      limit_minor: 1000,
      spent_minor: 1200,
      status: (["pending", "processing", "sent", "failed", "pending"] as const)[i],
    });
  }
  await db.insert(schema.transactions).values(
    ["root", "child", "grandchild"].map((category) => ({
      id: `txn-${category}`,
      user_id: "owner",
      account_id: "account",
      category_id: category,
      amount_minor: -500,
      date: "2026-11-01",
    })),
  );
  await db
    .insert(schema.receipts)
    .values({ id: "receipt", user_id: "owner", transaction_id: "txn-grandchild" });
  await db.insert(schema.receipt_items).values({
    id: "item",
    receipt_id: "receipt",
    name: "Milk",
    category_id: "grandchild",
    total_price_minor: 500,
  });
  await db.insert(schema.categorization_rules).values({
    id: "rule",
    user_id: "owner",
    category_id: "child",
    pattern: "milk",
  });
});

const snapshot = async () => ({
  categories: await db.select().from(schema.categories),
  budgets: await db.select().from(schema.budgets),
  notifications: await db.select().from(schema.budget_notifications),
  transactions: await db.select().from(schema.transactions),
  items: await db.select().from(schema.receipt_items),
  rules: await db.select().from(schema.categorization_rules),
});

describe("transactional category subtree deletion", () => {
  it("deletes budgets and notifications for all descendants while preserving other data", async () => {
    expect(await deleteCategoryInternal("owner", { id: "root" })).toEqual({ success: true });
    const remaining = await snapshot();
    expect(remaining.categories.map((r) => r.id).sort()).toEqual(["foreign", "keep"]);
    expect(remaining.budgets.map((r) => r.id).sort()).toEqual(["budget-foreign", "budget-keep"]);
    expect(remaining.notifications.map((r) => r.id).sort()).toEqual([
      "notice-foreign",
      "notice-keep",
    ]);
    expect(remaining.transactions).toHaveLength(3);
    expect(remaining.transactions.every((r) => r.category_id === null)).toBe(true);
    expect(remaining.items[0].category_id).toBeNull();
    expect(remaining.rules).toEqual([]);
  });

  it("reassigns descendant transactions but deletes their budgets rather than moving them", async () => {
    await deleteCategoryInternal("owner", { id: "child", reassignToCategoryId: "keep" });
    const remaining = await snapshot();
    expect(remaining.transactions.find((r) => r.id === "txn-root")?.category_id).toBe("root");
    expect(remaining.transactions.filter((r) => r.category_id === "keep")).toHaveLength(2);
    expect(remaining.budgets.map((r) => r.id).sort()).toEqual([
      "budget-foreign",
      "budget-keep",
      "budget-root",
    ]);
    expect(remaining.notifications.map((r) => r.id).sort()).toEqual([
      "notice-foreign",
      "notice-keep",
      "notice-root",
    ]);
  });

  it("rejects missing/foreign categories and invalid reassignment targets without changing data", async () => {
    const before = await snapshot();
    expect(await deleteCategoryInternal("owner", { id: "foreign" })).toEqual(
      await deleteCategoryInternal("owner", { id: "missing" }),
    );
    for (const target of ["root", "child", "grandchild", "foreign", "missing"]) {
      expect(
        await deleteCategoryInternal("owner", { id: "root", reassignToCategoryId: target }),
      ).toHaveProperty("error");
    }
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back every dependency change if category deletion fails", async () => {
    // This malformed foreign reference must block deletion, not be silently
    // changed or deleted by another tenant's operation.
    await db.insert(schema.categorization_rules).values({
      id: "foreign-reference",
      user_id: "other",
      category_id: "root",
      pattern: "block",
    });
    const before = await snapshot();
    await expect(
      deleteCategoryInternal("owner", { id: "root", reassignToCategoryId: "keep" }),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("can delete a category cycle without looping or duplicating work", async () => {
    await db
      .update(schema.categories)
      .set({ parent_id: "grandchild" })
      .where(eq(schema.categories.id, "root"));
    expect(await deleteCategoryInternal("owner", { id: "root" })).toEqual({ success: true });
    expect((await snapshot()).budgets).toHaveLength(2);
  });
});
