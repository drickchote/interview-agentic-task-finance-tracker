import { and, asc, eq, lte, or } from "drizzle-orm";
import { db as defaultDb, schema, type Db } from "#/db";
import { m } from "#/paraglide/messages";
import { formatMinor } from "#/lib/money";
import { listBudgets } from "./budgets.server";
import { EmailDeliveryError, sendEmail } from "./email";
import { env } from "./env";
import { getLogger } from "./logger";

const LEASE_MS = 2 * 60_000;
// Resend retains keys for 24h. Stop at 23h, allowing a safety margin for
// request timeouts and restarts. Even a crashed claim is potentially delivered.
const SAFE_RETRY_WINDOW_MS = 23 * 60 * 60_000;
type Notification = typeof schema.budget_notifications.$inferSelect;

export async function queueBudgetNotifications(
  userId: string,
  now = new Date(),
  db: Db = defaultDb,
) {
  const [user] = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  // Do not consume this month's alert slot for legacy accounts without email.
  if (!user?.email) return;
  const budgets = await listBudgets(userId, now, db);
  const exceeded = budgets.filter((budget) => budget.exceeded);
  if (!exceeded.length) return;
  await db
    .insert(schema.budget_notifications)
    .values(
      exceeded.map((budget) => ({
        id: crypto.randomUUID(),
        budget_id: budget.id,
        month: budget.month,
        recipient_email: user.email!,
        limit_minor: budget.limitMinor,
        spent_minor: budget.spentMinor,
        email_provider: env.email.provider,
        email_from: env.email.from,
        email_subject: m.email_budget_exceeded_subject({}, { locale: "en" }),
        email_text: m.email_budget_exceeded_body(
          {
            category: budget.categoryName,
            month: budget.month,
            limit: formatMinor(budget.limitMinor),
            spent: formatMinor(budget.spentMinor),
          },
          { locale: "en" },
        ),
        created_at: now,
        updated_at: now,
      })),
    )
    .onConflictDoNothing({
      target: [schema.budget_notifications.budget_id, schema.budget_notifications.month],
    });
}

function due(now: Date) {
  const t = schema.budget_notifications;
  return or(
    eq(t.status, "pending"),
    and(eq(t.status, "failed"), lte(t.next_retry_at, now)),
    and(eq(t.status, "processing"), lte(t.processing_at, new Date(now.getTime() - LEASE_MS))),
  );
}

/** Atomically claim a short lease, then send outside the transaction. A fencing
 * attempt number prevents a late worker from overwriting a newer result.
 */
export async function processBudgetNotifications(
  options: {
    db?: Db;
    now?: () => Date;
    send?: typeof sendEmail;
    limit?: number;
  } = {},
) {
  const db = options.db ?? defaultDb;
  const clock = options.now ?? (() => new Date());
  const send = options.send ?? sendEmail;
  for (let i = 0; i < (options.limit ?? 50); i++) {
    const claimed = await db.transaction(async (tx) => {
      const now = clock();
      const [row] = await tx
        .select()
        .from(schema.budget_notifications)
        .where(due(now))
        .orderBy(asc(schema.budget_notifications.created_at))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return;
      const [claim] = await tx
        .update(schema.budget_notifications)
        .set({
          status: "processing",
          processing_at: now,
          next_retry_at: null,
          first_attempt_at:
            row.first_attempt_at ??
            (row.attempt_count > 0 || row.status === "processing"
              ? (row.processing_at ?? row.created_at)
              : now),
          attempt_count: row.attempt_count + 1,
          updated_at: now,
        })
        .where(eq(schema.budget_notifications.id, row.id))
        .returning();
      return claim;
    });
    if (!claimed) break;
    const fence = and(
      eq(schema.budget_notifications.id, claimed.id),
      eq(schema.budget_notifications.attempt_count, claimed.attempt_count),
      eq(schema.budget_notifications.status, "processing"),
    );
    const finish = (values: Partial<typeof schema.budget_notifications.$inferInsert>) =>
      db
        .update(schema.budget_notifications)
        .set({ ...values, updated_at: clock() })
        .where(fence);
    const unsafe = reviewReason(claimed, clock());
    if (unsafe) {
      await finish({ status: "failed", next_retry_at: null, last_error: unsafe });
      getLogger().warn(
        { notificationId: claimed.id, reason: unsafe },
        "budget email requires review",
      );
      continue;
    }
    try {
      await send(
        {
          to: claimed.recipient_email,
          from: claimed.email_from!,
          subject: claimed.email_subject!,
          text: claimed.email_text!,
        },
        { idempotencyKey: claimed.delivery_idempotency_key },
      );
      await finish({ status: "sent", sent_at: clock(), next_retry_at: null, last_error: null });
    } catch (error) {
      // A timeout, 5xx or process crash may have happened after acceptance.
      // Never switch keys or reset first_attempt_at to extend the safe window.
      const now = clock();
      const permanent =
        error instanceof EmailDeliveryError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 409, 429].includes(error.status);
      const delay = Math.min(60_000 * 2 ** Math.min(claimed.attempt_count - 1, 10), 60 * 60_000);
      const retry = new Date(now.getTime() + delay);
      const withinWindow =
        retry.getTime() < claimed.first_attempt_at!.getTime() + SAFE_RETRY_WINDOW_MS;
      await finish({
        status: "failed",
        next_retry_at: !permanent && withinWindow ? retry : null,
        last_error: permanent
          ? "provider_rejected"
          : withinWindow
            ? "delivery_unconfirmed"
            : "delivery_window_expired_review_required",
      });
    }
  }
}

function reviewReason(row: Notification, now: Date) {
  if (!row.email_from || !row.email_subject || !row.email_text || !row.email_provider)
    return "missing_payload_review_required";
  if (row.email_provider !== env.email.provider) return "provider_changed_review_required";
  if (now.getTime() >= row.first_attempt_at!.getTime() + SAFE_RETRY_WINDOW_MS)
    return "delivery_window_expired_review_required";
}

/** Runs on startup/first request and periodically. Reconstructing current-month
 * checks closes the commit→queue crash gap; delivery itself resumes from DB.
 */
export async function runBudgetNotificationMaintenance() {
  const users = await defaultDb
    .selectDistinct({ userId: schema.budgets.user_id })
    .from(schema.budgets);
  for (const { userId } of users) {
    try {
      await queueBudgetNotifications(userId);
    } catch {
      getLogger().error({ userId }, "budget notification reconciliation failed");
    }
  }
  await processBudgetNotifications();
}
