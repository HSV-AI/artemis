import { describe, expect, it, vi } from "vitest";
import type { ArtemisRepository } from "../src/repository.js";
import type { ConversationIdentity } from "../src/domain.js";
import type { Logger } from "../src/domain.js";
import type { ScheduledPromptRecord } from "../src/domain.js";
import {
  SCHEDULER_POLL_INTERVAL_MS,
  SCHEDULER_RESPONSE_MAX_ATTEMPTS,
  SchedulerRunner,
  buildSchedulerCorrectionPrompt,
  buildSchedulerPrompt,
  dueOccurrence,
  parseScheduledResponse
} from "../src/scheduler-runner.js";
import { createLoggerMock } from "./helpers.js";

const CONVERSATION: ConversationIdentity = {
  key: "guild:g1:channel:c1",
  kind: "guild",
  guildId: "g1",
  channelId: "c1"
};

function job(overrides: Partial<ScheduledPromptRecord> = {}): ScheduledPromptRecord {
  return {
    id: overrides.id ?? "job-1",
    conversationKey: overrides.conversationKey ?? CONVERSATION.key,
    prompt: overrides.prompt ?? "Say good morning",
    schedule: overrides.schedule ?? { type: "daily", time: "09:15", timezone: "America/Chicago" },
    responseType: overrides.responseType ?? "message",
    scheduledByUserId: overrides.scheduledByUserId ?? "user-1",
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? "2026-08-30T14:00:00.000Z",
    ...(overrides.lastRunAt ? { lastRunAt: overrides.lastRunAt } : {}),
    ...(overrides.cancelledAt ? { cancelledAt: overrides.cancelledAt } : {})
  };
}

interface RepositoryCalls {
  listActiveScheduledPrompts: ReturnType<typeof vi.fn>;
  markScheduledPromptFired: ReturnType<typeof vi.fn>;
  completeScheduledPrompt: ReturnType<typeof vi.fn>;
  recordEvent: ReturnType<typeof vi.fn>;
}

function repositoryMock(jobs: ScheduledPromptRecord[] = []): RepositoryCalls {
  const stored = [...jobs];
  return {
    listActiveScheduledPrompts: vi.fn(() => stored.filter((entry) => entry.status === "active")),
    markScheduledPromptFired: vi.fn((id: string, firedAtUtc: string) => {
      const target = stored.find((entry) => entry.id === id);
      if (target) {
        target.lastRunAt = firedAtUtc;
      }
    }),
    completeScheduledPrompt: vi.fn((id: string, completedAtUtc: string) => {
      const target = stored.find((entry) => entry.id === id);
      if (target) {
        target.status = "completed";
        target.lastRunAt = completedAtUtc;
      }
    }),
    recordEvent: vi.fn()
  };
}

function harness(jobs: ScheduledPromptRecord[], nowIso: string, agentText: string) {
  const repository = repositoryMock(jobs);
  const conversations = {
    runExclusive: vi.fn(),
    // The gate (ConversationService.runScheduledPrompt) generates and persists
    // the turn; the engine consumes its unposted result.
    runScheduledPrompt: vi.fn().mockResolvedValue({ text: agentText, model: "test-model" }),
    runScheduledPromptInline: vi.fn().mockResolvedValue({ text: agentText, model: "test-model" })
  };
  const dispatcher = { sendToConversation: vi.fn().mockResolvedValue(true) };
  const logger: Logger = createLoggerMock();
  const at = new Date(nowIso);
  const runner = new SchedulerRunner({
    repository: repository as unknown as ArtemisRepository,
    conversations: conversations as unknown as ConstructorParameters<typeof SchedulerRunner>[0]["conversations"],
    dispatcher: dispatcher as unknown as ConstructorParameters<typeof SchedulerRunner>[0]["dispatcher"],
    logger,
    now: () => new Date(at.getTime())
  });
  return { runner, repository, conversations, dispatcher, logger };
}

function immediateHarness(
  record: ScheduledPromptRecord,
  options: {
    /** Resolved value of the inline gate; defaults to a valid message JSON reply. */
    inlineResult?: { text: string; model: string } | null | Error;
    dispatcherResult?: boolean;
    now?: string;
  } = {}
) {
  const repository = repositoryMock([record]);
  const conversations = {
    runExclusive: vi.fn(),
    runScheduledPrompt: vi.fn(),
    runScheduledPromptInline: vi.fn(async () => {
      if (options.inlineResult instanceof Error) {
        throw options.inlineResult;
      }
      if (options.inlineResult === null) {
        return null;
      }
      return options.inlineResult ?? {
        text: '{"type":"message","content":"Good morning!"}',
        model: "test-model"
      };
    })
  };
  const dispatcher = {
    sendToConversation: vi.fn().mockResolvedValue(options.dispatcherResult ?? true)
  };
  const logger: Logger = createLoggerMock();
  const at = new Date(options.now ?? "2026-08-30T14:20:00.000Z");
  const runner = new SchedulerRunner({
    repository: repository as unknown as ArtemisRepository,
    conversations: conversations as unknown as ConstructorParameters<typeof SchedulerRunner>[0]["conversations"],
    dispatcher: dispatcher as unknown as ConstructorParameters<typeof SchedulerRunner>[0]["dispatcher"],
    logger,
    now: () => new Date(at.getTime())
  });
  return { runner, repository, conversations, dispatcher, logger };
}

