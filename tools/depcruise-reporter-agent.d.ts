export type ReporterOutput = {
  readonly output: string;
  readonly exitCode: number;
};

declare function reporter(cruiseResult: unknown): ReporterOutput;

export default reporter;
