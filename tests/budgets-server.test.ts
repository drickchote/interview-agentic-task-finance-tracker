// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "#/db";
import {
  budgetMonth,
  listBudgets,
  createBudgetInternal,
  updateBudgetLimitInternal,
  deleteBudgetInternal,
} from "#/server/budgets.server";
import { getBillingStatusInternal } from "#/server/billing-status.server";

const now = new Date("2026-11-15T12:00:00Z");
const create = (categoryId = "root", limitMinor = 1000) =>
  createBudgetInternal("owner", { categoryId, limitMinor });
const transaction = (
  categoryId: string | null,
  amount: number,
  date = "2026-11-15",
  userId = "owner",
  accountId = "account",
) =>
  db
    .insert(schema.transactions)
    .values({
      id: crypto.randomUUID(),
      user_id: userId,
      account_id: accountId,
      category_id: categoryId,
      amount_minor: amount,
      date,
    })
    .returning();

beforeEach(async () => {
  await db.delete(schema.budgets);
  await db.delete(schema.subscriptions);
  await db.delete(schema.receipt_items);
  await db.delete(schema.receipts);
  await db.delete(schema.transactions);
  await db.delete(schema.categories);
  await db.delete(schema.accounts);
  await db.delete(schema.users);
  await db.insert(schema.users).values([
    { id: "owner", username: "owner", password_hash: "unused" },
    { id: "other", username: "other", password_hash: "unused" },
  ]);
  await db.insert(schema.accounts).values([
    { id: "account", user_id: "owner", name: "Main", currency: "PLN" },
    { id: "usd", user_id: "owner", name: "USD", currency: "USD" },
    { id: "foreign-account", user_id: "other", name: "Other" },
  ]);
  await db.insert(schema.categories).values([
    { id: "root", user_id: "owner", name: "Groceries" },
    { id: "child", user_id: "owner", name: "Fruit", parent_id: "root" },
    { id: "grandchild", user_id: "owner", name: "Apples", parent_id: "child" },
    { id: "unrelated", user_id: "owner", name: "Transport" },
    { id: "foreign", user_id: "other", name: "Other", parent_id: "root" },
  ]);
});

describe("budget plan limits", () => {
  const pro = () =>
    db.insert(schema.subscriptions).values({
      user_id: "owner",
      plan: "pro",
      status: "active",
    });

  it("allows three Free budgets, blocks the fourth, and scopes usage to the user", async () => {
    for (const category of ["root", "child", "grandchild"]) {
      expect(await create(category)).toMatchObject({ success: true });
    }
    expect(await create("unrelated")).toMatchObject({
      code: "budget_limit_reached",
      limit: 3,
    });
    expect(
      await createBudgetInternal("other", { categoryId: "foreign", limitMinor: 100 }),
    ).toMatchObject({ success: true });
    expect(await getBillingStatusInternal("owner")).toMatchObject({
      plan: "free",
      entitlements: { maxBudgets: 3 },
      usage: { budgetsUsed: 3 },
    });
    expect(await getBillingStatusInternal("other")).toMatchObject({ usage: { budgetsUsed: 1 } });
    expect(await getBillingStatusInternal("missing")).toMatchObject({ usage: { budgetsUsed: 0 } });
  });

  it("allows only one concurrent creation when a Free user has one slot left", async () => {
    await create("root");
    await create("child");
    const results = await Promise.all([create("grandchild"), create("unrelated")]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => "code" in r && r.code === "budget_limit_reached")).toHaveLength(1);
    expect(await listBudgets("owner", now)).toHaveLength(3);
  });

  it("applies the limit to concurrent creation from an empty account", async () => {
    const results = await Promise.all(
      ["root", "child", "grandchild", "unrelated"].map((id) => create(id)),
    );
    expect(results.filter((r) => r.success)).toHaveLength(3);
    expect(await listBudgets("owner", now)).toHaveLength(3);
  });

  it("allows Pro budgets beyond three and reports an unlimited allowance", async () => {
    await pro();
    const results = await Promise.all(
      ["root", "child", "grandchild", "unrelated"].map((id) => create(id)),
    );
    expect(results.every((r) => r.success)).toBe(true);
    expect(await getBillingStatusInternal("owner")).toMatchObject({
      plan: "pro",
      entitlements: { maxBudgets: null },
      usage: { budgetsUsed: 4 },
    });
  });

  it("preserves budgets after downgrade, allows edits/deletion, and resumes creation below three", async () => {
    await pro();
    for (const category of ["root", "child", "grandchild", "unrelated"]) await create(category);
    const before = await listBudgets("owner", now);
    await db
      .update(schema.subscriptions)
      .set({ status: "canceled" })
      .where(eq(schema.subscriptions.user_id, "owner"));
    expect(await listBudgets("owner", now)).toEqual(before);
    expect(await getBillingStatusInternal("owner")).toMatchObject({
      plan: "free",
      entitlements: { maxBudgets: 3 },
      usage: { budgetsUsed: 4 },
    });
    expect(
      await updateBudgetLimitInternal("owner", { id: before[0].id, limitMinor: 2000 }),
    ).toMatchObject({ success: true });
    await db.insert(schema.categories).values({ id: "new", user_id: "owner", name: "New" });
    expect(await create("new")).toMatchObject({ code: "budget_limit_reached" });
    expect(await deleteBudgetInternal("owner", { id: before[0].id })).toEqual({ success: true });
    expect(await create("new")).toMatchObject({ code: "budget_limit_reached" });
    await deleteBudgetInternal("owner", { id: before[1].id });
    expect(await create("new")).toMatchObject({ success: true });
    expect(await listBudgets("owner", now)).toHaveLength(3);
  });
});

