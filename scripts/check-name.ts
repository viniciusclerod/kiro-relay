// Consulta o VS Code Marketplace e o Open VSX (registro usado pelo Kiro IDE)
// para ver se já existem extensões parecidas com um nome candidato.
//
// Uso:  npm run check-name -- "Kiro Tether" "Kiro Relay"
//
// Atenção: "nenhum resultado" NÃO prova disponibilidade (busca é aproximada e a
// API pode falhar). A prova final é reservar o publisher/ID ao publicar.
import { pathToFileURL } from 'node:url';

export type Registry = 'marketplace' | 'open-vsx';

export interface Hit {
  registry: Registry;
  id: string;
  displayName: string;
}

export interface Classified extends Hit {
  exact: boolean;
  similar: boolean;
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function classify(candidate: string, hit: Hit): Classified {
  const c = normalize(candidate);
  const names = [normalize(hit.displayName), normalize(hit.id.split('.').slice(1).join('.'))];
  const exact = names.some((n) => n === c);
  const similar = !exact && names.some((n) => n.length >= 4 && (n.includes(c) || c.includes(n)));
  return { ...hit, exact, similar };
}

interface MarketplaceResponse {
  results?: {
    extensions?: {
      extensionName?: string;
      displayName?: string;
      publisher?: { publisherName?: string };
    }[];
  }[];
}

export function parseMarketplace(json: MarketplaceResponse): Hit[] {
  const out: Hit[] = [];
  for (const e of json.results?.[0]?.extensions ?? []) {
    const pub = e.publisher?.publisherName ?? '?';
    const name = e.extensionName ?? '?';
    out.push({ registry: 'marketplace', id: `${pub}.${name}`, displayName: e.displayName ?? name });
  }
  return out;
}

interface OpenVsxResponse {
  extensions?: { namespace?: string; name?: string; displayName?: string }[];
}

export function parseOpenVsx(json: OpenVsxResponse): Hit[] {
  return (json.extensions ?? []).map((e) => ({
    registry: 'open-vsx' as const,
    id: `${e.namespace ?? '?'}.${e.name ?? '?'}`,
    displayName: e.displayName ?? e.name ?? '?',
  }));
}

async function queryMarketplace(text: string): Promise<Hit[]> {
  const res = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json;api-version=7.1-preview.1',
    },
    body: JSON.stringify({
      filters: [
        { criteria: [{ filterType: 10, value: text }], pageNumber: 1, pageSize: 25, sortBy: 0, sortOrder: 0 },
      ],
      assetTypes: [],
      flags: 914,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseMarketplace((await res.json()) as MarketplaceResponse);
}

async function queryOpenVsx(text: string): Promise<Hit[]> {
  const url = `https://open-vsx.org/api/-/search?query=${encodeURIComponent(text)}&size=25`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseOpenVsx((await res.json()) as OpenVsxResponse);
}

async function main(names: string[]): Promise<number> {
  if (names.length === 0) {
    console.error('Uso: npm run check-name -- "Nome A" "Nome B"');
    return 2;
  }
  let anyFailure = false;
  for (const candidate of names) {
    console.log(`\n=== ${candidate} ===`);
    for (const [label, fn] of [
      ['VS Code Marketplace', queryMarketplace],
      ['Open VSX', queryOpenVsx],
    ] as const) {
      try {
        const hits = (await fn(candidate)).map((h) => classify(candidate, h));
        const exact = hits.filter((h) => h.exact);
        const similar = hits.filter((h) => h.similar);
        if (exact.length) {
          console.log(`${label}: JÁ EXISTE -> ${exact.map((h) => `${h.id} ("${h.displayName}")`).join(', ')}`);
        } else if (similar.length) {
          console.log(`${label}: parecidos -> ${similar.map((h) => `${h.id} ("${h.displayName}")`).join(', ')}`);
        } else {
          console.log(`${label}: nenhum nome igual ou parecido entre ${hits.length} resultado(s)`);
        }
      } catch (e) {
        anyFailure = true;
        console.log(`${label}: falha ao consultar (${(e as Error).message}); não conclua nada`);
      }
    }
  }
  return anyFailure ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
