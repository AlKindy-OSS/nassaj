/** Claude's on-disk project folder name: every char outside [A-Za-z0-9-] → '-'. Dependency-free leaf. */
export function encodeClaudeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
}
