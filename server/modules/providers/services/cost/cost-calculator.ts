/**
 * تحويل عدّادات التوكنز إلى مبالغ بالمعادلة الرسمية لكل مزوّد.
 *
 * المعادلة نفسها بسيطة (توكنز ÷ مليون × سعر البند)، والقيمة هنا في الصدق:
 *  • نموذج بلا سعر رسمي **لا يُسعَّر بصفر** — يُدرَج في `unpricedModels`
 *    وتُرفَع `complete=false`، فتقول الواجهة «جزئية» بدل أن تعرض رقماً ناقصاً
 *    كأنه كامل.
 *  • بند بسعر null (لا يُعلنه المزوّد) يُحتسب بصفر **وتوكنزه تُحصى** في
 *    `unpricedComponentTokens` — الصفر هنا واقع تسعير لدى جوجل، ونقص بيانات
 *    لدى غيرها، والتمييز يظهر للمستخدم لا يُبتلع.
 */

import { findModelPrice, PRICES_AS_OF, type ModelPrice } from './model-pricing.js';
import type { ModelUsage, SessionUsage, TokenTotals } from './usage-extractors.js';

const PER_MILLION = 1_000_000;

export type ModelCost = {
  model: string;
  /** null = لا سعر رسمي معروف لهذا النموذج (لا «صفر»). */
  costUsd: number | null;
  tokens: TokenTotals;
  requests: number;
};

export type SessionCost = {
  provider: string;
  /** إجمالي ما أمكن تسعيره. يبقى رقماً حتى لو كانت التغطية جزئية. */
  totalUsd: number;
  perModel: ModelCost[];
  /** نماذج ظهرت في المحادثة ولا سعر رسمي لها. */
  unpricedModels: string[];
  /** توكنز بنودها بلا سعر معلن (احتُسبت صفراً). */
  unpricedComponentTokens: number;
  /**
   * نماذج سُعِّرت بسعر **مفترَض** لا رسمي. رقمُها داخل الإجمالي (فهو أقرب
   * تقدير متاح) لكنه لا يُقدَّم كمقيس: وجودها وحده يُنزل `complete`.
   */
  assumedModels: string[];
  /** true فقط حين سُعِّر كل نموذج وكل بند. */
  complete: boolean;
  subagentRequests: number;
  pricesAsOf: string;
};

const componentCost = (tokens: number, ratePerMTok: number | null): { cost: number; unpriced: number } => {
  if (tokens <= 0) {
    return { cost: 0, unpriced: 0 };
  }
  if (ratePerMTok === null) {
    return { cost: 0, unpriced: tokens };
  }
  return { cost: (tokens / PER_MILLION) * ratePerMTok, unpriced: 0 };
};

/** كلفة نموذج واحد بأسعاره الرسمية. */
export function priceModelUsage(usage: ModelUsage): ModelCost & {
  unpricedTokens: number;
  assumedPrice: boolean;
} {
  const price: ModelPrice | null = findModelPrice(usage.model);

  if (!price) {
    return {
      model: usage.model,
      costUsd: null,
      tokens: usage.totals,
      requests: usage.requests,
      unpricedTokens: 0,
      assumedPrice: false,
    };
  }

  const parts = [
    componentCost(usage.totals.input, price.inputPerMTok),
    componentCost(usage.totals.output, price.outputPerMTok),
    componentCost(usage.totals.cacheWrite5m, price.cacheWrite5mPerMTok),
    componentCost(usage.totals.cacheWrite1h, price.cacheWrite1hPerMTok),
    componentCost(usage.totals.cacheRead, price.cacheReadPerMTok),
  ];

  return {
    model: usage.model,
    costUsd: parts.reduce((sum, part) => sum + part.cost, 0),
    tokens: usage.totals,
    requests: usage.requests,
    unpricedTokens: parts.reduce((sum, part) => sum + part.unpriced, 0),
    assumedPrice: price.assumed === true,
  };
}

/** كلفة محادثة كاملة (بما فيها وكلاؤها الفرعيون بنماذجهم المستقلّة). */
export function calculateSessionCost(usage: SessionUsage): SessionCost {
  const perModel: ModelCost[] = [];
  const unpricedModels: string[] = [];
  const assumedModels: string[] = [];
  let totalUsd = 0;
  let unpricedComponentTokens = 0;

  for (const modelUsage of usage.perModel) {
    const priced = priceModelUsage(modelUsage);
    const { unpricedTokens, assumedPrice, ...cost } = priced;
    if (assumedPrice) {
      assumedModels.push(cost.model);
    }

    if (cost.costUsd === null) {
      unpricedModels.push(cost.model);
    } else {
      totalUsd += cost.costUsd;
    }

    unpricedComponentTokens += unpricedTokens;
    perModel.push(cost);
  }

  return {
    provider: usage.provider,
    totalUsd,
    perModel,
    unpricedModels,
    unpricedComponentTokens,
    assumedModels,
    complete: unpricedModels.length === 0 && unpricedComponentTokens === 0 && assumedModels.length === 0,
    subagentRequests: usage.subagentRequests,
    pricesAsOf: PRICES_AS_OF,
  };
}

/** يجمع كلفات محادثات عدّة (لقسم الاشتراكات في الإعدادات السريعة). */
export function sumSessionCosts(costs: SessionCost[]): {
  totalUsd: number;
  complete: boolean;
  unpricedModels: string[];
  assumedModels: string[];
  sessions: number;
} {
  const assumed = new Set<string>();
  const unpriced = new Set<string>();
  let totalUsd = 0;
  let complete = true;

  for (const cost of costs) {
    totalUsd += cost.totalUsd;
    if (!cost.complete) {
      complete = false;
    }
    for (const model of cost.unpricedModels) {
      unpriced.add(model);
    }
    for (const model of cost.assumedModels ?? []) {
      assumed.add(model);
    }
  }

  return {
    totalUsd,
    complete,
    unpricedModels: [...unpriced],
    assumedModels: [...assumed],
    sessions: costs.length,
  };
}
