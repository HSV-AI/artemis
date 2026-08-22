export function markdownLinks(content: string): string[];
export function markdownHeadings(content: string): Set<string>;
export function checkDesignDocs(rootDirectory?: string): Promise<string[]>;
