import { invalidateBudgetQueries } from "#/lib/budget-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { m } from "#/paraglide/messages";
import { CategoryBadge } from "#/components/ui/category-badge";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import {
  getCategorizationRules,
  createCategorizationRule,
  updateCategorizationRule,
  deleteCategorizationRule,
  previewRuleImpact,
  applyRuleToExisting,
  reorderCategorizationRules,
  reCategorizeTransactions,
  getTransactionCounts,
  getAiStatus,
} from "#/server/categorization.functions";
import { getCategories } from "#/server/categories.functions";


const RULES_QUERY_KEY = ["categorization-rules"] as const;
const CATEGORIES_QUERY_KEY = ["categories"] as const;
const TRANSACTIONS_QUERY_KEY = ["transactions"] as const;

type Rule = Awaited<ReturnType<typeof getCategorizationRules>>[number];
type MatchType = "substring" | "exact";

interface FormState {
  pattern: string;
  matchType: MatchType;
  categoryId: string;
}

const emptyForm: FormState = {
  pattern: "",
  matchType: "substring",
  categoryId: "",
};

export const Route = createFileRoute("/_authed/categorization")({
  component: CategorizationPage,
});

function CategorizationPage() {
  const queryClient = useQueryClient();
  const getRulesFn = useServerFn(getCategorizationRules);
  const createRuleFn = useServerFn(createCategorizationRule);
  const updateRuleFn = useServerFn(updateCategorizationRule);
  const deleteRuleFn = useServerFn(deleteCategorizationRule);
  const previewImpactFn = useServerFn(previewRuleImpact);
  const applyRuleFn = useServerFn(applyRuleToExisting);
  const reorderRulesFn = useServerFn(reorderCategorizationRules);
  const getCategoriesFn = useServerFn(getCategories);
  const reCategorizeFn = useServerFn(reCategorizeTransactions);
  const getTransactionCountsFn = useServerFn(getTransactionCounts);
  const getAiStatusFn = useServerFn(getAiStatus);

  const { data: rules = [] } = useQuery({
    queryKey: RULES_QUERY_KEY,
    queryFn: () => getRulesFn(),
  });
  const { data: categories = [] } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
  });

  interface PendingImpact {
    wouldCategorize: number;
    wouldOverwrite: number;
    onlyUncat: () => Promise<void>;
    overwrite: () => Promise<void>;
  }

  interface RecatResult {
    updated: number;
    aiCategorized: number;
    skipped: number;
  }

  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [pendingImpact, setPendingImpact] = useState<PendingImpact | null>(null);
  const [deletingRule, setDeletingRule] = useState<Rule | null>(null);
  const [showRecategorize, setShowRecategorize] = useState(false);
  const [recatMode, setRecatMode] = useState<"only_uncategorized" | "overwrite_all">("only_uncategorized");
  const [useAi, setUseAi] = useState(false);
  const [recatLoading, setRecatLoading] = useState(false);
  const [recatResult, setRecatResult] = useState<RecatResult | null>(null);

  const { data: aiStatus } = useQuery({
    queryKey: ["ai-status"],
    queryFn: () => getAiStatusFn(),
  });
  const aiVisible = aiStatus?.visible ?? false;

  const { data: uncategorizedCount } = useQuery({
    queryKey: [...TRANSACTIONS_QUERY_KEY, "uncategorized-count"],
    queryFn: () => getTransactionCountsFn({ data: { mode: "only_uncategorized" } }),
  });

  const { data: totalCount } = useQuery({
    queryKey: [...TRANSACTIONS_QUERY_KEY, "total-count"],
    queryFn: () => getTransactionCountsFn({ data: { mode: "overwrite_all" } }),
  });

  const editingRule = useMemo(
    () => (editingRuleId ? rules.find((r) => r.id === editingRuleId) ?? null : null),
    [editingRuleId, rules],
  );

  useEffect(() => {
    if (editingRule) {
      setForm({
        pattern: editingRule.pattern,
        matchType: (editingRule.match_type as MatchType) ?? "substring",
        categoryId: editingRule.category_id,
      });
      setShowForm(true);
    }
  }, [editingRule]);

  const invalidate = () => {
    void invalidateBudgetQueries(queryClient);
    queryClient.invalidateQueries({ queryKey: RULES_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: TRANSACTIONS_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: [...TRANSACTIONS_QUERY_KEY, "uncategorized-count"] });
    queryClient.invalidateQueries({ queryKey: [...TRANSACTIONS_QUERY_KEY, "total-count"] });
  };

  const createMutation = useMutation({
    mutationFn: (data: FormState) =>
      createRuleFn({
        data: {
          pattern: data.pattern,
          matchType: data.matchType,
          categoryId: data.categoryId,
        },
      }),
    onSuccess: () => invalidate(),
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; data: FormState }) =>
      updateRuleFn({
        data: {
          id: input.id,
          pattern: input.data.pattern,
          matchType: input.data.matchType,
          categoryId: input.data.categoryId,
        },
      }),
    onSuccess: () => invalidate(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRuleFn({ data: { id } }),
    onSuccess: () => invalidate(),
  });

  const reorderMutation = useMutation({
    mutationFn: (ids: string[]) => reorderRulesFn({ data: { ids } }),
    onSuccess: () => invalidate(),
  });

  const closeForm = () => {
    setEditingRuleId(null);
    setForm(emptyForm);
    setShowForm(false);
  };

  const handleSubmit = async () => {
    if (!form.pattern.trim() || !form.categoryId) return;

    const impact = await previewImpactFn({
      data: {
        pattern: form.pattern,
        matchType: form.matchType,
        categoryId: form.categoryId,
        excludeRuleId: editingRuleId ?? undefined,
      },
    });

    const persist = async () => {
      if (editingRuleId) {
        await updateMutation.mutateAsync({ id: editingRuleId, data: form });
      } else {
        await createMutation.mutateAsync(form);
      }
      closeForm();
    };

    const applyToExisting = async (mode: "only_uncategorized" | "overwrite_all") => {
      let ruleId: string;
      if (editingRuleId) {
        await updateMutation.mutateAsync({ id: editingRuleId, data: form });
        ruleId = editingRuleId;
      } else {
        const result = await createMutation.mutateAsync(form);
        if ("error" in result) return;
        ruleId = result.id;
      }
      await applyRuleFn({ data: { ruleId, mode } });
      invalidate();
      closeForm();
    };

    if (impact.wouldOverwrite > 0) {
      setPendingImpact({
        wouldCategorize: impact.wouldCategorize,
        wouldOverwrite: impact.wouldOverwrite,
        onlyUncat: () => applyToExisting("only_uncategorized"),
        overwrite: () => applyToExisting("overwrite_all"),
      });
      return;
    }

    if (impact.wouldCategorize > 0) {
      await applyToExisting("only_uncategorized");
    } else {
      await persist();
    }
  };

  const moveRule = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= rules.length) return;
    const next = rules.map((r) => r.id);
    [next[index], next[target]] = [next[target], next[index]];
    reorderMutation.mutate(next);
  };

  const handleReCategorize = async () => {
    setRecatLoading(true);
    setRecatResult(null);
    try {
      const result = await reCategorizeFn({ data: { mode: recatMode, useAi } });
      setRecatResult(result);
      setShowRecategorize(false);
      invalidate();
    } catch {
      // Error handling is done at the server function level
    } finally {
      setRecatLoading(false);
    }
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold display-title">{m.categorization_rules()}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {m.match_description()}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline"
              onClick={() => {
                setShowRecategorize(true);
                setRecatResult(null);
              }}
              data-testid="re-categorize-btn"
            >
              {m.recategorize_btn()}
            </Button>
            <Button
              onClick={() => {
                setEditingRuleId(null);
                setForm(emptyForm);
                setShowForm(true);
              }}
              data-testid="add-rule"
            >
              <svg
                className="size-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 4v16m8-8H4"
                />
              </svg>
              {m.add_rule()}
            </Button>
          </div>
        </div>
      </header>

      <main className="page-wrap py-8">
        {rules.length === 0 ? (
          <div
            className="island-shell rounded-xl p-6 text-sm text-muted-foreground"
            data-testid="rules-empty"
          >
            {m.no_rules_yet()}
          </div>
        ) : (
          <div className="island-shell rounded-xl overflow-hidden" role="table" aria-label="Categorization rules">
              <div role="row" className="flex items-center gap-3 px-3 py-2 bg-muted/40 text-xs font-semibold text-muted-foreground uppercase">
                <span role="columnheader" className="w-12 text-center">{m.order_column()}</span>
                <span role="columnheader" className="w-24">{m.match_column()}</span>
                <span role="columnheader" className="flex-1">{m.pattern_column()}</span>
                <span role="columnheader" className="w-40">{m.category_column()}</span>
                <span role="columnheader" className="w-32 text-right">{m.actions_column()}</span>
              </div>
              <div className="divide-y divide-line/30">
                {rules.map((rule, idx) => (
                  <div
                    key={rule.id}
                    role="row"
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                    data-testid="rule-row"
                    data-rule-id={rule.id}
                  >
                    <span role="cell" className="w-12 flex items-center gap-0.5 justify-center">
                      <button
                        onClick={() => moveRule(idx, -1)}
                        disabled={idx === 0}
                        aria-label={m.move_up({ pattern: rule.pattern })}
                        className="size-6 rounded-md text-xs hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
                        data-testid="rule-move-up"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveRule(idx, 1)}
                        disabled={idx === rules.length - 1}
                        aria-label={m.move_down({ pattern: rule.pattern })}
                        className="size-6 rounded-md text-xs hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
                        data-testid="rule-move-down"
                      >
                        ↓
                      </button>
                    </span>
                    <span role="cell" className="w-24 flex items-center gap-2" data-field="match-type">
                      <span className="text-xs uppercase text-muted-foreground">{rule.match_type}</span>
                      {rule.source === "ai" && (
                        <Badge variant="ghost" className="bg-purple-500/15 text-purple-700 dark:text-purple-300 px-1.5 text-[10px] font-semibold uppercase tracking-wide">
                          {m.ai_badge()}
                        </Badge>
                      )}
                    </span>
                    <span role="cell" className="flex-1 truncate font-mono text-xs" data-field="pattern">
                      {rule.pattern}
                    </span>
                    <span role="cell" className="w-40 truncate" data-field="category">
                      <CategoryBadge name={rule.category_name} color={rule.category_color} />
                    </span>
                    <span role="cell" className="w-32 text-right flex justify-end gap-1">
                      <button
                        onClick={() => setEditingRuleId(rule.id)}
                        className="h-7 px-2 rounded-md text-xs font-medium border border-input bg-background hover:bg-accent transition-colors"
                        data-testid="edit-rule"
                      >
                        {m.edit()}
                      </button>
                      <button
                        onClick={() => setDeletingRule(rule)}
                        className="h-7 px-2 rounded-md text-xs font-medium border border-input bg-background hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40 transition-colors"
                        data-testid="delete-rule"
                      >
                        {m.delete()}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
        )}
      </main>

      {recatResult && (
        <div className="page-wrap mb-4">
          <div
            className="island-shell rounded-xl p-4 flex items-start justify-between gap-4"
            data-testid="recategorize-result"
          >
            <div>
              <p className="text-sm font-medium">
                {m.recategorize_updated({ n: recatResult.updated })}
              </p>
              {recatResult.aiCategorized > 0 && (
                <p className="text-sm text-muted-foreground">
                  {m.recategorize_ai_categorized({ n: recatResult.aiCategorized })}
                </p>
              )}
              {recatResult.skipped > 0 && (
                <p className="text-sm text-muted-foreground">
                  {m.recategorize_skipped({ n: recatResult.skipped })}
                </p>
              )}
            </div>
            <button
              onClick={() => setRecatResult(null)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              data-testid="recategorize-result-dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <RuleFormModal
          form={form}
          setForm={setForm}
          editing={editingRule !== null}
          categories={categories}
          onCancel={closeForm}
          onSubmit={handleSubmit}
          submitting={createMutation.isPending || updateMutation.isPending}
        />
      )}

      {pendingImpact && (
        <ImpactConfirm
          impact={pendingImpact}
          onCancel={() => setPendingImpact(null)}
          onOnlyUncat={async () => {
            await pendingImpact.onlyUncat();
            setPendingImpact(null);
          }}
          onOverwrite={async () => {
            await pendingImpact.overwrite();
            setPendingImpact(null);
          }}
        />
      )}

      {deletingRule && (
        <DeleteConfirm
          rule={deletingRule}
          onCancel={() => setDeletingRule(null)}
          onConfirm={async () => {
            await deleteMutation.mutateAsync(deletingRule.id);
            setDeletingRule(null);
          }}
        />
      )}

      {showRecategorize && (
        <RecategorizeModal
          mode={recatMode}
          setMode={setRecatMode}
          useAi={useAi}
          setUseAi={setUseAi}
          uncategorizedCount={uncategorizedCount?.count ?? 0}
          totalCount={totalCount?.count ?? 0}
          loading={recatLoading}
          onClose={() => setShowRecategorize(false)}
          onConfirm={handleReCategorize}
          aiVisible={aiVisible}
        />
      )}
    </div>
  );
}

function RuleFormModal({
  form,
  setForm,
  editing,
  categories,
  onCancel,
  onSubmit,
  submitting,
}: {
  form: FormState;
  setForm: (next: FormState) => void;
  editing: boolean;
  categories: Awaited<ReturnType<typeof getCategories>>;
  onCancel: () => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const valid = form.pattern.trim() && form.categoryId;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="rule-form">
        <DialogHeader>
          <DialogTitle>{editing ? m.edit_rule() : m.new_rule()}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="rule-pattern" className="mb-1">
              {m.pattern_label()}
            </Label>
            <Input
              id="rule-pattern"
              type="text"
              value={form.pattern}
              onChange={(e) => setForm({ ...form, pattern: e.target.value })}
              autoFocus
              maxLength={256}
              placeholder={m.pattern_placeholder()}
              data-testid="rule-pattern"
            />
          </div>
          <div>
            <Label htmlFor="rule-match-type" className="mb-1">
              {m.match_type_label()}
            </Label>
            <Select
              id="rule-match-type"
              aria-label="Match type"
              value={form.matchType}
              onChange={(e) =>
                setForm({ ...form, matchType: e.target.value as MatchType })
              }
             
            >
              <SelectItem value="substring">{m.substring_match()}</SelectItem>
              <SelectItem value="exact">{m.exact_match()}</SelectItem>
            </Select>
          </div>
          <div>
            <Label htmlFor="rule-category" className="mb-1">
              {m.category_label()}
            </Label>
            <Select
              id="rule-category"
              aria-label="Category"
              value={form.categoryId}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
             
            >
              <SelectItem value="">{m.select_category_placeholder()}</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </Select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline"
              onClick={onCancel}
              disabled={submitting}
              data-testid="rule-cancel"
            >
              {m.cancel()}
            </Button>
            <Button
              onClick={onSubmit}
              disabled={!valid || submitting}
              data-testid="rule-save"
            >
              {submitting ? m.saving() : m.save()}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ImpactConfirm({
  impact,
  onCancel,
  onOnlyUncat,
  onOverwrite,
}: {
  impact: { wouldCategorize: number; wouldOverwrite: number };
  onCancel: () => void;
  onOnlyUncat: () => void;
  onOverwrite: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="impact-confirm">
        <DialogHeader>
          <DialogTitle>{m.apply_rule_title()}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground mb-4">
          {m.rule_matches({
            n_uncategorized: impact.wouldCategorize,
            n_categorized: impact.wouldOverwrite,
          })}
        </p>
        <div className="flex flex-col gap-2">
          <Button variant="outline"
            onClick={onOnlyUncat}
            data-testid="impact-only-uncat"
          >
            {m.apply_only_uncategorized()}
          </Button>
          <Button variant="destructive"
            onClick={onOverwrite}
            data-testid="impact-overwrite"
          >
            {m.overwrite_all()}
          </Button>
          <Button variant="outline"
            onClick={onCancel}
            data-testid="impact-cancel"
          >
            {m.cancel()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteConfirm({
  rule,
  onCancel,
  onConfirm,
}: {
  rule: Rule;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className="sm:max-w-sm" data-testid="delete-rule-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{m.delete_rule_title()}</AlertDialogTitle>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground mb-4">
          {m.delete_rule_confirm({ pattern: rule.pattern })}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline"
            onClick={onCancel}
            data-testid="delete-rule-cancel"
          >
            {m.cancel()}
          </Button>
          <Button variant="destructive"
            onClick={onConfirm}
            data-testid="delete-rule-confirm"
          >
            {m.delete_btn()}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RecategorizeModal({
  mode,
  setMode,
  useAi,
  setUseAi,
  uncategorizedCount,
  totalCount,
  loading,
  onClose,
  onConfirm,
  aiVisible,
}: {
  mode: "only_uncategorized" | "overwrite_all";
  setMode: (m: "only_uncategorized" | "overwrite_all") => void;
  useAi: boolean;
  setUseAi: (v: boolean) => void;
  uncategorizedCount: number;
  totalCount: number;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  aiVisible: boolean;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="recategorize-modal">
        <DialogHeader>
          <DialogTitle>{m.recategorize_title()}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">
              {m.recategorize_mode_label()}
            </label>
            <div className="space-y-2">
              <Label className="cursor-pointer">
                <input
                  type="radio"
                  name="recat-mode"
                  checked={mode === "only_uncategorized"}
                  onChange={() => setMode("only_uncategorized")}
                  className="size-4 accent-primary"
                  data-testid="recat-mode-uncategorized"
                />
                <span>
                  {m.recategorize_only_uncat()}{" "}
                  <span className="text-muted-foreground">
                    ({m.recategorize_uncategorized_count({ n: uncategorizedCount })})
                  </span>
                </span>
              </Label>
              <Label className="cursor-pointer">
                <input
                  type="radio"
                  name="recat-mode"
                  checked={mode === "overwrite_all"}
                  onChange={() => setMode("overwrite_all")}
                  className="size-4 accent-primary"
                  data-testid="recat-mode-overwrite"
                />
                <span>
                  {m.recategorize_overwrite_all()}{" "}
                  <span className="text-muted-foreground">
                    ({m.recategorize_total_count({ n: totalCount })})
                  </span>
                </span>
              </Label>
            </div>
          </div>
          {aiVisible && (
            <div>
              <Label className="cursor-pointer">
                <input
                  type="checkbox"
                  checked={useAi}
                  onChange={(e) => setUseAi(e.target.checked)}
                  className="size-4 accent-primary"
                  data-testid="recat-use-ai"
                />
                <span>{m.recategorize_ai_label()}</span>
              </Label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                {m.recategorize_ai_desc()}
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline"
              onClick={onClose}
              disabled={loading}
              data-testid="recategorize-cancel"
            >
              {m.cancel()}
            </Button>
            <Button
              onClick={onConfirm}
              disabled={loading}
              data-testid="recategorize-run"
            >
              {loading ? m.recategorize_running() : m.recategorize_btn_run()}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
