import type { Command } from 'commander';
import type { OpenClawPluginApi, OpenClawConfig } from 'openclaw/plugin-sdk';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import WebSocket from 'ws';
import { exchangePairingCode, parseConnectionUri, buildWsUrl } from './utils';
import type { WhimmyConfig, ConnectionInfo } from './types';

const DEFAULT_HOST = 'api.whimmy.ai';

/**
 * Test a WebSocket connection by opening and immediately closing it.
 * Resolves true on successful open, false on error.
 */
function testWsConnection(conn: ConnectionInfo, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const url = buildWsUrl(conn);
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, timeoutMs);

    ws.once('open', () => {
      clearTimeout(timer);
      ws.close(1000, 'setup test');
      resolve(true);
    });
    ws.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function writeConnectionToConfig(
  api: OpenClawPluginApi,
  conn: ConnectionInfo,
  accountId?: string,
): Promise<void> {
  const rt = api.runtime;
  const liveCfg: OpenClawConfig = rt.config.loadConfig();

  if (!liveCfg.channels) {
    (liveCfg as any).channels = {};
  }
  if (!liveCfg.channels!.whimmy) {
    (liveCfg.channels as any).whimmy = {};
  }

  const whimmyCfg = liveCfg.channels!.whimmy as WhimmyConfig;

  if (accountId && accountId !== 'default') {
    if (!whimmyCfg.accounts) {
      whimmyCfg.accounts = {};
    }
    whimmyCfg.accounts[accountId] = {
      host: conn.host,
      token: conn.token,
      tls: conn.tls,
    };
  } else {
    whimmyCfg.host = conn.host;
    whimmyCfg.token = conn.token;
    whimmyCfg.tls = conn.tls;
    delete whimmyCfg.pairingCode;
    delete whimmyCfg.connectionUri;
  }

  // Whimmy connections are authenticated via pairing, so open DMs are safe.
  (whimmyCfg as any).dmPolicy = 'open';
  (whimmyCfg as any).allowFrom = ['*'];

  await rt.config.writeConfigFile(liveCfg);
}

async function runPairingSetup(api: OpenClawPluginApi, accountId: string, hostOverride?: string): Promise<void> {
  p.intro(chalk.bold('Whimmy Setup'));

  const host = hostOverride || DEFAULT_HOST;

  const code = await p.text({
    message: 'Enter your 6-digit pairing code from the Whimmy app',
    placeholder: '123456',
    validate: (v = '') => {
      if (!v.trim()) return 'Pairing code is required';
      if (!/^\d{6}$/.test(v.trim())) return 'Must be a 6-digit code';
    },
  });
  if (p.isCancel(code)) {
    p.cancel('Setup cancelled.');
    return;
  }

  let conn: ConnectionInfo;
  const s1 = p.spinner();
  s1.start(`Exchanging pairing code with ${chalk.dim(host)}...`);
  try {
    conn = await exchangePairingCode(code.trim(), host, true);
    s1.stop('Pairing code exchanged');
  } catch (err: any) {
    s1.stop('Pairing failed');
    p.log.error(err.message);
    p.outro(chalk.red('Setup failed.'));
    process.exitCode = 1;
    return;
  }

  const s2 = p.spinner();
  s2.start(`Connecting to ${chalk.dim(conn.host)}...`);
  const ok = await testWsConnection(conn);
  if (!ok) {
    s2.stop('Connection failed');
    p.log.error('Could not reach the server. Check your credentials and try again.');
    p.outro(chalk.red('Setup failed.'));
    process.exitCode = 1;
    return;
  }
  s2.stop('Connected');

  await writeConnectionToConfig(api, conn, accountId);

  const acctNote = accountId !== 'default' ? ` (account: ${chalk.cyan(accountId)})` : '';
  p.log.success(`Config saved${acctNote}`);
  p.outro(`Restart the gateway with ${chalk.cyan('openclaw gateway restart')} to connect.`);
}

export function registerWhimmyCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }) => {
      const root = program
        .command('whimmy')
        .description('Whimmy channel utilities');

      root
        .command('setup')
        .description('Configure Whimmy connection interactively or via flags')
        .option('--pairing-code <code>', 'Six-digit pairing code from the Whimmy app')
        .option('--uri <uri>', 'Connection URI (whimmy://{token}@{host})')
        .option('--host <host>', 'Backend host')
        .option('--token <token>', 'Connection token')
        .option('--account <id>', 'Account ID for multi-account setups')
        .action(async (options: {
          pairingCode?: string;
          uri?: string;
          host?: string;
          token?: string;
          account?: string;
        }) => {
          const accountId = options.account ?? 'default';

          // --- Flag-driven paths (non-interactive) ---

          if (options.pairingCode || options.uri || (options.host && options.token)) {
            p.intro(chalk.bold('Whimmy Setup'));

            let conn: ConnectionInfo | null = null;

            if (options.pairingCode) {
              const host = options.host || DEFAULT_HOST;
              const s = p.spinner();
              s.start(`Exchanging pairing code with ${chalk.dim(host)}...`);
              try {
                conn = await exchangePairingCode(options.pairingCode, host, true);
                s.stop('Pairing code exchanged');
              } catch (err: any) {
                s.stop('Pairing failed');
                p.log.error(err.message);
                p.outro(chalk.red('Setup failed.'));
                process.exitCode = 1;
                return;
              }
            } else if (options.uri) {
              conn = parseConnectionUri(options.uri);
              if (!conn) {
                p.log.error(`Invalid connection URI: ${options.uri}`);
                p.outro(chalk.red('Setup failed.'));
                process.exitCode = 1;
                return;
              }
            } else if (options.host && options.token) {
              conn = { host: options.host, token: options.token, tls: true };
            }

            if (!conn) {
              p.log.error('No connection info resolved.');
              p.outro(chalk.red('Setup failed.'));
              process.exitCode = 1;
              return;
            }

            const s = p.spinner();
            s.start(`Connecting to ${chalk.dim(conn.host)}...`);
            const ok = await testWsConnection(conn);
            if (!ok) {
              s.stop('Connection failed');
              p.log.error('Could not reach the server. Check your credentials and try again.');
              p.outro(chalk.red('Setup failed.'));
              process.exitCode = 1;
              return;
            }
            s.stop('Connected');

            await writeConnectionToConfig(api, conn, accountId);

            const acctNote = accountId !== 'default' ? ` (account: ${chalk.cyan(accountId)})` : '';
            p.log.success(`Config saved${acctNote}`);
            p.outro(`Restart the gateway with ${chalk.cyan('openclaw gateway restart')} to connect.`);
            return;
          }

          if (options.token && !options.host) {
            p.intro(chalk.bold('Whimmy Setup'));
            p.log.error('--host is required when using --token.');
            p.outro(chalk.red('Setup failed.'));
            process.exitCode = 1;
            return;
          }

          // --- Default: pairing code flow ---
          await runPairingSetup(api, accountId, options.host);
        });
    },
    { commands: ['whimmy'] },
  );
}
