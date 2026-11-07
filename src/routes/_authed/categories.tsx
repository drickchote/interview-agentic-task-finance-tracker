import { invalidateBudgetQueries } from "#/lib/budget-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { m } from "#/paraglide/messages";
import { EditButton, DeleteButton } from "#/components/ui/action-buttons";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from "#/server/categories.functions";


type CategoryRow =
  ReturnType<typeof getCategories> extends Promise<(infer T)[]> ? T : unknown;

export const Route = createFileRoute("/_authed/categories")({
  component: CategoriesPage,
});

type CategoryNode = CategoryRow & {
  children: CategoryNode[];
};

function buildCategoryTree(categories: CategoryRow[]): CategoryNode[] {
  const map = new Map<string, CategoryNode>();
  const roots: CategoryNode[] = [];

  // Create all nodes first
  for (const cat of categories) {
    map.set(cat.id, { ...cat, children: [] });
  }

  // Build tree structure
  for (const cat of categories) {
    const node = map.get(cat.id)!;
    if (cat.parent_id) {
      const parent = map.get(cat.parent_id);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  // Sort roots and children by sort_order
  roots.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const node of map.values()) {
    node.children.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }

  return roots;
}

function getTopLevelCategories(categories: CategoryRow[]): CategoryRow[] {
  return categories.filter((c) => c.parent_id === null);
}

// --- Category Row Component ---

function CategoryRow({
  node,
  depth,
  onEdit,
  onDelete,
}: {
  node: CategoryNode;
  depth: number;
  onEdit: (cat: CategoryNode) => void;
  onDelete: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const indent = depth * 24;
  const transactionCount = node.transaction_count ?? 0;

  return (
    <>
      <div
        className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/50 transition-colors group/row"
        style={{ paddingLeft: `${indent + 12}px` }}
        role="row"
        data-testid="category-row"
      >
        {/* Color dot */}
        <span
          className="size-4 shrink-0 rounded-full border border-border/50 shadow-sm"
          style={{ backgroundColor: node.color ?? "#6b7280" }}
          title={node.color ?? "#6b7280"}
        />

        {/* Name */}
        <span className="flex-1 text-sm font-medium truncate">{node.name}</span>

        {/* Transaction count */}
        <span
          className="w-24 text-right text-xs text-muted-foreground tabular-nums"
          data-testid="category-transaction-count"
        >
          {m.n_transactions({ n: transactionCount })}
        </span>

        {/* Actions */}
        <div className="flex items-center gap-1 w-32 justify-end">
          <EditButton
            onClick={() => onEdit(node)}
            data-testid="edit-category"
          />
          <DeleteButton
            onClick={() => onDelete(node.id)}
            data-testid="delete-category"
          />
        </div>
      </div>

      {/* Children */}
      {hasChildren &&
        node.children.map((child) => (
          <CategoryRow
            key={child.id}
            node={child}
            depth={depth + 1}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
    </>
  );
}

// --- Category Form Modal ---

interface CategoryFormData {
  name: string;
  parentId: string | undefined;
  color: string;
}

function CategoryForm({
  isOpen,
  editingCategory,
  topLevelCategories,
  onClose,
  onSubmit,
  error,
}: {
  isOpen: boolean;
  editingCategory: CategoryNode | null;
  topLevelCategories: CategoryRow[];
  onClose: () => void;
  onSubmit: (data: CategoryFormData) => void;
  error: string | null;
}) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | undefined>(undefined);
  const [color, setColor] = useState("#6b7280");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      if (editingCategory) {
        setName(editingCategory.name);
        setParentId(editingCategory.parent_id ?? undefined);
        setColor(editingCategory.color ?? "#6b7280");
      } else {
        setName("");
        setParentId(undefined);
        setColor("#6b7280");
      }
      setValidationError(null);
      setSubmitting(false);
    }
  }, [isOpen, editingCategory]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setValidationError(m.name_required());
      return;
    }
    setSubmitting(true);
    setValidationError(null);
    onSubmit({ name: name.trim(), parentId, color });
  };

  const handleCancel = () => {
    onClose();
  };

  // Filter out the current category from parent options when editing
  const availableParents = editingCategory
    ? topLevelCategories.filter((c) => c.id !== editingCategory.id)
    : topLevelCategories;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingCategory ? m.edit() : m.create_category_btn()}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <Label htmlFor="cat-name" className="mb-1">
              {m.name_label()}
            </Label>
            <Input
              id="cat-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={128}
              autoFocus
              placeholder={m.example_grocery()}
            />
          </div>

          {/* Parent */}
          <div>
            <Label htmlFor="cat-parent" className="mb-1">
              {m.parent_category_label()}
            </Label>
            <Select
              id="cat-parent"
              value={parentId || ""}
              onChange={(e) => setParentId(e.target.value || undefined)}
            >
              <SelectItem value="">{m.none_option()}</SelectItem>
              {availableParents.map((cat) => (
                <SelectItem key={cat.id} value={cat.id}>
                  {cat.name}
                </SelectItem>
              ))}
            </Select>
          </div>

          {/* Color */}
          <div>
            <Label htmlFor="cat-color" className="mb-1">
              {m.color_label()}
            </Label>
            <div className="flex items-center gap-3">
              <Input
                id="cat-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="size-9 w-9 cursor-pointer p-0.5"
              />
              <span className="text-sm text-muted-foreground font-mono">
                {color}
              </span>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="text-destructive text-sm" role="alert">
              {error}
            </div>
          )}
          {validationError && (
            <div className="text-destructive text-sm" role="alert">
              {validationError}
            </div>
          )}

          {/* Actions */}
          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={submitting}
            >
              {m.cancel()}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? editingCategory
                  ? m.saving()
                  : m.creating()
                : editingCategory
                  ? m.save_changes()
                  : m.create_category_btn()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Delete Confirmation ---

