import fs from "node:fs";
import path from "node:path";
import { isProtectedFile } from "../self-mod/code.js";

export class FileAccessError extends Error {
  readonly code = "FILE_ACCESS_DENIED";
}

/** File-API safeguard; a host administration shell is intentionally separate. */
export function isSensitivePath(filePath: string): boolean {
  const parts = path.resolve(filePath).split(path.sep);
  const name = parts.at(-1)!.toLowerCase();
  return parts.some((part) => [".ssh", ".gnupg", ".aws", ".azure", ".kube"].includes(part.toLowerCase())) ||
    ["wallet.json", "config.json", "automaton.json", "credentials", "id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"].includes(name) ||
    /^payment-ledger\.db(?:-(?:wal|shm|journal))?$/.test(name) ||
    name === ".env" || name.startsWith(".env.") || name.endsWith(".key") || name.endsWith(".pem") ||
    name.startsWith("private-key");
}

function allowedPath(filePath: string, roots?: string[], write = false): void {
  if (isSensitivePath(filePath) || (write && isProtectedFile(filePath))) {
    throw new FileAccessError("Blocked: sensitive or protected file");
  }
  if (roots && !roots.some((root) => {
    const canonical = fs.realpathSync(root);
    return filePath === canonical || filePath.startsWith(canonical + path.sep);
  })) throw new FileAccessError("Blocked: file outside configured roots");
}

function verifyDescriptor(fd: number, canonical: string, roots: string[] | undefined, write: boolean): void {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) throw new FileAccessError("Blocked: only regular files are supported");
  // Check the opened object, not only the path checked before open. Linux is the VPS target.
  const opened = process.platform === "linux" ? fs.realpathSync(`/proc/self/fd/${fd}`) : canonical;
  allowedPath(opened, roots, write);
  if (opened !== canonical) throw new FileAccessError("Blocked: file target changed while opening");
}

export function readToolFile(filePath: string, roots?: string[], maxBytes = 1024 * 1024): string {
  allowedPath(path.resolve(filePath), undefined);
  const canonical = fs.realpathSync(filePath);
  allowedPath(canonical, roots);
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    verifyDescriptor(fd, canonical, roots, false);
    if (fs.fstatSync(fd).size > maxBytes) throw new FileAccessError("Blocked: file exceeds read limit");
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const bytes = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!bytes) break;
      size += bytes;
    }
    if (size > maxBytes) throw new FileAccessError("Blocked: file exceeds read limit");
    return buffer.subarray(0, size).toString("utf8");
  } finally { fs.closeSync(fd); }
}

export function writeToolFile(filePath: string, content: string, roots?: string[]): void {
  allowedPath(path.resolve(filePath), undefined, true);
  if (roots) {
    // Refuse before creating directories outside the configured file API roots.
    const absolute = path.resolve(filePath);
    if (!roots.some((root) => absolute.startsWith(path.resolve(root) + path.sep))) throw new FileAccessError("Blocked: file outside configured roots");
  }
  // Resolve the existing ancestor BEFORE mkdir: a symlinked parent must not
  // create even empty directories outside the configured roots on rejection.
  const absolute = path.resolve(filePath);
  let ancestor = path.dirname(absolute);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const candidate = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, absolute));
  allowedPath(candidate, roots, true);
  filePath = candidate;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const canonical = fs.existsSync(filePath)
    ? fs.realpathSync(filePath)
    : path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
  allowedPath(canonical, roots, true);
  // No O_TRUNC before the opened object has been checked.
  const fd = fs.openSync(canonical, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    verifyDescriptor(fd, canonical, roots, true);
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, "utf8");
  } finally { fs.closeSync(fd); }
}
