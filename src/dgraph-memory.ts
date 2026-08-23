import { cosineSimilarity, type EmbedFunction } from "./embedding-client.js";

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

export interface DgraphCredentials {
  username: string;
  password: string;
  namespace: number;
}

interface LoginResponse {
  data?: {
    login?: {
      response?: {
        accessJWT?: string;
      };
    };
  };
  errors?: { message: string }[];
}

export class DgraphClient {
  private accessToken: string | undefined;
  private accessTokenExpiresAt = 0;
  private loginPromise: Promise<string> | undefined;

  public constructor(
    private readonly baseUrl: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly credentials?: DgraphCredentials
  ) {}

  public async alter(schema: string): Promise<void> {
    await this.request("/alter", schema, "application/dql");
  }

  public async dropAttribute(attribute: string): Promise<void> {
    await this.request("/alter", JSON.stringify({ drop_attr: attribute }));
  }

  public async query<T>(dql: string, variables: Record<string, string> = {}): Promise<T> {
    const result = await this.request("/query?ro=true", JSON.stringify({ query: dql, variables }));
    return (result as { data: T }).data;
  }

  public async mutate(
    set: Record<string, unknown>[],
    deleted: Record<string, unknown>[] = []
  ): Promise<Record<string, string>> {
    const body = {
      ...(set.length === 0 ? {} : { set }),
      ...(deleted.length === 0 ? {} : { delete: deleted })
    };
    const result = await this.request(
      "/mutate?commitNow=true",
      JSON.stringify(body)
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
    let response = await this.authenticatedRequest(path, body, contentType);
    if (response.status === 401 && this.credentials) {
      this.accessToken = undefined;
      this.accessTokenExpiresAt = 0;
      response = await this.authenticatedRequest(path, body, contentType);
    }
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

  private async authenticatedRequest(
    path: string,
    body: string,
    contentType: string
  ): Promise<Response> {
    const accessToken = this.credentials ? await this.login() : undefined;
    return this.fetchImplementation(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        ...(accessToken ? { "X-Dgraph-AccessToken": accessToken } : {})
      },
      body
    });
  }

