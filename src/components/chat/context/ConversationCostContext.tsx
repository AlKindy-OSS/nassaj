/**
 * ConversationCostContext — يشارك نتيجة `useConversationCost` (cost + status + refresh)
 * بين `ChatInterface` (يستدعي الـhook مرة واحدة) و`ConversationCostChip`
 * (يقرأ من السياق بدل استدعاء hook ثانٍ).
 *
 * القيمة الافتراضية: cost=null, status='idle', refresh=no-op
 * كي يبقى استهلاكها بلا حراسة حين يغيب المزوّد.
 */
import { createContext, useContext } from 'react';

import type {
  ConversationCost,
  ConversationCostStatus,
} from '../view/subcomponents/conversationCostFormat';

export type ConversationCostContextValue = {
  cost: ConversationCost | null;
  status: ConversationCostStatus;
  refresh: () => void;
};

const DEFAULT_VALUE: ConversationCostContextValue = {
  cost: null,
  status: 'idle',
  refresh: () => {},
};

export const ConversationCostContext = createContext<ConversationCostContextValue>(DEFAULT_VALUE);

export function useConversationCostContext(): ConversationCostContextValue {
  return useContext(ConversationCostContext);
}
