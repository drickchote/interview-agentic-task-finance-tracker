import { and, asc, count, eq, gte, lt, sql } from "drizzle-orm";
import { db as defaultDb, schema, type Db } from "#/db";
import { getEntitlements } from "./billing.server";
import { checkBudgetsAfterChange } from "./budget-check.server";
import { createBudgetSchema, updateBudgetLimitSchema, deleteBudgetSchema } from "./budgets.schemas";

/** Calendar-date cutoffs: transaction dates carry no time zone. */
export function budgetMonth(now: Date = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    month: start.toISOString().slice(0, 7),
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

export async function listBudgets(userId: string, now = new Date(), db: Db = defaultDb) {
  const { month, from, to } = budgetMonth(now);
  const rows = await db
    .select({
      id: schema.budgets.id,
      categoryId: schema.budgets.category_id,
      categoryName: schema.categories.name,
      categoryColor: schema.categories.color,
      limitMinor: schema.budgets.limit_minor,
      createdAt: schema.budgets.created_at,
      updatedAt: schema.budgets.updated_at,
    })
    .from(schema.budgets)
    .innerJoin(
      schema.categories,
      and(
        eq(schema.categories.id, schema.budgets.category_id),
        eq(schema.categories.user_id, userId),
      ),
    )
    .where(eq(schema.budgets.user_id, userId))
    .orderBy(asc(schema.categories.name), asc(schema.budgets.id));
  if (rows.length === 0) return [];

  const categories = await db
    .select({
      id: schema.categories.id,
      parentId: schema.categories.parent_id,
    })
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));
  // Aggregate once per category across all accounts, without currency conversion,
  // matching the dashboard summary. No receipt joins can multiply transactions.
  const totals = await db
    .select({
      categoryId: schema.transactions.category_id,
      spentMinor: sql<number>`sum(-${schema.transactions.amount_minor}::bigint)`.mapWith(Number),
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.user_id, userId),
        lt(schema.transactions.amount_minor, 0),
        gte(schema.transactions.date, from),
        lt(schema.transactions.date, to),
      ),
    )
    .groupBy(schema.transactions.category_id);
  const spending = new Map(totals.map((row) => [row.categoryId, row.spentMinor]));
  const children = new Map<string, string[]>();
  for (const category of categories) {
    if (category.parentId) {
      const siblings = children.get(category.parentId) ?? [];
      siblings.push(category.id);
      children.set(category.parentId, siblings);
    }
  }
  return rows.map((budget) => {
    const pending = [budget.categoryId];
    const visited = new Set<string>();
    let spentMinor = 0;
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      spentMinor += spending.get(id) ?? 0;
      pending.push(...(children.get(id) ?? []));
    }
    return {
      ...budget,
      month,
      spentMinor,
      remainingMinor: budget.limitMinor - spentMinor,
      exceeded: spentMinor > budget.limitMinor,
    };
  });
}

export async function createBudgetInternal(
  userId: string,
  input: { categoryId: string; limitMinor: number },
  db: Db = defaultDb,
) {
  const data = createBudgetSchema.parse(input);
  const result = await db.transaction(
    async (tx) => {
      // Lock the durable user row, even when no budgets exist yet. All budget
      // creators for this user serialize their entitlement/count/insert sequence.
      const [user] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for("update");
      if (!user) return { error: "User not found" } as const;
      const [category] = await tx
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(
          and(eq(schema.categories.id, data.categoryId), eq(schema.categories.user_id, userId)),
        )
        .limit(1);
      if (!category) return { error: "Category not found" } as const;
      const { maxBudgets } = await getEntitlements(userId, tx);
      if (maxBudgets !== null) {
        const [usage] = await tx
          .select({ count: count() })
          .from(schema.budgets)
          .where(eq(schema.budgets.user_id, userId));
        if (usage.count >= maxBudgets) {
          return {
            error: "Free plan budget limit reached. Upgrade to Pro for unlimited budgets.",
            code: "budget_limit_reached",
            limit: maxBudgets,
          } as const;
        }
      }
      const [budget] = await tx
        .insert(schema.budgets)
        .values({
          id: crypto.randomUUID(),
          user_id: userId,
          category_id: data.categoryId,
          limit_minor: data.limitMinor,
        })
        .onConflictDoNothing({ target: [schema.budgets.user_id, schema.budgets.category_id] })
        .returning();
      if (!budget) return { error: "A budget already exists for this category" } as const;
      return { success: true, data: budget } as const;
    },
    { isolationLevel: "read committed" },
  );
  if (result.success) await checkBudgetsAfterChange(userId, db);
  return result;
}

export async function updateBudgetLimitInternal(
  userId: string,
  input: { id: string; limitMinor: number },
  db: Db = defaultDb,
) {
  const data = updateBudgetLimitSchema.parse(input);
  const [budget] = await db
    .update(schema.budgets)
    .set({ limit_minor: data.limitMinor })
    .where(and(eq(schema.budgets.id, data.id), eq(schema.budgets.user_id, userId)))
    .returning();
  if (!budget) return { error: "Budget not found" } as const;
  await checkBudgetsAfterChange(userId, db);
  return { success: true, data: budget } as const;
}

export async function deleteBudgetInternal(
  userId: string,
  input: { id: string },
  db: Db = defaultDb,
) {
  const data = deleteBudgetSchema.parse(input);
  const [budget] = await db
    .delete(schema.budgets)
    .where(and(eq(schema.budgets.id, data.id), eq(schema.budgets.user_id, userId)))
    .returning({ id: schema.budgets.id });
  if (!budget) return { error: "Budget not found" } as const;
  await checkBudgetsAfterChange(userId, db);
  return { success: true } as const;
}
