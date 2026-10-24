// Arguments for `kiro-cli login`, from the kirorelay.login.* settings. Pure module: no vscode.
//
// kiro-cli 2.33.0 options: --license <free|pro>, --identity-provider <URL> (IAM Identity Center
// start URL), --region <REGION> (Identity Center region), --use-device-flow.
// The arguments go straight to the kiro-cli process (no shell), and are validated anyway.

import { defaultRun, type RunFn } from './renewer.ts';

export async function isCliInstalled(cliPath: string, run: RunFn = defaultRun): Promise<boolean> {
  try {
    await run(cliPath, ['--version'], { timeout: 5_000 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function buildInstallCommand(platform: NodeJS.Platform): { shellPath: string; shellArgs: string[] } | undefined {
  const command = 'set -o pipefail; curl -fsSL https://cli.kiro.dev/install | bash';
  if (platform === 'darwin' || platform === 'linux') {
    return { shellPath: '/bin/bash', shellArgs: ['-c', command] };
  }
  if (platform === 'win32') {
    return { shellPath: 'wsl.exe', shellArgs: ['--exec', 'bash', '-c', command] };
  }
  return undefined;
}

export interface LoginSettings {
  /** "" = let kiro-cli ask; "pro" = IAM Identity Center; "free" = Builder ID, Google or GitHub. */
  license?: string;
  startUrl?: string;
  region?: string;
  /** "auto" = device flow in remote windows (devcontainer, SSH, WSL), where no browser is next to kiro-cli. */
  deviceFlow?: 'auto' | 'always' | 'never';
}

export class LoginSettingsError extends Error {
  readonly setting: string;

  constructor(setting: string, message: string) {
    super(message);
    this.name = 'LoginSettingsError';
    this.setting = setting;
  }
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/** An http(s) URL without spaces or quotes, e.g. https://example.awsapps.com/start. */
export function isValidStartUrl(value: string): boolean {
  if (/[\s"'`]/.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname.length > 0;
  } catch {
    return false;
  }
}

export function buildLoginArgs(settings: LoginSettings, remote: boolean): string[] {
  const args = ['login'];
  const license = settings.license?.trim() ?? '';
  const startUrl = settings.startUrl?.trim() ?? '';
  const region = settings.region?.trim() ?? '';

  if (license) {
    if (license !== 'pro' && license !== 'free') {
      throw new LoginSettingsError('kirorelay.login.license', `unknown license: ${license} (use "pro" or "free")`);
    }
    args.push('--license', license);
  }
  // Start URL and region only apply to IAM Identity Center ("pro").
  if (license !== 'free') {
    if (startUrl) {
      if (!isValidStartUrl(startUrl)) {
        throw new LoginSettingsError('kirorelay.login.startUrl', `invalid start URL: ${startUrl} (expected https://…)`);
      }
      args.push('--identity-provider', startUrl);
    }
    if (region) {
      if (!REGION.test(region)) {
        throw new LoginSettingsError('kirorelay.login.region', `invalid region: ${region} (e.g. us-east-1)`);
      }
      args.push('--region', region);
    }
  }
  const deviceFlow = settings.deviceFlow ?? 'auto';
  if (deviceFlow === 'always' || (deviceFlow === 'auto' && remote)) args.push('--use-device-flow');
  return args;
}
