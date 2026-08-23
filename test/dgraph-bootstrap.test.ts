import { describe, expect, it, vi } from "vitest";
import {
  bootstrapDgraph,
  loadDgraphBootstrapConfig
} from "../src/dgraph-bootstrap.js";

const environment = {
  DGRAPH_URL: "http://dgraph:8080/",
  DGRAPH_INITIAL_GROOT_PASSWORD: "password",
  DGRAPH_GROOT_PASSWORD: "galaxy-password",
  DGRAPH_USER: "memory-user",
  DGRAPH_PASSWORD: "memory-password",
  HSVAI_DGRAPH_GROOT_PASSWORD: "hsvai-admin-password",
  HSVAI_DGRAPH_SYNC_USER: "sync-user",
  HSVAI_DGRAPH_SYNC_PASSWORD: "sync-password",
  HSVAI_DGRAPH_QUERY_USER: "query-user",
  HSVAI_DGRAPH_QUERY_PASSWORD: "query-password",
  HSVAI_DGRAPH_NAMESPACE: "1"
};

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("Dgraph bootstrap", () => {
  it("loads and validates ACL bootstrap configuration", () => {
    expect(loadDgraphBootstrapConfig(environment)).toMatchObject({
      baseUrl: "http://dgraph:8080",
      memoryUser: "memory-user",
      hsvaiNamespace: 1,
      hsvaiQueryUser: "query-user"
    });
    expect(() => loadDgraphBootstrapConfig({
      ...environment,
      HSVAI_DGRAPH_QUERY_USER: "sync-user"
    })).toThrow("must differ");
    expect(() => loadDgraphBootstrapConfig({
      ...environment,
      HSVAI_DGRAPH_NAMESPACE: "0"
    })).toThrow("must be a positive safe integer");
  });

  it("rotates the default root password, creates the namespace, and applies least privilege", async () => {
    let galaxyPasswordRotated = false;
    const requests: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = String(init?.body);
      requests.push(body);
      if (body.includes("login(")) {
        if (body.includes('password: "galaxy-password"') && !galaxyPasswordRotated) {
          return response({ errors: [{ message: "invalid login" }] });
        }
        return response({ data: { login: { response: { accessJWT: "token" } } } });
      }
      if (body.includes('filter: { name: { eq: "groot" } }')) {
        galaxyPasswordRotated = true;
        return response({ data: { updateUser: { user: [{ name: "groot" }] } } });
      }
      if (body.includes("state { namespaces }")) {
        return response({ data: { state: { namespaces: [0] } } });
      }
      if (body.includes("addNamespace")) {
        return response({ data: { addNamespace: { namespaceId: 1 } } });
      }
      if (body.startsWith("query")) {
        return response({ data: { getUser: null, getGroup: null } });
      }
      return response({ data: {} });
    });

    await bootstrapDgraph(loadDgraphBootstrapConfig(environment), fetchMock);

    expect(galaxyPasswordRotated).toBe(true);
    expect(requests.some((body) => body.includes("addNamespace"))).toBe(true);
    expect(requests.some((body) => body.includes("permission: 4"))).toBe(true);
    expect(requests.filter((body) => body.includes("permission: 7"))).toHaveLength(2);
    expect(requests.some((body) =>
      body.includes('userId: "query-user"') && body.includes("namespace: 1")
    )).toBe(true);
  });

  it("reuses an existing namespace and fails if Dgraph allocates a different ID", async () => {
    const existingFetch = vi.fn().mockImplementation(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = String(init?.body);
      if (body.includes("login(")) {
        return response({ data: { login: { response: { accessJWT: "token" } } } });
      }
      if (body.includes("state { namespaces }")) {
        return response({ data: { state: { namespaces: [0, 1] } } });
      }
      if (body.startsWith("query")) {
        return response({
          data: {
            getUser: { name: "existing", groups: [{ name: "stale-access" }] },
            getGroup: { name: "existing", rules: [{ predicate: "stale.predicate" }] }
          }
        });
      }
      return response({ data: {} });
    });
    await expect(
      bootstrapDgraph(loadDgraphBootstrapConfig(environment), existingFetch)
    ).resolves.toBeUndefined();
    expect(existingFetch.mock.calls.some(([, init]) =>
      String((init as RequestInit | undefined)?.body).includes("addNamespace")
    )).toBe(false);
    expect(existingFetch.mock.calls.some(([, init]) =>
      String((init as RequestInit | undefined)?.body).includes('remove: { groups: [{"name":"stale-access"}] }')
    )).toBe(true);
    expect(existingFetch.mock.calls.some(([, init]) =>
      String((init as RequestInit | undefined)?.body).includes('remove: { rules: ["stale.predicate"] }')
    )).toBe(true);

    const mismatchFetch = vi.fn().mockImplementation(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = String(init?.body);
      if (body.includes("login(")) {
        return response({ data: { login: { response: { accessJWT: "token" } } } });
      }
      if (body.includes("state { namespaces }")) {
        return response({ data: { state: { namespaces: [0] } } });
      }
      if (body.includes("addNamespace")) {
        return response({ data: { addNamespace: { namespaceId: 2 } } });
      }
      if (body.startsWith("query")) {
        return response({
          data: { getUser: { name: "existing" }, getGroup: { name: "existing" } }
        });
      }
      return response({ data: {} });
    });
    await expect(
      bootstrapDgraph(loadDgraphBootstrapConfig(environment), mismatchFetch)
    ).rejects.toThrow("created namespace 2, expected 1");
  });
});
