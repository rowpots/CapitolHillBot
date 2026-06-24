const CONSOLE_PATCH_FLAG = Symbol.for("snapbot.console.timestamped");

export function installTimestampedConsole() {
  if (console[CONSOLE_PATCH_FLAG]) {
    return;
  }

  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const originalMethod = console[method].bind(console);
    console[method] = (...args) => {
      originalMethod(`[${formatLogTimestamp()}]`, ...args);
    };
  }

  console[CONSOLE_PATCH_FLAG] = true;
}

export function parseJsonFile(text) {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(withoutBom);
}

export function describeError(error) {
  if (!error) {
    return "Unknown error";
  }

  const message = String(error?.message ?? error);
  const causeMessage =
    error?.cause && error.cause !== error
      ? String(error.cause?.message ?? error.cause)
      : "";

  if (causeMessage && causeMessage !== message) {
    return `${message} | cause: ${causeMessage}`;
  }

  return message;
}

function formatLogTimestamp() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";

  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
    "minute"
  )}:${get("second")} ${get("timeZoneName")}`.trim();
}
