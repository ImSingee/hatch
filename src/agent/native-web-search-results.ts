export type NativeWebSearch = {
  id: string;
  contentIndex: number;
  name: 'web_search' | 'web_fetch';
  args: { query?: string; queries?: string[]; url?: string };
  sources: { url: string; title?: string }[];
  error?: string;
  openAI?: { item: Record<string, unknown>; previousItemId?: string };
};

export function nativeWebSearchOutput(search: NativeWebSearch): string {
  return (
    search.error ??
    JSON.stringify({ ...search.args, results: search.sources }, null, 2)
  );
}
