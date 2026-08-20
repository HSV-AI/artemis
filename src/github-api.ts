const GITHUB_API_BASE = "https://api.github.com";

export interface GitHubRequestOptions {
  method?: string;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  fetchImplementation?: typeof fetch;
  headers?: Record<string, string>;
}

export async function githubRequest(
  token: string,
  path: string,
  options: GitHubRequestOptions = {}
): Promise<unknown> {
  const response = await (options.fetchImplementation ?? fetch)(`${GITHUB_API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(errorText || `GitHub request failed with status ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }
  const responseText = await response.text();
  return responseText ? (JSON.parse(responseText) as unknown) : null;
}

export const githubApiInternals = { GITHUB_API_BASE };
