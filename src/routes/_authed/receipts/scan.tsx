import { invalidateBudgetQueries } from "#/lib/budget-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAiUsage,
  scanReceipt,
  saveReceiptAndLink,
  suggestTransactionForReceipt,
} from "#/server/receipts.functions";
import { getCategories } from "#/server/categories.functions";
import { getAccounts } from "#/server/accounts.functions";
import { m } from "#/paraglide/messages";
import {
  formatMinor,
  minorToInputValue,
  parseAmountToMinor,
} from "#/lib/money";
import { Button } from "#/components/ui/button";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";


const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

// Vision-model cost scales with image size; a receipt is perfectly legible at
// 1500px. Downscaled uploads are re-encoded as JPEG, which also strips
// client-side metadata and shrinks the upload itself.
const MAX_IMAGE_DIMENSION = 1500;
const JPEG_QUALITY = 0.85;

/**
 * Downscales an image so its longest side is at most MAX_IMAGE_DIMENSION,
 * re-encoding as JPEG. Returns the original file untouched when it is
 * already small enough or when decoding fails (server validation still runs).
 */
async function downscaleImage(
  file: File,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const original = async () => ({
    bytes: new Uint8Array(await file.arrayBuffer()),
    filename: file.name,
  });
  try {
    const bitmap = await createImageBitmap(file);
    const scale = MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) {
      bitmap.close();
      return await original();
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return await original();
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob) return await original();
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      filename: file.name.replace(/\.[^.]+$/, "") + ".jpg",
    };
  } catch {
    return await original();
  }
}

