import { db as defaultDb, type Db } from "#/db";
import { getLogger } from "./logger";

/** Call once after a persisted operation/batch, never per import row.
 * Reconciliation retries missed checks after crashes or queue failures.
 */
export async function checkBudgetsAfterChange(userId: string, db: Db = defaultDb) {
  try {
    const { queueBudgetNotifications } = await import("./budget-notifications.server");
    await queueBudgetNotifications(userId, new Date(), db);
  } catch {
    getLogger().error({ userId }, "budget check failed; maintenance will reconcile");
  }
}
