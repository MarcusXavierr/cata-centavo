import type { Metric, Score, SensorReading } from "./test-sensor.d.ts";

export type Counts = { found: number; hit: number };

export type FileCoverage = {
  readonly file: string;
  readonly lines: Counts;
  readonly branches: Counts;
  readonly functions: Counts;
};

export type LcovReport = {
  readonly files: readonly FileCoverage[];
  readonly totals: {
    readonly lines: Counts;
    readonly branches: Counts;
    readonly functions: Counts;
  };
};

export declare function percent(counts: Counts): number;
export declare function parseLcov(text: string): LcovReport;
export declare function reading(lcov: string): SensorReading;

export type { Metric, Score, SensorReading };
