import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import type { OpenClawPluginApi, OpenClawConfig } from 'openclaw/plugin-sdk';
import WebSocket from 'ws';
import { exchangePairingCode, parseConnectionUri, buildWsUrl } from './utils';
import type { WhimmyConfig, ConnectionInfo } from './types';

const DEFAULT_HOST = 'api.whimmy.ai';

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function promptChoice(question: string, choices: string[]): Promise<number> {
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}) ${choices[i]}`);
  }
  const answer = await prompt(`${question} `);
  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= choices.length) {
    throw new Error(`Invalid choice: ${answer}`);
  }
  return idx;
}

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

  await rt.config.writeConfigFile(liveCfg);
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

          let conn: ConnectionInfo | null = null;

          // --- Flag-driven paths ---

          if (options.pairingCode) {
            console.log('Exchanging pairing code...');
            conn = await exchangePairingCode(options.pairingCode, DEFAULT_HOST, true);
          } else if (options.uri) {
            conn = parseConnectionUri(options.uri);
            if (!conn) {
              throw new Error(`Invalid connection URI: ${options.uri}`);
            }
          } else if (options.host && options.token) {
            conn = { host: options.host, token: options.token, tls: true };
          } else if (options.host || options.token) {
            throw new Error('Both --host and --token are required when using manual credentials');
          }

          // --- Interactive path ---

          if (!conn) {
            console.log('\nWhimmy Setup');
            console.log('============\n');
            console.log('Choose a connection method:\n');

            const choice = await promptChoice('Enter choice [1-3]:', [
              'Pairing code (from the Whimmy app)',
              'Connection URI (whimmy://{token}@{host})',
              'Host + Token (manual)',
            ]);

            switch (choice) {
              case 0: {
                const code = await prompt('Pairing code: ');
                if (!code) throw new Error('Pairing code cannot be empty');
                console.log('Exchanging pairing code...');
                conn = await exchangePairingCode(code, DEFAULT_HOST, true);
                break;
              }
              case 1: {
                const uri = await prompt('Connection URI: ');
                if (!uri) throw new Error('URI cannot be empty');
                conn = parseConnectionUri(uri);
                if (!conn) throw new Error(`Invalid connection URI: ${uri}`);
                break;
              }
              case 2: {
                const host = await prompt(`Host [${DEFAULT_HOST}]: `) || DEFAULT_HOST;
                const token = await prompt('Token: ');
                if (!token) throw new Error('Token cannot be empty');
                conn = { host, token, tls: true };
                break;
              }
            }
          }

          if (!conn) {
            throw new Error('No connection info resolved');
          }

          // Test the connection
          console.log(`Testing connection to ${conn.host}...`);
          const ok = await testWsConnection(conn);
          if (!ok) {
            console.error('Connection test failed. Config was NOT saved.');
            console.error('Check your credentials and ensure the host is reachable.');
            process.exitCode = 1;
            return;
          }
          console.log('Connection successful!');

          // Persist to config
          await writeConnectionToConfig(api, conn, accountId);
          console.log(`\nWhimmy config saved${accountId !== 'default' ? ` (account: ${accountId})` : ''}.`);
          console.log('Run `openclaw gateway` to start the connection.');
        });
    },
    { commands: ['whimmy'] },
  );
}
