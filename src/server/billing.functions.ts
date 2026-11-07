import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { db, schema } from "#/db";
import { getBillingStatusInternal } from "./billing-status.server";
import { getSubscription } from "./billing.server";
import { env } from "#/server/env";
import { requireUserId } from "#/server/session";
import {
  createStripeCheckoutSession,
  createStripePortalSession,
} from "#/server/stripe.server";

//
// Client-callable billing surface: current plan + entitlements + usage for
// the billing page, and Checkout/Portal session creation. Stripe calls live
// in stripe.server.ts; state reads in billing.server.ts.

export type { BillingStatus } from "./billing-status.server";

export const getBillingStatus = createServerFn({ method: "GET" }).handler(
  async () => getBillingStatusInternal(await requireUserId()),
);

export const createCheckoutSession = createServerFn({
  method: "POST",
}).handler(async (): Promise<{ url: string } | { error: string }> => {
  if (!env.billing.enabled) {
    return { error: "Billing is not available on this deployment." };
  }
  const userId = await requireUserId();
  const users = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  const base = env.email.baseUrl;
  return createStripeCheckoutSession({
    userId,
    email: users[0]?.email ?? null,
    successUrl: `${base}/billing?checkout=success`,
    cancelUrl: `${base}/billing?checkout=cancelled`,
  });
});

export const createPortalSession = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ url: string } | { error: string }> => {
    if (!env.billing.enabled) {
      return { error: "Billing is not available on this deployment." };
    }
    const userId = await requireUserId();
    const subscription = await getSubscription(userId);
    if (!subscription?.stripe_customer_id) {
      return { error: "No billing profile yet — upgrade first." };
    }
    return createStripePortalSession(
      subscription.stripe_customer_id,
      `${env.email.baseUrl}/billing`,
    );
  },
);
