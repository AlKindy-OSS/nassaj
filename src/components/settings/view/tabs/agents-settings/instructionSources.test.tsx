/**
 * instructionSources.test.tsx — «من أين يأخذ هذا الوكيل تعليماته» (ADR-093 §2، T-1195).
 *
 * يختبر ما يراه المالك فعلاً على الشاشة، لا شكل البيانات وحدها:
 *  - القنوات تُعرض بمسارها الحقيقي، وبهدف الرابط حين تكون رابطاً (حقيقة أمنية
 *    لا تفصيل تجميلي — §1.2/§6-3)؛
 *  - «محكوم» لا تُقال لقناة تحقُّقُها حضورٌ فقط: كلود تُعرَض «حاضر بلا تحقّق
 *    هوية» (§2.3-2)؛
 *  - kimi تُعلن آليتها وفرضها الحاجب بعد تصحيح §2.3-1؛
 *  - لكل سبب من الأسباب جملةٌ خاصّة به — «غير محكوم» وحدها لا تُترك للمالك؛
 *  - محرّك بلا آلية يُقال عنه ذلك صراحةً بلا صفوف فارغة (§2.4)؛
 *  - خادمٌ أقدم من T-1195 (لا `sources`) ⇒ لا يُرسم اللوح: غيابُ الجواب إخفاءٌ
 *    لا حكم — وهو نفس عقد الشارة القائمة (توافق خلفي).
 *
 * الحمولات مشتقّة من مخرَج الخدمة الحقيقي (نفس أسماء الحقول وقيمها)، و`t` يُحلّ
 * على `en/settings.json` الحقيقي فينكشف أي مفتاح ناقص هنا لا في الإنتاج.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enSettings from '../../../../../i18n/locales/en/settings.json';

function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    enSettings,
  );
  return typeof value === 'string' ? value : undefined;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      lookup(key) ?? (opts?.defaultValue as string) ?? key,
    i18n: { language: 'en' },
  }),
}));

/** The governance payload the mocked endpoint answers with (per test). */
let responder: (url: string, init?: RequestInit) => { ok: boolean; body?: unknown } =
  () => ({ ok: false });
/** Every call the panel makes, so the POST target and method are asserted, not assumed. */
const calls: Array<{ url: string; method: string }> = [];

vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    const { ok, body } = responder(url, init);
    return { ok, json: async () => body } as unknown as Response;
  }),
}));

import InstructionSourcesContent from './sections/content/InstructionSourcesContent';

type Channel = Record<string, unknown>;

function envelope(provider: string, extra: Record<string, unknown>, sources?: Channel[]) {
  return {
    success: true,
    data: { provider, status: 'ungoverned', enforced: false, mechanism: 'none', ...extra, sources },
  };
}

/** A codex-shaped fingerprint channel; overridable per case. */
function codexChannel(overrides: Channel = {}): Channel {
  const channel: Channel = {
    id: 'codex-home',
    scope: 'user',
    path: '/workspace/users/3/.codex/AGENTS.md',
    link: null,
    mechanism: 'codex-fingerprint',
    verification: 'fingerprint',
    enforcement: 'fail-closed',
    status: 'governed',
    reason: null,
    linkable: true,
    linkScope: 'user',
    linkRefusal: null,
    ...overrides,
  };
  // `undefined` in an override MEANS "the server omitted this field" — strip it so
  // the payload really lacks the key instead of carrying an undefined one.
  for (const [key, value] of Object.entries(channel)) {
    if (value === undefined) delete channel[key];
  }
  return channel;
}

/** Lets the hook's fetch promise chain settle before asserting on "nothing rendered". */
async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

beforeEach(() => {
  responder = () => ({ ok: false });
  calls.length = 0;
});

afterEach(cleanup);

describe('backward compatibility — the panel never guesses', () => {
  it('renders nothing when the server predates T-1195 (no sources field)', async () => {
    responder = () => ({
      ok: true,
      body: envelope('codex', { status: 'governed', enforced: true, mechanism: 'codex-fingerprint' }),
    });
    const { container } = render(<InstructionSourcesContent agent="codex" />);
    await flush();
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing on a 404 / network failure (fail-HIDDEN, as the badge)', async () => {
    responder = () => ({ ok: false });
    const { container } = render(<InstructionSourcesContent agent="codex" />);
    await flush();
    expect(container.innerHTML).toBe('');
  });

  it('drops a malformed channel rather than rendering it with holes', async () => {
    responder = () => ({
      ok: true,
      body: envelope('codex', { mechanism: 'codex-fingerprint' }, [
        { id: 'codex-home', scope: 'user' } as Channel,
      ]),
    });
    const { container } = render(<InstructionSourcesContent agent="codex" />);
    await flush();
    expect(container.innerHTML).toBe('');
  });
});

