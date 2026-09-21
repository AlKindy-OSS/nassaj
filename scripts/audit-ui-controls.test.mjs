#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyzeSourceSet, isAuditedPath } from './audit-ui-controls.mjs';

const scratch = mkdtempSync('/var/tmp/nassaj-ui-audit-test-');
try {
  const codeFixture = path.join(scratch, 'fixture.tsx');
  const cssFixture = path.join(scratch, 'fixture.css');
  writeFileSync(codeFixture, `
    import SharedButton from './shared/view/ui/Button';
    import { Button as PrimaryButton } from './shared/view/ui/Button';
    import { Button } from '@vendor/ui';
    export function Fixture() {
      return <>
        <PrimaryButton className="h-10 text-sm">Save</PrimaryButton>
        <SharedButton>Default import</SharedButton>
        <button className={enabled ? 'h-8 font-bold' : 'h-9'} style={{ fontSize: 13 }}>Raw</button>
        <div role="switch" className="custom-control" />
        <Button role="button">Unrelated component</Button>
        <Input className="h-11 text-base" />
        <a href="/next">Next</a>
        <div role="status">Not interactive</div>
      </>;
    }
  `, 'utf8');
  writeFileSync(cssFixture, '.custom-control { min-height: 2.5rem; line-height: 1.25rem; }', 'utf8');

  const result = analyzeSourceSet({
    ref: 'fixture',
    commit: '0123456789abcdef',
    codeFiles: [{
      file: 'src/fixture.tsx',
      content: readFileSync(codeFixture, 'utf8'),
    }],
    cssFiles: [{
      file: 'src/fixture.css',
      content: readFileSync(cssFixture, 'utf8'),
    }],
  });

  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.filesScanned, { code: 1, css: 1, total: 2 });
  assert.equal(result.counts.interactive, 6);
  assert.equal(result.counts.primitives, 2);
  assert.equal(result.counts.raw, 4);
  assert.deepEqual(result.counts.byFamily, { 'interactive-role': 2, native: 2, 'shared-button': 2 });
  assert.equal(result.counts.byHeightClass['h-10'], 1);
  assert.equal(result.counts.byHeightClass['h-8'], 1);
  assert.equal(result.counts.byHeightClass['h-9'], 1);
  assert.equal(result.counts.byTypeClass['text-sm'], 1);
  assert.equal(result.counts.byTypeClass['font-bold'], 1);
  assert.equal(result.counts.violationsByRule['raw-interactive-control'], 4);
  assert.equal(result.counts.violationsByRule['direct-typography-style'], 1);
  assert.equal(result.counts.violationsByRule['css-class-height'], 1);
  assert.equal(result.counts.violationsByRule['css-class-typography'], 1);
  assert.equal(result.interactiveNodes.find(({ role }) => role === 'switch').cssMatches.length, 1);
  assert.equal(result.interactiveNodes.some(({ element }) => element === 'Input'), false);
  assert.equal(result.primitiveNodes.some(({ element }) => element === 'Button'), false);
  assert.equal(result.rawNodes.some(({ element }) => element === 'Button'), true);
  assert.equal(result.rawNodes.some(({ element }) => element === 'PrimaryButton'), false);
  assert.equal(result.rawNodes.some(({ element }) => element === 'SharedButton'), false);
  assert.equal(result.violations.some(({ element, rule }) => element === 'PrimaryButton' && rule.startsWith('raw-')), false);
  assert.equal(result.violations.some(({ element, rule }) => element === 'SharedButton' && rule.startsWith('raw-')), false);
  assert.equal(result.rawNodes.some(({ element }) => element === 'button'), true);
  assert.match(result.approvedComponentPolicy.rawDefinition, /never overlap/);
  assert.ok(result.analysisLimits.length >= 4);

  const implementation = analyzeSourceSet({
    codeFiles: [{
      file: 'src/shared/view/ui/Button.tsx',
      content: 'export const Button = () => <button type="button">Approved implementation</button>;',
    }],
  });
  assert.equal(implementation.counts.interactive, 1);
  assert.equal(implementation.counts.primitives, 0);
  assert.equal(implementation.counts.raw, 0);
  assert.equal(implementation.interactiveNodes[0].approval, 'shared-button-implementation');
  assert.equal(implementation.counts.violationsByRule['raw-interactive-control'], undefined);

  assert.equal(isAuditedPath('src/components/Thing.tsx'), true);
  assert.equal(isAuditedPath('src/components/Thing.test.tsx'), false);
  assert.equal(isAuditedPath('src/components/__tests__/Thing.tsx'), false);
  assert.equal(isAuditedPath('src/generated/Thing.tsx'), false);
  assert.equal(isAuditedPath('server/Thing.tsx'), false);
  assert.equal(isAuditedPath('src/theme.css'), true);

  console.log('audit-ui-controls tests passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
