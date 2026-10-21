// Esforço de raciocínio por modelo. Módulo puro: sem vscode.
//
// O catálogo do Kiro descreve os campos extras de cada modelo em additionalModelRequestFieldsSchema.
// Observado em 2026-10-21: Claude usa `output_config.effort`, GPT usa `reasoning.effort`.

/** Chave da opção no configurationSchema do VS Code (aparece no seletor de modelos). */
export const EFFORT_OPTION = 'reasoningEffort';

const EFFORT_PARENTS = ['output_config', 'reasoning'] as const;
export type EffortParent = (typeof EFFORT_PARENTS)[number];

export interface EffortSupport {
  /** Onde o nível vai em additionalModelRequestFields. */
  parent: EffortParent;
  levels: string[];
  /** Padrão do backend para o modelo, se informado. */
  default?: string;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Extrai os níveis de esforço do additionalModelRequestFieldsSchema, se houver. */
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

/** configurationSchema no formato que o VS Code 1.142 transforma em menu no seletor de modelos. */
export function effortConfigurationSchema(e: EffortSupport): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      [EFFORT_OPTION]: {
        type: 'string',
        title: 'Thinking Effort',
        enum: e.levels,
        enumItemLabels: e.levels.map((l) => LABELS[l] ?? l),
        ...(e.default ? { default: e.default } : {}),
      },
    },
  };
}

export type EffortSource = 'seletor' | 'setting' | 'padrão do modelo';

export interface ResolvedEffort {
  level?: string;
  source: EffortSource;
  /** Para mesclar em additionalModelRequestFields; vazio quando vale o padrão do backend. */
  requestFields: Record<string, unknown>;
}

/**
 * Decide o nível: escolha no seletor (modelConfiguration) > setting kirorelay.reasoningEffort >
 * padrão do backend (nada é enviado). Níveis que o modelo não aceita são ignorados.
 *
 * O VS Code preenche modelConfiguration com o `default` do schema mesmo sem escolha do usuário,
 * então um valor igual ao padrão não conta como escolha explícita e não se sobrepõe à setting.
 */
export function resolveEffort(
  modelId: string,
  support: EffortSupport | undefined,
  modelConfiguration: Readonly<Record<string, unknown>> | undefined,
  settings: Readonly<Record<string, unknown>> | undefined,
): ResolvedEffort {
  if (!support) return { source: 'padrão do modelo', requestFields: {} };

  const picked = modelConfiguration?.[EFFORT_OPTION];
  const candidates: Array<[unknown, EffortSource]> = [
    [picked === support.default ? undefined : picked, 'seletor'],
    [settings?.[modelId], 'setting'],
    [picked, 'seletor'],
  ];
  for (const [value, source] of candidates) {
    if (typeof value !== 'string' || !support.levels.includes(value)) continue;
    return { level: value, source, requestFields: { [support.parent]: { effort: value } } };
  }
  return { level: support.default, source: 'padrão do modelo', requestFields: {} };
}
