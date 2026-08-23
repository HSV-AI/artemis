export class DgraphHttpError extends Error {
  public constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(`Dgraph ${operation} failed (${status}): ${body}`);
  }
}

interface UpsertMutation {
  set?: Record<string, unknown>[];
  cond?: string;
}

interface UpsertResult {
  uids: Record<string, string>;
  queries: Record<string, unknown[]>;
}

export class DgraphClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly fetchImplementation: typeof fetch = fetch
  ) {}

  public async alter(schema: string): Promise<void> {
    await this.request("/alter", schema, "application/dql");
  }

  public async query<T>(dql: string, variables: Record<string, string>): Promise<T> {
    const result = await this.request("/query", JSON.stringify({ query: dql, variables }));
    return (result as { data: T }).data;
  }

  public async mutate(set: Record<string, unknown>[]): Promise<Record<string, string>> {
    const result = await this.request(
      "/mutate?commitNow=true",
      JSON.stringify({ set })
    ) as { data: { uids?: Record<string, string> } };
    return result.data.uids ?? {};
  }

  public async upsert(query: string, mutations: UpsertMutation[]): Promise<UpsertResult> {
    const result = await this.request(
      "/mutate?commitNow=true",
      JSON.stringify({ query, mutations })
    ) as {
      data: { uids?: Record<string, string>; queries?: Record<string, unknown[]> };
    };
    return {
      uids: result.data.uids ?? {},
      queries: result.data.queries ?? {}
    };
  }

  private async request(
    path: string,
    body: string,
    contentType = "application/json"
  ): Promise<unknown> {
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body
    });
    const text = await response.text();
    if (!response.ok) {
      throw new DgraphHttpError(path, response.status, text);
    }
    const parsed = JSON.parse(text) as { errors?: { message: string }[] };
    if (parsed.errors?.length) {
      throw new DgraphHttpError(
        path,
        response.status,
        parsed.errors.map((error) => error.message).join("; ")
      );
    }
    return parsed;
  }
}

const MEMORY_SCHEMA = `
statement: string @index(fulltext) .
scope_key: string @index(exact) .
subject: string @index(exact) .
author: string .
source_message_id: string @index(exact) .
valid_from: dateTime .
invalid_at: dateTime .
recorded_at: dateTime @index(hour) .
expired_at: dateTime @index(hour) .
ended_reason: string @index(exact) .
supersedes: uid @reverse .

type Fact {
  statement
  scope_key
  subject
  author
  source_message_id
  valid_from
  invalid_at
  recorded_at
  expired_at
  ended_reason
  supersedes
}
`;

export interface MemoryFact {
  uid: string;
  statement: string;
  scope_key: string;
  subject?: string;
  author?: string;
  source_message_id?: string;
  valid_from?: string;
  invalid_at?: string;
  recorded_at: string;
  expired_at?: string;
  ended_reason?: "superseded" | "forgotten";
  supersedes?: { uid: string };
}

export interface RememberInput {
  scopeKey: string;
  statement: string;
  author: string;
  sourceMessageId: string;
  subject?: string;
  validFrom?: Date;
}

export interface MemoryStore {
  remember(input: RememberInput): Promise<string>;
  supersede(scopeKey: string, oldFactUid: string, replacement: RememberInput): Promise<string>;
  forget(scopeKey: string, factUid: string): Promise<void>;
  retrieveCurrent(scopeKey: string): Promise<MemoryFact[]>;
  believedAt(scopeKey: string, at: Date): Promise<MemoryFact[]>;
  listScope(scopeKey: string): Promise<MemoryFact[]>;
}

const FACT_FIELDS = `
  uid
  statement
  scope_key
  subject
  author
  source_message_id
  valid_from
  invalid_at
  recorded_at
  expired_at
  ended_reason
  supersedes { uid }
`;

function dqlString(value: string): string {
  return JSON.stringify(value);
}

function validatedUid(uid: string): string {
  if (!/^0x[0-9a-f]+$/iu.test(uid)) {
    throw new Error(`Invalid Dgraph fact uid: ${uid}`);
  }
  return uid;
}

export class GraphMemory implements MemoryStore {
  public constructor(
    private readonly client: DgraphClient,
    private readonly clock: () => Date = () => new Date()
  ) {}

  public async initialize(): Promise<void> {
    await this.client.alter(MEMORY_SCHEMA);
  }

  public async remember(input: RememberInput): Promise<string> {
    const uids = await this.client.mutate([
      { ...this.factNode(input, this.clock()), uid: "_:fact" }
    ]);
    const uid = uids.fact;
    if (!uid) {
      throw new Error(`Dgraph remember returned no uid: ${JSON.stringify(uids)}`);
    }
    return uid;
  }

