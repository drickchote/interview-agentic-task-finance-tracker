import { invalidateBudgetQueries } from "#/lib/budget-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import {
  previewImport,
  confirmImport,
  getImportHistory,
  deleteImportBatch,
  setImportAborted,
  type ImportSummary,
  type RuleSummary,
  type RowInfo,
} from "#/server/imports.functions";
import { getAccounts, createAccount } from "#/server/accounts.functions";
import { m } from "#/paraglide/messages";
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
import { formatMinor } from "#/lib/money";

let currentAbortController: AbortController | null = null;


const ACCOUNTS_QUERY_KEY = ["accounts"] as const;
const IMPORT_HISTORY_QUERY_KEY = ["import-history"] as const;

type PreviewResponse = Awaited<ReturnType<typeof previewImport>>;
type PreviewResult = Exclude<PreviewResponse, { error: string }>;
type ConfirmResult = ImportSummary;
type ImportFormat = "generic" | "pko_bp";
type Step =
  | "upload"
  | "mapping"
  | "account"
  | "preview"
  | "categorizing"
  | "summary";

interface Mapping {
  date: string;
  amount: string;
  description: string;
  category: string;
}

const emptyMapping: Mapping = {
  date: "",
  amount: "",
  description: "",
  category: "",
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// --- Inline new account form ---

function NewAccountModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const createAccountFn = useServerFn(createAccount);
  const [name, setName] = useState("");
  const [bank, setBank] = useState("");
  const [currency, setCurrency] = useState("PLN");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setBank("");
      setCurrency("PLN");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(m.account_name_required());
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await createAccountFn({
      data: { name: name.trim(), bank: bank.trim() || undefined, currency },
    });
    setSubmitting(false);
    if ("error" in result) {
      setError(
        result.code === "account_limit_reached"
          ? m.account_limit_reached({ limit: result.limit })
          : (result.error ?? null),
      );
      return;
    }
    queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
    onCreated(result.id);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.new_account_title()}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="ia-name" className="mb-1">
              {m.account_name_label()}
            </Label>
            <Input
              id="ia-name"
              type="text"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              maxLength={128}
              placeholder="e.g. Main Checking"
            />
          </div>
          <div>
            <Label htmlFor="ia-bank" className="mb-1">
              {m.bank_label()}
            </Label>
            <Input
              id="ia-bank"
              type="text"
              value={bank}
              onChange={(e) => setBank(e.target.value)}
              maxLength={128}
            />
          </div>
          <div>
            <Label
              htmlFor="ia-currency"
              className="mb-1"
            >
              {m.currency_label()}
            </Label>
            <input
              id="ia-currency"
              type="text"
              value={currency}
              onChange={(e) =>
                setCurrency(e.target.value.toUpperCase().slice(0, 3))
              }
              maxLength={3}
              className="h-9 w-20 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 font-mono"
              placeholder="PLN"
            />
          </div>
          {error && (
            <div className="text-destructive text-sm" role="alert">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline"
              type="button"
              onClick={onClose}
              disabled={submitting}
            >
              {m.cancel()}
            </Button>
            <Button
              type="submit"
              disabled={submitting}
            >
              {submitting ? m.creating_btn() : m.create_account_btn()}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Page ---

export const Route = createFileRoute("/_authed/import")({
  component: ImportPage,
});

function ImportPage() {
  const previewImportFn = useServerFn(previewImport);
  const confirmImportFn = useServerFn(confirmImport);
  const getAccountsFn = useServerFn(getAccounts);
  const getImportHistoryFn = useServerFn(getImportHistory);
  const deleteImportBatchFn = useServerFn(deleteImportBatch);

  const { data: accounts = [] } = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: () => getAccountsFn(),
  });
  const { data: history = [] } = useQuery({
    queryKey: IMPORT_HISTORY_QUERY_KEY,
    queryFn: () => getImportHistoryFn(),
  });
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>("upload");
  const [filename, setFilename] = useState("");
  const [fileData, setFileData] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [mapping, setMapping] = useState<Mapping>(emptyMapping);
  const [accountId, setAccountId] = useState("");
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [summary, setSummary] = useState<ConfirmResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [formatOverride, setFormatOverride] = useState<
    ImportFormat | undefined
  >(undefined);
  const [undoBatchId, setUndoBatchId] = useState<string | null>(null);
  const [undoSubmitting, setUndoSubmitting] = useState(false);
  const [currentRequestId, setCurrentRequestId] = useState<number | null>(null);
  const [streamCurrent, setStreamCurrent] = useState(0);
  const [streamTotal, setStreamTotal] = useState(0);
  const [currentItem, setCurrentItem] = useState<RowInfo | null>(null);
  const [newRules, setNewRules] = useState<RuleSummary[]>([]);
  const [mismatchedPatterns, setMismatchedPatterns] = useState<
    Array<{ pattern: string; description: string }>
  >([]);

  const format: ImportFormat = preview?.format ?? "generic";
  const detectedFormat: ImportFormat = preview?.detectedFormat ?? "generic";

  const reset = () => {
    setStep("upload");
    setFilename("");
    setFileData("");
    setPreview(null);
    setMapping(emptyMapping);
    setAccountId("");
    setSummary(null);
    setError(null);
    setFormatOverride(undefined);
    setStreamCurrent(0);
    setStreamTotal(0);
    setCurrentItem(null);
    setNewRules([]);
    setMismatchedPatterns([]);
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    if (currentRequestId !== null) {
      setImportAborted(currentRequestId, false);
    }
    setCurrentRequestId(null);
  };

  const applyPreview = (
    result: PreviewResult,
    opts?: { resetMapping?: boolean },
  ) => {
    setPreview(result);
    if (result.format === "generic" && (opts?.resetMapping || !mapping.date)) {
      setMapping({
        date: result.mapping.date ?? "",
        amount: result.mapping.amount ?? "",
        description: result.mapping.description ?? "",
        category: result.mapping.category ?? "",
      });
    }
  };

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      const buf = await file.arrayBuffer();
      const data = bytesToBase64(new Uint8Array(buf));
      setFilename(file.name);
      setFileData(data);
      setFormatOverride(undefined);
      const result = await previewImportFn({
        data: { filename: file.name, data },
      });
      if ("error" in result) {
        setError(result.error ?? "Import failed");
        return;
      }
      applyPreview(result, { resetMapping: true });
      // PKO files skip the mapping step entirely.
      setStep(result.format === "pko_bp" ? "account" : "mapping");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewImportFn],
  );

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const refreshPreview = async (
    next: Mapping,
    opts?: { accountId?: string },
  ) => {
    if (!fileData) return;
    const result = await previewImportFn({
      data: {
        filename,
        data: fileData,
        mapping: {
          date: next.date || undefined,
          amount: next.amount || undefined,
          description: next.description || undefined,
          category: next.category || undefined,
        },
        accountId: opts?.accountId || undefined,
        formatOverride,
      },
    });
    if ("error" in result) {
      setError(result.error ?? "Import failed");
      return;
    }
    applyPreview(result);
  };

  const handleMappingChange = (field: keyof Mapping, value: string) => {
    const next = { ...mapping, [field]: value };
    setMapping(next);
    void refreshPreview(next);
  };

  const goToPreview = () => {
    void refreshPreview(mapping, { accountId });
    setStep("preview");
  };

  const switchToGenericMapping = async () => {
    if (!fileData) return;
    setFormatOverride("generic");
    const result = await previewImportFn({
      data: {
        filename,
        data: fileData,
        formatOverride: "generic",
      },
    });
    if ("error" in result) {
      setError(result.error ?? "Import failed");
      return;
    }
    applyPreview(result, { resetMapping: true });
    setStep("mapping");
  };

  const mappingComplete =
    format === "pko_bp" ||
    !!(mapping.date && mapping.amount && mapping.description);

  const handleConfirm = async () => {
    if (!accountId) {
      setError("Please pick an account");
      return;
    }
    setSubmitting(true);
    setError(null);
    setNewRules([]);
    setMismatchedPatterns([]);
    setCurrentItem(null);
    setStep("categorizing");

    const confirmData = {
      filename,
      data: fileData,
      format,
      mapping:
        format === "generic"
          ? {
              date: mapping.date,
              amount: mapping.amount,
              description: mapping.description,
              category: mapping.category || undefined,
            }
          : undefined,
      accountId,
    };

    try {
      let finalSummary: ImportSummary | null = null;
      const reqId = Date.now();
      setCurrentRequestId(reqId);
      currentAbortController = new AbortController();

      for await (const chunk of await confirmImportFn({ data: confirmData })) {
        if (currentAbortController.signal.aborted) break;

        if (
          chunk.type === "ruleMatch" ||
          chunk.type === "aiMatched" ||
          chunk.type === "newRule" ||
          chunk.type === "aiMismatch" ||
          chunk.type === "error" ||
          chunk.type === "uncategorized" ||
          chunk.type === "duplicate"
        ) {
          setStreamCurrent(chunk.current);
          setStreamTotal(chunk.total);
          setCurrentItem(chunk.row);
        }

        if (chunk.type === "newRule") {
          setNewRules((prev) => [...prev, chunk.rule]);
        }

        if (chunk.type === "aiMismatch") {
          setMismatchedPatterns((prev) => [
            ...prev,
            { pattern: chunk.pattern, description: chunk.row.description },
          ]);
        }

        if (chunk.type === "complete") {
          void invalidateBudgetQueries(queryClient);
          finalSummary = chunk.summary;
        }
      }

      setSummary(finalSummary);
      setSubmitting(false);
      setStep("summary");
    } catch (err) {
      setSubmitting(false);
      if (err instanceof Error && err.message === "Import cancelled") {
        setError(m.cancelled());
        setStep("upload");
      } else {
        setError(err instanceof Error ? err.message : "Import failed");
        setStep("summary");
      }
    } finally {
      currentAbortController = null;
    }
  };

  const handleCancelImport = () => {
    if (currentAbortController) {
      currentAbortController.abort();
    }
    if (currentRequestId !== null) {
      setImportAborted(currentRequestId, true);
    }
  };

  const undoTarget = undoBatchId
    ? (history.find((h) => h.id === undoBatchId) ?? null)
    : null;

  const handleUndoConfirm = async () => {
    if (!undoBatchId) return;
    setUndoSubmitting(true);
    await deleteImportBatchFn({ data: { batchId: undoBatchId } });
    setUndoSubmitting(false);
    setUndoBatchId(null);
    void invalidateBudgetQueries(queryClient);
    queryClient.invalidateQueries({ queryKey: IMPORT_HISTORY_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: ["transactions"] });
  };

  const visibleSteps: Step[] =
    format === "pko_bp"
      ? ["upload", "account", "preview", "categorizing", "summary"]
      : ["upload", "mapping", "account", "preview", "categorizing", "summary"];

  return (
    <div className="min-h-screen">
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4">
          <h1 className="text-xl font-bold display-title">Import</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Import bank transactions from a CSV file.
          </p>
        </div>
      </header>

      <main className="page-wrap py-8 max-w-3xl">
        {/* Stepper */}
        <ol className="flex items-center gap-2 text-xs text-muted-foreground mb-6">
          {visibleSteps.map((s, idx) => (
            <li key={s} className="flex items-center gap-2">
              <span
                className={`size-5 rounded-full flex items-center justify-center text-[10px] font-semibold ${
                  s === step
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {idx + 1}
              </span>
              <span className={s === step ? "text-foreground font-medium" : ""}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </span>
              {idx < visibleSteps.length - 1 && (
                <span className="opacity-40">›</span>
              )}
            </li>
          ))}
        </ol>

        {error && (
          <div
            className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm"
            role="alert"
          >
            {error}
          </div>
        )}

        {step === "upload" && (
          <section aria-label={m.upload_step()} className="space-y-6">
            <div
              data-testid="drop-zone"
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              className={`island-shell rounded-xl p-10 text-center border-2 border-dashed transition-colors ${
                dragActive ? "border-primary bg-accent/40" : "border-line/60"
              }`}
            >
              <p className="text-sm text-muted-foreground mb-3">
                {m.drag_drop_csv()}
              </p>
              <label className="inline-flex h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer items-center gap-2">
                <input
                  type="file"
                  accept=".csv"
                  onChange={onFileInput}
                  className="sr-only"
                  data-testid="file-input"
                />
                {m.choose_file()}
              </label>
            </div>

            <ImportHistory
              history={history}
              onUndo={(id) => setUndoBatchId(id)}
            />
          </section>
        )}

        {step !== "upload" && preview && (
          <section className="island-shell rounded-xl p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{filename}</p>
                <p className="text-xs text-muted-foreground">
                  {preview.totalRows} rows
                </p>
              </div>
              <button
                onClick={reset}
                className="text-xs text-muted-foreground hover:text-foreground underline"
              >
                {m.choose_another()}
              </button>
            </div>

            {format === "pko_bp" && step !== "summary" && (
              <FormatBanner
                onUseGeneric={() => void switchToGenericMapping()}
              />
            )}

            {step === "mapping" && preview.format === "generic" && (
              <>
                <h2 className="text-base font-semibold">{m.map_columns()}</h2>
                {detectedFormat === "pko_bp" && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="generic-fallback-hint"
                  >
                    {m.falling_back_mapping()}
                  </p>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <MappingField
                    label={m.date_col()}
                    required
                    headers={preview.headers}
                    value={mapping.date}
                    onChange={(v) => handleMappingChange("date", v)}
                  />
                  <MappingField
                    label={m.amount_col()}
                    required
                    headers={preview.headers}
                    value={mapping.amount}
                    onChange={(v) => handleMappingChange("amount", v)}
                  />
                  <MappingField
                    label={m.description_col()}
                    required
                    headers={preview.headers}
                    value={mapping.description}
                    onChange={(v) => handleMappingChange("description", v)}
                  />
                  <MappingField
                    label={m.category_col()}
                    headers={preview.headers}
                    value={mapping.category}
                    onChange={(v) => handleMappingChange("category", v)}
                  />
                </div>
                {!mappingComplete && (
                  <p
                    className="text-xs text-destructive"
                    data-testid="mapping-required-error"
                  >
                    {m.columns_required()}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setStep("account")}
                    disabled={!mappingComplete}
                    className="h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="continue-to-account"
                  >
                    {m.continue_btn()}
                  </button>
                </div>
              </>
            )}

            {step === "account" && (
              <>
                <h2 className="text-base font-semibold">
                  {m.choose_account()}
                </h2>
                <div className="space-y-3">
                  <Select
                    aria-label={m.account_filter()}
                    value={accountId}
                    onChange={(e) => {
                      if (e.target.value === "__new__") {
                        setShowNewAccount(true);
                      } else {
                        setAccountId(e.target.value);
                      }
                    }}
                   
                  >
                    <SelectItem value="">{m.select_account_placeholder()}</SelectItem>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name} ({a.currency})
                      </SelectItem>
                    ))}
                    <SelectItem value="__new__">{m.create_new_account()}</SelectItem>
                  </Select>
                </div>
                <div className="flex justify-between gap-2">
                  <Button variant="outline"
                    onClick={() =>
                      setStep(format === "pko_bp" ? "upload" : "mapping")
                    }
                  >
                    {m.back_btn()}
                  </Button>
                  <Button
                    onClick={goToPreview}
                    disabled={!accountId}
                    data-testid="continue-to-preview"
                  >
                    {m.continue_btn()}
                  </Button>
                </div>
              </>
            )}

            {step === "preview" && (
              <>
                <h2 className="text-base font-semibold">{m.preview_label()}</h2>
                <PreviewTable rows={preview.resolved ?? []} />
                <div className="flex justify-between gap-2">
                  <Button variant="outline"
                    onClick={() => setStep("account")}
                  >
                    {m.back_btn()}
                  </Button>
                  <Button
                    onClick={handleConfirm}
                    disabled={!accountId || submitting}
                  >
                    {submitting ? m.importing() : m.confirm_import()}
                  </Button>
                </div>
              </>
            )}

            {step === "categorizing" && (
              <>
                <h2 className="text-base font-semibold">
                  {m.categorizing_step()}
                </h2>

                {/* Progress bar */}
                <div className="w-full bg-muted rounded-full h-2 mt-2">
                  <div
                    className="bg-primary h-2 rounded-full transition-all duration-300"
                    style={{
                      width:
                        streamTotal > 0
                          ? `${(streamCurrent / streamTotal) * 100}%`
                          : "0%",
                    }}
                  />
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {streamCurrent}/{streamTotal}
                </p>

                {/* Current item being processed */}
                {currentItem && (
                  <div className="island-shell rounded-md p-3 mt-4 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {m.row_number({ n: currentItem.rowIndex })}
                      </span>
                      {currentItem.description && (
                        <span className="text-sm font-medium truncate">
                          {currentItem.description}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2 text-xs text-muted-foreground">
                      <span>{currentItem.date || "—"}</span>
                      <span>
                        {currentItem.amountMinor != null
                          ? formatMinor(currentItem.amountMinor)
                          : "—"}
                      </span>
                    </div>
                  </div>
                )}

                {/* New rules list */}
                {newRules.length > 0 && (
                  <details className="mt-4" open data-testid="new-rules-list">
                    <summary className="text-sm font-medium cursor-pointer select-none">
                      {m.new_rules_added({ n: newRules.length })}
                    </summary>
                    <ul className="divide-y text-sm mt-2 border">
                      {newRules.map((rule, i) => (
                        <li
                          key={i}
                          className="py-1.5 px-3 flex items-center gap-2"
                          data-testid="new-rule-item"
                        >
                          <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
                            {rule.pattern}
                          </span>
                          <span className="text-muted-foreground">→</span>
                          <span>{rule.category_name}</span>
                          <Badge
                            variant="ghost"
                            className="text-[10px] font-semibold px-1.5 bg-primary/10 text-primary"
                          >
                            {m.ai_badge()}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                {/* Mismatched patterns */}
                {mismatchedPatterns.length > 0 && (
                  <details className="mt-4">
                    <summary className="text-sm font-medium text-amber-600 cursor-pointer select-none">
                      {m.ai_patterns_not_matched({
                        n: mismatchedPatterns.length,
                      })}
                    </summary>
                    <ul className="divide-y text-sm mt-2 border text-amber-700">
                      {mismatchedPatterns.map((p, i) => (
                        <li
                          key={i}
                          className="py-1.5 px-3 text-xs"
                          data-testid="mismatched-pattern-item"
                        >
                          "{p.pattern}" → "{p.description}"
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                {/* Cancel button */}
                <button
                  onClick={handleCancelImport}
                  className="mt-4 text-sm text-muted-foreground hover:text-foreground underline"
                  data-testid="cancel-import"
                >
                  {m.cancel_import()}
                </button>
              </>
            )}

            {step === "summary" &&
              summary &&
              summary.imported !== undefined && (
                <>
                  <h2 className="text-base font-semibold">
                    {m.import_complete()}
                  </h2>
                  <p className="text-sm" data-testid="import-summary">
                    <span className="font-medium">{summary.imported}</span> new
                    transactions imported (
                    <span
                      className="font-medium"
                      data-testid="summary-auto-categorized"
                    >
                      {summary.autoCategorized ?? 0}
                    </span>{" "}
                    matched by rules,
                    <span
                      className="font-medium"
                      data-testid="summary-ai-categorized"
                    >
                      {summary.aiCategorized ?? 0}
                    </span>{" "}
                    matched by AI,
                    <span
                      className="font-medium"
                      data-testid="summary-uncategorized"
                    >
                      {summary.uncategorized ?? 0}
                    </span>{" "}
                    uncategorized),{" "}
                    <span className="font-medium">{summary.duplicates}</span>{" "}
                    duplicates skipped,{" "}
                    <span className="font-medium">{summary.errors}</span> errors
                  </p>

                  {summary.duplicateRows.length > 0 && (
                    <DuplicateList rows={summary.duplicateRows} />
                  )}

                  {summary.errorRows.length > 0 && (
                    <ErrorList rows={summary.errorRows} />
                  )}

                  {summary.newRules.length > 0 && (
                    <details
                      className="rounded-md border border-emerald-500/30 bg-emerald-500/5"
                      data-testid="new-rules-summary"
                      open
                    >
                      <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium select-none">
                        <span className="text-emerald-700 dark:text-emerald-300">
                          {m.new_rules_added({ n: summary.newRules.length })}
                        </span>
                      </summary>
                      <ul className="divide-y divide-emerald-500/15 border-t border-emerald-500/15">
                        {summary.newRules.map((rule, i) => (
                          <li
                            key={i}
                            className="flex gap-3 px-3 py-1.5 text-sm"
                            data-testid="new-rule-summary-item"
                          >
                            <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
                              {rule.pattern}
                            </code>
                            <span className="text-muted-foreground">→</span>
                            <span>{rule.category_name}</span>
                            <Badge
                              variant="ghost"
                              className="text-[10px] font-semibold px-1.5 bg-primary/10 text-primary"
                            >
                              {m.ai_badge()}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {summary.mismatchedPatterns.length > 0 && (
                    <details
                      className="rounded-md border border-amber-500/30 bg-amber-500/5"
                      data-testid="mismatched-patterns-summary"
                    >
                      <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium select-none">
                        <span className="text-amber-700 dark:text-amber-300">
                          {m.ai_patterns_not_matched({
                            n: summary.mismatchedPatterns.length,
                          })}
                        </span>
                      </summary>
                      <ul className="divide-y divide-amber-500/15 border-t border-amber-500/15">
                        {summary.mismatchedPatterns.map((p, i) => (
                          <li
                            key={i}
                            className="px-3 py-1.5 text-sm text-amber-700"
                            data-testid="mismatched-pattern-summary-item"
                          >
                            "{p.pattern}" → "{p.description}"
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  <div className="flex gap-2">
                    <Button variant="outline"
                      onClick={reset}
                    >
                      {m.import_another()}
                    </Button>
                    <Link
                      to="/transactions"
                      className="h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex items-center"
                    >
                      {m.view_transactions()}
                    </Link>
                  </div>
                </>
              )}
          </section>
        )}
      </main>

      <NewAccountModal
        open={showNewAccount}
        onClose={() => setShowNewAccount(false)}
        onCreated={(id) => {
          setAccountId(id);
          setShowNewAccount(false);
        }}
      />

      <UndoImportConfirm
        batch={undoTarget}
        submitting={undoSubmitting}
        onConfirm={handleUndoConfirm}
        onCancel={() => {
          if (!undoSubmitting) setUndoBatchId(null);
        }}
      />
    </div>
  );
}

function DuplicateList({
  rows,
}: {
  rows: { date: string; amountMinor: number; description: string }[];
}) {
  return (
    <details
      className="rounded-md border border-amber-500/30 bg-amber-500/5"
      data-testid="duplicate-list"
      open
    >
      <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium select-none">
        <span className="text-amber-700 dark:text-amber-300">
          {m.duplicates_skipped({ n: rows.length })}
        </span>
      </summary>
      <ul className="divide-y divide-amber-500/15 border-t border-amber-500/15">
        {rows.map((r, idx) => (
          <li
            key={idx}
            className="flex gap-3 px-3 py-1.5 text-sm"
            data-testid="duplicate-list-item"
          >
            <span className="w-24 tabular-nums text-muted-foreground">
              {r.date}
            </span>
            <span className="w-28 text-right font-mono">
              {formatMinor(r.amountMinor)}
            </span>
            <span className="flex-1 truncate">
              {r.description || (
                <span className="text-muted-foreground/60 italic">empty</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ErrorList({
  rows,
}: {
  rows: {
    rowIndex: number;
    errors: string[];
    rawDate: string;
    rawAmount: string;
    description: string;
  }[];
}) {
  return (
    <details
      className="rounded-md border border-destructive/30 bg-destructive/5"
      data-testid="error-list"
      open
    >
      <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium select-none">
        <span className="text-destructive">
          {m.import_errors({ n: rows.length })}
        </span>
      </summary>
      <ul className="divide-y divide-destructive/15 border-t border-destructive/15">
        {rows.map((r) => (
          <li
            key={r.rowIndex}
            className="px-3 py-2 text-sm space-y-0.5"
            data-testid="error-list-item"
          >
            <div className="flex gap-3">
              <span className="w-16 text-xs text-muted-foreground tabular-nums">
                {m.row_number({ n: r.rowIndex })}
              </span>
              <span className="text-destructive text-xs font-medium">
                {r.errors.length > 0 ? r.errors.join(", ") : m.unknown_error()}
              </span>
            </div>
            <div className="pl-16 text-xs text-muted-foreground flex gap-3">
              <span className="tabular-nums">date: {r.rawDate || "—"}</span>
              <span className="tabular-nums">amount: {r.rawAmount || "—"}</span>
              <span className="truncate">desc: {r.description || "—"}</span>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function FormatBanner({ onUseGeneric }: { onUseGeneric: () => void }) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm"
      data-testid="format-banner"
    >
      <span>{m.detected_format({ format: "PKO BP (iPKO)" })}</span>
      <button
        onClick={onUseGeneric}
        className="text-xs underline hover:no-underline"
        data-testid="use-generic-mapping"
      >
        {m.use_generic_mapping()}
      </button>
    </div>
  );
}

function MappingField({
  label,
  required,
  headers,
  value,
  onChange,
}: {
  label: string;
  required?: boolean;
  headers: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </span>
      <Select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
       
      >
        <SelectItem value="">{m.none_option()}</SelectItem>
        {headers
          .filter((h, idx, arr) => h !== "" && arr.indexOf(h) === idx)
          .map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
      </Select>
    </label>
  );
}

function PreviewTable({
  rows,
}: {
  rows: {
    date: string | null;
    amountMinor: number | null;
    description: string;
    errors: string[];
    duplicate?: boolean;
  }[];
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{m.no_rows_preview()}</p>
    );
  }
  return (
    <div
      className="island-shell rounded-md overflow-hidden border border-line/40"
      role="table"
      aria-label={m.preview_label()}
    >
      <div
        role="row"
        className="flex gap-3 px-3 py-2 bg-muted/40 text-xs font-semibold text-muted-foreground uppercase"
      >
        <span role="columnheader" className="w-24">
          {m.date_col()}
        </span>
        <span role="columnheader" className="w-28 text-right">
          {m.amount_col()}
        </span>
        <span role="columnheader" className="flex-1">
          {m.description_col()}
        </span>
        <span role="columnheader" className="w-20 text-right">
          Status
        </span>
      </div>
      <div className="divide-y divide-line/30">
        {rows.map((r, idx) => (
          <div
            key={idx}
            role="row"
            className="flex gap-3 px-3 py-2 text-sm"
            data-testid="preview-row"
            data-duplicate={r.duplicate ? "true" : undefined}
          >
            <span role="cell" className="w-24 tabular-nums" data-field="date">
              {r.date ?? <span className="text-destructive">invalid</span>}
            </span>
            <span
              role="cell"
              className="w-28 text-right font-mono"
              data-field="amount"
            >
              {r.amountMinor === null ? (
                <span className="text-destructive">invalid</span>
              ) : (
                formatMinor(r.amountMinor)
              )}
            </span>
            <span
              role="cell"
              className="flex-1 truncate"
              data-field="description"
            >
              {r.description || (
                <span className="text-muted-foreground/50 italic">empty</span>
              )}
            </span>
            <span role="cell" className="w-20 text-right" data-field="status">
              {r.duplicate ? (
                <Badge
                  variant="ghost"
                  className="bg-amber-500/15 text-amber-700 dark:text-amber-300 px-2 text-[10px] font-semibold uppercase tracking-wide"
                  data-testid="duplicate-badge"
                >
                  {m.duplicate_label()}
                </Badge>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

type ImportHistoryRow = Awaited<ReturnType<typeof getImportHistory>>[number];

function formatBatchDate(value: ImportHistoryRow["created_at"]): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function ImportHistory({
  history,
  onUndo,
}: {
  history: ImportHistoryRow[];
  onUndo: (id: string) => void;
}) {
  if (history.length === 0) {
    return (
      <div
        className="island-shell rounded-xl p-4 text-sm text-muted-foreground"
        data-testid="import-history-empty"
      >
        <h2 className="text-base font-semibold text-foreground mb-1">
          {m.import_history()}
        </h2>
        <p>{m.no_imports_yet()}</p>
      </div>
    );
  }
  return (
    <div className="island-shell rounded-xl p-4" data-testid="import-history">
      <h2 className="text-base font-semibold mb-3">{m.import_history()}</h2>
      <div
        className="rounded-md overflow-hidden border border-line/40"
        role="table"
        aria-label={m.import_history()}
      >
        <div
          role="row"
          className="flex gap-3 px-3 py-2 bg-muted/40 text-xs font-semibold text-muted-foreground uppercase"
        >
          <span role="columnheader" className="flex-1">
            {m.file_column()}
          </span>
          <span role="columnheader" className="w-32">
            {m.account_column()}
          </span>
          <span role="columnheader" className="w-36">
            {m.imported_at()}
          </span>
          <span role="columnheader" className="w-20 text-right">
            {m.rows_column()}
          </span>
          <span role="columnheader" className="w-20 text-right">
            {m.actions_column()}
          </span>
        </div>
        <div className="divide-y divide-line/30">
          {history.map((batch) => (
            <div
              key={batch.id}
              role="row"
              className="flex items-center gap-3 px-3 py-2 text-sm"
              data-testid="import-history-row"
              data-batch-id={batch.id}
            >
              <span
                role="cell"
                className="flex-1 truncate"
                data-field="filename"
              >
                {batch.filename}
              </span>
              <span
                role="cell"
                className="w-32 truncate text-muted-foreground"
                data-field="account"
              >
                {batch.account_name ?? "—"}
              </span>
              <span
                role="cell"
                className="w-36 text-muted-foreground tabular-nums"
                data-field="created-at"
              >
                {formatBatchDate(batch.created_at)}
              </span>
              <span
                role="cell"
                className="w-20 text-right tabular-nums"
                data-field="count"
              >
                {batch.transaction_count}
              </span>
              <span role="cell" className="w-20 text-right">
                <button
                  onClick={() => onUndo(batch.id)}
                  className="h-7 px-3 rounded-md text-xs font-medium border border-input bg-background hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40 transition-colors"
                  data-testid="undo-import"
                >
                  {m.undo_btn()}
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function UndoImportConfirm({
  batch,
  submitting,
  onConfirm,
  onCancel,
}: {
  batch: ImportHistoryRow | null;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!batch) return null;
  const count = batch.transaction_count;
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className="sm:max-w-sm" data-testid="undo-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{m.undo_import()}</AlertDialogTitle>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground mb-2">
          {m.undo_delete_txns({ n: count })}
        </p>
        <p className="text-sm font-medium mb-1">{batch.filename}</p>
        <p className="text-xs text-muted-foreground mb-4">
          {m.undo_receipts_warning()} {m.undo_cannot_be_undone()}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline"
            onClick={onCancel}
            disabled={submitting}
            data-testid="undo-cancel"
          >
            {m.cancel()}
          </Button>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="h-9 px-4 rounded-md text-sm font-medium bg-destructive text-white hover:bg-destructive/90 transition-colors disabled:opacity-50"
            data-testid="undo-confirm-button"
          >
            {submitting ? m.undoing() : m.undo_import()}
          </button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