describe("parseScheduledResponse", () => {
  it("accepts a message response and trims the content", () => {
    expect(parseScheduledResponse('{"type":"message","content":"  Good morning!  "}')).toEqual({
      outcome: "message",
      content: "Good morning!"
    });
  });

  it("accepts a silent response", () => {
    expect(parseScheduledResponse('{"type":"silent"}')).toEqual({ outcome: "silent" });
  });

  it("accepts an object wrapped in a single code fence", () => {
    expect(parseScheduledResponse('```json\n{"type":"message","content":"Hi"}\n```')).toEqual({
      outcome: "message",
      content: "Hi"
    });
    expect(parseScheduledResponse('```\n{"type":"silent"}\n```')).toEqual({ outcome: "silent" });
  });

  it("ignores extra unknown fields on a valid response", () => {
    expect(parseScheduledResponse('{"type":"silent","note":"done"}')).toEqual({ outcome: "silent" });
  });

  it("rejects non-JSON and malformed payloads", () => {
    expect(parseScheduledResponse("Good morning everyone!")).toBeUndefined();
    expect(parseScheduledResponse("")).toBeUndefined();
    expect(parseScheduledResponse("   ")).toBeUndefined();
    expect(parseScheduledResponse('{"type":"message","content":')).toBeUndefined();
  });

  it("rejects objects without a valid type", () => {
    expect(parseScheduledResponse("{}")).toBeUndefined();
    expect(parseScheduledResponse('{"type":"email"}')).toBeUndefined();
    expect(parseScheduledResponse('{"content":"no type"}')).toBeUndefined();
  });

  it("rejects message responses without non-empty string content", () => {
    expect(parseScheduledResponse('{"type":"message"}')).toBeUndefined();
    expect(parseScheduledResponse('{"type":"message","content":""}')).toBeUndefined();
    expect(parseScheduledResponse('{"type":"message","content":"   "}')).toBeUndefined();
    expect(parseScheduledResponse('{"type":"message","content":42}')).toBeUndefined();
  });

  it("rejects arrays, null, numbers, and JSON with surrounding commentary", () => {
    expect(parseScheduledResponse('["message"]')).toBeUndefined();
    expect(parseScheduledResponse("null")).toBeUndefined();
    expect(parseScheduledResponse("42")).toBeUndefined();
    expect(parseScheduledResponse('Here you go: {"type":"silent"}')).toBeUndefined();
    expect(parseScheduledResponse('{"type":"silent"} thanks!')).toBeUndefined();
  });
});

describe("buildSchedulerPrompt", () => {
  it("frames the stored prompt with the strict JSON response contract", () => {
    const prompt = buildSchedulerPrompt("Post the standup reminder");
    expect(prompt).toContain("Post the standup reminder");
    expect(prompt).toContain('"type":"message","content":');
    expect(prompt).toContain('{"type":"silent"}');
    expect(prompt).toContain("No Discord user");
  });
});

describe("buildSchedulerCorrectionPrompt", () => {
  it("names both valid response shapes and the required content field", () => {
    const prompt = buildSchedulerCorrectionPrompt();
    expect(prompt).toContain('"type":"message","content":');
    expect(prompt).toContain('"type":"silent"');
    expect(prompt).toContain("content");
  });

  it("demands a JSON-only reply with no prose or code fences", () => {
    const prompt = buildSchedulerCorrectionPrompt();
    expect(prompt).toContain("JSON object");
    expect(prompt).toContain("no code fences");
    expect(prompt).toContain("no commentary");
  });
});

describe("SCHEDULER_RESPONSE_MAX_ATTEMPTS", () => {
  it("caps the agent at three tries per fired occurrence", () => {
    expect(SCHEDULER_RESPONSE_MAX_ATTEMPTS).toBe(3);
  });
});

