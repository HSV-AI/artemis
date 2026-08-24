import { describe, expect, it, vi } from "vitest";
import { EmbeddingClient } from "../src/embedding-client.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("EmbeddingClient", () => {
  it("returns batch embeddings in response index order", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] }
      ] }));
    const client = new EmbeddingClient("http://embeddings/v1", "embedding-model", {}, fetchMock);

    await expect(client.embedMany(["first", "second"])).resolves.toEqual([[1, 0], [0, 1]]);
  });

  it("reports request and empty-vector failures", async () => {
    const requestFailure = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 429 }));
    await expect(new EmbeddingClient(
      "http://embeddings/v1",
      "model",
      {},
      requestFailure
    ).embed("text")).rejects.toThrow("request failed (429)");

    const emptyVector = vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{}] }));
    await expect(new EmbeddingClient(
      "http://embeddings/v1",
      "model",
      {},
      emptyVector
    ).embed("text")).rejects.toThrow("contained no vector");
  });
});