function DeleteConfirm({
  isOpen,
  categoryName,
  transactionCount,
  childCount,
  reassignOptions,
  error,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean;
  categoryName: string;
  transactionCount: number;
  childCount: number;
  reassignOptions: CategoryRow[];
  error: string | null;
  onConfirm: (reassignToCategoryId: string | null) => void;
  onCancel: () => void;
}) {
  const [reassignToId, setReassignToId] = useState<string>("");

  useEffect(() => {
    if (isOpen) {
      setReassignToId("");
    }
  }, [isOpen]);

  const hasTransactions = transactionCount > 0;
  const hasChildren = childCount > 0;

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{m.delete_category_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {m.delete_category_confirm({ name: categoryName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {hasChildren && (
          <div className="p-2 rounded-md bg-amber-500/10 text-amber-600 text-xs">
            {m.delete_will_remove_children({ n: childCount })}
          </div>
        )}
        {hasTransactions ? (
          <>
            <p className="text-xs text-muted-foreground">
              {m.n_transactions({ n: transactionCount })}. Choose how to handle
              them:
            </p>
            <div>
              <Label htmlFor="reassign-target" className="mb-1">
                {m.reassign_transactions()}
              </Label>
              <Select
                id="reassign-target"
                value={reassignToId}
                onChange={(e) => setReassignToId(e.target.value)}
              >
                <SelectItem value="">{m.leave_uncategorized()}</SelectItem>
                {reassignOptions.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name}
                  </SelectItem>
                ))}
              </Select>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {m.delete_account_unsaved()}
          </p>
        )}
        {error && (
          <div
            className="text-destructive text-sm p-3 rounded-md bg-destructive/10"
            role="alert"
          >
            {error}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{m.cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => onConfirm(reassignToId || null)}
          >
            {m.delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// --- Main Page ---

const CATEGORIES_QUERY_KEY = ["categories"] as const;

function CategoriesPage() {
  const queryClient = useQueryClient();
  const getCategoriesFn = useServerFn(getCategories);
  const createCategoryFn = useServerFn(createCategory);
  const updateCategoryFn = useServerFn(updateCategory);
  const deleteCategoryFn = useServerFn(deleteCategory);

  const { data: categories = [], isLoading } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
    refetchOnMount: true,
    staleTime: 0,
  });

  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      parentId: string | null;
      color: string;
    }) => createCategoryFn({ data }),
    onSuccess: () => {
      void invalidateBudgetQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: {
      id: string;
      name: string;
      parentId: string | null;
      color: string;
    }) => updateCategoryFn({ data }),
    onSuccess: () => {
      void invalidateBudgetQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (data: { id: string; reassignToCategoryId: string | null }) =>
      deleteCategoryFn({ data }),
    onSuccess: () => {
      void invalidateBudgetQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
    },
  });

  // Form state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<CategoryNode | null>(
    null,
  );
  const [formError, setFormError] = useState<string | null>(null);

  // Delete state
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Build tree
  const tree = buildCategoryTree(categories);
  const topLevelCategories = getTopLevelCategories(categories);

  // Handle add
  const handleAdd = () => {
    setEditingCategory(null);
    setIsFormOpen(true);
    setFormError(null);
  };

  // Handle edit
  const handleEdit = (cat: CategoryNode) => {
    setEditingCategory(cat);
    setIsFormOpen(true);
    setFormError(null);
  };

  // Handle form submit (create or update)
  const handleFormSubmit = async (data: CategoryFormData) => {
    setFormError(null);
    if (editingCategory) {
      // Update
      const result = await updateMutation.mutateAsync({
        id: editingCategory.id,
        name: data.name,
        parentId: data.parentId || null,
        color: data.color,
      });
      if (result && "error" in result) {
        setFormError(result.error ?? null);
        return;
      }
    } else {
      // Create
      const result = await createMutation.mutateAsync({
        name: data.name,
        parentId: data.parentId || null,
        color: data.color,
      });
      if (result && "error" in result) {
        setFormError(result.error ?? null);
        return;
      }
    }
    setIsFormOpen(false);
    setEditingCategory(null);
  };

  // Handle delete confirm
  const handleDeleteConfirm = async (reassignToCategoryId: string | null) => {
    if (!deleteConfirmId) return;
    setDeleteError(null);

    try {
      const result = await deleteMutation.mutateAsync({
        id: deleteConfirmId,
        reassignToCategoryId,
      });
      if (result && "error" in result) {
        setDeleteError(result.error ?? null);
        return;
      }

      setDeleteConfirmId(null);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete category",
      );
    }
  };

  // Handle delete click
  const handleDeleteClick = (id: string) => {
    setDeleteConfirmId(id);
    setDeleteError(null);
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold display-title">Categories</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Manage your spending categories and sub-categories.
            </p>
          </div>
          <Button onClick={handleAdd}>
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
            {m.add_category()}
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="page-wrap py-8">
        {formError && (
          <div
            className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm"
            role="alert"
          >
            {formError}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">
                {m.loading()}
              </span>
            </div>
          </div>
        ) : categories.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <svg
              className="size-12 text-muted-foreground/40 mb-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z"
              />
            </svg>
            <h3 className="text-base font-medium mb-1">
              {m.no_categories_yet()}
            </h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              {m.create_first_category()}
            </p>
          </div>
        ) : (
          <div className="island-shell rounded-xl overflow-hidden">
            {/* Table header */}
            <div className="flex items-center gap-3 px-3 py-2 bg-muted/40 border-b border-line/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <span className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">{m.category_column()}</span>
              <span className="w-24 text-right">{m.transactions_column()}</span>
              <span className="w-32 text-right">{m.actions_column()}</span>
            </div>

            {/* Tree */}
            <div className="divide-y divide-line/30">
              {tree.map((node) => (
                <CategoryRow
                  key={node.id}
                  node={node}
                  depth={0}
                  onEdit={handleEdit}
                  onDelete={handleDeleteClick}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Add/Edit Form */}
      <CategoryForm
        isOpen={isFormOpen}
        editingCategory={editingCategory}
        topLevelCategories={topLevelCategories}
        onClose={() => {
          setIsFormOpen(false);
          setEditingCategory(null);
          setFormError(null);
        }}
        onSubmit={handleFormSubmit}
        error={formError}
      />

      {/* Delete Confirmation */}
      <DeleteConfirm
        isOpen={!!deleteConfirmId}
        categoryName={
          categories.find((c) => c.id === deleteConfirmId)?.name ?? ""
        }
        transactionCount={
          categories.find((c) => c.id === deleteConfirmId)?.transaction_count ??
          0
        }
        childCount={
          categories.find((c) => c.id === deleteConfirmId)?.child_count ?? 0
        }
        reassignOptions={categories.filter((c) => c.id !== deleteConfirmId)}
        error={deleteError}
        onConfirm={handleDeleteConfirm}
        onCancel={() => {
          setDeleteConfirmId(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
