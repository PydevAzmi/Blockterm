import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

interface PackResult {
  files: { path: string }[];
}

function packDryRun(): Promise<PackResult> {
  return new Promise((resolve, reject) => {
    const useCmd = process.platform === 'win32';
    const file = useCmd ? (process.env.ComSpec ?? 'cmd.exe') : NPM;
    const args = useCmd
      ? ['/d', '/s', '/c', NPM, 'pack', '--dry-run', '--ignore-scripts', '--json']
      : ['pack', '--dry-run', '--ignore-scripts', '--json'];
    const child = spawn(file, args, { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`npm pack failed (${code}): ${stderr}`));
        return;
      }
      const start = stdout.indexOf('[');
      const end = stdout.lastIndexOf(']');
      if (start === -1 || end < start) {
        reject(new Error(`npm pack printed no JSON: ${stdout}${stderr}`));
        return;
      }
      resolve((JSON.parse(stdout.slice(start, end + 1)) as PackResult[])[0] as PackResult);
    });
  });
}

test(
  'the tarball contains only dist, README, LICENSE and package.json',
  async () => {
    const packed = await packDryRun();
    const paths = packed.files.map(file => file.path);

    for (const path of paths) {
      const allowed =
        path === 'package.json' ||
        path === 'README.md' ||
        path === 'LICENSE' ||
        path.startsWith('dist/');
      expect(allowed, path).toBe(true);
      expect(path).not.toMatch(/test|\.env|fixtures|\.superpowers/);
    }

    expect(paths).toContain('dist/cli.js');
  },
  60_000,
);

test('the published metadata matches the release', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.description).toBeTypeOf('string');
  expect(pkg.keywords).toEqual(expect.arrayContaining(['terminal', 'agent']));
  expect(pkg.homepage).toBe('https://blockterm.mohamedazmi.dev');
  expect(pkg.bugs).toEqual({ url: 'https://github.com/pydevazmi/blockterm/issues' });
  expect(pkg.files).toEqual(['dist']);
  expect(pkg.bin).toEqual({ blockterm: 'dist/cli.js' });
  expect(pkg.engines).toEqual({ node: '>=24' });
  expect(pkg.license).toBe('MIT');
});
