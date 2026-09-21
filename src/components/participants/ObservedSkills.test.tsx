import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { ThemeProvider } from '../../contexts/ThemeContext';
import en from '../../i18n/locales/en/chat.json';
import ar from '../../i18n/locales/ar/chat.json';

import SessionAgentsChip from './SessionAgentsChip';
import { ObservedSkillCount, ProjectSkillsSection, SessionSkillsSection } from './ObservedSkills';
import { observation, projection } from './skillObservations.fixtures';
import type { SessionSkillsState } from './useSessionSkills';

import AgentStatusCard from '../chat/view/subcomponents/AgentStatusCard';

import { attachObservedSkills } from './skillObservationHelpers';

afterEach(cleanup);
function setup(language = 'en') {
  const i18n = createInstance();
  void i18n.init({ lng: language, fallbackLng: 'en', ns: ['chat'], defaultNS: 'chat', resources: { en: { chat: en }, ar: { chat: ar } }, initImmediate: false });
  return i18n;
}
const state = (): SessionSkillsState => ({ projection: projection(), status: 'ready', stale: false, refresh: vi.fn() });

describe('observed skills disclosure', () => {
  it('renders different skills under two same-role live agent instances', () => {
    const i18n = setup();
    const data = projection([observation(), observation({ id: 'event-2', actorToolCallId: 'call-2', skillKey: 'skill-2', skillName: 'security-review' })]);
    const agents = attachObservedSkills(['call-1', 'call-2'].map(id => ({ id, type: 'backend-dev', description: id, status: 'running' as const, callCount: 0, startedAt: 0 })), data);
    render(<I18nextProvider i18n={i18n}><ThemeProvider><AgentStatusCard agents={agents} status={{ text: 'Working' }} isLoading provider="claude" /></ThemeProvider></I18nextProvider>);
    const triggers = screen.getAllByRole('button', { name: /backend-dev.*observed skills/ });
    expect(triggers).toHaveLength(2);
    fireEvent.click(triggers[0]);
    const firstPanel = document.getElementById(triggers[0].getAttribute('aria-controls')!)!;
    expect(within(firstPanel).getByText('diagnosing-bugs')).toBeTruthy();
    expect(within(firstPanel).queryByText('security-review')).toBeNull();
    fireEvent.click(triggers[1]);
    const secondPanel = document.getElementById(triggers[1].getAttribute('aria-controls')!)!;
    expect(within(secondPanel).getByText('security-review')).toBeTruthy();
    expect(within(secondPanel).queryByText('diagnosing-bugs')).toBeNull();
  });
  it('keeps skills reachable without models and returns focus after Escape', () => {
    const i18n = setup();
    render(<I18nextProvider i18n={i18n}><ThemeProvider><SessionAgentsChip agents={[]} skills={state()} t={i18n.t} dir="rtl" /></ThemeProvider></I18nextProvider>);
    const trigger = screen.getByRole('button');
    // The count belongs to the panel, not the chip: the chip stays the model name alone.
    expect(trigger.textContent).not.toContain('observed skills');
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Participants and skills' });
    expect(dialog.getAttribute('dir')).toBe('rtl');
    expect(within(dialog).getByText('diagnosing-bugs')).toBeTruthy();
    expect(within(dialog).queryByText('Models')).toBeNull();
    expect(dialog.querySelector('button button')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it('preserves the answering model when skill observations are unsupported', () => {
    const i18n = setup();
    render(<I18nextProvider i18n={i18n}><ThemeProvider><SessionAgentsChip agents={[{ agent_name: 'gpt-6-astra', agent_kind: 'model', invocation_count: 1 }]} skills={{ ...state(), status: 'unsupported', projection: null }} t={i18n.t} dir="ltr" /></ThemeProvider></I18nextProvider>);
    expect(screen.getByRole('button').textContent).toContain('gpt-6-astra');
    expect(screen.getByRole('button').textContent).not.toContain('observed skills');
    fireEvent.click(screen.getByRole('button'));
    // Unsupported coverage has no count to show; the panel states that instead.
    expect(within(screen.getByRole('dialog')).getByText(/not supported by this server or provider/)).toBeTruthy();
  });
  it('lists each skill once like a tool row, without raw evidence', () => {
    const i18n = setup();
    const data = projection([observation(), observation({ id: 'event-2', evidence: 'invocation', outcome: 'failed' })]);
    render(<I18nextProvider i18n={i18n}><SessionSkillsSection state={{ ...state(), projection: data }} /></I18nextProvider>);
    // Both events share skill-1: one row, marked used because the read succeeded.
    expect(screen.getAllByText('diagnosing-bugs')).toHaveLength(1);
    expect(screen.getByLabelText('Succeeded')).toBeTruthy();
    expect(screen.queryByText('skill-1')).toBeNull();
    expect(document.querySelector('time')).toBeNull();
  });
  it('marks a skill whose only invocations failed and counts repeats', () => {
    const i18n = setup();
    const failed = { evidence: 'invocation' as const, outcome: 'failed' as const };
    const data = projection([observation({ id: 'e1', ...failed }), observation({ id: 'e2', ...failed })]);
    render(<I18nextProvider i18n={i18n}><SessionSkillsSection state={{ ...state(), projection: data }} /></I18nextProvider>);
    expect(screen.getByLabelText('Failed')).toBeTruthy();
    expect(screen.getByText('×2')).toBeTruthy();
  });
  it('hides observed-skills label and section when agent has zero observed skills', () => {
    const i18n = setup();
    const data = projection([]);
    const agents = attachObservedSkills([{ id: 'call-1', type: 'backend-dev', description: 'call-1', status: 'done' as const, callCount: 0, startedAt: 0 }], data);
    render(<I18nextProvider i18n={i18n}><ThemeProvider><AgentStatusCard agents={agents} status={{ text: 'Done' }} isLoading={false} provider="claude" /></ThemeProvider></I18nextProvider>);
    // Row trigger must NOT mention observed skills
    const trigger = screen.getByRole('button', { name: /backend-dev/ });
    expect(trigger.getAttribute('aria-label')).not.toMatch(/observed skills/i);
    // Expand the row and confirm no skills section appears
    fireEvent.click(trigger);
    const panelId = trigger.getAttribute('aria-controls')!;
    const panel = document.getElementById(panelId)!;
    expect(within(panel).queryByText(/observed skills/i)).toBeNull();
  });
  it('uses localized Arabic numbers and explicit partial coverage', () => {
    const i18n = setup('ar'); const data = projection(); data.coverage.state = 'partial';
    render(<I18nextProvider i18n={i18n}><ObservedSkillCount count={2} coverage={data.coverage} /></I18nextProvider>);
    expect(screen.getByText('٢ مهارات مرصودة · رصد جزئي')).toBeTruthy();
  });
  it('keeps cold project cache unavailable rather than reporting zero usage', () => {
    const i18n = setup(); const data = projection([]); data.coverage.state = 'unavailable';
    render(<I18nextProvider i18n={i18n}><ProjectSkillsSection skills={{ ...data, rows: [], eligibleSessions: 10, scannedSessions: 0, partialSessions: 0, unavailableSessions: 10 }} /></I18nextProvider>);
    expect(screen.getByText('Observation data unavailable')).toBeTruthy();
    expect(screen.queryByText('Successful instruction reads: 0')).toBeNull();
  });
});
