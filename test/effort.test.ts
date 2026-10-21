import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModel, toChatModelInfo } from '../src/models/catalog.ts';
import {
  EFFORT_OPTION,
  effortConfigurationSchema,
  parseEffortSupport,
  resolveEffort,
} from '../src/models/effort.ts';

// Schemas como vieram do ListAvailableModels em 2026-10-21.
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

test('parseEffortSupport: Claude (output_config), GPT (reasoning) e modelos sem esforço', () => {
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
  // default fora do enum é ignorado
  const odd = parseEffortSupport({
    properties: { reasoning: { properties: { effort: { enum: ['low', 1, ''], default: 'ultra' } } } },
  });
  assert.deepEqual(odd, { parent: 'reasoning', levels: ['low'], default: undefined });
});

test('effortConfigurationSchema: formato lido pelo seletor do VS Code', () => {
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

test('toChatModelInfo inclui configurationSchema só para modelos com esforço', () => {
  const withEffort = parseModel({ modelId: 'claude-x', additionalModelRequestFieldsSchema: CLAUDE_SCHEMA })!;
  const without = parseModel({ modelId: 'glm-x', additionalModelRequestFieldsSchema: null })!;
  assert.ok(toChatModelInfo(withEffort).configurationSchema);
  assert.equal('configurationSchema' in toChatModelInfo(without), false);
});

test('resolveEffort: precedência seletor > setting > padrão', () => {
  const claude = parseEffortSupport(CLAUDE_SCHEMA);
  const gpt = parseEffortSupport(GPT_SCHEMA);

  assert.deepEqual(resolveEffort('claude-x', claude, { [EFFORT_OPTION]: 'max' }, { 'claude-x': 'low' }), {
    level: 'max',
    source: 'seletor',
    requestFields: { output_config: { effort: 'max' } },
  });
  assert.deepEqual(resolveEffort('gpt-x', gpt, undefined, { 'gpt-x': 'none' }), {
    level: 'none',
    source: 'setting',
    requestFields: { reasoning: { effort: 'none' } },
  });
  assert.deepEqual(resolveEffort('claude-x', claude, undefined, undefined), {
    level: 'high',
    source: 'padrão do modelo',
    requestFields: {},
  });
});

test('resolveEffort: o default que o VS Code preenche não se sobrepõe à setting', () => {
  const claude = parseEffortSupport(CLAUDE_SCHEMA);
  const r = resolveEffort('claude-x', claude, { [EFFORT_OPTION]: 'high' }, { 'claude-x': 'low' });
  assert.equal(r.level, 'low');
  assert.equal(r.source, 'setting');
  // Sem setting, o default vindo do seletor é enviado explicitamente.
  const s = resolveEffort('claude-x', claude, { [EFFORT_OPTION]: 'high' }, {});
  assert.deepEqual(s.requestFields, { output_config: { effort: 'high' } });
});

test('resolveEffort: níveis inválidos e modelos sem esforço', () => {
  const claude = parseEffortSupport(CLAUDE_SCHEMA);
  // 'none' não existe para Claude: ignorado, cai no padrão
  const r = resolveEffort('claude-x', claude, { [EFFORT_OPTION]: 'none' }, { 'claude-x': 42 });
  assert.deepEqual(r, { level: 'high', source: 'padrão do modelo', requestFields: {} });
  assert.deepEqual(resolveEffort('glm-x', undefined, { [EFFORT_OPTION]: 'high' }, { 'glm-x': 'high' }), {
    source: 'padrão do modelo',
    requestFields: {},
  });
});
