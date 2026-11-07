import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { m } from "#/paraglide/messages";
import {
  getBudgets,
  createBudget,
  updateBudgetLimit,
  deleteBudget,
} from "#/server/budgets.functions";
import { getCategories } from "#/server/categories.functions";
import { getBillingStatus } from "#/server/billing.functions";
import { BUDGETS_QUERY_KEY, BILLING_QUERY_KEY, invalidateBudgetQueries } from "#/lib/budget-query";
import { useUtcMonth } from "#/lib/use-utc-month";
import { formatMinor, parseAmountToMinor } from "#/lib/money";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import { Badge } from "#/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "#/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "#/components/ui/alert-dialog";

const CATEGORIES_QUERY_KEY = ["categories"] as const;
type Budget = Awaited<ReturnType<typeof getBudgets>>[number];
type Form = { budget: Budget | null; categoryId: string; limit: string };

export const Route = createFileRoute("/_authed/budgets")({ component: BudgetsPage });

function BudgetsPage() {
  const queryClient = useQueryClient();
  const month = useUtcMonth();
  const getBudgetsFn = useServerFn(getBudgets);
  const getCategoriesFn = useServerFn(getCategories);
  const getBillingFn = useServerFn(getBillingStatus);
  const createFn = useServerFn(createBudget);
  const updateFn = useServerFn(updateBudgetLimit);
  const deleteFn = useServerFn(deleteBudget);
  const budgetsQuery = useQuery({
    queryKey: [...BUDGETS_QUERY_KEY, month],
    queryFn: () => getBudgetsFn(),
    refetchInterval: 60_000,
    retry: 1,
  });
  const categoriesQuery = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
    retry: 1,
  });
  const billingQuery = useQuery({
    queryKey: BILLING_QUERY_KEY,
    queryFn: () => getBillingFn(),
    refetchInterval: 30_000,
    retry: 1,
  });
  const budgets = budgetsQuery.data ?? [];
  const categories = categoriesQuery.data ?? [];
  const billing = billingQuery.data;
  const loading = budgetsQuery.isPending || categoriesQuery.isPending || billingQuery.isPending;
  const loadError = budgetsQuery.isError || categoriesQuery.isError || billingQuery.isError;
  const available = categories.filter(
    (category) => !budgets.some((budget) => budget.categoryId === category.id),
  );
  const atLimit =
    billing?.entitlements.maxBudgets != null && budgets.length >= billing.entitlements.maxBudgets;
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Budget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const saveMutation = useMutation({
    mutationFn: async (data: { budget: Budget | null; categoryId: string; limitMinor: number }) =>
      data.budget
        ? updateFn({ data: { id: data.budget.id, limitMinor: data.limitMinor } })
        : createFn({ data: { categoryId: data.categoryId, limitMinor: data.limitMinor } }),
    onSuccess: async (result) => {
      if (result.error) {
        setFormError(
          "code" in result && result.code === "budget_limit_reached"
            ? m.budgets_limit_reached()
            : result.error === "A budget already exists for this category"
              ? m.budgets_duplicate()
              : m.budgets_save_error(),
        );
      } else {
        setForm(null);
      }
      await invalidateBudgetQueries(queryClient);
    },
    onError: () => {
      setFormError(m.budgets_save_error());
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: async (result) => {
      if (result.error) setDeleteError(m.budgets_delete_error());
      else setDeleting(null);
      await invalidateBudgetQueries(queryClient);
    },
    onError: () => {
      setDeleteError(m.budgets_delete_error());
    },
  });

  function categoryLabel(id: string) {
    const names: string[] = [];
    const visited = new Set<string>();
    let category = categories.find((row) => row.id === id);
    while (category && !visited.has(category.id)) {
      visited.add(category.id);
      names.unshift(category.name);
      category = categories.find((row) => row.id === category?.parent_id);
    }
    return names.reduce(
      (parent, name) => (parent ? m.budgets_category_path({ parent, category: name }) : name),
      "",
    );
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form || saveMutation.isPending) return;
    const amount = form.limit.trim();
    const limitMinor = parseAmountToMinor(amount);
    if (
      !/^\d+(?:[.,]\d{1,2})?$/.test(amount) ||
      limitMinor === null ||
      limitMinor <= 0 ||
      limitMinor > 2147483647
    ) {
      setFormError(m.budgets_invalid_limit());
      return;
    }
    if (!form.categoryId) {
      setFormError(m.budgets_category_required());
      return;
    }
    setFormError(null);
    saveMutation.mutate({ budget: form.budget, categoryId: form.categoryId, limitMinor });
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold display-title">{m.nav_budgets()}</h1>
            <p className="text-sm text-muted-foreground mt-1">{m.budgets_description()}</p>
          </div>
          <Button
            disabled={loading || loadError || atLimit || available.length === 0}
            onClick={() => {
              setFormError(null);
              setForm({ budget: null, categoryId: "", limit: "" });
            }}
          >
            {m.budgets_add()}
          </Button>
        </div>
      </header>
      <main className="page-wrap py-6 space-y-6" aria-busy={loading}>
        {loading && <p role="status">{m.budgets_loading()}</p>}
        {loadError && (
          <div role="alert" className="rounded-xl border border-destructive/40 p-4 space-y-3">
            <p>{m.budgets_load_error()}</p>
            <Button
              variant="outline"
              onClick={() => {
                void budgetsQuery.refetch();
                void categoriesQuery.refetch();
                void billingQuery.refetch();
              }}
            >
              {m.budgets_retry()}
            </Button>
          </div>
        )}
        {!loading && !loadError && billing && (
          <>
            <section
              aria-label={m.budgets_plan_usage()}
              className="island-shell rounded-xl p-4 flex flex-wrap items-center justify-between gap-3"
            >
              <div>
                <p className="font-medium">
                  {billing.entitlements.maxBudgets === null
                    ? m.budgets_usage_unlimited({ used: budgets.length })
                    : m.budgets_usage_free({
                        used: budgets.length,
                        limit: billing.entitlements.maxBudgets,
                      })}
                </p>
                {billing.plan === "free" && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {atLimit ? m.budgets_limit_reached() : m.budgets_upgrade_guidance()}
                  </p>
                )}
              </div>
              {billing.plan === "free" && (
                <Button variant="outline" asChild>
                  <Link to="/billing">{m.budgets_view_plans()}</Link>
                </Button>
              )}
            </section>
            <div>
              <h2 className="text-lg font-semibold">
                {m.budgets_period({ month: budgets[0]?.month ?? month })}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">{m.budgets_spending_help()}</p>
            </div>
            {available.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {m.budgets_no_categories()}{" "}
                <Link to="/categories" className="underline">
                  {m.budgets_manage_categories()}
                </Link>
              </p>
            )}
            {budgets.length === 0 ? (
              <section className="island-shell rounded-xl p-8 text-center">
                <h3 className="font-semibold">{m.budgets_empty_title()}</h3>
                <p className="text-sm text-muted-foreground mt-2">
                  {m.budgets_empty_description()}
                </p>
              </section>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {budgets.map((budget) => (
                  <article
                    key={budget.id}
                    aria-label={budget.categoryName}
                    className={`island-shell rounded-xl border p-5 space-y-4 ${budget.exceeded ? "border-destructive/60" : "border-line/50"}`}
                  >
                    <div className="flex flex-wrap justify-between items-start gap-2">
                      <h3 className="font-semibold">{categoryLabel(budget.categoryId)}</h3>
                      <Badge variant={budget.exceeded ? "destructive" : "secondary"}>
                        {budget.exceeded
                          ? m.budgets_exceeded()
                          : budget.remainingMinor === 0
                            ? m.budgets_at_limit()
                            : m.budgets_within_limit()}
                      </Badge>
                    </div>
                    <dl className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <dt className="text-muted-foreground">{m.budgets_monthly_limit()}</dt>
                        <dd className="font-mono mt-1">{formatMinor(budget.limitMinor)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">{m.budgets_spent()}</dt>
                        <dd className="font-mono mt-1">{formatMinor(budget.spentMinor)}</dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-muted-foreground">{m.budgets_remaining()}</dt>
                        <dd
                          className={`font-mono text-lg mt-1 ${budget.exceeded ? "text-destructive" : ""}`}
                        >
                          {formatMinor(budget.remainingMinor)}
                        </dd>
                      </div>
                    </dl>
                    <progress
                      className="w-full accent-primary"
                      aria-label={m.budgets_progress({ category: budget.categoryName })}
                      max={budget.limitMinor}
                      value={Math.min(budget.spentMinor, budget.limitMinor)}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setFormError(null);
                          setForm({
                            budget,
                            categoryId: budget.categoryId,
                            limit: formatMinor(budget.limitMinor),
                          });
                        }}
                      >
                        {m.budgets_edit()}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setDeleteError(null);
                          setDeleting(budget);
                        }}
                      >
                        {m.delete()}
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </main>
      <Dialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open && !saveMutation.isPending) setForm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form?.budget ? m.budgets_edit() : m.budgets_add()}</DialogTitle>
            <DialogDescription>{m.budgets_form_help()}</DialogDescription>
          </DialogHeader>
          {form && (
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div>
                <Label htmlFor="budget-category">{m.budgets_category()}</Label>
                {form.budget ? (
                  <p id="budget-category" className="mt-1 font-medium">
                    {categoryLabel(form.categoryId)}
                  </p>
                ) : (
                  <Select
                    id="budget-category"
                    value={form.categoryId}
                    disabled={saveMutation.isPending}
                    onChange={(event) => setForm({ ...form, categoryId: event.target.value })}
                  >
                    <SelectItem value="">{m.budgets_choose_category()}</SelectItem>
                    {available.map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {categoryLabel(category.id)}
                      </SelectItem>
                    ))}
                  </Select>
                )}
              </div>
              <div>
                <Label htmlFor="budget-limit">{m.budgets_monthly_limit()}</Label>
                <Input
                  id="budget-limit"
                  inputMode="decimal"
                  autoFocus
                  value={form.limit}
                  disabled={saveMutation.isPending}
                  aria-invalid={!!formError}
                  aria-describedby={formError ? "budget-form-error" : undefined}
                  onChange={(event) => setForm({ ...form, limit: event.target.value })}
                />
              </div>
              {formError && (
                <p id="budget-form-error" role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saveMutation.isPending}
                  onClick={() => setForm(null)}
                >
                  {m.cancel()}
                </Button>
                <Button type="submit" disabled={saveMutation.isPending}>
                  {saveMutation.isPending
                    ? m.saving()
                    : form.budget
                      ? m.save_changes()
                      : m.budgets_create()}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.budgets_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.budgets_delete_confirm({ category: deleting?.categoryName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>{m.cancel()}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleting) {
                  setDeleteError(null);
                  deleteMutation.mutate(deleting.id);
                }
              }}
            >
              {deleteMutation.isPending ? m.saving() : m.delete()}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