describe("budget business operations", () => {
  it("lists an empty state and creates, updates only the limit, and deletes an owned budget", async () => {
    expect(await listBudgets("owner", now)).toEqual([]);
    const result = await create();
    if (!result.data) throw new Error("Expected budget");
    const id = result.data.id;
    expect(await listBudgets("owner", now)).toEqual([
      expect.objectContaining({
        id,
        categoryId: "root",
        categoryName: "Groceries",
        month: "2026-11",
        limitMinor: 1000,
        spentMinor: 0,
        remainingMinor: 1000,
        exceeded: false,
      }),
    ]);
    expect(await updateBudgetLimitInternal("owner", { id, limitMinor: 500 })).toMatchObject({
      success: true,
      data: { category_id: "root", limit_minor: 500 },
    });
    expect(await deleteBudgetInternal("owner", { id })).toEqual({ success: true });
    expect(await listBudgets("owner", now)).toEqual([]);
  });

  it("rejects foreign/missing categories and hides foreign/missing budgets identically", async () => {
    expect(await create("foreign")).toEqual(await create("missing"));
    const result = await create();
    if (!result.data) throw new Error("Expected budget");
    const id = result.data.id;
    expect(await listBudgets("other", now)).toEqual([]);
    expect(await updateBudgetLimitInternal("other", { id, limitMinor: 10 })).toEqual(
      await updateBudgetLimitInternal("other", { id: "missing", limitMinor: 10 }),
    );
    expect(await deleteBudgetInternal("other", { id })).toEqual(
      await deleteBudgetInternal("other", { id: "missing" }),
    );
    expect((await listBudgets("owner", now))[0].limitMinor).toBe(1000);
  });

  it("handles concurrent duplicate creation as one success and one domain error", async () => {
    const results = await Promise.all([create(), create()]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => r.error)).toHaveLength(1);
    expect(await listBudgets("owner", now)).toHaveLength(1);
  });

  it("validates positive integer minor units and refuses client-supplied ownership or category changes", async () => {
    for (const limitMinor of [0, -1, 0.5, NaN, Infinity, 2147483648]) {
      await expect(create("root", limitMinor)).rejects.toThrow();
      await expect(
        updateBudgetLimitInternal("owner", { id: "missing", limitMinor }),
      ).rejects.toThrow();
    }
    const spoofedCreate = { categoryId: "root", limitMinor: 1, userId: "other" };
    await expect(createBudgetInternal("owner", spoofedCreate)).rejects.toThrow();
    const changedCategory = { id: "missing", limitMinor: 1, categoryId: "foreign" };
    await expect(updateBudgetLimitInternal("owner", changedCategory)).rejects.toThrow();
    await expect(deleteBudgetInternal("owner", { id: "" })).rejects.toThrow();
  });

  it("deletes notification records through the budget cascade", async () => {
    const result = await create();
    if (!result.data) throw new Error("Expected budget");
    await db.insert(schema.budget_notifications).values({
      id: "notice",
      budget_id: result.data.id,
      month: "2026-11",
      recipient_email: "owner@example.com",
      limit_minor: 1000,
      spent_minor: 1100,
    });
    await deleteBudgetInternal("owner", { id: result.data.id });
    expect(await db.select().from(schema.budget_notifications)).toEqual([]);
  });
});

