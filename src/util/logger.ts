type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL: Level = (process.env["BOOTH_LOG_LEVEL"] as Level | undefined) ?? "info";

function shouldLog(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

function format(scope: string, level: Level, message: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] [${scope}] ${message}`;
  if (meta === undefined) return base;
  if (meta instanceof Error) return `${base} :: ${meta.stack ?? meta.message}`;
  try {
    return `${base} :: ${JSON.stringify(meta)}`;
  } catch {
    return `${base} :: ${String(meta)}`;
  }
}

export function createLogger(scope: string): Logger {
  return {
    debug(message, meta) {
      if (shouldLog("debug")) console.debug(format(scope, "debug", message, meta));
    },
    info(message, meta) {
      if (shouldLog("info")) console.info(format(scope, "info", message, meta));
    },
    warn(message, meta) {
      if (shouldLog("warn")) console.warn(format(scope, "warn", message, meta));
    },
    error(message, meta) {
      if (shouldLog("error")) console.error(format(scope, "error", message, meta));
    },
  };
}
