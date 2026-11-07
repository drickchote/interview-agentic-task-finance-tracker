import { and, asc, eq, inArray } from "drizzle-orm";
import { db as defaultDb, schema, type Db } from "#/db";
import { checkBudgetsAfterChange } from "./budget-check.server";

/** Delete a user's complete subtree and its dependent data atomically. */
export async function deleteCategoryInternal(
  userId: string,
  data: { id: string; reassignToCategoryId?: string | null },
  db: Db = defaultDb,
) {
  const result = await db.transaction(async (tx) => {
    // Use the same per-user lock as budget creation so no new budget can be
    // attached between subtree discovery and category deletion.
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for("update");
    const [category] = await tx
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(and(eq(schema.categories.id, data.id), eq(schema.categories.user_id, userId)))
      .limit(1);
    if (!category) return { error: "Category not found" } as const;
    const categories = await tx
      .select({ id: schema.categories.id, parentId: schema.categories.parent_id })
      .from(schema.categories)
      .where(eq(schema.categories.user_id, userId))
      .orderBy(asc(schema.categories.id))
      .for("update");
    const children = new Map<string, string[]>();
    for (const row of categories) {
      if (!row.parentId) continue;
      const siblings = children.get(row.parentId) ?? [];
      siblings.push(row.id);
      children.set(row.parentId, siblings);
    }
    const deleted = new Set<string>();
    const pending = [data.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (deleted.has(id)) continue;
      deleted.add(id);
      pending.push(...(children.get(id) ?? []));
    }
    const ids = [...deleted];
    if (data.reassignToCategoryId) {
      if (deleted.has(data.reassignToCategoryId)) {
        return { error: "Cannot reassign transactions to the category being deleted" } as const;
      }
      if (!categories.some((row) => row.id === data.reassignToCategoryId)) {
        return { error: "Reassignment target category does not exist" } as const;
      }
    }
    await tx
      .update(schema.transactions)
      .set({ category_id: data.reassignToCategoryId || null })
      .where(
        and(eq(schema.transactions.user_id, userId), inArray(schema.transactions.category_id, ids)),
      );
    const receipts = tx
      .select({ id: schema.receipts.id })
      .from(schema.receipts)
      .where(eq(schema.receipts.user_id, userId));
    await tx
      .update(schema.receipt_items)
      .set({ category_id: null })
      .where(
        and(
          inArray(schema.receipt_items.category_id, ids),
          inArray(schema.receipt_items.receipt_id, receipts),
        ),
      );
    await tx
      .delete(schema.categorization_rules)
      .where(
        and(
          eq(schema.categorization_rules.user_id, userId),
          inArray(schema.categorization_rules.category_id, ids),
        ),
      );
    // Notifications cascade from budgets. Delete budgets before their category
    // foreign keys, inside the same transaction as all other dependency changes.
    await tx
      .delete(schema.budgets)
      .where(and(eq(schema.budgets.user_id, userId), inArray(schema.budgets.category_id, ids)));
    await tx
      .delete(schema.categories)
      .where(and(eq(schema.categories.user_id, userId), inArray(schema.categories.id, ids)));
    return { success: true } as const;
  });
  if (result.success) await checkBudgetsAfterChange(userId, db);
  return result;
}
