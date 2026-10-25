export interface IndexScopeSettings {
  indexEnabled: boolean;
  indexIncludeFolders: string;
  indexExcludeFolders: string;
}
export interface RetrievalScope { mode: "folders" | "vault"; folders?: string[]; }
export function parseFolders(raw: string): string[] {
  return [...new Set(raw.split(/[\n,，]/).map(normalizeFolder).filter(Boolean))];
}
export function normalizeFolder(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
export function underFolder(path: string, folder: string): boolean {
  const f = normalizeFolder(folder);
  return f === "." || path === f || path.startsWith(`${f}/`);
}
export function allowedIndexPath(path: string, settings: IndexScopeSettings): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.split("/").some(p => p === ".." || p.startsWith("."))) return false;
  if (!settings.indexEnabled) return false;
  const include = settings.indexIncludeFolders;
  if (!parseFolders(include).some(f => underFolder(normalized, f))) return false;
  return !parseFolders(settings.indexExcludeFolders).some(f => underFolder(normalized, f));
}
export function allowedRetrievalPath(path: string, scope: RetrievalScope): boolean {
  return scope.mode === "vault" || (scope.folders ?? []).some(folder => underFolder(path, folder));
}
