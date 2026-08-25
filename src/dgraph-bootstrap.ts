import "dotenv/config";
import { pathToFileURL } from "node:url";

interface BootstrapConfig {
  baseUrl: string;
  initialGalaxyPassword: string;
  galaxyPassword: string;
  memoryUser: string;
  memoryPassword: string;
  hsvaiNamespace: number;
  hsvaiAdminPassword: string;
  hsvaiSyncUser: string;
  hsvaiSyncPassword: string;
  hsvaiQueryUser: string;
  hsvaiQueryPassword: string;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required Dgraph bootstrap configuration: ${name}`);
  return value;
}

function namespace(value: string | undefined): number {
  const parsed = Number(value ?? "1");
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("HSVAI_DGRAPH_NAMESPACE must be a positive safe integer");
  }
  return parsed;
}

export function loadDgraphBootstrapConfig(env: NodeJS.ProcessEnv = process.env): BootstrapConfig {
  const baseUrl = env.DGRAPH_URL?.trim() || "http://dgraph:8080";
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("DGRAPH_URL must use HTTP or HTTPS");
  }
  const hsvaiSyncUser = required(env, "HSVAI_DGRAPH_SYNC_USER");
  const hsvaiQueryUser = required(env, "HSVAI_DGRAPH_QUERY_USER");
  if (hsvaiSyncUser === hsvaiQueryUser) {
    throw new Error("HSVAI_DGRAPH_SYNC_USER and HSVAI_DGRAPH_QUERY_USER must differ");
  }
  return {
    baseUrl: baseUrl.replace(/\/$/u, ""),
    initialGalaxyPassword: env.DGRAPH_INITIAL_GROOT_PASSWORD?.trim() || "password",
    galaxyPassword: required(env, "DGRAPH_GROOT_PASSWORD"),
    memoryUser: required(env, "DGRAPH_USER"),
    memoryPassword: required(env, "DGRAPH_PASSWORD"),
    hsvaiNamespace: namespace(env.HSVAI_DGRAPH_NAMESPACE),
    hsvaiAdminPassword: required(env, "HSVAI_DGRAPH_GROOT_PASSWORD"),
    hsvaiSyncUser,
    hsvaiSyncPassword: required(env, "HSVAI_DGRAPH_SYNC_PASSWORD"),
    hsvaiQueryUser,
    hsvaiQueryPassword: required(env, "HSVAI_DGRAPH_QUERY_PASSWORD")
  };
}

class DgraphAdminClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly fetchImplementation: typeof fetch
  ) {}

  public async login(password: string, namespaceId = 0, userId = "groot"): Promise<string> {
    const data = await this.request<{
      login?: { response?: { accessJWT?: string } };
    }>(
      `mutation { login(userId: ${JSON.stringify(userId)}, password: ${JSON.stringify(password)}, namespace: ${namespaceId}) { response { accessJWT } } }`
    );
    const token = data.login?.response?.accessJWT;
    if (!token) throw new Error(`Dgraph login returned no token for namespace ${namespaceId}`);
    return token;
  }

  public async query<T>(token: string, query: string): Promise<T> {
    return this.request<T>(query, token);
  }

  private async request<T>(query: string, token?: string): Promise<T> {
    const response = await this.fetchImplementation(`${this.baseUrl}/admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/graphql",
        ...(token ? { "X-Dgraph-AccessToken": token } : {})
      },
      body: query
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Dgraph admin request failed (${response.status}): ${text}`);
    const payload = JSON.parse(text) as GraphqlResponse<T>;
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message).join("; "));
    }
    if (!payload.data) throw new Error("Dgraph admin request returned no data");
    return payload.data;
  }
}

async function galaxyLogin(client: DgraphAdminClient, config: BootstrapConfig): Promise<string> {
  try {
    return await client.login(config.galaxyPassword);
  } catch {
    const initialToken = await client.login(config.initialGalaxyPassword);
    await client.query(initialToken, `mutation {
      updateUser(input: {
        filter: { name: { eq: "groot" } }
        set: { password: ${JSON.stringify(config.galaxyPassword)} }
      }) { user { name } }
    }`);
    return client.login(config.galaxyPassword);
  }
}

async function ensureServiceAccount(
  client: DgraphAdminClient,
  token: string,
  user: string,
  password: string,
  group: string,
  permission: 4 | 7,
  namespaceId: number
): Promise<void> {
  const existing = await client.query<{
    getUser?: { name: string; groups?: { name: string }[] } | null;
    getGroup?: { name: string; rules?: { predicate: string }[] } | null;
  }>(token, `query {
    getUser(name: ${JSON.stringify(user)}) { name groups { name } }
    getGroup(name: ${JSON.stringify(group)}) { name rules { predicate } }
  }`);
  if (!existing.getGroup) {
    await client.query(token, `mutation {
      addGroup(input: [{ name: ${JSON.stringify(group)} }]) { group { name } }
    }`);
  }
  if (!existing.getUser) {
    await client.query(token, `mutation {
      addUser(input: [{ name: ${JSON.stringify(user)}, password: ${JSON.stringify(password)} }]) {
        user { name }
      }
    }`);
  }
  const otherGroups = existing.getUser?.groups
    ?.map((membership) => membership.name)
    .filter((name) => name !== group) ?? [];
  if (otherGroups.length) {
    await client.query(token, `mutation {
      updateUser(input: {
        filter: { name: { eq: ${JSON.stringify(user)} } }
        remove: { groups: ${JSON.stringify(otherGroups.map((name) => ({ name })))} }
      }) { user { name } }
    }`);
  }
  const otherRules = existing.getGroup?.rules
    ?.map((rule) => rule.predicate)
    .filter((predicate) => predicate !== "dgraph.all") ?? [];
  if (otherRules.length) {
    await client.query(token, `mutation {
      updateGroup(input: {
        filter: { name: { eq: ${JSON.stringify(group)} } }
        remove: { rules: ${JSON.stringify(otherRules)} }
      }) { group { name } }
    }`);
  }
  await client.query(token, `mutation {
    updateGroup(input: {
      filter: { name: { eq: ${JSON.stringify(group)} } }
      set: { rules: [{ predicate: "dgraph.all", permission: ${permission} }] }
    }) { group { name } }
  }`);
  await client.query(token, `mutation {
    updateUser(input: {
      filter: { name: { eq: ${JSON.stringify(user)} } }
      set: {
        password: ${JSON.stringify(password)}
        groups: [{ name: ${JSON.stringify(group)} }]
      }
    }) { user { name } }
  }`);
  await client.login(password, namespaceId, user);
}

async function ensureHsvaiNamespace(
  client: DgraphAdminClient,
  galaxyToken: string,
  config: BootstrapConfig
): Promise<string> {
  const state = await client.query<{ state?: { namespaces?: number[] } }>(
    galaxyToken,
    "query { state { namespaces } }"
  );
  if (!state.state?.namespaces?.includes(config.hsvaiNamespace)) {
    const created = await client.query<{
      addNamespace?: { namespaceId?: number };
    }>(galaxyToken, `mutation {
      addNamespace(input: { password: ${JSON.stringify(config.hsvaiAdminPassword)} }) {
        namespaceId
      }
    }`);
    if (created.addNamespace?.namespaceId !== config.hsvaiNamespace) {
      throw new Error(
        `Dgraph created namespace ${created.addNamespace?.namespaceId ?? "unknown"}, expected ${config.hsvaiNamespace}`
      );
    }
  } else {
    try {
      return await client.login(config.hsvaiAdminPassword, config.hsvaiNamespace);
    } catch {
      await client.query(galaxyToken, `mutation {
        resetPassword(input: {
          userId: "groot"
          password: ${JSON.stringify(config.hsvaiAdminPassword)}
          namespace: ${config.hsvaiNamespace}
        }) { userId }
      }`);
    }
  }
  return client.login(config.hsvaiAdminPassword, config.hsvaiNamespace);
}

export async function bootstrapDgraph(
  config: BootstrapConfig,
  fetchImplementation: typeof fetch = fetch
): Promise<void> {
  const client = new DgraphAdminClient(config.baseUrl, fetchImplementation);
  const galaxyToken = await galaxyLogin(client, config);
  await ensureServiceAccount(
    client,
    galaxyToken,
    config.memoryUser,
    config.memoryPassword,
    "artemis-memory-access",
    7,
    0
  );
  const hsvaiToken = await ensureHsvaiNamespace(client, galaxyToken, config);
  await ensureServiceAccount(
    client,
    hsvaiToken,
    config.hsvaiSyncUser,
    config.hsvaiSyncPassword,
    "artemis-hsvai-sync-access",
    7,
    config.hsvaiNamespace
  );
  await ensureServiceAccount(
    client,
    hsvaiToken,
    config.hsvaiQueryUser,
    config.hsvaiQueryPassword,
    "artemis-hsvai-query-access",
    4,
    config.hsvaiNamespace
  );
}

async function main(): Promise<void> {
  await bootstrapDgraph(loadDgraphBootstrapConfig());
  process.stdout.write("Dgraph ACL users and HSVAI namespace are ready.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
