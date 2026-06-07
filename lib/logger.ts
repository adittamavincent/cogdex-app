export function debug(...args: unknown[]) {
  if (process.env.NODE_ENV !== "production") {
    // Use console.debug to maintain dev tooling integration
    // Prefix with project tag for easier filtering
    // eslint-disable-next-line no-console
    console.debug("[Cogdex]", ...args);
  }
}

export function info(...args: unknown[]) {
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.info("[Cogdex]", ...args);
  }
}

export function warn(...args: unknown[]) {
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.warn("[Cogdex]", ...args);
  }
}

export function error(...args: unknown[]) {
  // Always surface errors in logs (useful for production observability)
  // eslint-disable-next-line no-console
  console.error("[Cogdex]", ...args);
}

export default {
  debug,
  info,
  warn,
  error,
};
