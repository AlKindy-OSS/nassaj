/**
 * TurnCostContext — خريطة `Map<assistantMessageId, SessionCostTurn>` مُشتركة
 * بين `ChatInterface` (يبنيها من نتيجة `useConversationCost`) و`MessageComponent`
 * (يقرأها لعرض كلفة الدور في تذييل الرسالة).
 *
 * تُعيد الخريطة الافتراضية فارغةً (لا null) كي يبقى استهلاكها بلا حراسة.
 * يُجدَّد السياق عند كل إجابة جديدة من الخادم (isLoading ← false) دون
 * جلب إضافي لأن `ChatInterface` يشارك نفس `useConversationCost` الذي
 * يغذّي الشارة.
 */
import { createContext, useContext } from 'react';

import type { SessionCostTurn } from '../view/subcomponents/conversationCostFormat';

export type TurnCostMap = Map<string, SessionCostTurn>;

const EMPTY_MAP: TurnCostMap = new Map();

export const TurnCostContext = createContext<TurnCostMap>(EMPTY_MAP);

/**
 * قارئ السياق لاستهلاك الخريطة في `MessageComponent`.
 * يعيد خريطة فارغة (لا null) حين يغيب المزوّد.
 */
export function useTurnCostMap(): TurnCostMap {
  return useContext(TurnCostContext);
}
