export function debug(...args: unknown[]) {
  if (process.env.NODE_ENV !== "production") {
    // Use console.debug to maintain dev tooling integration
    // Prefix with project tag for easier filtering
    console.debug("[Cogdex]", ...args);
  }
}

export function info(...args: unknown[]) {
  if (process.env.NODE_ENV !== "production") {
    console.info("[Cogdex]", ...args);
  }
}

export function warn(...args: unknown[]) {
  if (process.env.NODE_ENV !== "production") {
    console.warn("[Cogdex]", ...args);
  }
}

export function error(...args: unknown[]) {
  // Always surface errors in logs (useful for production observability)
  console.error("[Cogdex]", ...args);
}

const logger = {
  debug,
  info,
  warn,
  error,
};

export default logger;
