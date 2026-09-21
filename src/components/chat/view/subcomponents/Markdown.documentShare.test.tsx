import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatActionsContext, type ChatActionsContextValue } from '../../context/ChatActionsContext';
import { Markdown } from './Markdown';

vi.mock('react-i18next', async original => ({ ...await original<Record<string, unknown>>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ar' } }) }));
vi.mock('../../../document-sharing/DocumentShareButton', () => ({
  default: ({ projectId, filePath }: { projectId: string; filePath: string }) => <button data-project={projectId} data-file={filePath}>share-file</button>,
}));

const context: ChatActionsContextValue = {
  catalog: [], runAction: async () => ({ status: 'error', code: 'test' }), userRole: 'owner',
  inlineExecEnabled: true, liveStatusOf: () => null, sessionId: 'session', shareProjectId: 'trusted-project',
};
afterEach(cleanup);

describe('provider-neutral file sharing references', () => {
  it('binds a candidate to UI project context without executing anything', () => {
    const open = vi.fn();
    render(<ChatActionsContext.Provider value={{ ...context, onShareFileOpen: open }}>
      <Markdown>{'[الصفحة](docs/page.html)'}</Markdown>
    </ChatActionsContext.Provider>);
    const share = screen.getByRole('button', { name: 'share-file' });
    expect(share.getAttribute('data-project')).toBe('trusted-project');
    expect(share.getAttribute('data-file')).toBe('docs/page.html');
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة' }));
    expect(open).toHaveBeenCalledWith('docs/page.html');
  });
  it.each(['user/tool/thinking', 'streaming', 'missing-project'])('does not offer an action for %s', mode => {
    render(<ChatActionsContext.Provider value={{ ...context,
      inlineExecEnabled: mode !== 'user/tool/thinking', shareProjectId: mode === 'missing-project' ? undefined : 'p',
    }}><Markdown streaming={mode === 'streaming'}>{'[page](docs/page.html)'}</Markdown></ChatActionsContext.Provider>);
    expect(screen.queryByRole('button', { name: 'share-file' })).toBeNull();
  });
  it.each(['https://evil.test/docs/page.html', 'docs/../private.html', 'docs/page.html?project=other', '/project/docs/page.html'])('leaves ineligible links without sharing: %s', href => {
    render(<ChatActionsContext.Provider value={context}><Markdown>{`[page](${href})`}</Markdown></ChatActionsContext.Provider>);
    expect(screen.queryByRole('button', { name: 'share-file' })).toBeNull();
  });
});
