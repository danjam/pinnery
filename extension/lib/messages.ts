// Messages between the service worker and the content script (and the in-page toast back to the
// worker). The wire format is plain JSON: `type` picks the shape.

// Worker -> content script: the image under the pointer, as candidate URLs (best first).
export interface ResolveMessage {
  type: 'resolve';
  srcUrl?: string;
}
export interface ResolveReply {
  candidates: string[];
  title: string;
}

// Worker -> content script: fetch from inside the page; the bytes come back as a data: URL.
export interface FetchMessage {
  type: 'fetch';
  url: string;
}
export type PageFetchReply = { ok: true; type: string; dataUrl: string } | { ok: false; error: string };

// Worker -> content script: show the in-page toast.
export interface ToastMessage {
  type: 'toast';
  text: string;
  ok: boolean;
  url?: string | null;
}

// Content script -> worker: open the board the toast links to.
export interface OpenMessage {
  type: 'open';
  url: string;
}

export type ContentMessage = ResolveMessage | FetchMessage | ToastMessage;
export type WorkerMessage = OpenMessage;
