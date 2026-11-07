import { z } from "zod";

const idSchema = z.string().min(1).max(128);
// PostgreSQL integer columns store signed 32-bit minor units.
const limitSchema = z.number().int().positive().max(2147483647);

export const createBudgetSchema = z
  .object({
    categoryId: idSchema,
    limitMinor: limitSchema,
  })
  .strict();

export const updateBudgetLimitSchema = z
  .object({
    id: idSchema,
    limitMinor: limitSchema,
  })
  .strict();

export const deleteBudgetSchema = z.object({ id: idSchema }).strict();
