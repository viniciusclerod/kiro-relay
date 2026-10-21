// Reasoning effort per model. Pure module: no vscode.
//
// The Kiro catalog describes each model's extra fields in additionalModelRequestFieldsSchema.
// Observed on 2026-10-21: Claude uses `output_config.effort`, GPT uses `reasoning.effort`.

/** Option key in the VS Code configurationSchema (shown in the model picker). */
export const EFFORT_OPTION = 'reasoningEffort';

const EFFORT_PARENTS = ['output_config', 'reasoning'] as const;
export type EffortParent = (typeof EFFORT_PARENTS)[number];

export interface EffortSupport {
  /** Where the level goes in additionalModelRequestFields. */
  parent: EffortParent;
  levels: string[];
  /** The backend's default for the model, if given. */
  default?: string;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Extracts the effort levels from additionalModelRequestFieldsSchema, if any. */
export function parseEffortSupport(schema: Record<string, unknown> | undefined): EffortSupport | undefined {
  const props = obj(schema?.properties);
  if (!props) return undefined;
  for (const parent of EFFORT_PARENTS) {
    const effort = obj(obj(obj(props[parent])?.properties)?.effort);
    const levels = Array.isArray(effort?.enum)
      ? effort.enum.filter((l): l is string => typeof l === 'string' && l !== '')
      : [];
    if (levels.length === 0) continue;
    const def = typeof effort?.default === 'string' && levels.includes(effort.default) ? effort.default : undefined;
    return { parent, levels, default: def };
  }
  return undefined;
}

const LABELS: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

/**
 * configurationSchema in the format VS Code 1.142 turns into a menu in the model picker.
 * The picker's "Details" panel only shows properties with `group` "navigation" (or "tokens") and an enum
 * of 2+ items; "navigation" is the group VS Code itself uses for reasoningEffort.
 */
export function effortConfigurationSchema(e: EffortSupport): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      [EFFORT_OPTION]: {
        type: 'string',
        title: 'Thinking Effort',
        group: 'navigation',
        enum: e.levels,
        enumItemLabels: e.levels.map((l) => LABELS[l] ?? l),
        ...(e.default ? { default: e.default } : {}),
      },
    },
  };
}

export type EffortSource = 'picker' | 'setting' | 'model-default';

export interface ResolvedEffort {
  level?: string;
  source: EffortSource;
  /** To merge into additionalModelRequestFields; empty when the backend default applies. */
  requestFields: Record<string, unknown>;
}

/**
 * Picks the level: choice in the picker (modelConfiguration) > kirorelay.reasoningEffort setting >
 * backend default (nothing is sent). Levels the model does not accept are ignored.
 *
 * VS Code fills modelConfiguration with the schema `default` even when the user chose nothing,
 * so a value equal to the default does not count as an explicit choice and does not override the setting.
 */
export function resolveEffort(
  modelId: string,
  support: EffortSupport | undefined,
  modelConfiguration: Readonly<Record<string, unknown>> | undefined,
  settings: Readonly<Record<string, unknown>> | undefined,
): ResolvedEffort {
  if (!support) return { source: 'model-default', requestFields: {} };

  const picked = modelConfiguration?.[EFFORT_OPTION];
  const candidates: Array<[unknown, EffortSource]> = [
    [picked === support.default ? undefined : picked, 'picker'],
    [settings?.[modelId], 'setting'],
    [picked, 'picker'],
  ];
  for (const [value, source] of candidates) {
    if (typeof value !== 'string' || !support.levels.includes(value)) continue;
    return { level: value, source, requestFields: { [support.parent]: { effort: value } } };
  }
  return { level: support.default, source: 'model-default', requestFields: {} };
}
