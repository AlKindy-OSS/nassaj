import type { ComponentType } from 'react';
import {
  Minus,
  Gauge,
  Zap,
  Flame,
  Cpu,
  Layers,
  Sparkles,
} from 'lucide-react';

export type EffortMode = {
  id: string;
  /** Technical value sent as `effort` field. Empty string = no effort field. */
  effortValue: string;
  name: string;
  description: string;
  icon: ComponentType<{ className?: string }> | null;
  color: string;
  /** Intensity level for visual treatment: 0 = none, 1 = light, 2 = medium, 3 = high, 4 = max */
  intensity: 0 | 1 | 2 | 3 | 4;
};

export const effortModes: EffortMode[] = [
  {
    id: 'none',
    effortValue: '',
    name: 'standard',
    description: '',
    icon: Minus,
    color: 'text-gray-400',
    intensity: 0,
  },
  {
    id: 'low',
    effortValue: 'low',
    name: 'low',
    description: '',
    icon: Gauge,
    // warning في Claude Code → أصفر في Tailwind
    color: 'text-yellow-500',
    intensity: 1,
  },
  {
    id: 'medium',
    effortValue: 'medium',
    name: 'medium',
    description: '',
    icon: Zap,
    // success في Claude Code → أخضر في Tailwind
    color: 'text-green-500',
    intensity: 2,
  },
  {
    id: 'high',
    effortValue: 'high',
    name: 'high',
    description: '',
    icon: Flame,
    // permission في Claude Code → أزرق في Tailwind
    color: 'text-blue-500',
    intensity: 2,
  },
  {
    id: 'xhigh',
    effortValue: 'xhigh',
    name: 'xhigh',
    description: '',
    icon: Cpu,
    color: 'text-purple-500',
    intensity: 3,
  },
  {
    id: 'max',
    effortValue: 'max',
    name: 'max',
    description: '',
    icon: Layers,
    color: 'text-orange-500',
    intensity: 3,
  },
  {
    id: 'ultracode',
    effortValue: 'ultracode',
    name: 'ultracode',
    description: '',
    icon: Sparkles,
    color: 'text-red-500',
    intensity: 4,
  },
];

/**
 * الوضع المُختار افتراضياً في المُؤلِّف، ولدى تبدّل مزوّد الجلسة.
 *
 * ليس 'none': ذاك يعني «لا تمرّر --effort»، فيؤول إلى افتراضي النموذج (~high)
 * — أغلى الخيارات لا أوسطها (مقيس 2026-07-28: ‏auto ≈ high في الكلفة، وmedium
 * أرخص 3–7 أضعاف وأسرع بالنصف). 'medium' أرضية صريحة للعمل الروتيني، ويرفعها
 * المستخدم من المنتقي حين تستحق المهمة. مدعوم لدى claude وcodex كليهما.
 */
export const DEFAULT_EFFORT_MODE = 'medium';
