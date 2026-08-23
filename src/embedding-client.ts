export type EmbedFunction = (text: string) => Promise<number[]>;

export class EmbeddingClient {
  private modelId: Promise<string> | undefined;

  public constructor(
    private readonly baseUrl: string,
    private readonly fetchImplementation: typeof fetch = fetch
  ) {
    if (!baseUrl) {
      throw new Error("EmbeddingClient requires a base URL");
    }
  }

  public readonly embed: EmbedFunction = async (text) => {
    const model = await this.resolveModel();
    const response = await this.fetchImplementation(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text })
    });
    if (!response.ok) {
      throw new Error(
        `Embedding request failed (${response.status}): ${await response.text()}`
      );
    }
    const parsed = (await response.json()) as { data?: { embedding?: number[] }[] };
    const vector = parsed.data?.[0]?.embedding;
    if (!vector?.length) {
      throw new Error("Embedding response contained no vector");
    }
    return vector;
  };

  private resolveModel(): Promise<string> {
    if (!this.modelId) {
      this.modelId = this.fetchImplementation(`${this.baseUrl}/models`).then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Embedding model discovery failed (${response.status}): ${await response.text()}`
          );
        }
        const parsed = (await response.json()) as { data?: { id?: string }[] };
        const modelId = parsed.data?.[0]?.id;
        if (!modelId) {
          throw new Error(`No embedding model served at ${this.baseUrl}`);
        }
        return modelId;
      });
    }
    return this.modelId;
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error(`Vector length mismatch: ${left.length} vs ${right.length}`);
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}