describe('a governed fingerprint channel shows the path, the mechanism and the enforcement', () => {
  it('renders the reported path as isolated LTR monospace technical text', async () => {
    responder = () => ({
      ok: true,
      body: envelope(
        'codex',
        { status: 'governed', enforced: true, mechanism: 'codex-fingerprint' },
        [codexChannel()],
      ),
    });
    render(<InstructionSourcesContent agent="codex" />);

    const path = await screen.findByText('/workspace/users/3/.codex/AGENTS.md');
    expect(path.getAttribute('dir')).toBe('ltr');
    expect(path.className).toContain('font-mono');
    expect(path.style.unicodeBidi).toBe('isolate');

    expect(screen.getByText(lookup('agents.instructionSources.verdict.governed')!)).toBeTruthy();
    expect(
      screen.getByText(lookup('agents.instructionSources.enforcement.fail-closed')!),
    ).toBeTruthy();
    expect(
      screen.getByText(lookup('agents.instructionSources.verification.fingerprint')!),
    ).toBeTruthy();
  });
});

describe('ADR-093 §2.3-2 — claude is present-but-unverified, never plain "governed"', () => {
  it('says "present, identity unverified" and names the symlink target', async () => {
    responder = () => ({
      ok: true,
      body: envelope('claude', { status: 'governed', mechanism: 'claude-md' }, [
        {
          id: 'claude-home',
          scope: 'user',
          path: '/workspace/users/2/.claude/CLAUDE.md',
          link: '/workspace/governance/NASSAJ.md',
          mechanism: 'claude-md',
          verification: 'presence',
          enforcement: 'informational',
          status: 'governed',
          reason: null,
        },
      ]),
    });
    render(<InstructionSourcesContent agent="claude" />);

    expect(
      await screen.findByText(lookup('agents.instructionSources.verdict.presentUnverified')!),
    ).toBeTruthy();
    expect(screen.queryByText(lookup('agents.instructionSources.verdict.governed')!)).toBeNull();
    // The link is a security fact: it must be on screen, not folded away.
    expect(screen.getByText('/workspace/governance/NASSAJ.md')).toBeTruthy();
    expect(screen.getByText(lookup('agents.instructionSources.field.linkNote')!)).toBeTruthy();
    expect(
      screen.getByText(lookup('agents.instructionSources.enforcement.informational')!),
    ).toBeTruthy();
  });
});

describe('ADR-093 §2.3-1 — kimi declares its fail-closed channel', () => {
  it('shows the KIMI_CODE_HOME copy, its fingerprint check and the blocking enforcement', async () => {
    responder = () => ({
      ok: true,
      body: envelope('kimi', { status: 'governed', enforced: true, mechanism: 'kimi-agents' }, [
        codexChannel({
          id: 'kimi-home',
          mechanism: 'kimi-agents',
          path: '/workspace/users/3/.kimi/AGENTS.md',
        }),
      ]),
    });
    render(<InstructionSourcesContent agent="kimi" />);

    expect(await screen.findByText('/workspace/users/3/.kimi/AGENTS.md')).toBeTruthy();
    expect(screen.getByText(lookup('agents.instructionSources.mechanism.kimi-agents')!)).toBeTruthy();
    expect(
      screen.getByText(lookup('agents.instructionSources.enforcement.fail-closed')!),
    ).toBeTruthy();
  });
});

describe('ADR-093 §2.2 — every reason gets its own sentence, none is left as "ungoverned"', () => {
  const REASONS = [
    'source_absent',
    'copy_missing',
    'copy_empty',
    'symlink_rejected',
    'drifted',
    'project_unresolved',
  ] as const;

  for (const reason of REASONS) {
    it(`explains ${reason}`, async () => {
      responder = () => ({
        ok: true,
        body: envelope('codex', { mechanism: 'codex-fingerprint' }, [
          codexChannel({ status: 'ungoverned', reason }),
        ]),
      });
      render(<InstructionSourcesContent agent="codex" />);

      expect(
        await screen.findByText(lookup('agents.instructionSources.verdict.ungoverned')!),
      ).toBeTruthy();
      const sentence = lookup(`agents.instructionSources.reason.${reason}`)!;
      expect(sentence).toBeTruthy();
      expect(screen.getByText(sentence)).toBeTruthy();
    });
  }

  it('no_mechanism is a sentence, not a grey badge with empty rows (§2.4)', async () => {
    responder = () => ({
      ok: true,
      body: envelope('hermes', {}, [
        {
          id: 'none',
          scope: 'user',
          path: null,
          link: null,
          mechanism: 'none',
          verification: 'none',
          enforcement: 'none',
          status: 'ungoverned',
          reason: 'no_mechanism',
        },
      ]),
    });
    render(<InstructionSourcesContent agent="hermes" />);

    expect(
      await screen.findByText(lookup('agents.instructionSources.reason.no_mechanism')!),
    ).toBeTruthy();
    expect(screen.queryByText(lookup('agents.instructionSources.field.path')!)).toBeNull();
  });
});

