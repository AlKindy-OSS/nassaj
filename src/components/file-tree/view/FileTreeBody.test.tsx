import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import en from '../../../i18n/locales/en/common.json';
import ar from '../../../i18n/locales/ar/common.json';
import FileTreeBody from './FileTreeBody';

afterEach(cleanup);

function setup(language: 'en' | 'ar' = 'en') {
  const i18n = createInstance();
  void i18n.init({
    lng: language,
    fallbackLng: 'en',
    ns: ['common'],
    defaultNS: 'common',
    resources: { en: { common: en }, ar: { common: ar } },
    initImmediate: false,
  });
  return i18n;
}

const noop = () => {};

describe('FileTreeBody', () => {
  it('shows the limit in the too-large warning when a limit is known', () => {
    render(
      <I18nextProvider i18n={setup()}>
        <FileTreeBody
          files={[]}
          filteredFiles={[]}
          searchQuery=""
          viewMode="simple"
          error="tooLarge"
          limit={10000}
          expandedDirs={new Set()}
          onItemClick={noop}
          renderFileIcon={() => null}
          formatFileSize={() => ''}
          formatRelativeTime={() => ''}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText(/10000/)).toBeTruthy();
  });

  it('falls back to the no-limit warning copy when limit is null (no "over  entries" gap)', () => {
    render(
      <I18nextProvider i18n={setup()}>
        <FileTreeBody
          files={[]}
          filteredFiles={[]}
          searchQuery=""
          viewMode="simple"
          error="tooLarge"
          limit={null}
          expandedDirs={new Set()}
          onItemClick={noop}
          renderFileIcon={() => null}
          formatFileSize={() => ''}
          formatRelativeTime={() => ''}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByText(/over\s+entries/i)).toBeNull();
    expect(screen.getByText(en.fileTree.tooLargeNoLimit)).toBeTruthy();
  });

  it('renders the Arabic no-limit warning copy under ar locale', () => {
    render(
      <I18nextProvider i18n={setup('ar')}>
        <FileTreeBody
          files={[]}
          filteredFiles={[]}
          searchQuery=""
          viewMode="simple"
          error="tooLarge"
          limit={null}
          expandedDirs={new Set()}
          onItemClick={noop}
          renderFileIcon={() => null}
          formatFileSize={() => ''}
          formatRelativeTime={() => ''}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText(ar.fileTree.tooLargeNoLimit)).toBeTruthy();
  });

  it('shows the generic load-failed warning when error is "loadFailed"', () => {
    render(
      <I18nextProvider i18n={setup()}>
        <FileTreeBody
          files={[]}
          filteredFiles={[]}
          searchQuery=""
          viewMode="simple"
          error="loadFailed"
          expandedDirs={new Set()}
          onItemClick={noop}
          renderFileIcon={() => null}
          formatFileSize={() => ''}
          formatRelativeTime={() => ''}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText(en.fileTree.loadFailed)).toBeTruthy();
  });
});
