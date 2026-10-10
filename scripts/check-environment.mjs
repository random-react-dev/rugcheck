#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const worker = args[0] === '--worker' ? args.splice(0, 2)[1] : 'codex';
const executable = args[0];
let home;
const result = { worker, node: process.version, platform: process.platform, cli_flags: 'NOT_CHECKED', gateway: 'NOT_CHECKED', real_execution: 'NOT_RUN', host_isolation: 'NOT_QUALIFIED' };
try {
  if (Number(process.versions.node.split('.')[0]) !== 24 || !['linux', 'darwin'].includes(process.platform)) throw new Error('RUNTIME_UNQUALIFIED');
  if (!['codex', 'claude-code'].includes(worker)) throw new Error('WORKER_UNSUPPORTED');
  if (!executable || !path.isAbsolute(executable)) throw new Error(worker === 'claude-code' ? 'ABSOLUTE_CLAUDE_PATH_REQUIRED' : 'ABSOLUTE_CODEX_PATH_REQUIRED');
  await fs.access(executable, fs.constants.X_OK);
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'rugcheck-cli-help-'));
  // Help only. No authentication or model task; no stdout/stderr text is returned to callers.
  const child = spawn(executable, worker === 'claude-code' ? ['--help'] : ['exec', '--help'], { detached: true, env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'), PATH: [path.dirname(executable), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const timer = setTimeout(kill, 5000); let output = '', bytes = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) kill(); else output += chunk; });
  const code = await new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('close', resolve); }); clearTimeout(timer); kill();
  if (code !== 0 || bytes > 65536) throw new Error('CLI_HELP_FAILED');
  const flags = worker === 'claude-code' ? ['--print', '--bare', '--output-format', '--tools', '--allowedTools', '--setting-sources', '--strict-mcp-config', '--mcp-config', '--no-session-persistence', '--permission-mode'] : ['--sandbox', '--ephemeral', '--json', '--output-schema', '--output-last-message', '--skip-git-repo-check', '--cd'];
  if (!flags.every(flag => output.includes(flag))) throw new Error('CLI_FLAGS_MISSING');
  result.cli_flags = 'PRESENT'; result.status = 'PREREQUISITES_ONLY';
} catch (error) { result.status = 'BLOCKED'; result.error = /^[A-Z_]+$/.test(error.message) ? error.message : 'ENVIRONMENT_CHECK_FAILED'; process.exitCode = 1; }
finally { if (home) await fs.rm(home, { recursive: true, force: true }); }
console.log(JSON.stringify(result));
