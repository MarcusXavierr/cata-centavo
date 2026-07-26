import { z } from "zod";

import type { Account } from "../../core/account.ts";
import { isCategoryId } from "../../core/category.ts";
import type { TransactionFilter } from "../../core/contracts.ts";

const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "must be YYYY-MM-DD");
const categoryInput = z.string().refine(isCategoryId, "must be a known category id");

export const listTransactionsInput = z.object({
  startDate: dateInput,
  endDate: dateInput,
  categories: z.array(categoryInput).optional(),
  minAmountCents: z.number().int().optional(),
  maxAmountCents: z.number().int().optional(),
  accountType: z.enum(["BANK", "CREDIT", "INVESTMENT", "LOAN"]).optional(),
  accountSubtype: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100),
  cursor: z.string().optional(),
}).superRefine(validateRange);

export type ListTransactionsInput = z.infer<typeof listTransactionsInput>;

export function validateRange(input: { readonly startDate: string; readonly endDate: string }, context: z.RefinementCtx): void {
  if (input.endDate < input.startDate) {
    context.addIssue({ code: "custom", path: ["endDate"], message: "must not be before startDate" });
  }
}

export function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "Invalid transaction filters.";
  }
  return `Invalid transaction filters: ${issue.path.join(".") || "input"} ${issue.message}.`;
}

export function toTransactionFilter(
  input: Pick<ListTransactionsInput, "startDate" | "endDate" | "categories" | "minAmountCents" | "maxAmountCents" | "accountType" | "accountSubtype">,
  accounts: readonly Account[],
): TransactionFilter {
  let filter: TransactionFilter = {
    accountIds: accounts.map((account) => account.id),
    from: input.startDate,
    to: input.endDate,
  };
  if (input.categories !== undefined) {
    filter = { ...filter, categories: input.categories };
  }
  if (input.minAmountCents !== undefined) {
    filter = { ...filter, minAmountCents: input.minAmountCents };
  }
  if (input.maxAmountCents !== undefined) {
    filter = { ...filter, maxAmountCents: input.maxAmountCents };
  }
  if (input.accountType !== undefined) {
    filter = { ...filter, accountType: input.accountType };
  }
  if (input.accountSubtype !== undefined) {
    filter = { ...filter, accountSubtype: input.accountSubtype };
  }
  return filter;
}
