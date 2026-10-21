import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModel, toChatModelInfo } from '../src/models/catalog.ts';
import {
  EFFORT_OPTION,
  effortConfigurationSchema,
  parseEffortSupport,
  resolveEffort,
} from '../src/models/effort.ts';

// Schemas as returned by ListAvailableModels on 2026-10-21.
const CLAUDE_SCHEMA = {
  type: 'object',
  properties: {
    thinking: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['adaptive', 'disabled'] },
        display: { type: 'string', enum: ['summarized', 'omitted'] },
      },
      required: ['type'],
    },
    output_config: {
      type: 'object',
      properties: {
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
      },
    },
    max_tokens: { type: 'integer', minimum: 1024, maximum: 128000 },
  },
  additionalProperties: false,
};
const GPT_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: {
      type: 'object',
      properties: {
        effort: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
      },
    },
  },
  additionalProperties: false,
};

test('parseEffortSupport: Claude (output_config), GPT (reasoning) and models without effort', () => {
  assert.deepEqual(parseEffortSupport(CLAUDE_SCHEMA), {
    parent: 'output_config',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    default: 'high',
  });
  assert.deepEqual(parseEffortSupport(GPT_SCHEMA), {
    parent: 'reasoning',
    levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    default: 'high',
  });
  assert.equal(parseEffortSupport(undefined), undefined);
  assert.equal(parseEffortSupport({ type: 'object', properties: { thinking: {} } }), undefined);
  // a default outside the enum is ignored
  const odd = parseEffortSupport({
    properties: { reasoning: { properties: { effort: { enum: ['low', 1, ''], default: 'ultra' } } } },
  });
  assert.deepEqual(odd, { parent: 'reasoning', levels: ['low'], default: undefined });
});

test('effortConfigurationSchema: format read by the VS Code model picker', () => {
  const schema = effortConfigurationSchema(parseEffortSupport(CLAUDE_SCHEMA)!);
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      [EFFORT_OPTION]: {
        type: 'string',
        title: 'Thinking Effort',
        group: 'navigation',
        enum: ['low', 'medium', 'high', 'xhigh', 'max'],
        enumItemLabels: ['Low', 'Medium', 'High', 'Extra High', 'Max'],
        default: 'high',
      },
    },
  });
});

test('toChatModelInfo includes configurationSchema only for models with effort', () => {
  const withEffort = parseModel({ modelId: 'claude-x', additionalModelRequestFieldsSchema: CLAUDE_SCHEMA })!;
  const without = parseModel({ modelId: 'glm-x', additionalModelRequestFieldsSchema: null })!;
  assert.ok(toChatModelInfo(withEffort).configurationSchema);
  assert.equal('configurationSchema' in toChatModelInfo(without), false);
});

test('resolveEffort: precedence picker > setting > default', () => {
  const claude = parseEffortSupport(CLAUDE_SCHEMA);
  const gpt = parseEffortSupport(GPT_SCHEMA);

  assert.deepEqual(resolveEffort('claude-x', claude, { [EFFORT_OPTION]: 'max' }, { 'claude-x': 'low' }), {
    level: 'max',
    source: 'picker',
    requestFields: { output_config: { effort: 'max' } },
  });
  assert.deepEqual(resolveEffort('gpt-x', gpt, undefined, { 'gpt-x': 'none' }), {
    level: 'none',
    source: 'setting',
    requestFields: { reasoning: { effort: 'none' } },
  });
  assert.deepEqual(resolveEffort('claude-x', claude, undefined, undefined), {
    level: 'high',
    source: 'model-default',
    requestFields: {},
  });
});

test('resolveEffort: the default VS Code fills in does not override the setting', () => {
  const claude = parseEffortSupport(CLAUDE_SCHEMA);
  const r = resolveEffort('claude-x', claude, { [EFFORT_OPTION]: 'high' }, { 'claude-x': 'low' });
  assert.equal(r.level, 'low');
  assert.equal(r.source, 'setting');
  // Without a setting, the default coming from the picker is sent explicitly.
  const s = resolveEffort('claude-x', claude, { [EFFORT_OPTION]: 'high' }, {});
  assert.deepEqual(s.requestFields, { output_config: { effort: 'high' } });
});

test('resolveEffort: invalid levels and models without effort', () => {
  const claude = parseEffortSupport(CLAUDE_SCHEMA);
  // 'none' does not exist for Claude: ignored, falls back to the default
  const r = resolveEffort('claude-x', claude, { [EFFORT_OPTION]: 'none' }, { 'claude-x': 42 });
  assert.deepEqual(r, { level: 'high', source: 'model-default', requestFields: {} });
  assert.deepEqual(resolveEffort('glm-x', undefined, { [EFFORT_OPTION]: 'high' }, { 'glm-x': 'high' }), {
    source: 'model-default',
    requestFields: {},
  });
});
