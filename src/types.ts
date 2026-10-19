export interface TimeRange { start: string; end: string }
export interface Hit {
  id: string;
  instance: string;
  file: string;
  line: number;
  text: string;
  sourceUrl: string;
  downloadUrl?: string;
  query: TimeRange & { keyword: string };
}
export interface SearchPage {
  hits: Hit[];
  /** undefined means the platform's cap is not yet known. */
  capped: boolean | undefined;
}
export interface LogBackend {
  open(): Promise<{ url: string; ready: boolean; message: string }>;
  listInstances(): Promise<string[]>;
  search(instance: string, keyword: string, range: TimeRange): Promise<SearchPage>;
  preview(hit: Hit): Promise<string>;
  download(hit: Hit): Promise<Buffer>;
  downloadAdjacent(hit: Hit, file: string): Promise<Buffer>;
  close(): Promise<void>;
}
export class LogError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
