/**
 * Defense in depth at log and model boundaries. This is not an access-control
 * boundary: the shell must not be able to read a secret in the first place.
 * Only explicitly registered values and strongly labelled secret formats are
 * removed. Ordinary source code, addresses and transaction hashes remain useful.
 */

const REDACTED = "[REDACTED]";
const SECRET_FIELD = /^(?:api[_-]?key|private[_-]?key|secret[_-]?key|password|passphrase|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|access[_-]?token|refresh[_-]?token|client[_-]?secret|conwayApiKey|openaiApiKey|anthropicApiKey)$/i;

export class SecretRedactor {
  private readonly secrets = new Set<string>();

  /** Call only with credentials already loaded for a legitimate operation. */
  register(value: unknown): void {
    // Short values cause destructive false positives (e.g. local key "ollama").
    // They are still hidden under sensitive field names / labelled patterns.
    if (typeof value !== "string" || value.length < 8 || value === REDACTED) return;
    this.secrets.add(value);
    // Also cover the value in a JSON-encoded tool result or exception.
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) this.secrets.add(escaped);
  }

  text(text: string): string {
    let safe = text;
    // Longest first prevents a shorter registered prefix leaking a suffix.
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      safe = safe.split(secret).join(REDACTED);
    }
    return safe
      .replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g, REDACTED)
      .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|cnwy_k_[A-Za-z0-9_-]{12,})\b/g, REDACTED)
      .replace(/(\b(?:authorization|proxy-authorization)\s*[=:]\s*["']?(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]+={0,2}/gi, `$1${REDACTED}`)
      .replace(/(["']?(?:api[_-]?key|private[_-]?key|secret[_-]?key|password|passphrase|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\\\r\n])*?\2/gi, `$1"${REDACTED}"`)
      .replace(/(\b(?:api[_-]?key|private[_-]?key|secret[_-]?key|password|passphrase|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*=\s*)(?!["'\[])[^\s,;&]+/gi, `$1${REDACTED}`)
      .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)=)[^&#\s"']+/gi, `$1${REDACTED}`)
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  }

  value<T>(value: T): T {
    const active = new WeakSet<object>();
    const visit = (item: unknown, depth: number): unknown => {
      if (typeof item === "string") return this.text(item);
      if (typeof item !== "object" || item === null) return item;
      if (depth > 32) return "[REDACTED: maximum nesting]";
      if (active.has(item)) return "[Circular]";
      if (item instanceof Date) return item.toISOString();
      active.add(item);
      try {
        if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
        const result: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(item)) {
          // Objects describing an API-key schema are not secret values.
          result[key] = SECRET_FIELD.test(key) && typeof entry === "string"
            ? REDACTED
            : visit(entry, depth + 1);
        }
        return result;
      } finally {
        active.delete(item);
      }
    };
    return visit(value, 0) as T;
  }
}

const runtimeRedactor = new SecretRedactor();

export function registerSecret(value: unknown): void {
  runtimeRedactor.register(value);
}

export function registerSecrets(...values: unknown[]): void {
  for (const value of values) registerSecret(value);
}

export function redactText(text: string): string {
  return runtimeRedactor.text(text);
}

export function redactValue<T>(value: T): T {
  return runtimeRedactor.value(value);
}
