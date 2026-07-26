/** The slice of `mutation-testing-report-schema` this reporter actually reads. */
export type MutationReport = {
  readonly files: Readonly<
    Record<
      string,
      {
        readonly mutants: readonly {
          readonly mutatorName: string;
          readonly replacement?: string;
          readonly status: string;
          readonly location: { readonly start: { readonly line: number; readonly column: number } };
        }[];
      }
    >
  >;
};

export type Summary = {
  readonly killed: number;
  readonly timeout: number;
  readonly survived: number;
  readonly noCoverage: number;
  readonly invalid: number;
  readonly detected: number;
  readonly viable: number;
  /** `null` rather than a division by zero when nothing viable was mutated. */
  readonly score: number | null;
  readonly scoreCovered: number | null;
};

export type MutatorGroup = {
  readonly mutator: string;
  readonly entries: readonly { readonly where: string; readonly what: string }[];
};

export type Hotspot = { readonly file: string; readonly undetected: number };

export declare function summarize(report: MutationReport): Summary;
export declare function groupByMutator(report: MutationReport): MutatorGroup[];
export declare function hotspots(report: MutationReport): Hotspot[];
export declare function render(report: MutationReport): string;
export declare function renderSummary(report: MutationReport): string;
