/**
 * modelPickerRows.ts — one row per RUNNABLE COMBINATION, with its engine named
 * on the row (B-245, owner decision 2026-07-28).
 *
 * ADR-073 describes a run as `{ body, engine, model }`. The picker used to show
 * only the body axis, with the engine axis bolted on as two extra groups after
 * every body — so "Claude engine on GLM" was the ninth of nine groups, below the
 * fold, and the owner reported it missing while the settings screen said it was
 * present. Both readings were true.
 *
 * Worse, the same engine surfaced under several names. Five rows read "GLM" for
 * three different runs: opencode's paid Zen route (`opencode/glm-5.2`), our
 * governed carrier through opencode (`glm/glm-5.2`), and the Claude body pointed
 * at z.ai (`glm-5.2` under the engine group). Only a parenthesis told them
 * apart — and that parenthesis exists solely because B-219 had to stop two of
 * them rendering identically.
 *
 * The fix is not more disambiguation, it is stating the second axis outright:
 * every row carries a sentence naming the endpoint that will answer it and what
 * it costs the operator. Rows stay grouped by BODY because the body is what
 * actually differs for the user — its tools, permissions and sessions — while
 * the engine only changes who generates the tokens.
 *
 * Pure and DOM-free so the row set is unit-tested without cmdk or React.
 */

import {
  ELIGIBLE_ENGINE_PROVIDERS,
  engineProviderHost,
  engineProviderLabel,
  type EligibleEngineProviderId,
} from '../../../../../shared/engineProviders';
import { engineKeySlot, type EngineAxisId } from '../../../../../shared/bodyEngineMatrix';
import { vendorForSlot } from '../../../../../shared/vendors';
import type { LLMProvider, ProviderModelOption, ProviderModelsDefinition } from '../../../../types/app';

/** One selectable line in the picker. */
export type PickerRow = {
  /** Stable react key. Unique across the whole picker. */
  key: string;
  /** The model id that goes on the wire for this body. */
  model: string;
  label: string;
  /** The catalog's own description line, if any. */
  description?: string;
  /**
   * i18n key + interpolation for the sentence naming the engine. Kept as data
   * rather than a rendered string so the component owns translation.
   */
  engine: { key: string; vars: Record<string, string> };
  /**
   * The engine to pin when this row is picked, or null for the body's own
   * engine. Only ever set on Claude rows — ADR-073 §4 forbids launching another
   * body on a custom engine before that body's config guard exists.
   */
  engineProvider: EligibleEngineProviderId | null;
  /** No key stored: selecting opens settings instead of choosing a model. */
  locked: boolean;
  /**
   * أين يُدخَل مفتاح هذا الصفّ فعلاً — على الصفوف المقفولة وحدها (B-413).
   *
   * الصفّ المقفول يَعِد بحقلٍ عند الضغط، فالوجهة جزءٌ من الوعد لا تفصيلُ عرض.
   */
  credentialDestination?: CredentialDestination;
  /**
   * وضع الاتصال المكتشَف لهذا المزوّد: مفتاح API، اشتراك OAuth، أو الاثنان.
   * يُعرض بجانب اسم النموذج كشارة توضيحية.
   */
  authMode?: 'api_key' | 'subscription_oauth' | 'both' | null;
};

/**
 * أين تُدخَل قيمةُ اعتمادٍ ينقص — **الشركةُ تُسمّى، والمنزل واحد** (‏B-413 ثم
 * T-1219).
 *
 * العطل الذي أوجب هذه الدالّة: الصفّ المقفول تحت مجموعة Claude كان يرسل
 * `{ agent: 'claude', category: 'account' }`، أي **الجسم** الذي يظهر الصفّ تحته.
 * فمن ضغط «أضف مفتاح GLM» هبط على صفحةٍ لا حقلَ فيها لـZ.AI ولا رسالةَ تقول أين
 * ذهب. والاعتماد ليس ملكَ الجسم الذي يصرفه أصلاً: هو ملكُ **شركته**.
 *
 * وT-1219 أنهى نصف السؤال: لم يعد للشركة «منزلٌ» يُحسب — كلُّ حقلٍ في تبويب
 * «المورّدون والاعتمادات» وحده. فبقي من هذا النوع ما يُفيد فعلاً: **أيّ شركة**،
 * وهو ما يتحقّق به الحارس أن الوجهة المُعلَنة تحمل حقلها بالفعل. وحقلُ `agent`
 * سقط لأنه كان يحمل جواباً صار ثابتاً — وحقلٌ ثابتٌ في نوع هو دعوةٌ إلى أن يقرأه
 * سطحٌ ثالث ويخالفه.
 */
export type CredentialDestination = {
  /** الشركة المالكة للمفتاح — بها يتحقّق الحارس أن الوجهة تحمل حقلها فعلاً. */
  companyId: string;
};

/** الوجهة لموضع اعتمادٍ بعينه، أو `null` حين لا موضع لهذا المفتاح أصلاً. */
export function destinationForSlot(
  slot: { provider: string; target?: string } | null,
): CredentialDestination | null {
  if (!slot) return null;
  const vendor = vendorForSlot(slot.provider, slot.target);
  if (!vendor) return null;
  return { companyId: vendor.companyId };
}

/** الوجهة لزوج (جسم × محرّك) — نفس مسار لوح المحرّكات: الموضع ثم الشركة ثم منزلها. */
export function engineCredentialDestination(
  body: string,
  engine: string,
): CredentialDestination | null {
  return destinationForSlot(engineKeySlot(body, engine as EngineAxisId));
}

