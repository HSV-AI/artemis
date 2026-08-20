import { describe, expect, it, vi } from "vitest";
import { githubApiInternals, githubRequest } from "../src/github-api.js";

describe("githubRequest", () => {
  it("sends authenticated JSON requests and parses JSON responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":1}', { status: 200 }));
    const controller = new AbortController();
    await expect(githubRequest("secret", "/repos/o/r", {
      method: "POST",
      body: { title: "hello" },
      signal: controller.signal,
      fetchImplementation: fetchMock,
      headers: { Accept: "custom" }
    })).resolves.toEqual({ id: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      `${githubApiInternals.GITHUB_API_BASE}/repos/o/r`,
      expect.objectContaining({
        method: "POST",
        body: '{"title":"hello"}',
        signal: controller.signal,
        headers: expect.objectContaining({ Authorization: "Bearer secret", Accept: "custom" })
      })
    );
  });

  it("handles empty successful responses", async () => {
    await expect(githubRequest("token", "/empty", {
      fetchImplementation: vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    })).resolves.toBeNull();
    await expect(githubRequest("token", "/empty", {
      fetchImplementation: vi.fn().mockResolvedValue(new Response("", { status: 200 }))
    })).resolves.toBeNull();
  });

  it("reports GitHub response errors", async () => {
    await expect(githubRequest("token", "/bad", {
      fetchImplementation: vi.fn().mockResolvedValue(new Response("denied", { status: 403 }))
    })).rejects.toThrow("denied");
    const response = {
      ok: false,
      status: 500,
      text: vi.fn().mockRejectedValue(new Error("unreadable"))
    } as unknown as Response;
    await expect(githubRequest("token", "/bad", {
      fetchImplementation: vi.fn().mockResolvedValue(response)
    })).rejects.toThrow("status 500");
  });
});