/** Maps server-side gate codes to localized messages. */
function scanErrorMessage(
  error: string,
  code: string | undefined,
  scansLimit: number,
): string {
  switch (code) {
    case "ai_quota_exceeded":
      return m.scan_quota_exceeded({ limit: scansLimit });
    case "ai_rate_limited":
      return m.scan_rate_limited();
    case "ai_unavailable":
      return m.scan_ai_unavailable();
    default:
      return error;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface ReceiptItem {
  name: string;
  quantity: number;
  /** Integer minor units (grosze/cents). */
  unit_price_minor: number;
  total_price_minor: number;
  suggested_category: string;
  category_id?: string | null;
}

interface ExtractedData {
  store_name: string;
  date: string;
  items: ReceiptItem[];
  /** Integer minor units (grosze/cents). */
  total_minor: number;
  suggested_parent_category: string;
  _categories?: CategoryInfo[];
}

interface CategoryInfo {
  id: string;
  name: string;
  parent_id: string | null;
}

interface TransactionSuggestion {
  id: string;
  account_id: string;
  date: string;
  /** Integer minor units (grosze/cents). */
  amount_minor: number;
  description: string | null;
  category_id: string | null;
  source: string | null;
  source_ref: string | null;
  created_at: Date | null;
  account_name: string | null;
  account_currency: string | null;
  category_name: string | null;
  category_color: string | null;
}

export const Route = createFileRoute("/_authed/receipts/scan")({
  component: ReceiptScanPage,
});

const AI_USAGE_QUERY_KEY = ["ai-usage"] as const;

function ReceiptScanPage() {
  const scanReceiptFn = useServerFn(scanReceipt);
  const getAiUsageFn = useServerFn(getAiUsage);
  const saveReceiptAndLinkFn = useServerFn(saveReceiptAndLink);
  const suggestTransactionFn = useServerFn(suggestTransactionForReceipt);
  const queryClient = useQueryClient();

  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    success: true;
    data: ExtractedData;
    imagePaths: string[];
  } | null>(null);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savingError, setSavingError] = useState<string | null>(null);

  // Editable items state
  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [editedDate, setEditedDate] = useState("");
  const [editedStore, setEditedStore] = useState("");
  const [editedTotal, setEditedTotal] = useState(0);

  // Transaction matching state
  const [transactionSuggestion, setTransactionSuggestion] =
    useState<TransactionSuggestion | null>(null);
  const [selectedExistingTransactionId, setSelectedExistingTransactionId] =
    useState<string | null>(null);
  const [transactionLoading, setTransactionLoading] = useState(false);

  // Account selection
  const [selectedAccountId, setSelectedAccountId] = useState("");

  // Fetch categories and accounts
  const categoriesQuery = useQuery({
    queryKey: ["categories"],
    queryFn: () => getCategories(),
  });

  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: () => getAccounts(),
  });

  const aiUsageQuery = useQuery({
    queryKey: AI_USAGE_QUERY_KEY,
    queryFn: () => getAiUsageFn(),
  });

  // Build category tree for dropdowns
  const categories = categoriesQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];

  // Calculate items total (integer minor units)
  const itemsTotal = items.reduce(
    (sum, item) => sum + item.total_price_minor,
    0,
  );
  const delta = itemsTotal - editedTotal;
  const deltaExceedsThreshold = Math.abs(delta) > 50;

  // State for editable parent category
  const [editedParentCategory, setEditedParentCategory] = useState<string>("");

  const processFile = useCallback(
    async (file: File) => {
      setError(null);
      setResult(null);
      setPreviewUrls([]);
      setSaved(false);
      setSavingError(null);
      setSelectedExistingTransactionId(null);
      setTransactionSuggestion(null);

      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        setError("Unsupported format. Allowed: JPG, JPEG, PNG, WebP");
        return;
      }

      setUploading(true);

      try {
        const downscaled = await downscaleImage(file);
        const base64 = bytesToBase64(downscaled.bytes);

        const url = URL.createObjectURL(file);
        setPreviewUrls([url]);

        const scanResult = await scanReceiptFn({
          data: {
            images: [{ data: base64, filename: downscaled.filename }],
          },
        });

        // A scan attempt consumes quota whether it succeeds or not.
        queryClient.invalidateQueries({ queryKey: AI_USAGE_QUERY_KEY });

        if ("error" in scanResult) {
          if (scanResult.error) {
            setError(
              scanErrorMessage(
                scanResult.error,
                "code" in scanResult ? scanResult.code : undefined,
                aiUsageQuery.data?.scansLimit ?? 10,
              ),
            );
          }
          setUploading(false);
          return;
        }

        if (scanResult.success) {
          const data = scanResult.data;
          setResult(scanResult);
          // Map AI suggested_category to actual category_id
          // Use categories from the server response (already available)
          const cats = data._categories ?? categories;
          setItems(
            data.items.map((item) => {
              const catMatch = cats.find(
                (c) =>
                  c.name.toLowerCase() ===
                  item.suggested_category.toLowerCase(),
              );
              return {
                ...item,
                category_id: catMatch ? catMatch.id : null,
              };
            }),
          );
          setEditedDate(data.date);
          setEditedStore(data.store_name);
          setEditedTotal(data.total_minor);
          // Set the suggested parent category
          const parentMatch = cats.find(
            (c) =>
              c.parent_id === null &&
              c.name.toLowerCase() ===
                data.suggested_parent_category.toLowerCase(),
          );
          setEditedParentCategory(parentMatch ? parentMatch.id : "");
        } else {
          setError("Unknown error");
        }
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Failed to process image";
        setError(message);
      } finally {
        setUploading(false);
      }
    },
    [scanReceiptFn, queryClient, aiUsageQuery.data?.scansLimit],
  );

  const onFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  // Update a single item field
  const updateItemField = useCallback(
    (
      index: number,
      field: keyof ReceiptItem,
      value: string | number | null,
    ) => {
      setItems((prev) => {
        const updated = [...prev];
        updated[index] = { ...updated[index], [field]: value };
        return updated;
      });
    },
    [],
  );

  // Add new empty item
  const addItem = useCallback(() => {
    setItems((prev) => [
      ...prev,
      {
        name: "",
        quantity: 1,
        unit_price_minor: 0,
        total_price_minor: 0,
        suggested_category: "",
        category_id: null,
      },
    ]);
  }, []);

  // Delete item
  const deleteItem = useCallback((index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Refresh transaction suggestion when date or total changes
  const refreshTransactionMatch = useCallback(async () => {
    if (!editedDate || editedTotal === 0) return;
    setTransactionLoading(true);
    try {
      const suggestion = await suggestTransactionFn({
        data: { date: editedDate, amountMinor: -editedTotal },
      });

      if (suggestion && "success" in suggestion && suggestion.success) {
        setTransactionSuggestion(suggestion.suggestion ?? null);
        if (suggestion.suggestion) {
          setSelectedExistingTransactionId(suggestion.suggestion.id);
        }
      }
    } catch {
      // Ignore errors
    } finally {
      setTransactionLoading(false);
    }
  }, [editedDate, editedTotal, suggestTransactionFn]);

  // Auto-select first account when accounts are loaded
  useEffect(() => {
    if (accounts.length > 0 && !selectedAccountId) {
      setSelectedAccountId(accounts[0].id);
    }
  }, [accounts, selectedAccountId]);

  // Reset transaction suggestion when result changes
  useEffect(() => {
    setTransactionSuggestion(null);
    setSelectedExistingTransactionId(null);
  }, [result]);

  // Auto-fetch transaction suggestion after scan
  useEffect(() => {
    if (result && editedDate && editedTotal > 0 && !transactionSuggestion) {
      refreshTransactionMatch();
    }
  }, [result, editedDate, editedTotal]);

  // Save receipt and link/create transaction
  const handleSave = useCallback(async () => {
    if (!result || !selectedAccountId) return;
    setSaving(true);
    setSavingError(null);

    try {
      const saveResult = await saveReceiptAndLinkFn({
        data: {
          imagePaths: result.imagePaths,
          store_name: editedStore,
          date: editedDate,
          totalMinor: editedTotal,
          suggested_parent_category:
            selectedParentCategory?.name ||
            result.data.suggested_parent_category,
          items: items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            unit_price_minor: item.unit_price_minor,
            total_price_minor: item.total_price_minor,
            category_id: item.category_id || "",
          })),
          accountId: selectedAccountId,
          existingTransactionId: selectedExistingTransactionId || null,
        },
      });

      if ("error" in saveResult && saveResult.error) {
        setSavingError(saveResult.error);
        return;
      }

      if (saveResult.success) {
        setSaved(true);
        void invalidateBudgetQueries(queryClient);
        queryClient.invalidateQueries({ queryKey: ["transactions"] });
      } else {
        setSavingError("Unknown error during save");
      }
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Failed to save receipt";
      setSavingError(message);
    } finally {
      setSaving(false);
    }
  }, [
    result,
    editedStore,
    editedDate,
    editedTotal,
    items,
    selectedAccountId,
    selectedExistingTransactionId,
    saveReceiptAndLinkFn,
    queryClient,
  ]);

  const formatCurrency = (amountMinor: number): string => {
    return formatMinor(amountMinor);
  };

  // Get sub-categories under the selected parent category
  const selectedParentCategory = editedParentCategory
    ? (categories.find(
        (c) => c.id === editedParentCategory,
      ) as CategoryInfo | null)
    : null;

  // Get sub-categories for the dropdown (children of selected parent)
  const subCategories = categories.filter(
    (c) => c.parent_id === (selectedParentCategory?.id ?? null),
  );

  // All top-level categories for parent category selector
  const topCategories = categories.filter((c) => c.parent_id === null);

  return (
    <div className="min-h-screen">
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4">
          <h1 className="text-xl font-bold display-title">
            {m.scan_receipt_title()}
          </h1>
        </div>
      </header>

      <main className="page-wrap py-8">
        {/* Upload zone */}
        {!result && !saved && (
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
              {m.scan_drag_drop()}
            </p>
            <label className="inline-flex h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer items-center gap-2">
              <input
                type="file"
                accept=".jpg,.jpeg,.png,.webp"
                onChange={onFileInput}
                className="sr-only"
                data-testid="file-input"
              />
              {m.scan_choose_file()}
            </label>
            <p className="text-xs text-muted-foreground mt-3">
              JPG, JPEG, PNG, WebP — max 20MB
            </p>
            {aiUsageQuery.data && (
              <p
                className="text-xs text-muted-foreground mt-1"
                data-testid="scan-usage"
              >
                {m.scan_usage_this_month({
                  used: aiUsageQuery.data.scansUsed,
                  limit: aiUsageQuery.data.scansLimit,
                })}
              </p>
            )}
          </div>
        )}

        {/* Error message */}
        {error && (
          <div
            className="mt-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm"
            role="alert"
            data-testid="error-message"
          >
            {error}
          </div>
        )}

        {/* Saving error */}
        {savingError && !error && (
          <div
            className="mt-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm"
            role="alert"
          >
            {savingError}
          </div>
        )}

        {/* Loading state */}
        {uploading && (
          <div className="mt-8 flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div
                className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin"
                data-testid="loading-spinner"
              />
              <span className="text-sm text-muted-foreground">
                {m.scan_analyzing()}
              </span>
            </div>
          </div>
        )}

        {/* Saved confirmation */}
        {saved && (
          <div className="mt-8 p-4 rounded-md bg-emerald-500/10 text-emerald-600 text-sm">
            <p className="font-semibold mb-1">Receipt saved successfully!</p>
            <p>Transaction created with {items.length} item(s).</p>
          </div>
        )}

        {/* Results */}
        {result && !saved && (
          <div className="mt-8 space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Image preview */}
              <div className="island-shell rounded-xl p-4">
                <h2 className="text-base font-semibold mb-3">
                  {m.scan_image_preview()}
                </h2>
                {previewUrls.length > 0 && (
                  <img
                    src={previewUrls[0]}
                    alt="Receipt preview"
                    className="w-full rounded-lg max-h-[500px] object-contain bg-muted/30"
                  />
                )}
              </div>

              {/* Extracted data with editing */}
              <div className="island-shell rounded-xl p-4">
                <h2 className="text-base font-semibold mb-4">
                  {m.scan_extracted_data()}
                </h2>

                {/* Store info */}
                <div className="space-y-3 mb-6">
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wide">
                      {m.scan_store_name()}
                    </span>
                    <input
                      type="text"
                      value={editedStore}
                      onChange={(e) => setEditedStore(e.target.value)}
                      className="h-auto w-full mt-0.5 px-2 py-1 border-line/50 rounded shadow-none"
                      data-testid="store-name-input"
                    />
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wide">
                      {m.scan_date()}
                    </span>
                    <input
                      type="date"
                      value={editedDate}
                      onChange={(e) => setEditedDate(e.target.value)}
                      className="h-auto w-full mt-0.5 px-2 py-1 border-line/50 rounded shadow-none"
                      data-testid="date-input"
                    />
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wide">
                      {m.scan_receipt_total()}
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      value={minorToInputValue(editedTotal)}
                      onChange={(e) =>
                        setEditedTotal(parseAmountToMinor(e.target.value) ?? 0)
                      }
                      className="h-auto w-full mt-0.5 px-2 py-1 border-line/50 rounded shadow-none"
                      data-testid="receipt-total-input"
                    />{" "}
                    PLN
                  </div>
                  {topCategories.length > 0 && (
                    <div>
                      <span className="text-xs text-muted-foreground uppercase tracking-wide">
                        {m.scan_suggested_category()}
                      </span>
                      <Select
                        value={editedParentCategory}
                        onChange={(e) =>
                          setEditedParentCategory(e.target.value)
                        }
                        className="h-auto w-full mt-0.5 px-2 py-1 border-line/50 rounded shadow-none"
                        data-testid="parent-category-select"
                      >
                        <SelectItem value="">{m.none_option()}</SelectItem>
                        {topCategories.map((cat) => (
                          <SelectItem key={cat.id} value={cat.id}>
                            {cat.name}
                          </SelectItem>
                        ))}
                      </Select>
                    </div>
                  )}
                </div>

                {/* Items table */}
                {items.length > 0 && (
                  <>
                    <h3 className="text-sm font-semibold mb-2">
                      {m.scan_items()}
                    </h3>
                    <div className="overflow-x-auto mb-4">
                      <Table className="w-full text-sm">
                        <TableHeader>
                          <TableRow className="border-b border-line/50">
                            <TableHead
                              className="text-left py-2 pr-2 text-xs text-muted-foreground font-medium"
                             
                            >
                              {m.scan_item_name()}
                            </TableHead>
                            <TableHead
                              className="text-right py-2 px-2 text-xs text-muted-foreground font-medium w-24"
                             
                            >
                              {m.scan_total_price()}
                            </TableHead>
                            <TableHead
                              className="text-left py-2 pl-2 text-xs text-muted-foreground font-medium"
                             
                            >
                              {m.scan_category()}
                            </TableHead>
                            <TableHead
                              className="text-center py-2 pl-2 text-xs text-muted-foreground font-medium w-10"
                             
                            ></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {items.map((item, idx) => (
                            <TableRow
                              key={idx}
                              className="border-b border-line/30 last:border-0"
                            >
                              <TableCell className="py-1 pr-2">
                                <input
                                  type="text"
                                  value={item.name}
                                  onChange={(e) =>
                                    updateItemField(idx, "name", e.target.value)
                                  }
                                  className="w-full px-1 py-0.5 text-sm border border-transparent hover:border-line/50 focus:border-primary rounded bg-transparent focus:outline-none"
                                  data-testid={`item-name-${idx}`}
                                />
                              </TableCell>
                              <TableCell className="py-1 px-2">
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={minorToInputValue(
                                    item.total_price_minor,
                                  )}
                                  onChange={(e) =>
                                    updateItemField(
                                      idx,
                                      "total_price_minor",
                                      parseAmountToMinor(e.target.value) ?? 0,
                                    )
                                  }
                                  className="w-full px-1 py-0.5 text-sm text-right border border-transparent hover:border-line/50 focus:border-primary rounded bg-transparent focus:outline-none"
                                  data-testid={`item-total-price-${idx}`}
                                />
                              </TableCell>
                              <TableCell className="py-1 pl-2">
                                <Select
                                  value={item.category_id ?? ""}
                                  onChange={(e) =>
                                    updateItemField(
                                      idx,
                                      "category_id",
                                      e.target.value || null,
                                    )
                                  }
                                  className="w-full px-1 py-0.5 text-sm border border-transparent hover:border-line/50 focus:border-primary rounded bg-transparent focus:outline-none"
                                  data-testid={`item-category-${idx}`}
                                >
                                  <SelectItem value="">{m.none_option()}</SelectItem>
                                  {subCategories.map((cat) => (
                                    <SelectItem key={cat.id} value={cat.id}>
                                      {cat.name}
                                    </SelectItem>
                                  ))}
                                </Select>
                              </TableCell>
                              <TableCell className="py-1 pl-2 text-center">
                                <button
                                  type="button"
                                  onClick={() => deleteItem(idx)}
                                  className="text-destructive hover:text-destructive/80 transition-colors"
                                  data-testid={`delete-item-${idx}`}
                                  title="Delete item"
                                >
                                  ✕
                                </button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>

                    {/* Add item button */}
                    <button
                      type="button"
                      onClick={addItem}
                      className="text-sm text-primary hover:text-primary/80 transition-colors mb-4"
                      data-testid="add-item-btn"
                    >
                      + {m.scan_items()}
                    </button>

                    {/* Running total bar */}
                    <div
                      className={`p-3 rounded-md text-sm ${
                        deltaExceedsThreshold
                          ? "bg-amber-500/10 text-amber-600"
                          : "bg-muted/50 text-muted-foreground"
                      }`}
                      data-testid="running-total-bar"
                    >
                      <span>
                        {m.scan_items()} total: {formatCurrency(itemsTotal)} PLN
                        vs {m.scan_receipt_total()}:{" "}
                        {formatCurrency(editedTotal)} PLN
                      </span>
                      {deltaExceedsThreshold && (
                        <span className="ml-2">
                          (delta: {formatCurrency(delta)} PLN)
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Transaction matching section */}
            <div className="island-shell rounded-xl p-4">
              <h2 className="text-base font-semibold mb-3">
                {m.scan_link_transaction()}
              </h2>

              <div className="space-y-3">
                {/* Account selector */}
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wide">
                    {m.account_filter()}
                  </label>
                  <Select
                    value={selectedAccountId}
                    onChange={(e) => setSelectedAccountId(e.target.value)}
                    className="h-auto w-full mt-1 px-2 py-1.5 border-line/50 rounded shadow-none"
                    data-testid="account-select"
                  >
                    <SelectItem value="">— {m.choose_account()} —</SelectItem>
                    {accounts.map((acc) => (
                      <SelectItem key={acc.id} value={acc.id}>
                        {acc.name}
                      </SelectItem>
                    ))}
                  </Select>
                </div>

                {/* Transaction suggestion */}
                {transactionSuggestion ? (
                  <div className="p-3 rounded-md bg-emerald-500/10">
                    <p className="text-sm font-medium text-emerald-600 mb-2">
                      {m.scan_matching_found()}
                    </p>
                    <div className="text-sm space-y-1">
                      <p>
                        <span className="text-muted-foreground">
                          {m.scan_date()}:{" "}
                        </span>
                        {transactionSuggestion.date}
                      </p>
                      <p>
                        <span className="text-muted-foreground">
                          {m.amount_label()}:{" "}
                        </span>
                        {formatCurrency(transactionSuggestion.amount_minor)}{" "}
                        PLN
                      </p>
                      {transactionSuggestion.description && (
                        <p>
                          <span className="text-muted-foreground">
                            {m.description_label()}:{" "}
                          </span>
                          {transactionSuggestion.description}
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  transactionLoading && (
                    <p className="text-sm text-muted-foreground">
                      {m.scan_matching_loading()}
                    </p>
                  )
                )}

                {/* Create new transaction option */}
                {!transactionSuggestion && !transactionLoading && (
                  <p className="text-sm text-muted-foreground">
                    {m.scan_matching_create_new()}
                  </p>
                )}
              </div>
            </div>

            {/* Save button */}
            <div className="flex justify-end gap-3">
              <Button
                type="button"
                onClick={handleSave}
                disabled={saving || !selectedAccountId}
                className="disabled:cursor-not-allowed"
                data-testid="save-receipt-btn"
              >
                {saving ? m.scan_saving() : m.scan_save()}
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
