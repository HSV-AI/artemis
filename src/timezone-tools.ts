import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChannelTimezoneStore } from "./domain.js";

export interface ChannelTimezoneToolContext {
  /** Stable conversation key. Injected by the harness from Discord identity. */
  conversationKey: string;
}

export interface ZonedInstant {
  /** Offset-qualified local ISO-8601 timestamp, e.g. `2026-08-29T09:15:00-05:00`. */
  local: string;
  /** Numeric UTC offset, e.g. `-05:00`. */
  offset: string;
  /** Locale zone abbreviation, e.g. `CDT`. */
  abbreviation: string;
  /** Abbreviated weekday of the local date, e.g. `Sat`. */
  weekday: string;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/**
 * Whether the runtime recognizes the candidate as a valid IANA timezone
 * identifier. Malformed input (blank text, whitespace, control characters)
 * is rejected, so validated identifiers are safe to echo back.
 */
export function isValidTimezone(candidate: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

/**
 * Render one instant in a timezone: an offset-qualified local ISO-8601
 * timestamp plus the numeric offset, zone abbreviation, and weekday.
 * Daylight saving time is resolved by the runtime for the exact instant.
 */
export function formatZonedInstant(instant: Date, timeZone: string): ZonedInstant {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPart["type"]): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const localWithoutOffset =
    `${value("year")}-${value("month")}-${value("day")}` +
    `T${value("hour")}:${value("minute")}:${value("second")}`;
  const offset = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")
    ?.value?.replace(/^GMT/, "") || "+00:00";
  const abbreviation = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")
    ?.value ?? "UTC";
  return {
    local: `${localWithoutOffset}${offset}`,
    offset,
    abbreviation,
    weekday: value("weekday")
  };
}

function zoneSummaryLine(timezone: string, instant: Date): string {
  const zoned = formatZonedInstant(instant, timezone);
  return `Timezone: ${timezone} (UTC${zoned.offset}, ${zoned.abbreviation})`;
}

function invalidTimezoneError(candidate: string): string {
  return (
    `Error: "${candidate}" is not a valid IANA timezone identifier. ` +
    "Use an identifier like America/Chicago, Europe/Berlin, or UTC."
  );
}

function missingTimezoneError(): string {
  return (
    "Error: an IANA timezone identifier is required, e.g. America/Chicago or Europe/Berlin."
  );
}

/**
 * Create the channel timezone tools. The conversation identity comes from the
 * context built by the harness (see {@link ChannelTimezoneToolContext}); tool
 * parameters never influence which conversation is read or written, so the
 * model can only manage the timezone of the channel it is actually in.
 */
export function createChannelTimezoneTools(
  store: ChannelTimezoneStore,
  context: ChannelTimezoneToolContext,
  now: () => Date = () => new Date()
) {
  const setChannelTimezone = defineTool({
    name: "set_channel_timezone",
    label: "Set Channel Timezone",
    description:
      "Set this conversation's timezone to an IANA timezone identifier such as America/Chicago.",
    promptSnippet: "Set this conversation's timezone (IANA identifier)",
    promptGuidelines: [
      "Set the timezone only when the current Discord user explicitly asks for it.",
      "Pass a valid IANA timezone identifier; invalid identifiers return an error without changes.",
      "Times stay UTC in storage and scheduling; use get_current_datetime to read the channel-local time."
    ],
    parameters: Type.Object({
      timezone: Type.String({
        description: "IANA timezone identifier, e.g. America/Chicago or Europe/Berlin"
      })
    }),
    async execute(_toolCallId, params) {
      const candidate = params.timezone?.trim() ?? "";
      if (candidate === "") {
        return textResult(missingTimezoneError());
      }
      if (!isValidTimezone(candidate)) {
        return textResult(invalidTimezoneError(candidate));
      }
      store.setChannelTimezone(context.conversationKey, candidate);
      const zoned = formatZonedInstant(now(), candidate);
      return textResult(
        `Channel timezone set to ${candidate} (UTC${zoned.offset}, ${zoned.abbreviation}). ` +
          `Current local time: ${zoned.local} (${zoned.weekday}).`
      );
    }
  });

  const getCurrentDatetime = defineTool({
    name: "get_current_datetime",
    label: "Current Datetime",
    description:
      "Return the current date and time in this conversation's timezone, an explicit timezone, or UTC.",
    promptSnippet: "Fetch the current datetime in this conversation's timezone or UTC",
    promptGuidelines: [
      "Use this tool instead of guessing the current date or time.",
      "The result reports both the UTC instant and the requested timezone's local time."
    ],
    parameters: Type.Object({
      timezone: Type.Optional(Type.String({
        description:
          "Optional IANA timezone identifier for the local rendering; defaults to this conversation's timezone, or UTC when unset"
      }))
    }),
    async execute(_toolCallId, params) {
      const requested = params.timezone?.trim();
      if (requested === "") {
        return textResult(missingTimezoneError());
      }
      if (requested !== undefined && !isValidTimezone(requested)) {
        return textResult(invalidTimezoneError(requested));
      }
      const stored = requested ?? store.getChannelTimezone(context.conversationKey);
      const timezone = stored !== undefined && isValidTimezone(stored) ? stored : "UTC";
      const instant = now();
      const zoned = formatZonedInstant(instant, timezone);
      return textResult(
        `UTC now: ${instant.toISOString()}\n` +
          `${zoneSummaryLine(timezone, instant)}\n` +
          `Local now: ${zoned.local} (${zoned.weekday})`
      );
    }
  });

  return [setChannelTimezone, getCurrentDatetime] as const;
}