describe("dueOccurrence", () => {
  it("returns the stored instant for a one-time schedule once it is due", () => {
    const due = dueOccurrence(
      job({ schedule: { type: "once", atUtc: "2026-08-30T14:00:00.000Z" } }),
      new Date("2026-08-30T14:30:00.000Z")
    );
    expect(due?.toISOString()).toBe("2026-08-30T14:00:00.000Z");
  });

  it("returns undefined for a one-time schedule in the future", () => {
    const due = dueOccurrence(
      job({ schedule: { type: "once", atUtc: "2026-09-01T14:00:00.000Z" } }),
      new Date("2026-08-30T14:30:00.000Z")
    );
    expect(due).toBeUndefined();
  });

  it("resolves a daily occurrence from creation when never run", () => {
    const due = dueOccurrence(
      job({ createdAt: "2026-08-30T14:00:00.000Z" }),
      new Date("2026-08-30T14:20:00.000Z")
    );
    expect(due?.toISOString()).toBe("2026-08-30T14:15:00.000Z");
  });

  it("resolves the next occurrence from lastRunAt when the job has run before", () => {
    const due = dueOccurrence(
      job({ createdAt: "2026-08-29T13:00:00.000Z", lastRunAt: "2026-08-29T14:20:00.001Z" }),
      new Date("2026-08-30T14:20:00.500Z")
    );
    expect(due?.toISOString()).toBe("2026-08-30T14:15:00.000Z");
  });

  it("returns undefined for an unparseable schedule", () => {
    expect(dueOccurrence(job({ schedule: { type: "daily", time: "aa:bb", timezone: "UTC" } }),
      new Date("2026-08-30T14:30:00.000Z"))).toBeUndefined();
  });

  it("returns undefined when the stored base timestamp is invalid", () => {
    expect(dueOccurrence(job({ createdAt: "not-a-date" }), new Date("2026-08-30T14:30:00.000Z")))
      .toBeUndefined();
  });

  it("resolves a cron job's due weekday occurrence from creation", () => {
    const weekdays = {
      type: "cron" as const,
      cron: "15 9 * * 1-5",
      timezone: "America/Chicago"
    };
    // Created Friday 2026-08-28 17:00 CDT: Monday 09:15 CDT is the next due
    // occurrence; it is not due before then.
    expect(dueOccurrence(
      job({ schedule: weekdays, createdAt: "2026-08-28T22:00:00.000Z" }),
      new Date("2026-08-30T14:30:00.000Z")
    )).toBeUndefined();
    expect(dueOccurrence(
      job({ schedule: weekdays, createdAt: "2026-08-28T22:00:00.000Z" }),
      new Date("2026-08-31T14:30:00.000Z")
    )?.toISOString()).toBe("2026-08-31T14:15:00.000Z");
  });

  it("re-arms a cron job from its last run to the next weekday occurrence", () => {
    const due = dueOccurrence(
      job({
        schedule: { type: "cron", cron: "15 9 * * 1-5", timezone: "America/Chicago" },
        createdAt: "2026-08-28T22:00:00.000Z",
        lastRunAt: "2026-08-31T14:20:00.001Z"
      }),
      new Date("2026-09-01T14:20:00.500Z")
    );
    expect(due?.toISOString()).toBe("2026-09-01T14:15:00.000Z");
  });
});

