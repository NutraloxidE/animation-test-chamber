/**
 * Filesystem operations behind an interface so fault-injection tests can make
 * any individual operation throw at any point, including "after the bytes are
 * on disk but before fsync returns" and "during the Nth promotion rename".
 * Real code always goes through `createNodeFilesystem()`; tests wrap it with
 * `withFaultInjection()`.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export type FsOpName =
  | 'readFileBytes'
  | 'writeFile'
  | 'mkdirRecursive'
  | 'rename'
  | 'remove'
  | 'fsyncFile'
  | 'fsyncDirectory'
  | 'createExclusive';

export interface FilesystemOps {
  readFileIfExists(absolutePath: string): Uint8Array | null;
  writeFile(absolutePath: string, data: Uint8Array): void;
  mkdirRecursive(absolutePath: string): void;
  rename(fromAbsolute: string, toAbsolute: string): void;
  remove(absolutePath: string, options?: { recursive?: boolean }): void;
  exists(absolutePath: string): boolean;
  fsyncFile(absolutePath: string): void;
  /**
   * Flushes a directory entry, so a rename into it survives a power cut.
   * Best-effort by contract: not every platform or filesystem supports it, and
   * the atomicity callers rely on comes from the rename itself, not from this.
   */
  fsyncDirectory(absolutePath: string): void;
  /** Repository-relative, forward-slash paths of every regular file under `absoluteDir`. */
  listFilesRecursive(absoluteDir: string): string[];
  /** Atomically creates a file only if it does not already exist. Returns false without writing if it does. */
  createExclusive(absolutePath: string, data: Uint8Array): boolean;
}

function toRelativePosix(base: string, target: string): string {
  return relative(base, target).split(sep).join('/');
}

export function createNodeFilesystem(): FilesystemOps {
  return {
    readFileIfExists(absolutePath) {
      if (!existsSync(absolutePath)) return null;
      return new Uint8Array(readFileSync(absolutePath));
    },
    writeFile(absolutePath, data) {
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, data);
    },
    mkdirRecursive(absolutePath) {
      mkdirSync(absolutePath, { recursive: true });
    },
    rename(fromAbsolute, toAbsolute) {
      mkdirSync(dirname(toAbsolute), { recursive: true });
      renameSync(fromAbsolute, toAbsolute);
    },
    remove(absolutePath, options) {
      rmSync(absolutePath, { recursive: options?.recursive ?? false, force: true });
    },
    exists(absolutePath) {
      return existsSync(absolutePath);
    },
    fsyncFile(absolutePath) {
      // Not every filesystem backing this container supports fsync (overlayfs
      // in some sandboxes rejects it); best-effort durability, never fatal.
      try {
        const fd = openSync(absolutePath, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        // ignored: fsync is best-effort durability, not correctness-critical
        // for the in-process rollback/recovery logic this package implements.
      }
    },
    fsyncDirectory(absolutePath) {
      try {
        const fd = openSync(absolutePath, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        // ignored: see fsyncFile. Directory fsync is rejected outright on some
        // platforms, and a journal rename is still atomic without it.
      }
    },
    listFilesRecursive(absoluteDir) {
      const out: string[] = [];
      const walk = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile()) out.push(toRelativePosix(absoluteDir, full));
        }
      };
      walk(absoluteDir);
      return out;
    },
    createExclusive(absolutePath, data) {
      mkdirSync(dirname(absolutePath), { recursive: true });
      try {
        writeFileSync(absolutePath, data, { flag: 'wx' });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    },
  };
}

export interface FaultInjectionContext {
  op: FsOpName;
  /** Absolute path the operation targets. */
  path: string;
  /** 1-based count of calls to this specific operation so far, including this one. */
  callIndex: number;
}

/** Throw from this hook to make the targeted operation fail. Return normally to let it proceed. */
export type FaultInjectionHook = (context: FaultInjectionContext) => void;

export function withFaultInjection(fs: FilesystemOps, hook: FaultInjectionHook): FilesystemOps {
  const counts: Record<FsOpName, number> = {
    readFileBytes: 0,
    writeFile: 0,
    mkdirRecursive: 0,
    rename: 0,
    remove: 0,
    fsyncFile: 0,
    fsyncDirectory: 0,
    createExclusive: 0,
  };
  function guard(op: FsOpName, path: string): void {
    counts[op] += 1;
    // Fault selectors are repository-path predicates and must behave the same
    // on POSIX and Windows. The underlying filesystem still receives the native path.
    hook({ op, path: path.replace(/\\/g, '/'), callIndex: counts[op] });
  }
  return {
    readFileIfExists(absolutePath) {
      guard('readFileBytes', absolutePath);
      return fs.readFileIfExists(absolutePath);
    },
    writeFile(absolutePath, data) {
      guard('writeFile', absolutePath);
      fs.writeFile(absolutePath, data);
    },
    mkdirRecursive(absolutePath) {
      guard('mkdirRecursive', absolutePath);
      fs.mkdirRecursive(absolutePath);
    },
    rename(fromAbsolute, toAbsolute) {
      guard('rename', toAbsolute);
      fs.rename(fromAbsolute, toAbsolute);
    },
    remove(absolutePath, options) {
      guard('remove', absolutePath);
      fs.remove(absolutePath, options);
    },
    exists(absolutePath) {
      return fs.exists(absolutePath);
    },
    fsyncFile(absolutePath) {
      guard('fsyncFile', absolutePath);
      fs.fsyncFile(absolutePath);
    },
    fsyncDirectory(absolutePath) {
      guard('fsyncDirectory', absolutePath);
      fs.fsyncDirectory(absolutePath);
    },
    listFilesRecursive(absoluteDir) {
      return fs.listFilesRecursive(absoluteDir);
    },
    createExclusive(absolutePath, data) {
      guard('createExclusive', absolutePath);
      return fs.createExclusive(absolutePath, data);
    },
  };
}
