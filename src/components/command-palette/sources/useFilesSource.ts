import { api } from '../../../utils/api';

import { useApiSource } from './useApiSource';

export type FileResult = {
  path: string;
  name: string;
};

interface FileNode {
  type: 'file' | 'directory';
  name: string;
  path: string;
  children?: FileNode[];
}

const MAX_FILES = 500;

function flatten(nodes: FileNode[], out: FileResult[]): void {
  for (const node of nodes) {
    if (out.length >= MAX_FILES) return;
    if (node.type === 'file') {
      out.push({ path: node.path, name: node.name });
    } else if (node.children && node.children.length > 0) {
      flatten(node.children, out);
    }
  }
}

export function useFilesSource(projectId: string | undefined, enabled: boolean) {
  return useApiSource<FileResult, unknown>({
    enabled: enabled && !!projectId,
    deps: [projectId],
    // B-1669: the lean listing; a large repo would answer 413 to the full tree.
    fetcher: (signal) => api.getFiles(projectId!, { signal, partial: true }),
    parse: (data) => {
      const tree: FileNode[] = Array.isArray(data) ? (data as FileNode[]) : [];
      const flat: FileResult[] = [];
      flatten(tree, flat);
      return flat;
    },
  });
}