  public async supersede(
    scopeKey: string,
    oldFactUid: string,
    replacement: RememberInput
  ): Promise<string> {
    if (replacement.scopeKey !== scopeKey) {
      throw new Error(`Replacement scope ${replacement.scopeKey} does not match ${scopeKey}`);
    }
    const uid = validatedUid(oldFactUid);
    const now = this.clock();
    const query = `
      query {
        target as var(func: uid(${uid})) @filter(type(Fact) AND eq(scope_key, ${dqlString(scopeKey)}) AND NOT has(expired_at))
        found(func: uid(target)) { uid }
      }`;
    const result = await this.client.upsert(query, [
      {
        cond: "@if(eq(len(target), 1))",
        set: [
          {
            uid: "uid(target)",
            expired_at: now.toISOString(),
            invalid_at: now.toISOString(),
            ended_reason: "superseded"
          },
          {
            ...this.factNode(replacement, now),
            uid: "_:fact",
            supersedes: { uid: "uid(target)" }
          }
        ]
      }
    ]);
    if ((result.queries.found ?? []).length !== 1) {
      throw new Error(`Supersede target ${uid} is not an active fact in scope ${scopeKey}`);
    }
    const replacementUid = result.uids.fact;
    if (!replacementUid) {
      throw new Error(`Dgraph supersede returned no uid: ${JSON.stringify(result.uids)}`);
    }
    return replacementUid;
  }

  public async forget(scopeKey: string, factUid: string): Promise<void> {
    const uid = validatedUid(factUid);
    const query = `
      query {
        target as var(func: uid(${uid})) @filter(type(Fact) AND eq(scope_key, ${dqlString(scopeKey)}) AND NOT has(expired_at))
        found(func: uid(target)) { uid }
      }`;
    const result = await this.client.upsert(query, [
      {
        cond: "@if(eq(len(target), 1))",
        set: [
          {
            uid: "uid(target)",
            expired_at: this.clock().toISOString(),
            ended_reason: "forgotten"
          }
        ]
      }
    ]);
    if ((result.queries.found ?? []).length !== 1) {
      throw new Error(`Forget target ${uid} is not an active fact in scope ${scopeKey}`);
    }
  }

  public async retrieveCurrent(scopeKey: string): Promise<MemoryFact[]> {
    const data = await this.client.query<{ facts?: MemoryFact[] }>(
      `query current($scope: string) {
        facts(func: eq(scope_key, $scope), orderasc: recorded_at) @filter(type(Fact) AND NOT has(expired_at)) {
          ${FACT_FIELDS}
        }
      }`,
      { $scope: scopeKey }
    );
    return data.facts ?? [];
  }

  public async believedAt(scopeKey: string, at: Date): Promise<MemoryFact[]> {
    const data = await this.client.query<{ facts?: MemoryFact[] }>(
      `query believed($scope: string, $at: string) {
        facts(func: eq(scope_key, $scope), orderasc: recorded_at)
          @filter(type(Fact) AND le(recorded_at, $at) AND (NOT has(expired_at) OR gt(expired_at, $at))) {
          ${FACT_FIELDS}
        }
      }`,
      { $scope: scopeKey, $at: at.toISOString() }
    );
    return data.facts ?? [];
  }

  public async listScope(scopeKey: string): Promise<MemoryFact[]> {
    const data = await this.client.query<{ facts?: MemoryFact[] }>(
      `query all($scope: string) {
        facts(func: eq(scope_key, $scope), orderasc: recorded_at) @filter(type(Fact)) {
          ${FACT_FIELDS}
        }
      }`,
      { $scope: scopeKey }
    );
    return data.facts ?? [];
  }

  private factNode(input: RememberInput, now: Date): Record<string, unknown> {
    if (!input.scopeKey.trim()) {
      throw new Error("Remember requires a scope key");
    }
    if (!input.statement.trim()) {
      throw new Error("Remember requires a statement");
    }
    if (!input.author.trim()) {
      throw new Error("Remember requires an author");
    }
    if (!input.sourceMessageId.trim()) {
      throw new Error("Remember requires a source message ID");
    }
    return {
      "dgraph.type": "Fact",
      statement: input.statement.trim(),
      scope_key: input.scopeKey,
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      author: input.author,
      source_message_id: input.sourceMessageId,
      valid_from: (input.validFrom ?? now).toISOString(),
      recorded_at: now.toISOString()
    };
  }
}

export const dgraphMemoryInternals = { dqlString, validatedUid };
