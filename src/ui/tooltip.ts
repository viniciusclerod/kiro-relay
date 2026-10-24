export interface TooltipData {
  tokenLabel: string;
  tokenValue: string;
  sessionLabel: string;
  sessionValue: string;
}

/** Plain text only: account details and actions belong in the panel. */
export function renderTooltip(data: TooltipData): string {
  return `${data.tokenLabel}: ${data.tokenValue}\n${data.sessionLabel}: ${data.sessionValue}`;
}
