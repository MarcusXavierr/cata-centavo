/** Whether Stryker leaves this path out of the sandbox it copies the project into. */
export declare function ignored(path: string, patterns?: readonly string[]): boolean;

/** Every FIFO and socket under `root` that Stryker would block trying to open. */
export declare function scan(root: string, patterns?: readonly string[]): Promise<string[]>;

export declare function render(paths: readonly string[]): string;
