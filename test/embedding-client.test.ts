import { describe, expect, it, vi } from "vitest";
import { EmbeddingClient, cosineSimilarity } from "../src/embedding-client.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("EmbeddingClient", () => {
  it("discovers the model once and embeds each input", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "embedding-model" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ embedding: [1, 0] }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ embedding: [0, 1] }] }));
    const client = new EmbeddingClient("http://embeddings/v1", fetchMock);

    await expect(client.embed("first")).resolves.toEqual([1, 0]);
    await expect(client.embed("second")).resolves.toEqual([0, 1]);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://embeddings/v1/models");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://embeddings/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "embedding-model", input: "first" })
      })
    );
  });

  it("reports discovery, request, and empty-vector failures", async () => {
    await expect(new EmbeddingClient(
      "http://embeddings/v1",
      vi.fn().mockResolvedValue(new Response("offline", { status: 503 }))
    ).embed("text")).rejects.toThrow("model discovery failed (503)");

    const requestFailure = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model" }] }))
      .mockResolvedValueOnce(new Response("busy", { status: 429 }));
    await expect(new EmbeddingClient(
      "http://embeddings/v1",
      requestFailure
    ).embed("text")).rejects.toThrow("request failed (429)");

    const emptyVector = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{}] }));
    await expect(new EmbeddingClient(
      "http://embeddings/v1",
      emptyVector
    ).embed("text")).rejects.toThrow("contained no vector");
  });
});

describe("cosineSimilarity", () => {
  it("computes similarity and rejects incompatible vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 0])).toThrow("Vector length mismatch");
  });
});
