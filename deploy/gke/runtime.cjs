const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');

function runtimeEnvironment(path, base = process.env) {
  let values;
  try {
    values = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Runtime secret must be a readable JSON object');
  }
  if (!values || Array.isArray(values) || typeof values !== 'object')
    throw new Error('Runtime secret must be an object');
  const blocked = new Set(['NODE_OPTIONS', 'LD_PRELOAD', 'PATH', 'NODE_PATH']);
  for (const [key, value] of Object.entries(values)) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      blocked.has(key) ||
      typeof value !== 'string' ||
      value.includes('\0')
    )
      throw new Error('Invalid runtime secret entry');
  }
  return { ...base, ...values };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (!args.length) throw new Error('Application command required');
    const env = runtimeEnvironment(
      process.env.RUNTIME_SECRET_FILE ?? '/var/run/wgo/runtime.json',
    );
    const child = spawn(args[0], args.slice(1), { env, stdio: 'inherit' });
    // PID 1 must forward termination to the application so its worker leases drain.
    for (const signal of ['SIGTERM', 'SIGINT'])
      process.on(signal, () => child.kill(signal));
    child.on('error', () => {
      console.error('Application failed to start');
      process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { runtimeEnvironment };