describe('ADR-093 §2.3-3 — agy shows both channels', () => {
  it('lists the home GEMINI.md and the project channel with its own scope and enforcement', async () => {
    responder = () => ({
      ok: true,
      body: envelope('antigravity', { status: 'governed', mechanism: 'gemini-md' }, [
        {
          id: 'agy-home',
          scope: 'user',
          path: '/workspace/users/sample/.gemini/GEMINI.md',
          link: '/workspace/governance/GEMINI.md',
          mechanism: 'gemini-md',
          verification: 'presence',
          enforcement: 'best-effort',
          status: 'governed',
          reason: null,
        },
        {
          id: 'agy-project',
          scope: 'project',
          path: null,
          link: null,
          mechanism: 'nassaj-project-md',
          verification: 'none',
          enforcement: 'informational',
          status: 'ungoverned',
          reason: 'project_unresolved',
        },
      ]),
    });
    render(<InstructionSourcesContent agent="antigravity" />);

    expect(await screen.findByText(lookup('agents.instructionSources.channel.user')!)).toBeTruthy();
    expect(screen.getByText(lookup('agents.instructionSources.channel.project')!)).toBeTruthy();
    expect(
      screen.getByText(lookup('agents.instructionSources.enforcement.best-effort')!),
    ).toBeTruthy();
    expect(
      screen.getByText(lookup('agents.instructionSources.mechanism.nassaj-project-md')!),
    ).toBeTruthy();
    // No path was read for the project channel — say so, do not invent one.
    expect(screen.getByText(lookup('agents.instructionSources.field.noPath')!)).toBeTruthy();
  });
});

describe('ADR-093 §4 (T-1197) — the link action', () => {
  /** A channel the SERVER says this caller may establish. */
  const linkable = (overrides: Channel = {}): Channel =>
    codexChannel({
      status: 'ungoverned',
      reason: 'copy_missing',
      linkable: true,
      linkScope: 'user',
      linkRefusal: null,
      ...overrides,
    });

  it('POSTs to the provider\'s own link route and then RE-READS the verdict from the server', async () => {
    // The whole point: the panel must not paint "done" from a 200. It re-fetches,
    // and what it shows is whatever the second GET says the disk holds.
    let linked = false;
    responder = (url, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        linked = true;
        return { ok: true, body: envelope('codex', { mechanism: 'codex-fingerprint' }, []) };
      }
      return {
        ok: true,
        body: envelope('codex', { mechanism: 'codex-fingerprint' }, [
          linked
            ? linkable({ status: 'governed', reason: null })
            : linkable(),
        ]),
      };
    };

    render(<InstructionSourcesContent agent="codex" />);
    const button = await screen.findByRole('button', {
      name: lookup('agents.instructionSources.link.button')!,
    });
    expect(screen.getByText(lookup('agents.instructionSources.verdict.ungoverned')!)).toBeTruthy();

    fireEvent.click(button);

    expect(
      await screen.findByText(lookup('agents.instructionSources.verdict.governed')!),
    ).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/providers/codex/governance/link'))
      .toBe(true);
    // A re-read must have happened AFTER the write.
    const postIndex = calls.findIndex((c) => c.method === 'POST');
    expect(calls.slice(postIndex + 1).some((c) => c.method === 'GET')).toBe(true);
  });

  it('a failed link says so and leaves the verdict exactly as it was', async () => {
    responder = (_url, init) =>
      (init?.method ?? 'GET').toUpperCase() === 'POST'
        ? { ok: false }
        : {
          ok: true,
          body: envelope('codex', { mechanism: 'codex-fingerprint' }, [linkable()]),
        };

    render(<InstructionSourcesContent agent="codex" />);
    fireEvent.click(
      await screen.findByRole('button', { name: lookup('agents.instructionSources.link.button')! }),
    );

    expect(await screen.findByText(lookup('agents.instructionSources.link.failed')!)).toBeTruthy();
    expect(screen.getByText(lookup('agents.instructionSources.verdict.ungoverned')!)).toBeTruthy();
    expect(screen.queryByText(lookup('agents.instructionSources.link.rechecked')!)).toBeNull();
  });

  it('a server refusal renders its SENTENCE and no button at all (never a disabled one)', async () => {
    for (const refusal of [
      'symlink_by_design',
      'shared_source_is_the_file',
      'project_scoped',
      'owner_required',
    ] as const) {
      responder = () => ({
        ok: true,
        body: envelope('codex', { mechanism: 'codex-fingerprint' }, [
          codexChannel({ linkable: false, linkScope: null, linkRefusal: refusal }),
        ]),
      });
      const view = render(<InstructionSourcesContent agent="codex" />);
      expect(
        await screen.findByText(lookup(`agents.instructionSources.linkRefusal.${refusal}`)!),
      ).toBeTruthy();
      expect(screen.queryAllByRole('button')).toHaveLength(0);
      view.unmount();
    }
  });

  it('offers no button when the server omits the link fields (a T-1195-only server)', async () => {
    responder = () => ({
      ok: true,
      body: envelope('codex', { status: 'governed', mechanism: 'codex-fingerprint' }, [
        codexChannel({ linkable: undefined, linkScope: undefined, linkRefusal: undefined }),
      ]),
    });
    render(<InstructionSourcesContent agent="codex" />);
    // The channel is still described — only the affordance is absent.
    expect(await screen.findByText('/workspace/users/3/.codex/AGENTS.md')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
