export type EmbedFunction = (text: string) => Promise<number[]>;
export type EmbedBatchFunction = (texts: string[]) => Promise<number[][]>;

export class EmbeddingClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly modelId: string,
    private readonly requestHeaders: Readonly<Record<string, string>> = {},
    private readonly fetchImplementation: typeof fetch = fetch
  ) {
    if (!baseUrl) {
      throw new Error("EmbeddingClient requires a base URL");
    }
    if (!modelId) {
      throw new Error("EmbeddingClient requires a model ID");
    }
  }

  public readonly embed: EmbedFunction = async (text) => {
    const [vector] = await this.embedMany([text]);
    if (!vector) {
      throw new Error("Embedding response contained no vector");
    }
    return vector;
  };

  public readonly embedMany: EmbedBatchFunction = async (texts) => {
    if (texts.length === 0) {
      return [];
    }
    const response = await this.fetchImplementation(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { ...this.requestHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.modelId, input: texts })
    });
    if (!response.ok) {
      throw new Error(
        `Embedding request failed (${response.status}): ${await response.text()}`
      );
    }
    const parsed = (await response.json()) as {
      data?: { embedding?: number[]; index?: number }[];
    };
    const rows = [...(parsed.data ?? [])].sort(
      (left, right) => (left.index ?? 0) - (right.index ?? 0)
    );
    const vectors = rows.map((row) => row.embedding).filter(
      (vector): vector is number[] => Boolean(vector?.length)
    );
    if (vectors.length !== texts.length) {
      if (texts.length === 1 && vectors.length === 0) {
        throw new Error("Embedding response contained no vector");
      }
      throw new Error(`Embedding response contained ${vectors.length} vectors for ${texts.length} inputs`);
    }
    return vectors;
  };

  public embeddingModel(): Promise<string> {
    return Promise.resolve(this.modelId);
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
