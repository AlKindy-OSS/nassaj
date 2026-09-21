import spawn from 'cross-spawn';

import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { resolveCliExecutablePath } from '@/shared/cli-executable-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { isCliInstalled } from '@/shared/utils.js';

type CursorLoginStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class CursorProviderAuth implements IProviderAuth {
  /**
   * Checks whether the cursor-agent CLI is available on this host.
   */
  private checkInstalled(): boolean {
    return isCliInstalled('cursor-agent');
  }

  /**
   * Returns Cursor CLI installation and login status.
   */
  async getStatus(userId?: string | number | null): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'cursor',
        authenticated: false,
        email: null,
        method: null,
        error: 'Cursor CLI is not installed',
      };
    }

    const login = await this.checkCursorLogin(userId);

    return {
      installed,
      provider: 'cursor',
      authenticated: login.authenticated,
      email: login.email,
      method: login.method,
      error: login.authenticated ? undefined : login.error || 'Not logged in',
    };
  }

  /**
   * Runs cursor-agent status and parses the login marker from stdout.
   *
   * B-587: the probe runs under the SAME env a cursor turn for this user would
   * get. `cursor-agent` has no dedicated config variable — `HOME` is the only
   * knob that moves its tree (see resolve-provider-env.js `case 'cursor'`), so
   * inheriting the server's env made every member read the OPERATOR's login.
   *
   * `userId == null` (shared policy, anonymous probe) keeps the operator's env
   * deliberately: resolveProviderEnv returns the base env unchanged there.
   */
  private checkCursorLogin(userId?: string | number | null): Promise<CursorLoginStatus> {
    return new Promise((resolve) => {
      let processCompleted = false;
      let childProcess: ReturnType<typeof spawn> | undefined;

      const timeout = setTimeout(() => {
        if (!processCompleted) {
          processCompleted = true;
          childProcess?.kill();
          resolve({
            authenticated: false,
            email: null,
            method: null,
            error: 'Command timeout',
          });
        }
      }, 5000);

      try {
        childProcess = spawn(resolveCliExecutablePath('cursor-agent'), ['status'], {
          env: resolveProviderEnv(userId ?? null, 'cursor', process.env),
        });
      } catch {
        clearTimeout(timeout);
        processCompleted = true;
        resolve({
          authenticated: false,
          email: null,
          method: null,
          error: 'Cursor CLI not found or not installed',
        });
        return;
      }

      let stdout = '';
      let stderr = '';

      childProcess.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      childProcess.on('close', (code) => {
        if (processCompleted) {
          return;
        }
        processCompleted = true;
        clearTimeout(timeout);

        if (code === 0) {
          const emailMatch = stdout.match(/Logged in as ([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
          if (emailMatch?.[1]) {
            resolve({ authenticated: true, email: emailMatch[1], method: 'cli' });
            return;
          }

          if (stdout.includes('Logged in')) {
            resolve({ authenticated: true, email: 'Logged in', method: 'cli' });
            return;
          }

          resolve({ authenticated: false, email: null, method: null, error: 'Not logged in' });
          return;
        }

        resolve({ authenticated: false, email: null, method: null, error: stderr || 'Not logged in' });
      });

      childProcess.on('error', () => {
        if (processCompleted) {
          return;
        }
        processCompleted = true;
        clearTimeout(timeout);

        resolve({
          authenticated: false,
          email: null,
          method: null,
          error: 'Cursor CLI not found or not installed',
        });
      });
    });
  }
}
