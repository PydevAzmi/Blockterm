import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface HeaderFs {
  readFile(path: string): string | null;
}

const disk: HeaderFs = {
  readFile(path: string): string | null {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
};

function branchFromHead(head: string): string | null {
  const text = head.trim();
  const ref = /^ref:\s*(.+)$/.exec(text);
  if (ref !== null) return ref[1]!.replace(/^refs\/heads\//, '');
  if (/^[0-9a-f]{40}$/i.test(text)) return text.slice(0, 7);
  return null;
}

export function gitBranch(folder: string, fs: HeaderFs = disk): string | null {
  let dir = resolve(folder);

  while (true) {
    const dotGit = join(dir, '.git');
    const marker = fs.readFile(dotGit);
    let gitDir = dotGit;

    if (marker !== null) {
      const match = /^gitdir:\s*(.+)$/im.exec(marker);
      if (match !== null) {
        const target = match[1]!.trim();
        gitDir = isAbsolute(target) ? target : resolve(dir, target);
      }
    }

    const head = fs.readFile(join(gitDir, 'HEAD')) ?? fs.readFile(gitDir);
    if (head !== null) {
      const branch = branchFromHead(head);
      if (branch !== null) return branch;
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function folderText(folder: string, home: string): string {
  const windows = process.platform === 'win32';
  const normalize = (path: string): string => (windows ? path.replace(/\\/g, '/').toLowerCase() : path);
  const f = normalize(folder);
  const h = normalize(home);

  if (h !== '' && f === h) return '~';
  if (
    h !== '' &&
    f.startsWith(h) &&
    (f[h.length] === '/' || f[h.length] === '\\')
  ) {
    return `~${folder.slice(home.length)}`;
  }
  return folder;
}

export function headerText(o: {
  folder: string | null;
  home: string;
  branch: string | null;
  model: string | null;
}): string {
  const parts: string[] = [];
  if (o.folder !== null) {
    parts.push(o.branch !== null ? `${folderText(o.folder, o.home)} (${o.branch})` : folderText(o.folder, o.home));
  }
  if (o.model !== null) parts.push(o.model);
  return parts.join(' · ');
}
