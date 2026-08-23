import { describe, expect, it, vi } from "vitest";
import { EmbeddingClient, cosineSimilarity } from "../src/embedding-client.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("EmbeddingClient", () => {
  it("uses the configured model and request headers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ embedding: [1, 0] }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ embedding: [0, 1] }] }));
    const client = new EmbeddingClient(
      "http://embeddings/v1",
      "embedding-model",
      { Authorization: "Bearer secret" },
      fetchMock
    );

    await expect(client.embed("first")).resolves.toEqual([1, 0]);
    await expect(client.embed("second")).resolves.toEqual([0, 1]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://embeddings/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "embedding-model", input: ["first"] })
      })
    );
  });

  it("embeds batches in response index order and exposes the selected model", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] }
      ] }));
    const client = new EmbeddingClient("http://embeddings/v1", "embedding-model", {}, fetchMock);

    await expect(client.embeddingModel()).resolves.toBe("embedding-model");
    await expect(client.embedMany(["first", "second"])).resolves.toEqual([[1, 0], [0, 1]]);
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it("requires an endpoint and model", () => {
    expect(() => new EmbeddingClient("", "model")).toThrow("requires a base URL");
    expect(() => new EmbeddingClient("http://embeddings/v1", "")).toThrow("requires a model ID");
  });
});

describe("cosineSimilarity", () => {
  it("computes similarity and rejects incompatible vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 0])).toThrow("Vector length mismatch");
  });
});