/**
 * الوجهة لمجموعةِ جسمٍ مقفولة (زرّ «أضف مفتاح <المزوّد>» فوق صفوف المجموعة):
 * موضعُ الجسم نفسه هو `{provider: body}`، وشركتُه هي التي تُسأل عن منزلها. فمجموعة
 * `glm` المقفولة — لو ظهرت — تقود إلى حساب OpenCode لا إلى صفحةٍ بلا بلاطة.
 */
export function bodyCredentialDestination(body: string): CredentialDestination | null {
  return destinationForSlot({ provider: body });
}

/**
 * Upstream provider prefixes inside opencode's own catalog (`provider/slug`).
 * `glm` is OUR governed carrier block in opencode.json, so it resolves to the
 * z.ai host and the operator's own key; `opencode` is Zen, which bills against a
 * balance (`opencode/glm-5.2` answers 401 "No payment method" without one —
 * measured, and the reason B-219 had to qualify the labels at all).
 */
const OPENCODE_UPSTREAM = {
  glm: { key: 'yourKey', vars: () => ({ host: engineProviderHost('glm') ?? 'z.ai' }) },
  opencode: { key: 'zen', vars: () => ({}) },
} as const;

/** The engine sentence for a body's own, native engine. */
const NATIVE_ENGINE: Partial<Record<LLMProvider, { key: string; vars: Record<string, string> }>> = {
  claude: { key: 'subscription', vars: { engine: 'Anthropic' } },
  codex: { key: 'subscription', vars: { engine: 'OpenAI' } },
  cursor: { key: 'subscription', vars: { engine: 'Cursor' } },
  antigravity: { key: 'subscription', vars: { engine: 'Antigravity' } },
  hermes: { key: 'subscription', vars: { engine: 'Nous' } },
  kimi: { key: 'native', vars: { engine: 'Moonshot' } },
};

const splitOpenCodeId = (id: string): { upstream: string; slug: string } => {
  const at = id.indexOf('/');
  return at < 0 ? { upstream: '', slug: id } : { upstream: id.slice(0, at), slug: id.slice(at + 1) };
};

/** The engine descriptor for one model id under one body. */
function engineFor(
  body: LLMProvider,
  modelId: string,
  authMode?: 'api_key' | 'subscription_oauth' | 'both' | null,
): PickerRow['engine'] {
  if (body === 'opencode') {
    const { upstream } = splitOpenCodeId(modelId);
    if (/^nassaj_local_[a-f0-9]{32}$/.test(upstream)) {
      return { key: 'local', vars: {} };
    }
    const known = OPENCODE_UPSTREAM[upstream as keyof typeof OPENCODE_UPSTREAM];
    if (known) {
      return { key: known.key, vars: known.vars() };
    }
    // An upstream we have not characterised: name it and claim nothing else.
    return { key: 'upstream', vars: { engine: upstream || 'opencode' } };
  }

  // kimi has TWO paths: subscription (Kimi Code OAuth) and API key. The
  // static `native` label hid that difference — now the mode decides.
  if (body === 'kimi' && authMode) {
    if (authMode === 'subscription_oauth' || authMode === 'both') {
      return { key: 'subscription', vars: { engine: 'Kimi Code' } };
    }
    return { key: 'apiKey', vars: { engine: 'Moonshot' } };
  }

  return NATIVE_ENGINE[body] ?? { key: 'upstream', vars: { engine: body } };
}

/**
 * Rows for one body.
 *
 * For the Claude body the engine axis is folded in HERE rather than appended as
 * a separate group: its own models first, then one block per eligible engine
 * (ADR-073 `ELIGIBLE_ENGINE_PROVIDERS`) — the engine's models when a key is
 * stored, or a single locked row pointing at settings when it is not.
 *
 * @param body the group being rendered.
 * @param catalog per-provider model catalogs (live or embedded fallback).
 * @param keyStatuses which engines have a stored key.
 */
export function rowsForBody(
  body: LLMProvider,
  catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>,
  keyStatuses: Partial<Record<string, boolean>>,
  authModes?: Partial<Record<string, 'api_key' | 'subscription_oauth' | 'both' | null>>,
): PickerRow[] {
  const own: ProviderModelOption[] = catalog[body]?.OPTIONS ?? [];
  const bodyAuthMode = authModes?.[body];
  const rows: PickerRow[] = own.map((option) => ({
    key: `${body}:${option.value}`,
    model: option.value,
    label: option.label,
    description: option.description === 'local' ? undefined : option.description,
    engine: engineFor(body, option.value, bodyAuthMode),
    engineProvider: null,
    locked: false,
    authMode: bodyAuthMode ?? undefined,
  }));

  if (body !== 'claude') {
    return rows;
  }

  for (const engine of ELIGIBLE_ENGINE_PROVIDERS) {
    const name = engineProviderLabel(engine);
    const host = engineProviderHost(engine) ?? name;

    if (!keyStatuses[engine]) {
      rows.push({
        key: `claude:engine:${engine}:locked`,
        model: '',
        label: name,
        engine: { key: 'needsKey', vars: { engine: name, host } },
        engineProvider: engine,
        locked: true,
        // ‏B-413 — الوجهة تُحمَل على الصفّ لا تُستنتج عند الضغط: هذا الصفّ نفسه هو
        // ما يَعِد بحقلٍ، فالوعد والوجهة يُولدان معاً أو يكذب أحدهما على الآخر.
        credentialDestination: engineCredentialDestination(body, engine) ?? undefined,
      });
      continue;
    }

    for (const option of catalog[engine]?.OPTIONS ?? []) {
      rows.push({
        key: `claude:engine:${engine}:${option.value}`,
        model: option.value,
        label: option.label,
        description: option.description,
        engine: { key: 'yourKey', vars: { host } },
        engineProvider: engine,
        locked: false,
      });
    }
  }

  return rows;
}
