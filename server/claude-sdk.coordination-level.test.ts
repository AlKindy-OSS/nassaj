import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCliOptionsToSDK } from './claude-sdk.js';

const ENV_KEYS = {
  depth: 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
  concurrent: 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
  perSession: 'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION',
} as const;

function mappedOptions(coordinationLevel: string) {
  process.env[ENV_KEYS.depth] = '99';
  process.env[ENV_KEYS.concurrent] = '99';
  process.env[ENV_KEYS.perSession] = '99';
  try {
    return mapCliOptionsToSDK({ coordinationLevel }) as {
      env: Record<string, string>;
      systemPrompt: { append?: string };
    };
  } finally {
    delete process.env[ENV_KEYS.depth];
    delete process.env[ENV_KEYS.concurrent];
    delete process.env[ENV_KEYS.perSession];
  }
}

test('coordination level writes Claude subagent env explicitly for all supported levels', () => {
  // `delegate_review` عند 2 لا 3: افتراضُ الـCLI نفسه 3، فضبطُه عليه كان صفرَ أثر
  // ووعداً بحدٍّ لا يُفرَض. و`perSession` لا يُضبط أصلاً — لا قارئ له في الثنائية.
  const cases = [
    ['direct', '1', '20'],
    ['delegate', '1', '20'],
    ['delegate_review', '2', '20'],
  ] as const;

  for (const [level, depth, concurrent] of cases) {
    const options = mappedOptions(level);
    const env = options.env;
    assert.equal(env[ENV_KEYS.depth], depth, `${level} depth`);
    assert.equal(env[ENV_KEYS.concurrent], concurrent, `${level} concurrent`);
    // الاسمُ الذي لا يقرؤه أحد لا يُضبط — ويبقى ما ورثته البيئة ('99' هنا)
    // شاهداً على أننا لم نلمسه (درس B-548: ضبطُ اسمٍ ميّت يوهم بإنفاذٍ غير قائم).
    assert.equal(env[ENV_KEYS.perSession], '99', `${level} per-session untouched`);
    if (level === 'direct') {
      assert.match(options.systemPrompt.append ?? '', /<nassaj_document_sharing>/);
      assert.doesNotMatch(options.systemPrompt.append ?? '', /Coordination level for this turn/);
    } else {
      assert.match(options.systemPrompt.append ?? '', /delegat/i);
    }
  }
});

test('unknown coordination level fails closed to direct and does not inherit process env', () => {
  const options = mappedOptions('surprise');
  const env = options.env;
  assert.equal(env[ENV_KEYS.depth], '1');
  assert.equal(env[ENV_KEYS.concurrent], '20');
  // غيرُ مضبوط عمداً (لا قارئ له) فيبقى ما ورثته البيئة — والمقصود بـ«لا يرث»
  // هو المفتاحان اللذان نضبطهما فعلاً أعلاه، وقد أثبتناهما بقيمةٍ غير '99'.
  assert.equal(env[ENV_KEYS.perSession], '99');
  assert.match(options.systemPrompt.append ?? '', /<nassaj_document_sharing>/);
  assert.doesNotMatch(options.systemPrompt.append ?? '', /Coordination level for this turn/);
});
