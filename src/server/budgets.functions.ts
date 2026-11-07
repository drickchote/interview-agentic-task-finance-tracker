import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUserId } from "#/server/session";
import {
  listBudgets,
  createBudgetInternal,
  updateBudgetLimitInternal,
  deleteBudgetInternal,
} from "./budgets.server";
import { createBudgetSchema, updateBudgetLimitSchema, deleteBudgetSchema } from "./budgets.schemas";

export const getBudgets = createServerFn({ method: "GET" })
  .inputValidator(z.void())
  .handler(async () => listBudgets(await requireUserId()));

export const createBudget = createServerFn({ method: "POST" })
  .inputValidator(createBudgetSchema)
  .handler(async ({ data }) => createBudgetInternal(await requireUserId(), data));

export const updateBudgetLimit = createServerFn({ method: "POST" })
  .inputValidator(updateBudgetLimitSchema)
  .handler(async ({ data }) => updateBudgetLimitInternal(await requireUserId(), data));

export const deleteBudget = createServerFn({ method: "POST" })
  .inputValidator(deleteBudgetSchema)
  .handler(async ({ data }) => deleteBudgetInternal(await requireUserId(), data));
