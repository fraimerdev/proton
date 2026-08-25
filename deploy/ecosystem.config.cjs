// The only host-specific values in this file. See docs/DEPLOY.md for where they come from.
const ROOT = '/srv/proton';
const BUN = '/home/proton/.bun/bin/bun';

// No entry for the gateway on purpose: Discord caps session starts at 1000/day and every gateway
// boot spends one, so it must never be restarted by a threshold nobody is watching.
const MEMORY_LIMIT = {
  'rest-proxy': '400M',
  api: '600M',
  worker: '900M',
  dashboard: '700M',
};

function service(name, dir, script, env) {
  return {
    name: `proton-${name}`,
    cwd: `${ROOT}/${dir}`,
    script,
    interpreter: BUN,
    // Every service reads the one root .env. PORT and HOST are set per process instead, because a
    // shared .env cannot hold three different values for PORT — and a real environment variable
    // wins over an --env-file entry, so these override cleanly.
    interpreter_args: `--env-file=${ROOT}/.env`,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    exp_backoff_restart_delay: 2000,
    kill_timeout: 15000,
    time: true,
    merge_logs: true,
    env: { NODE_ENV: 'production', ...env },
    ...(MEMORY_LIMIT[name] ? { max_memory_restart: MEMORY_LIMIT[name] } : {}),
  };
}

module.exports = {
  apps: [
    service('rest-proxy', 'apps/rest-proxy', 'src/index.ts', { PORT: 9001, HOST: '127.0.0.1' }),
    service('api', 'apps/api', 'src/index.ts', { PORT: 9002, HOST: '127.0.0.1' }),
    service('gateway', 'apps/gateway', 'src/index.ts', {}),
    service('worker', 'apps/worker', 'src/index.ts', {}),
    service('dashboard', 'apps/dashboard', 'serve.ts', { PORT: 9000, HOST: '127.0.0.1' }),
  ],
};