describe("SchedulerRunner", () => {
  it("fires a due one-time message job through the authorization gate, posts the content, and completes the job", async () => {
    const scheduled = job({ schedule: { type: "once", atUtc: "2026-08-30T14:00:00.000Z" } });
    const { runner, repository, conversations, dispatcher, logger } = harness([scheduled],
      "2026-08-30T14:30:00.000Z",
      '{"type":"message","content":"Good morning!"}');
    await runner.runOnce();

    expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(1);
    expect(conversations.runScheduledPrompt).toHaveBeenCalledWith(scheduled);
    // The occurrence is consumed before the gate runs so a crash mid-turn
    // cannot double-post.
    const consumeOrder = repository.completeScheduledPrompt.mock.invocationCallOrder[0];
    const gateOrder = conversations.runScheduledPrompt.mock.invocationCallOrder[0];
    expect(consumeOrder).toBeDefined();
    expect(gateOrder).toBeDefined();
    if (consumeOrder === undefined || gateOrder === undefined) {
      return;
    }
    expect(consumeOrder).toBeLessThan(gateOrder);
    expect(dispatcher.sendToConversation).toHaveBeenCalledWith(CONVERSATION, "Good morning!");
    expect(repository.recordEvent).toHaveBeenCalledWith(
      "scheduled_prompt_fired",
      expect.objectContaining({
        conversationKey: CONVERSATION.key,
        details: expect.objectContaining({ jobId: "job-1", outcome: "posted" })
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "scheduled_prompt_fired",
      expect.objectContaining({ jobId: "job-1", outcome: "posted" })
    );
  });

  it("does not fire a one-time job scheduled in the future", async () => {
    const { runner, dispatcher, repository, conversations } = harness(
      [job({ schedule: { type: "once", atUtc: "2026-09-01T14:00:00.000Z" } })],
      "2026-08-30T14:30:00.000Z",
      '{"type":"message","content":"later"}'
    );
    await runner.runOnce();
    expect(conversations.runScheduledPrompt).not.toHaveBeenCalled();
    expect(dispatcher.sendToConversation).not.toHaveBeenCalled();
    expect(repository.completeScheduledPrompt).not.toHaveBeenCalled();
  });

  it("runs a due daily job, posts the content, and re-arms via lastRunAt", async () => {
    const { runner, repository, conversations } = harness(
      [job({ createdAt: "2026-08-30T14:00:00.000Z" })],
      "2026-08-30T14:20:00.000Z",
      '{"type":"message","content":"Morning!"}'
    );
    await runner.runOnce();
    expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(1);
    expect(repository.markScheduledPromptFired).toHaveBeenCalledWith("job-1", "2026-08-30T14:20:00.001Z");
    expect(repository.completeScheduledPrompt).not.toHaveBeenCalled();

    await runner.runOnce();
    expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(1);
  });

  it("fires a due cron job once with at-most-once re-arm and never completes it", async () => {
    // Created Friday 2026-08-28 17:00 CDT; the next weekday occurrence is
    // Monday 2026-08-31 09:15 CDT.
    const cronJob = job({
      schedule: { type: "cron", cron: "15 9 * * 1-5", timezone: "America/Chicago" },
      createdAt: "2026-08-28T22:00:00.000Z"
    });
    const repository = repositoryMock([cronJob]);
    const conversations = {
      runExclusive: vi.fn(),
      runScheduledPrompt: vi.fn().mockResolvedValue({
        text: '{"type":"message","content":"Monday standup!"}',
        model: "test-model"
      }),
      runScheduledPromptInline: vi.fn()
    };
    const dispatcher = { sendToConversation: vi.fn().mockResolvedValue(true) };
    const clock = { value: new Date("2026-08-30T14:30:00.000Z") };
    const runner = new SchedulerRunner({
      repository: repository as unknown as ArtemisRepository,
      conversations: conversations as never,
      dispatcher: dispatcher as never,
      logger: createLoggerMock(),
      now: () => new Date(clock.value.getTime())
    });

    // Saturday: the next weekday occurrence is still in the future.
    await runner.runOnce();
    expect(conversations.runScheduledPrompt).not.toHaveBeenCalled();
    expect(dispatcher.sendToConversation).not.toHaveBeenCalled();

    // Monday after the occurrence: fires, re-arms via lastRunAt, never completes.
    clock.value = new Date("2026-08-31T14:30:00.000Z");
    await runner.runOnce();
    expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(1);
    expect(repository.markScheduledPromptFired).toHaveBeenCalledWith("job-1", "2026-08-31T14:30:00.001Z");
    expect(repository.completeScheduledPrompt).not.toHaveBeenCalled();
    expect(dispatcher.sendToConversation).toHaveBeenCalledWith(CONVERSATION, "Monday standup!");

    // The re-armed job is not due again on Monday; its next run is Tuesday.
    await runner.runOnce();
    expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(1);
  });

  it("re-arms a weekly job with DST-correct next occurrences", async () => {
    // Sunday 2026-10-25 09:15 America/Chicago = 14:15:00Z (CDT). After firing,
    // the next occurrence is Sunday 2026-11-01 09:15 CST = 15:15:00Z.
    const weekly = job({
      schedule: { type: "weekly", time: "09:15", dayOfWeek: 0, timezone: "America/Chicago" },
      createdAt: "2026-10-25T13:00:00.000Z"
    });
    const repository = repositoryMock([weekly]);
    const conversations = {
      runExclusive: vi.fn(),
      runScheduledPrompt: vi.fn().mockResolvedValue({ text: '{"type":"silent"}', model: "m" })
    };
    const clock = { value: new Date("2026-10-25T14:20:00.000Z") };
    const runner = new SchedulerRunner({
      repository: repository as unknown as ArtemisRepository,
      conversations: conversations as never,
      dispatcher: { sendToConversation: vi.fn().mockResolvedValue(true) } as never,
      logger: createLoggerMock(),
      now: () => new Date(clock.value.getTime())
    });

    await runner.runOnce();
    expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(1);
    clock.value = new Date("2026-10-31T20:00:00.000Z");
    await runner.runOnce();
    expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(1);
    clock.value = new Date("2026-11-01T15:20:00.000Z");
    await runner.runOnce();
    expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(2);
  });

  it("collapses a week of missed daily occurrences into a single late run", async () => {
    const { runner, conversations } = harness(
      [job({ createdAt: "2026-08-24T13:00:00.000Z" })],
      "2026-08-29T16:00:00.000Z",
      '{"type":"silent"}'
    );
    await runner.runOnce();
    expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(1);
  });

  it("skips a daily job before today's occurrence and one re-armed ahead of its next run", async () => {
    const { runner, conversations } = harness(
      [job({ createdAt: "2026-08-29T14:20:00.000Z" })],
      "2026-08-30T13:00:00.000Z",
      '{"type":"silent"}'
    );
    await runner.runOnce();
    expect(conversations.runScheduledPrompt).not.toHaveBeenCalled();
  });

  it("runs a silent one-time job through the gate, posts nothing, and completes it", async () => {
    const { runner, dispatcher, repository } = harness(
      [
        job({
          responseType: "silent",
          schedule: { type: "once", atUtc: "2026-08-30T14:00:00.000Z" }
        })
      ],
      "2026-08-30T14:30:00.000Z",
      '{"type":"silent"}'
    );
    await runner.runOnce();
    expect(repository.completeScheduledPrompt).toHaveBeenCalledWith("job-1", "2026-08-30T14:30:00.000Z");
    expect(dispatcher.sendToConversation).not.toHaveBeenCalled();
    expect(repository.recordEvent).toHaveBeenCalledWith(
      "scheduled_prompt_fired",
      expect.objectContaining({
        details: expect.objectContaining({ jobId: "job-1", outcome: "silent" })
      })
    );
  });

  it("posts nothing and logs an error when the agent response is not valid JSON", async () => {
    const { runner, dispatcher, repository, conversations, logger } = harness(
      [job({ createdAt: "2026-08-30T14:00:00.000Z" })],
      "2026-08-30T14:20:00.000Z",
      "Good morning everyone, quick reminder!"
    );
    await runner.runOnce();

    expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendToConversation).not.toHaveBeenCalled();
    // Retry ownership belongs to the gate; the engine submits the job once
    // and refuses to post whatever invalid result comes back.
    expect(logger.error).toHaveBeenCalledWith(
      "scheduled_prompt_invalid_response",
      expect.objectContaining({ jobId: "job-1", conversationKey: CONVERSATION.key })
    );
    expect(repository.recordEvent).toHaveBeenCalledWith(
      "scheduled_prompt_invalid_response",
      expect.objectContaining({
        conversationKey: CONVERSATION.key,
        details: expect.objectContaining({
          jobId: "job-1",
          responsePreview: "Good morning everyone, quick reminder!"
        })
      })
    );
    // The occurrence is still consumed so an invalid response cannot retry-storm.
    expect(repository.markScheduledPromptFired).toHaveBeenCalled();
  });

  it("posts nothing when the authorization gate denies or fails the run", async () => {
    const repository = repositoryMock([job({ createdAt: "2026-08-30T14:00:00.000Z" })]);
    const conversations = {
      runExclusive: vi.fn(),
      runScheduledPrompt: vi.fn().mockResolvedValue(null)
    };
    const dispatcher = { sendToConversation: vi.fn().mockResolvedValue(true) };
    const logger = createLoggerMock();
    const runner = new SchedulerRunner({
      repository: repository as unknown as ArtemisRepository,
      conversations: conversations as never,
      dispatcher: dispatcher as never,
      logger,
      now: () => new Date("2026-08-30T14:20:00.000Z")
    });

    await runner.runOnce();
    // Denied or failed runs return null already logged by the gate; the
    // engine posts nothing and does not double-log an invalid response.
    expect(dispatcher.sendToConversation).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(repository.recordEvent).not.toHaveBeenCalledWith(
      "scheduled_prompt_invalid_response",
      expect.anything()
    );
   });
 
   it("logs a failure, posts nothing, and consumes the occurrence when delivery fails", async () => {
    const repository = repositoryMock([job({ createdAt: "2026-08-30T14:00:00.000Z" })]);
    const conversations = {
      runExclusive: vi.fn(),
      runScheduledPrompt: vi.fn().mockResolvedValue({
        text: '{"type":"message","content":"hello"}',
        model: "m"
      })
    };
    const dispatcher = { sendToConversation: vi.fn().mockResolvedValue(false) };
    const logger = createLoggerMock();
    const runner = new SchedulerRunner({
      repository: repository as unknown as ArtemisRepository,
      conversations: conversations as never,
      dispatcher: dispatcher as never,
      logger,
      now: () => new Date("2026-08-30T14:20:00.000Z")
    });

    await runner.runOnce();
    expect(dispatcher.sendToConversation).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "scheduled_prompt_failed",
      expect.objectContaining({
        jobId: "job-1",
        errorMessage: "Scheduler response could not be delivered to the channel"
      })
    );
    expect(repository.recordEvent).toHaveBeenCalledWith(
      "scheduled_prompt_failed",
      expect.objectContaining({ details: expect.objectContaining({ jobId: "job-1" }) })
    );
  });

  it("logs an error and posts nothing when the conversation key cannot be routed", async () => {
    const { runner, repository, conversations, dispatcher, logger } = harness(
      [job({ id: "job-bad", conversationKey: "not-a-conversation-key" })],
      "2026-08-30T14:20:00.000Z",
      '{"type":"message","content":"hello"}'
    );
    await runner.runOnce();
    expect(dispatcher.sendToConversation).not.toHaveBeenCalled();
    expect(repository.recordEvent).not.toHaveBeenCalledWith(
      "scheduled_prompt_fired",
      expect.anything()
    );
    expect(logger.error).toHaveBeenCalledWith(
      "scheduled_prompt_unroutable",
      expect.objectContaining({ jobId: "job-bad", conversationKey: "not-a-conversation-key" })
    );
    expect(conversations.runScheduledPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-bad" })
    );
    expect(repository.markScheduledPromptFired).toHaveBeenCalledWith("job-bad", "2026-08-30T14:20:00.001Z");
  });

  it("defers firing while Discord is not ready and leaves the occurrence unconsumed", async () => {
    const scheduled = job({ schedule: { type: "once", atUtc: "2026-08-30T14:00:00.000Z" } });
    const repository = repositoryMock([scheduled]);
    const conversations = {
      runExclusive: vi.fn(),
      runScheduledPrompt: vi.fn().mockResolvedValue(null)
    };
    const dispatcher = { sendToConversation: vi.fn().mockResolvedValue(true) };
    const logger = createLoggerMock();
    const ready = () => false;
    const runner = new SchedulerRunner({
      repository: repository as unknown as ArtemisRepository,
      conversations: conversations as never,
      dispatcher: dispatcher as never,
      logger,
      now: () => new Date("2026-08-30T14:30:00.000Z"),
      ready
    });

    await runner.runOnce();
    await runner.runOnce(); // repeated ticks stay deferred

    // Nothing runs pre-ready: no listing, no consumption, no generation, no
    // post. The occurrence is still due and the next ready tick takes it.
    expect(repository.listActiveScheduledPrompts).not.toHaveBeenCalled();
    expect(repository.completeScheduledPrompt).not.toHaveBeenCalled();
    expect(conversations.runScheduledPrompt).not.toHaveBeenCalled();
    expect(dispatcher.sendToConversation).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      "scheduler_deferred_not_ready",
      expect.anything()
    );
  });

  it("fires a due one-time job and posts its valid JSON response once Discord becomes ready", async () => {
    const scheduled = job({ schedule: { type: "once", atUtc: "2026-08-30T14:00:00.000Z" } });
    const repository = repositoryMock([scheduled]);
    const conversations = {
      runExclusive: vi.fn(),
      runScheduledPrompt: vi.fn().mockResolvedValue({
        text: '{"type":"message","content":"Good morning!"}',
        model: "test-model"
      })
    };
    const dispatcher = { sendToConversation: vi.fn().mockResolvedValue(true) };
    const logger = createLoggerMock();
    let ready = false;
    const runner = new SchedulerRunner({
      repository: repository as unknown as ArtemisRepository,
      conversations: conversations as never,
      dispatcher: dispatcher as never,
      logger,
      now: () => new Date("2026-08-30T14:30:00.000Z"),
      ready: () => ready
    });

    await runner.runOnce(); // still deferred pre-ready
    ready = true;
    await runner.runOnce(); // ready tick runs the full chained regression

    expect(repository.completeScheduledPrompt).toHaveBeenCalledTimes(1);
    expect(conversations.runScheduledPrompt).toHaveBeenCalledWith(scheduled);
    expect(dispatcher.sendToConversation).toHaveBeenCalledWith(CONVERSATION, "Good morning!");
    expect(repository.recordEvent).toHaveBeenCalledWith(
      "scheduled_prompt_fired",
      expect.objectContaining({
        conversationKey: CONVERSATION.key,
        details: expect.objectContaining({ jobId: "job-1", outcome: "posted" })
      })
    );
  });

  it("leaves the job due when consuming the occurrence fails in storage", async () => {
    const repository = repositoryMock([job({ createdAt: "2026-08-30T14:00:00.000Z" })]);
    repository.markScheduledPromptFired.mockImplementation(() => {
      throw new Error("disk full");
    });
    const conversations = {
      runExclusive: vi.fn(),
      runScheduledPrompt: vi.fn().mockResolvedValue({ text: '{"type":"silent"}', model: "m" })
    };
    const logger = createLoggerMock();
    const runner = new SchedulerRunner({
      repository: repository as unknown as ArtemisRepository,
      conversations: conversations as never,
      dispatcher: { sendToConversation: vi.fn().mockResolvedValue(true) } as never,
      logger,
      now: () => new Date("2026-08-30T14:20:00.000Z")
    });

    await runner.runOnce();
    expect(conversations.runScheduledPrompt).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "scheduled_prompt_state_failed",
      expect.objectContaining({ jobId: "job-1", errorMessage: "disk full" })
    );
  });

  it("does not fire a silent daily job twice from one stored state", async () => {
    const { runner, conversations } = harness(
      [job({ responseType: "silent" })],
      "2026-08-30T14:20:00.000Z",
      '{"type":"silent"}'
    );
    await runner.runOnce();
    await runner.runOnce();
    expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(1);
  });

  it("polls immediately after start and on each interval tick, skipping busy ticks", async () => {
    vi.useFakeTimers();
    try {
      const scheduled = job({ responseType: "silent" });
      const repository = repositoryMock([scheduled]);
      let release: ((result: { text: string; model: string }) => void) | undefined;
      const conversations = {
        runExclusive: vi.fn(),
        runScheduledPrompt: vi.fn(
          () =>
            new Promise((resolve) => {
              release = resolve;
            })
        )
      };
      const clock = { value: new Date("2026-08-30T14:20:00.000Z") };
      const runner = new SchedulerRunner({
        repository: repository as unknown as ArtemisRepository,
        conversations: conversations as never,
        dispatcher: { sendToConversation: vi.fn().mockResolvedValue(true) } as never,
        logger: createLoggerMock(),
        now: () => new Date(clock.value.getTime())
      });

      runner.start();
      await vi.advanceTimersByTimeAsync(0); // the immediate catch-up poll runs
      expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_INTERVAL_MS);
      expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(1); // tick while in flight is skipped

      release?.({ text: '{"type":"silent"}', model: "m" });
      clock.value = new Date("2026-08-31T14:20:00.000Z"); // advance past the next occurrence
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_INTERVAL_MS);
      expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(2); // next tick fires again

      runner.stop();
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_INTERVAL_MS);
      expect(conversations.runScheduledPrompt).toHaveBeenCalledTimes(2); // no polling after stop
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("SchedulerRunner.runScheduledTaskNow", () => {
  it("runs an active job immediately: consumes the occurrence, uses the inline gate, posts, and reports posted", async () => {
    const scheduled = job({ id: "job-now", schedule: { type: "once", atUtc: "2026-09-01T14:00:00.000Z" } });
    const { runner, repository, conversations, dispatcher, logger } = immediateHarness(scheduled, {
      inlineResult: { text: '{"type":"message","content":"On demand!"}', model: "test-model" },
      now: "2026-08-30T15:00:00.000Z"
    });

    await expect(runner.runScheduledTaskNow(scheduled)).resolves.toEqual({
      status: "posted",
      content: "On demand!"
    });

    // The occurrence is consumed first, exactly like an engine fire: a
    // one-time job completes at the run instant and never fires again.
    expect(repository.completeScheduledPrompt).toHaveBeenCalledWith(
      "job-now",
      "2026-08-30T15:00:00.000Z"
    );
    expect(conversations.runScheduledPromptInline).toHaveBeenCalledTimes(1);
    expect(conversations.runScheduledPromptInline).toHaveBeenCalledWith(scheduled);
    expect(conversations.runScheduledPrompt).not.toHaveBeenCalled();
    const consumeOrder = repository.completeScheduledPrompt.mock.invocationCallOrder[0];
    const gateOrder = conversations.runScheduledPromptInline.mock.invocationCallOrder[0];
    expect(consumeOrder).toBeDefined();
    expect(gateOrder).toBeDefined();
    if (consumeOrder === undefined || gateOrder === undefined) {
      return;
    }
    expect(consumeOrder).toBeLessThan(gateOrder);
    expect(dispatcher.sendToConversation).toHaveBeenCalledWith(CONVERSATION, "On demand!");
    expect(repository.recordEvent).toHaveBeenCalledWith(
      "scheduled_prompt_fired",
      expect.objectContaining({
        conversationKey: CONVERSATION.key,
        details: expect.objectContaining({ jobId: "job-now", outcome: "posted", trigger: "on-demand" })
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "scheduled_prompt_fired",
      expect.objectContaining({ jobId: "job-now", outcome: "posted", trigger: "on-demand" })
    );
  });

  it("re-arms a recurring job like an engine fire", async () => {
    const recurring = job({ id: "job-daily", createdAt: "2026-08-30T14:00:00.000Z" });
    const { runner, repository } = immediateHarness(recurring, {
      inlineResult: { text: '{"type":"silent"}', model: "m" },
      now: "2026-08-30T15:00:00.000Z"
    });

    await expect(runner.runScheduledTaskNow(recurring)).resolves.toEqual({ status: "silent" });
    expect(repository.markScheduledPromptFired).toHaveBeenCalledWith(
      "job-daily",
      "2026-08-30T15:00:00.001Z"
    );
    expect(repository.completeScheduledPrompt).not.toHaveBeenCalled();
  });

  it("posts nothing on a silent response and reports silent", async () => {
    const scheduled = job({ id: "job-silent", responseType: "silent" });
    const { runner, dispatcher, repository } = immediateHarness(scheduled, {
      inlineResult: { text: '{"type":"silent"}', model: "m" }
    });

    await expect(runner.runScheduledTaskNow(scheduled)).resolves.toEqual({ status: "silent" });
    expect(dispatcher.sendToConversation).not.toHaveBeenCalled();
    expect(repository.recordEvent).toHaveBeenCalledWith(
      "scheduled_prompt_fired",
      expect.objectContaining({
        details: expect.objectContaining({ jobId: "job-silent", outcome: "silent", trigger: "on-demand" })
      })
    );
  });

  it("posts nothing on an invalid response, records the event, and reports invalid-response", async () => {
    const scheduled = job({ id: "job-invalid" });
    const { runner, dispatcher, repository, logger } = immediateHarness(scheduled, {
      inlineResult: { text: "Not JSON at all", model: "m" }
    });

    await expect(runner.runScheduledTaskNow(scheduled)).resolves.toEqual({
      status: "invalid-response",
      responsePreview: "Not JSON at all"
    });
    expect(dispatcher.sendToConversation).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "scheduled_prompt_invalid_response",
      expect.objectContaining({ jobId: "job-invalid" })
    );
    expect(repository.recordEvent).toHaveBeenCalledWith(
      "scheduled_prompt_invalid_response",
      expect.objectContaining({ details: expect.objectContaining({ jobId: "job-invalid" }) })
    );
  });

  it("reports not-run without posting when the inline gate denies or fails the run", async () => {
    const scheduled = job({ id: "job-denied" });
    const { runner, dispatcher, logger, repository } = immediateHarness(scheduled, {
      inlineResult: null
    });

    await expect(runner.runScheduledTaskNow(scheduled)).resolves.toEqual({ status: "not-run" });
    expect(dispatcher.sendToConversation).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(repository.recordEvent).not.toHaveBeenCalledWith(
      "scheduled_prompt_invalid_response",
      expect.anything()
    );
  });

  it("logs a failure and reports undelivered when delivery fails", async () => {
    const scheduled = job({ id: "job-drop" });
    const { runner, dispatcher, repository, logger } = immediateHarness(scheduled, {
      dispatcherResult: false
    });

    await expect(runner.runScheduledTaskNow(scheduled)).resolves.toEqual({ status: "undelivered" });
    expect(dispatcher.sendToConversation).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "scheduled_prompt_failed",
      expect.objectContaining({
        jobId: "job-drop",
        errorMessage: "Scheduler response could not be delivered to the channel"
      })
    );
    expect(repository.recordEvent).toHaveBeenCalledWith(
      "scheduled_prompt_failed",
      expect.objectContaining({ details: expect.objectContaining({ jobId: "job-drop" }) })
    );
  });

  it("reports undelivered for an unresolvable stored conversation key", async () => {
    const scheduled = job({ id: "job-unroutable", conversationKey: "not-a-key" });
    const { runner, dispatcher, logger } = immediateHarness(scheduled, {});

    await expect(runner.runScheduledTaskNow(scheduled)).resolves.toEqual({ status: "undelivered" });
    expect(dispatcher.sendToConversation).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "scheduled_prompt_unroutable",
      expect.objectContaining({ jobId: "job-unroutable" })
    );
  });

  it("refuses non-active records without consuming or generating", async () => {
    const cancelled = job({ id: "job-cancelled", status: "cancelled", cancelledAt: "2026-08-29T00:00:00.000Z" });
    const { runner, repository, conversations } = immediateHarness(cancelled, {});

    await expect(runner.runScheduledTaskNow(cancelled)).resolves.toEqual({ status: "not-run" });
    expect(repository.completeScheduledPrompt).not.toHaveBeenCalled();
    expect(repository.markScheduledPromptFired).not.toHaveBeenCalled();
    expect(conversations.runScheduledPromptInline).not.toHaveBeenCalled();
  });

  it("reports not-run when consuming the occurrence fails in storage", async () => {
    const scheduled = job({ id: "job-disk" });
    const { runner, repository, conversations, logger } = immediateHarness(scheduled, {});
    repository.markScheduledPromptFired.mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(runner.runScheduledTaskNow(scheduled)).resolves.toEqual({ status: "not-run" });
    expect(conversations.runScheduledPromptInline).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "scheduled_prompt_state_failed",
      expect.objectContaining({ jobId: "job-disk", errorMessage: "disk full" })
    );
  });

  it("reports not-run when the inline gate throws, instead of rejecting the tool call", async () => {
    const scheduled = job({ id: "job-throw" });
    const { runner, repository, logger } = immediateHarness(scheduled, {
      inlineResult: new Error("model offline")
    });

    await expect(runner.runScheduledTaskNow(scheduled)).resolves.toEqual({ status: "not-run" });
    expect(logger.error).toHaveBeenCalledWith(
      "scheduled_prompt_failed",
      expect.objectContaining({ jobId: "job-throw", errorMessage: "model offline" })
    );
    expect(repository.recordEvent).toHaveBeenCalledWith(
      "scheduled_prompt_failed",
      expect.objectContaining({ details: expect.objectContaining({ jobId: "job-throw" }) })
    );
  });
});
