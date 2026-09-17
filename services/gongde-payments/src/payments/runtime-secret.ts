import { lstatSync, readFileSync } from "node:fs";

export function loadRuntimeSecret(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
  directName: string,
  fileName: string
): string {
  const direct = source[directName]?.trim() ?? "";
  if (direct) return direct;
  const path = source[fileName]?.trim() ?? "";
  if (!path) throw new Error(`${directName} or ${fileName} is required`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${fileName} must reference a regular file`);
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`${fileName} must not be empty`);
  return value;
}
