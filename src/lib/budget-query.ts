import type { QueryClient } from "@tanstack/react-query";

export const BUDGETS_QUERY_KEY = ["budgets"] as const;
export const BILLING_QUERY_KEY = ["billing"] as const;

export function invalidateBudgetQueries(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: BILLING_QUERY_KEY }),
  ]);
}
