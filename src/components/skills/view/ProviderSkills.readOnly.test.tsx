/**
 * ProviderSkills — shared skills (T-2003 part A, ADR-203 C4): read-only rows
 * hide delete and carry an origin badge; deleting an operator-shared skill
 * asks first that it is removed for everyone; a 409 read-only answer becomes a
 * plain message; a member on private files may manage their own skills.
 *
 * RUNNER: vitest (jsdom). `NODE_ENV=test` is required in this repo.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { t } = vi.hoisted(() => ({
  t: (key: string, options?: Record<string, unknown>) => (
    options && typeof options.name === 'string' ? `${key}:${options.name}` : key
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'en' } }),
}));

let role = 'owner';
vi.mock('../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'u', role } }),
}));

type Call = { url: string; method: string };
let calls: Call[] = [];
let skills: Array<Record<string, unknown>> = [];
let deleteReply: { status: number; body: unknown } = { status: 200, body: { success: true, data: {} } };

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'DELETE') {
      return { ok: deleteReply.status < 400, status: deleteReply.status, json: async () => deleteReply.body };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { provider: 'claude', skills } }) };
  }),
}));

import ProviderSkills from './ProviderSkills';

const skill = (name: string, extra: Record<string, unknown> = {}) => ({
  name, description: `${name} description`, command: `/${name}`, scope: 'user', sourcePath: `${name}/SKILL.md`, ...extra,
});

type Provider = 'claude' | 'codex' | 'cursor' | 'qwen';
// The skills cache is module-level, keyed by provider and mode: each test uses its own pair.
const renderSkills = (filesMode: 'shared' | 'private', provider: Provider) => (
  render(<ProviderSkills selectedProvider={provider} currentProjects={[]} filesMode={filesMode} />)
);

describe('ProviderSkills shared skills', () => {
  beforeEach(() => {
    role = 'owner';
    calls = [];
    skills = [];
    deleteReply = { status: 200, body: { success: true, data: {} } };
  });
  afterEach(() => cleanup());

  it('hides delete for a read-only skill and shows its origin badge', async () => {
    skills = [skill('pinned', { readOnly: true, origin: 'nassaj-shared' }), skill('mine')];
    renderSkills('shared', 'claude');
    expect(await screen.findByText('skills.origin.nassaj-shared')).toBeTruthy();
    expect(screen.getByText('skills.readOnlyHint')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'skills.delete: pinned' })).toBeNull();
    expect(screen.getByRole('button', { name: 'skills.delete: mine' })).toBeTruthy();
  });

  it('asks before deleting an operator-shared skill that it is removed for everyone', async () => {
    skills = [skill('lib', { origin: 'operator-shared' })];
    renderSkills('shared', 'codex');
    fireEvent.click(await screen.findByRole('button', { name: 'skills.delete: lib' }));
    expect(screen.getByText('skills.confirmSharedDeleteBody')).toBeTruthy();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'skills.confirmYes' }));
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
  });

  it('turns a 409 PROVIDER_SKILL_READ_ONLY answer into a plain message', async () => {
    skills = [skill('stale')];
    deleteReply = { status: 409, body: { success: false, error: { code: 'PROVIDER_SKILL_READ_ONLY', message: 'raw' } } };
    renderSkills('shared', 'cursor');
    fireEvent.click(await screen.findByRole('button', { name: 'skills.delete: stale' }));
    fireEvent.click(screen.getByRole('button', { name: 'skills.confirmYes' }));
    expect((await screen.findByRole('alert')).textContent).toBe('skills.errors.readOnly');
  });

  it('lets a member manage skills only on their private files', async () => {
    role = 'member';
    skills = [skill('own')];
    renderSkills('shared', 'qwen');
    await screen.findByText('own');
    expect(screen.queryByRole('button', { name: 'skills.addSkill' })).toBeNull();
    cleanup();
    renderSkills('private', 'claude');
    expect(await screen.findByRole('button', { name: 'skills.addSkill' })).toBeTruthy();
  });
});
