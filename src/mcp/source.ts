import type { Bank, BankFailure } from "../core/contracts.ts";
import type { TransactionReader } from "../core/transactions.ts";

/** The configured bank source, or the configuration problems that prevent it. */
export type Source =
  | {
      readonly ok: true;
      readonly connections: readonly string[];
      readonly bank: Bank;
      readonly toFailure: (error: unknown) => BankFailure;
      readonly reader: TransactionReader;
    }
  | {
      readonly ok: false;
      readonly problems: readonly string[];
      readonly databaseProblems?: readonly string[];
    };
