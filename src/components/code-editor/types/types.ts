export type CodeEditorDiffInfo = {
  old_string?: string;
  new_string?: string;
  [key: string]: unknown;
};

export type CodeEditorFile = {
  name: string;
  path: string;
  // DB projectId; used by the editor to build `/api/projects/:projectId/file`
  // URLs for reading and saving content.
  projectId?: string;
  // B-1689: chat session the file was opened from; the server then reads and
  // saves that session's overlay copy when it runs in one.
  sessionId?: string | null;
  diffInfo?: CodeEditorDiffInfo | null;
  // Open .md files directly in the rendered markdown preview (read-first
  // entry points such as project-board decision links).
  openMarkdownPreview?: boolean;
  [key: string]: unknown;
};

export type CodeEditorSettingsState = {
  isDarkMode: boolean;
  wordWrap: boolean;
  minimapEnabled: boolean;
  showLineNumbers: boolean;
  fontSize: string;
};
