/**
 * wikiIcons.ts — maps the `icon` key carried by a wiki section in index.json to
 * a lucide component.
 *
 * The index is authored by non-developers in a separate content repository, so
 * it names icons by intent ("lifebuoy") rather than importing anything. An
 * unknown or missing key falls back to a neutral page icon instead of throwing.
 */

import { BookOpen, Brain, LayoutGrid, LifeBuoy, Rocket, FileText } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { WikiIconName } from './wikiContent';

const ICONS: Record<WikiIconName, LucideIcon> = {
  rocket: Rocket,
  layout: LayoutGrid,
  brain: Brain,
  lifebuoy: LifeBuoy,
  book: BookOpen,
  page: FileText,
};

export function wikiIcon(name?: string): LucideIcon {
  return ICONS[name as WikiIconName] ?? FileText;
}
