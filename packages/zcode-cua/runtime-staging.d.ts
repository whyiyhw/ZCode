export declare class CuaRuntimeStagingError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export interface CuaHelperRuntimeManifest {
  schemaVersion: 1;
  packageName: "@zcode/zcode-cua";
  packageVersion: string;
  platform: "win32";
  arch: "x64" | "arm64";
  electronVersion: string;
  entry: string;
  addon: string;
  sha256: { entry: string; addon: string };
}

export interface VerifyCuaHelperRuntimeOptions {
  arch?: NodeJS.Architecture;
  electronVersion?: string;
}

export declare function verifyCuaHelperRuntime(
  root: string,
  options?: VerifyCuaHelperRuntimeOptions,
): Promise<CuaHelperRuntimeManifest>;

export interface FindWindowsCuaHelperSourceOptions {
  extraRoots?: string[];
  readRegistry?: boolean;
  regQuery?: (hive: string, key: string, view: "64" | "32") => string;
}

export declare function findWindowsCuaHelperSource(
  env?: Record<string, string | undefined>,
  options?: FindWindowsCuaHelperSourceOptions,
): Promise<string | null>;

export interface StageCuaHelperRuntimeOptions {
  sourceRoot: string;
  targetRoot: string;
  arch?: NodeJS.Architecture;
  electronVersion?: string;
  force?: boolean;
}

export declare function stageCuaHelperRuntime(
  options: StageCuaHelperRuntimeOptions,
): Promise<{ staged: boolean; manifest: CuaHelperRuntimeManifest }>;

export declare function isAutoStageEnabled(env?: Record<string, string | undefined>): boolean;

export declare const USER_STAGED_RUNTIME_DIR_NAME: string;
