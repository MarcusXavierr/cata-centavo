/** The fields of the sidecar's `SensorReading` this wrapper fills in. */
export type Finding = {
  readonly message: string;
  readonly severity: "error" | "warning" | "info";
  readonly file?: string;
  readonly rule?: string;
};

export type Metric = {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly direction: "less" | "more";
};

export type Score = {
  readonly value: number;
  readonly direction: "less" | "more";
  readonly description: string;
};

export type SensorReading = {
  readonly success: boolean;
  readonly summary: string;
  readonly score: Score;
  readonly metrics: readonly Metric[];
  readonly findings: readonly Finding[];
};

export type TapFailure = { readonly file: string | null; readonly name: string };

export type TapResult = {
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
  readonly failures: readonly TapFailure[];
};

export declare function requiredNodeMajor(): number;
export declare function parseTap(text: string): TapResult;
export declare function reading(input: { nodeMajor: number; tap: string }): SensorReading;
