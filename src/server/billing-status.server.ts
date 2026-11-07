import { count, eq } from "drizzle-orm";
import { db as defaultDb, schema, type Db } from "#/db";
import { getMonthlyScanCount } from "./ai-usage.server";
import { getEntitlements, getSubscription } from "./billing.server";
import { env } from "./env";

export interface BillingStatus {
  billingEnabled: boolean;
  plan: "free" | "pro";
  /** Raw Stripe status of the mirrored subscription, if any. */
  subscriptionStatus: string | null;
  /** ISO date the current paid period ends (renews or expires), if known. */
  currentPeriodEnd: string | null;
  /** True when a Stripe customer exists, i.e. the portal is reachable. */
  hasStripeCustomer: boolean;
  entitlements: {
    maxAccounts: number | null;
    maxBudgets: number | null;
    scansPerMonth: number;
  };
  usage: {
    scansUsed: number;
    accountsUsed: number;
    budgetsUsed: number;
  };
}

export async function getBillingStatusInternal(
  userId: string,
  db: Db = defaultDb,
): Promise<BillingStatus> {
  const [entitlements, subscription, scansUsed, accountRows, budgetRows] = await Promise.all([
    getEntitlements(userId, db),
    getSubscription(userId, db),
    getMonthlyScanCount(userId, db),
    db.select({ count: count() }).from(schema.accounts).where(eq(schema.accounts.user_id, userId)),
    db.select({ count: count() }).from(schema.budgets).where(eq(schema.budgets.user_id, userId)),
  ]);

  return {
    billingEnabled: env.billing.enabled,
    plan: entitlements.plan,
    subscriptionStatus: subscription?.status ?? null,
    currentPeriodEnd: subscription?.current_period_end?.toISOString() ?? null,
    hasStripeCustomer: Boolean(subscription?.stripe_customer_id),
    entitlements: {
      maxAccounts: entitlements.maxAccounts,
      maxBudgets: entitlements.maxBudgets,
      scansPerMonth: entitlements.scansPerMonth,
    },
    usage: {
      scansUsed,
      accountsUsed: accountRows[0]?.count ?? 0,
      budgetsUsed: budgetRows[0]?.count ?? 0,
    },
  };
}