  private async login(): Promise<string> {
    if (this.accessToken && this.accessTokenExpiresAt > Date.now() + 30_000) {
      return this.accessToken;
    }
    this.loginPromise ??= this.requestAccessToken().finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private async requestAccessToken(): Promise<string> {
    if (!this.credentials) {
      throw new Error("Dgraph credentials are required for login");
    }
    const { username, password, namespace } = this.credentials;
    const response = await this.fetchImplementation(`${this.baseUrl}/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/graphql" },
      body: `mutation { login(userId: ${JSON.stringify(username)}, password: ${JSON.stringify(password)}, namespace: ${namespace}) { response { accessJWT } } }`
    });
    const text = await response.text();
    if (!response.ok) {
      throw new DgraphHttpError("/admin login", response.status, text);
    }
    const parsed = JSON.parse(text) as LoginResponse;
    const token = parsed.data?.login?.response?.accessJWT;
    if (!token || parsed.errors?.length) {
      const message = parsed.errors?.map((error) => error.message).join("; ")
        ?? "Dgraph login returned no access token";
      throw new DgraphHttpError("/admin login", response.status, message);
    }
    this.accessToken = token;
    this.accessTokenExpiresAt = tokenExpiration(token);
    return token;
  }
}

function tokenExpiration(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof decoded.exp === "number" ? decoded.exp * 1_000 : 0;
  } catch {
    return 0;
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
source_episode: uid @reverse .
episode_id: string @index(exact) .
occurred_at: dateTime .
channel: string .
entity_name: string @index(exact) .
about: uid @reverse .
statement_embedding: float32vector @index(hnsw(metric:"cosine")) .

type Fact {
  statement
  statement_embedding
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
  source_episode
  about
}

type Entity {
  entity_name
}

type Episode {
  episode_id
  scope_key
  occurred_at
  channel
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
  source_episode?: { uid: string; episode_id?: string };
  about?: { uid: string; entity_name?: string };
  statement_embedding?: number[];
}

export interface EpisodeReference {
  id: string;
  channel?: string;
}

export interface RememberInput {
  scopeKey: string;
  statement: string;
  author: string;
  sourceMessageId: string;
  subject?: string;
  validFrom?: Date;
  episode?: EpisodeReference;
  entityName?: string;
  allowSimilar?: boolean;
}

export interface RankedMemoryFact {
  fact: MemoryFact;
  score: number;
  channels: string[];
}

export interface MemoryStore {
  remember(input: RememberInput): Promise<string>;
  supersede(scopeKey: string, oldFactUid: string, replacement: RememberInput): Promise<string>;
  forget(scopeKey: string, factUid: string): Promise<void>;
  retrieveCurrent(scopeKey: string): Promise<MemoryFact[]>;
  searchRanked(
    scopeKey: string,
    query: string,
    options?: { episodeId?: string; limit?: number }
  ): Promise<RankedMemoryFact[]>;
  believedAt(scopeKey: string, at: Date): Promise<MemoryFact[]>;
  listScope(scopeKey: string): Promise<MemoryFact[]>;
  factsForEpisode(scopeKey: string, episodeId: string): Promise<MemoryFact[]>;
  factsAboutEntity(scopeKey: string, entityName: string): Promise<MemoryFact[]>;
}

export interface GraphMemoryOptions {
  clock?: () => Date;
  embed?: EmbedFunction;
}

const DUPLICATE_TOKEN_JACCARD = 0.85;
const SIMILAR_TOKEN_JACCARD = 0.6;
const DUPLICATE_COSINE = 0.95;
const SIMILAR_COSINE = 0.88;
const RRF_K = 60;

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
  source_episode { uid episode_id }
  about { uid entity_name }
`;

export class NoveltyError extends Error {
  public constructor(
    public readonly verdict: "duplicate" | "similar",
    public readonly matchUid: string,
    public readonly matchStatement: string,
    public readonly similarity: number
  ) {
    const action = verdict === "duplicate"
      ? "nothing stored"
      : "supersede it if this replaces it, or retry with force to store both";
    super(
      `${verdict} of ${matchUid} ("${matchStatement}", similarity ${similarity.toFixed(2)}): ${action}`
    );
  }
}

function dqlString(value: string): string {
  return JSON.stringify(value);
}

function validatedUid(uid: string): string {
  if (!/^0x[0-9a-f]+$/iu.test(uid)) {
    throw new Error(`Invalid Dgraph fact uid: ${uid}`);
  }
  return uid;
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/gu, " ")
      .split(/\s+/u)
      .filter((token) => token.length > 1)
  );
}

function tokenJaccard(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / (leftTokens.size + rightTokens.size - overlap);
}

export class GraphMemory implements MemoryStore {
  private readonly clock: () => Date;
  private readonly embed: EmbedFunction | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly client: DgraphClient,
    options: GraphMemoryOptions | (() => Date) = {}
  ) {
    const normalized = typeof options === "function" ? { clock: options } : options;
    this.clock = normalized.clock ?? (() => new Date());
    this.embed = normalized.embed;
  }

  public async initialize(): Promise<void> {
    await this.client.alter(MEMORY_SCHEMA);
  }

  public remember(input: RememberInput): Promise<string> {
    return this.enqueue(async () => {
      this.validateRememberInput(input);
      const vector = this.embed ? await this.embed(input.statement) : undefined;
      await this.assertNovelNow(input, vector);
      const node = await this.factNode(input, this.clock());
      if (vector) {
        node.statement_embedding = JSON.stringify(vector);
      }
      const uids = await this.client.mutate([{ ...node, uid: "_:fact" }]);
      const uid = uids.fact;
      if (!uid) {
        throw new Error(`Dgraph remember returned no uid: ${JSON.stringify(uids)}`);
      }
      return uid;
    });
  }

  public supersede(
    scopeKey: string,
    oldFactUid: string,
    replacement: RememberInput
  ): Promise<string> {
    return this.enqueue(async () => {
      if (replacement.scopeKey !== scopeKey) {
        throw new Error(`Replacement scope ${replacement.scopeKey} does not match ${scopeKey}`);
      }
      const uid = validatedUid(oldFactUid);
      const vector = this.embed ? await this.embed(replacement.statement) : undefined;
      const now = this.clock();
      const query = `
        query {
          target as var(func: uid(${uid})) @filter(type(Fact) AND eq(scope_key, ${dqlString(scopeKey)}) AND NOT has(expired_at))
          found(func: uid(target)) { uid }
        }`;
      const node = await this.factNode(replacement, now);
      if (vector) {
        node.statement_embedding = JSON.stringify(vector);
      }
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
              ...node,
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
    });
  }

  public forget(scopeKey: string, factUid: string): Promise<void> {
    return this.enqueue(async () => {
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
    });
  }

  public retrieveCurrent(scopeKey: string): Promise<MemoryFact[]> {
    return this.enqueue(() => this.retrieveCurrentNow(scopeKey));
  }

  public searchRanked(
    scopeKey: string,
    query: string,
    options: { episodeId?: string; limit?: number } = {}
  ): Promise<RankedMemoryFact[]> {
    return this.enqueue(async () => {
      const channels: [string, MemoryFact[]][] = [
        ["fulltext", await this.searchNow(scopeKey, query)]
      ];
      if (this.embed) {
        const vector = await this.embed(query);
        channels.push(["semantic", await this.searchSemanticNow(scopeKey, vector, 20)]);
      }
      if (options.episodeId) {
        channels.push([
          "graph",
          await this.relatedToEpisodeNow(scopeKey, options.episodeId)
        ]);
      }
      const recent = [...await this.retrieveCurrentNow(scopeKey)]
        .sort((left, right) => right.recorded_at.localeCompare(left.recorded_at))
        .slice(0, 20);
      channels.push(["recency", recent]);

      const ranked = new Map<string, RankedMemoryFact>();
      for (const [channel, facts] of channels) {
        facts.forEach((fact, rank) => {
          const result = ranked.get(fact.uid) ?? { fact, score: 0, channels: [] };
          result.score += 1 / (RRF_K + rank + 1);
          result.channels.push(channel);
          ranked.set(fact.uid, result);
        });
      }
      return [...ranked.values()]
        .sort((left, right) => right.score - left.score || left.fact.uid.localeCompare(right.fact.uid))
        .slice(0, options.limit ?? 10);
    });
  }

  public believedAt(scopeKey: string, at: Date): Promise<MemoryFact[]> {
    return this.enqueue(async () => {
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
    });
  }

  public listScope(scopeKey: string): Promise<MemoryFact[]> {
    return this.enqueue(async () => {
      const data = await this.client.query<{ facts?: MemoryFact[] }>(
        `query all($scope: string) {
          facts(func: eq(scope_key, $scope), orderasc: recorded_at) @filter(type(Fact)) {
            ${FACT_FIELDS}
          }
        }`,
        { $scope: scopeKey }
      );
      return data.facts ?? [];
    });
  }

  public factsForEpisode(scopeKey: string, episodeId: string): Promise<MemoryFact[]> {
    return this.enqueue(async () => {
      const data = await this.client.query<{ episodes?: { facts?: MemoryFact[] }[] }>(
        `query byEpisode($scope: string, $episode: string) {
          episodes(func: eq(episode_id, $episode)) @filter(type(Episode) AND eq(scope_key, $scope)) {
            facts: ~source_episode(orderasc: recorded_at) @filter(type(Fact)) {
              ${FACT_FIELDS}
            }
          }
        }`,
        { $scope: scopeKey, $episode: episodeId }
      );
      return (data.episodes ?? []).flatMap((episode) => episode.facts ?? []);
    });
  }

  public factsAboutEntity(scopeKey: string, entityName: string): Promise<MemoryFact[]> {
    return this.enqueue(async () => {
      const data = await this.client.query<{ entities?: { facts?: MemoryFact[] }[] }>(
        `query aboutEntity($scope: string, $name: string) {
          entities(func: eq(entity_name, $name)) @filter(type(Entity)) {
            facts: ~about(orderasc: recorded_at)
              @filter(type(Fact) AND eq(scope_key, $scope) AND NOT has(expired_at)) {
              ${FACT_FIELDS}
            }
          }
        }`,
        { $scope: scopeKey, $name: entityName }
      );
      return (data.entities ?? []).flatMap((entity) => entity.facts ?? []);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async retrieveCurrentNow(scopeKey: string): Promise<MemoryFact[]> {
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

  private async searchNow(scopeKey: string, terms: string): Promise<MemoryFact[]> {
    if (!terms.trim()) {
      throw new Error("Memory search requires a query");
    }
    const data = await this.client.query<{ facts?: MemoryFact[] }>(
      `query search($scope: string, $terms: string) {
        facts(func: anyoftext(statement, $terms), orderasc: recorded_at)
          @filter(type(Fact) AND eq(scope_key, $scope) AND NOT has(expired_at)) {
          ${FACT_FIELDS}
        }
      }`,
      { $scope: scopeKey, $terms: terms }
    );
    return data.facts ?? [];
  }

  private async searchSemanticNow(
    scopeKey: string,
    vector: number[],
    topK: number
  ): Promise<MemoryFact[]> {
    const data = await this.client.query<{ facts?: MemoryFact[] }>(
      `query semantic($scope: string, $vector: string) {
        facts(func: similar_to(statement_embedding, ${topK}, $vector))
          @filter(type(Fact) AND eq(scope_key, $scope) AND NOT has(expired_at)) {
          ${FACT_FIELDS}
          statement_embedding
        }
      }`,
      { $scope: scopeKey, $vector: JSON.stringify(vector) }
    );
    return data.facts ?? [];
  }

  private async relatedToEpisodeNow(
    scopeKey: string,
    episodeId: string
  ): Promise<MemoryFact[]> {
    const data = await this.client.query<{ entities?: { related?: MemoryFact[] }[] }>(
      `query related($scope: string, $episode: string) {
        episode as var(func: eq(episode_id, $episode)) @filter(type(Episode) AND eq(scope_key, $scope))
        var(func: uid(episode)) {
          sessionFacts as ~source_episode @filter(type(Fact)) {
            entities as about
          }
        }
        entities(func: uid(entities)) {
          related: ~about(orderasc: recorded_at)
            @filter(type(Fact) AND eq(scope_key, $scope) AND NOT has(expired_at) AND NOT uid(sessionFacts)) {
            ${FACT_FIELDS}
          }
        }
      }`,
      { $scope: scopeKey, $episode: episodeId }
    );
    const seen = new Set<string>();
    return (data.entities ?? []).flatMap((entity) => entity.related ?? []).filter((fact) => {
      if (seen.has(fact.uid)) {
        return false;
      }
      seen.add(fact.uid);
      return true;
    });
  }

  private async assertNovelNow(
    input: RememberInput,
    vector: number[] | undefined
  ): Promise<void> {
    const candidates = new Map<string, MemoryFact>();
    for (const fact of await this.searchNow(input.scopeKey, input.statement)) {
      candidates.set(fact.uid, fact);
    }
    if (vector) {
      for (const fact of await this.searchSemanticNow(input.scopeKey, vector, 8)) {
        candidates.set(fact.uid, fact);
      }
    }

    let best: {
      uid: string;
      statement: string;
      similarity: number;
      verdict: "duplicate" | "similar";
    } | undefined;
    for (const candidate of candidates.values()) {
      const jaccard = tokenJaccard(input.statement, candidate.statement);
      const cosine = vector && candidate.statement_embedding
        ? cosineSimilarity(vector, candidate.statement_embedding)
        : 0;
      const similarity = Math.max(jaccard, cosine);
      let verdict: "duplicate" | "similar" | undefined;
      if (jaccard >= DUPLICATE_TOKEN_JACCARD || cosine >= DUPLICATE_COSINE) {
        verdict = "duplicate";
      } else if (jaccard >= SIMILAR_TOKEN_JACCARD || cosine >= SIMILAR_COSINE) {
        verdict = "similar";
      }
      if (!verdict) {
        continue;
      }
      if (
        !best ||
        similarity > best.similarity ||
        (verdict === "duplicate" && best.verdict === "similar")
      ) {
        best = {
          uid: candidate.uid,
          statement: candidate.statement,
          similarity,
          verdict
        };
      }
    }
    if (best && (best.verdict === "duplicate" || !input.allowSimilar)) {
      throw new NoveltyError(
        best.verdict,
        best.uid,
        best.statement,
        best.similarity
      );
    }
  }

  private async factNode(input: RememberInput, now: Date): Promise<Record<string, unknown>> {
    this.validateRememberInput(input);
    const node: Record<string, unknown> = {
      "dgraph.type": "Fact",
      statement: input.statement.trim(),
      scope_key: input.scopeKey,
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      author: input.author,
      source_message_id: input.sourceMessageId,
      valid_from: (input.validFrom ?? now).toISOString(),
      recorded_at: now.toISOString()
    };
    if (input.episode) {
      node.source_episode = {
        uid: await this.ensureEpisodeNow(input.scopeKey, input.episode)
      };
    }
    if (input.entityName) {
      node.about = { uid: await this.ensureEntityNow(input.entityName) };
    }
    return node;
  }

  private validateRememberInput(input: RememberInput): void {
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
  }

  private async ensureEpisodeNow(
    scopeKey: string,
    episode: EpisodeReference
  ): Promise<string> {
    if (!scopeKey.trim() || !episode.id.trim()) {
      throw new Error("Episode requires a scope key and ID");
    }
    const query = `
      query {
        episode as var(func: eq(episode_id, ${dqlString(episode.id)}))
          @filter(type(Episode) AND eq(scope_key, ${dqlString(scopeKey)}))
        existing(func: uid(episode)) { uid }
      }`;
    const result = await this.client.upsert(query, [
      {
        cond: "@if(eq(len(episode), 0))",
        set: [
          {
            uid: "_:episode",
            "dgraph.type": "Episode",
            episode_id: episode.id,
            scope_key: scopeKey,
            occurred_at: this.clock().toISOString(),
            ...(episode.channel === undefined ? {} : { channel: episode.channel })
          }
        ]
      }
    ]);
    const existing = (result.queries.existing ?? []) as { uid: string }[];
    const uid = result.uids.episode ?? existing[0]?.uid;
    if (!uid) {
      throw new Error(`Episode ${episode.id} resolved no uid in scope ${scopeKey}`);
    }
    return uid;
  }

  private async ensureEntityNow(entityName: string): Promise<string> {
    if (!entityName.trim()) {
      throw new Error("Entity requires a name");
    }
    const query = `
      query {
        entity as var(func: eq(entity_name, ${dqlString(entityName)})) @filter(type(Entity))
        existing(func: uid(entity)) { uid }
      }`;
    const result = await this.client.upsert(query, [
      {
        cond: "@if(eq(len(entity), 0))",
        set: [
          {
            uid: "_:entity",
            "dgraph.type": "Entity",
            entity_name: entityName
          }
        ]
      }
    ]);
    const existing = (result.queries.existing ?? []) as { uid: string }[];
    const uid = result.uids.entity ?? existing[0]?.uid;
    if (!uid) {
      throw new Error(`Entity ${entityName} resolved no uid`);
    }
    return uid;
  }
}

export const dgraphMemoryInternals = {
  dqlString,
  tokenJaccard,
  validatedUid
};
