import { createFileRoute } from "@tanstack/react-router";
import { runComplianceSweep } from "#/server/compliance.server";
import { processBudgetNotifications } from "#/server/budget-notifications.server";
import { createBudgetInternal, updateBudgetLimitInternal } from "#/server/budgets.server";
import { requireUserId } from "#/server/session";
import { db, schema } from "#/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

// Test-only endpoint: runs one compliance sweep pass (expired account
// deletions + ai_raw_response retention) synchronously so E2E tests can
// observe its effects deterministically — the real hourly loop is disarmed
// in TEST_MODE. Only enabled when TEST_MODE=1.
export const Route = createFileRoute("/test-run-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (process.env.TEST_MODE !== "1") {
          return new Response("Not available", { status: 404 });
        }
        const action = new URL(request.url).searchParams.get("budgets");
        if (action) {
          const userId = await requireUserId();
          if (action === "process") {
            await processBudgetNotifications({ userId });
            return Response.json({ success: true });
          }
          if (action === "create") {
            const data = z
              .object({ categoryName: z.string(), limitMinor: z.number().int().positive() })
              .parse(await request.json());
            const [category] = await db
              .select({ id: schema.categories.id })
              .from(schema.categories)
              .where(
                and(
                  eq(schema.categories.user_id, userId),
                  eq(schema.categories.name, data.categoryName),
                ),
              )
              .limit(1);
            if (!category) return Response.json({ error: "Category not found" }, { status: 404 });
            return Response.json(
              await createBudgetInternal(userId, {
                categoryId: category.id,
                limitMinor: data.limitMinor,
              }),
            );
          }
          if (action === "limit") {
            const data = z
              .object({ id: z.string(), limitMinor: z.number().int().positive() })
              .parse(await request.json());
            return Response.json(await updateBudgetLimitInternal(userId, data));
          }
          return new Response("Unknown action", { status: 400 });
        }
        const result = await runComplianceSweep();
        return Response.json(result);
      },
    },
  },
});