describe("monthly budget spending", () => {
  it("rolls up all descendants once, ignores non-expenses and isolates users", async () => {
    await create();
    await create("child");
    await transaction("root", -100);
    await transaction("child", -200);
    await transaction("grandchild", -300);
    await transaction("root", 500); // Refunds/income do not offset spending.
    await transaction("root", 0);
    await transaction("unrelated", -900);
    await transaction(null, -900);
    await transaction("foreign", -900, "2026-11-15", "other", "foreign-account");
    // Even inconsistent foreign transaction/category links must not leak spending.
    await transaction("root", -900, "2026-11-15", "other", "foreign-account");
    const rows = await listBudgets("owner", now);
    expect(rows.find((r) => r.categoryId === "root")).toMatchObject({
      spentMinor: 600,
      remainingMinor: 400,
    });
    expect(rows.find((r) => r.categoryId === "child")).toMatchObject({ spentMinor: 500 });
  });

  it("uses transaction dates with inclusive month start and exclusive next-month cutoff", async () => {
    await create();
    await transaction("root", -100, "2026-10-31");
    await transaction("root", -200, "2026-11-01");
    await transaction("root", -300, "2026-11-30");
    await transaction("root", -400, "2026-12-01");
    expect((await listBudgets("owner", now))[0].spentMinor).toBe(500);
    expect((await listBudgets("owner", new Date("2026-12-15Z")))[0]).toMatchObject({
      month: "2026-12",
      spentMinor: 400,
      limitMinor: 1000,
    });
  });

  it("selects the UTC month across offsets, leap years and year rollover", () => {
    expect(budgetMonth(new Date("2026-11-30T23:30:00-03:00"))).toEqual({
      month: "2026-12",
      from: "2026-12-01",
      to: "2027-01-01",
    });
    expect(budgetMonth(new Date("2024-03-01T00:30:00+03:00"))).toEqual({
      month: "2024-02",
      from: "2024-02-01",
      to: "2024-03-01",
    });
  });

  it("exceeds only above the limit and recalculates after limit and transaction changes", async () => {
    const result = await create();
    if (!result.data) throw new Error("Expected budget");
    const [txn] = await transaction("root", -1000);
    expect((await listBudgets("owner", now))[0]).toMatchObject({
      remainingMinor: 0,
      exceeded: false,
    });
    await updateBudgetLimitInternal("owner", { id: result.data.id, limitMinor: 999 });
    expect((await listBudgets("owner", now))[0]).toMatchObject({
      remainingMinor: -1,
      exceeded: true,
    });
    await db
      .update(schema.transactions)
      .set({ category_id: "unrelated" })
      .where(eq(schema.transactions.id, txn.id));
    expect((await listBudgets("owner", now))[0].spentMinor).toBe(0);
  });

  it("ignores receipt-item categories and does not multiply linked transactions", async () => {
    await create();
    await create("unrelated");
    const [txn] = await transaction("root", -100);
    await db
      .insert(schema.receipts)
      .values({ id: "receipt", user_id: "owner", transaction_id: txn.id });
    await db.insert(schema.receipt_items).values([
      {
        id: "item1",
        receipt_id: "receipt",
        name: "One",
        total_price_minor: 50,
        category_id: "unrelated",
      },
      {
        id: "item2",
        receipt_id: "receipt",
        name: "Two",
        total_price_minor: 50,
        category_id: "root",
      },
    ]);
    const rows = await listBudgets("owner", now);
    expect(rows.find((r) => r.categoryId === "root")?.spentMinor).toBe(100);
    expect(rows.find((r) => r.categoryId === "unrelated")?.spentMinor).toBe(0);
  });

  it("preserves dashboard aggregation across currencies and handles the minimum integer expense", async () => {
    await create();
    await transaction("root", -100);
    await transaction("root", -200, "2026-11-15", "owner", "usd");
    await transaction("root", -2147483648);
    expect((await listBudgets("owner", now))[0].spentMinor).toBe(2147483948);
  });

  it("handles a malformed category cycle without double counting or hanging", async () => {
    await create();
    await transaction("root", -100);
    await transaction("child", -200);
    await db
      .update(schema.categories)
      .set({ parent_id: "grandchild" })
      .where(eq(schema.categories.id, "root"));
    expect((await listBudgets("owner", now))[0].spentMinor).toBe(300);
  });
});
