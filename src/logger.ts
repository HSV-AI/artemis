import type { LogEntry, LogFields, Logger } from "./domain.js";
import type { LogLevel } from "./config.js";

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class JsonLogger implements Logger {
  public constructor(
    private readonly minimumLevel: LogLevel,
    private readonly write: (line: string) => void = console.log,
    private readonly persist?: (entry: LogEntry) => void
  ) {}

  public debug(event: string, fields?: LogFields): void {
    this.log("debug", event, fields);
  }

  public info(event: string, fields?: LogFields): void {
    this.log("info", event, fields);
  }

  public warn(event: string, fields?: LogFields): void {
    this.log("warn", event, fields);
  }

  public error(event: string, fields?: LogFields): void {
    this.log("error", event, fields);
  }

  private log(level: LogLevel, event: string, fields?: LogFields): void {
    if (priorities[level] < priorities[this.minimumLevel]) {
      return;
    }
    const entry: LogEntry = {
      ...(fields ?? {}),
      timestamp: new Date().toISOString(),
      level,
      event
    };
    this.write(JSON.stringify(entry));
    try {
      this.persist?.(entry);
    } catch (error: unknown) {
      this.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "log_persistence_failed",
          originalEvent: event,
          ...safeError(error)
        })
      );
    }
  }
}

export function safeError(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message };
  }
  return { errorName: "UnknownError", errorMessage: String(error) };
}
