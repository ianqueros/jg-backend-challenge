import assert from 'node:assert/strict';
import { installTestEnvironment, testTargets } from './test-environment.js';

installTestEnvironment();

// Recovery campaigns stop shared services. Run them after the isolated suites, never in parallel.
const commands: string[][] = [
  [process.execPath, 'run', 'quality'],
  [process.execPath, 'run', 'build'],
  [
    'docker',
    'compose',
    '--env-file',
    'docker/test.env',
    '-p',
    testTargets.COMPOSE_PROJECT_NAME,
    '-f',
    'compose.services.yaml',
    '-f',
    'compose.apps.yaml',
    'up',
    '-d',
    '--build',
    '--wait',
    '--wait-timeout',
    '180',
  ],
  [process.execPath, 'run', 'test:all'],
  [process.execPath, 'run', 'acceptance:recovery'],
  [process.execPath, 'run', 'acceptance:fresh'],
];
for (const command of commands) {
  console.log(
    JSON.stringify({ acceptanceCommand: command.join(' '), status: 'started' }),
  );
  const child = Bun.spawn(command, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  assert.equal(await child.exited, 0, `Acceptance command failed: ${command.join(' ')}`);
  console.log(JSON.stringify({ acceptanceCommand: command.join(' '), status: 'passed' }));
}
