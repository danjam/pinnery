// The shapes of what the server sends back, as the app uses them (see routes.js, auth.js,
// users.js, transfer.js).
export type Role = 'owner' | 'editor' | 'viewer';

// A board as /api/boards/:id/pins reports it: the user's standing on it, and whose it is.
export interface BoardInfo {
  id: number;
  name: string;
  cover_pin_id: number | null;
  created_at: string;
  role: Role;
  owner_name: string;
}

// A board as /api/boards lists it. `cover` is the chosen cover pin, else the newest.
export interface Board extends BoardInfo {
  pin_count: number;
  last_pin_at: string | null;
  cover: { sha256: string; width: number; height: number } | null;
}

export interface Pin {
  id: number;
  board_id: number;
  sha256: string;
  width: number;
  height: number;
  mime: string;
  animated: number;   // 0 or 1: straight from SQLite
  source_url: string | null;
  page_title: string | null;
  created_at: string;
}

export interface Share {
  user_id: number;
  display_name: string;
  email: string;
  role: 'viewer' | 'editor';
  created_at: string;
}

// Someone a board can be shared with.
export interface Person {
  id: number;
  display_name: string;
  email: string;
}

export interface Me extends Person {
  is_admin: boolean;
  must_change_password: boolean;
}

// A user as the admin list shows them, with what they own.
export interface AdminUser extends Person {
  is_admin: boolean;
  created_at: string;
  last_seen_at: string | null;
  boards: number;
  pins: number;
}

export interface Invite {
  id: number;
  email: string;
  created_at: string;
  expires_at: string;
}

// An emailed link the server hands back too (a new invite, an admin's password reset): `sent` says
// whether the email went, `error` why not.
export interface EmailedLink {
  email: string;
  link: string;
  expires_at: string;
  sent: boolean;
  error?: string;
}

export interface Token {
  id: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
  current: boolean;
}

export interface ImportSummary {
  boards_created: number;
  boards_merged: number;
  pins_added: number;
  pins_skipped: number;
}

interface Ok { ok: true }

// The error body, and the Error that request() throws for a failed call.
export interface ErrorBody { error?: string; code?: string; invite_id?: number }
export interface ApiError extends Error {
  status: number;
  data: ErrorBody;
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
// The ApiError behind a caught value, if it is one.
export const apiError = (e: unknown): ApiError | null => (e instanceof Error && 'status' in e ? e as ApiError : null);

// Thin fetch wrapper for /api. A 401 means the session is gone: back to the login page. A 403
// with code password_change_required means the account must choose a new password first.
async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    if (body instanceof Blob) {
      init.body = body;
      headers['Content-Type'] = body.type || 'application/octet-stream';
    } else {
      init.body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(path, init);
  const data: T & ErrorBody = await res.json().catch(() => ({}));
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('signed out');
  }
  if (res.status === 403 && data.code === 'password_change_required') {
    location.href = '/password';
    throw new Error('password change required');
  }
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status, data });
  }
  return data;
}

export const api = {
  boards: () => request<Board[]>('GET', '/api/boards'),
  createBoard: (name: string) => request<Board>('POST', '/api/boards', { name }),
  updateBoard: (id: number, patch: { name: string } | { cover_pin_id: number | null }) => request<Board>('PATCH', `/api/boards/${id}`, patch),
  deleteBoard: (id: number, moveTo?: number | null) => request<Ok>('DELETE', `/api/boards/${id}`, { move_to: moveTo ?? null }),
  boardPins: (id: number) => request<{ board: BoardInfo; pins: Pin[] }>('GET', `/api/boards/${id}/pins`),
  shares: (id: number) => request<Share[]>('GET', `/api/boards/${id}/shares`),
  setShare: (id: number, userId: number, role: Share['role']) => request<Share & { added: boolean }>('PUT', `/api/boards/${id}/shares/${userId}`, { role }),
  removeShare: (id: number, userId: number) => request<Ok>('DELETE', `/api/boards/${id}/shares/${userId}`),
  directory: () => request<Person[]>('GET', '/api/users/directory'),
  pinFromUrl: (boardId: number, url: string) => request<Pin>('POST', '/api/pins/url', { board_id: boardId, url }),
  upload: (boardId: number, file: File) =>
    request<Pin>('POST', `/api/pins/upload?board_id=${boardId}&name=${encodeURIComponent(file.name || '')}`, file),
  me: () => request<Me>('GET', '/api/me'),
  updateMe: (patch: { display_name: string }) => request<Me>('PATCH', '/api/me', patch),
  changePassword: (current: string, next: string) => request<Ok>('POST', '/api/password', { current, new: next }),
  mail: () => request<{ enabled: boolean; reset: boolean }>('GET', '/api/mail'),
  requestEmailChange: (email: string, password: string) => request<Ok & { email: string }>('POST', '/api/email', { email, password }),
  invites: () => request<Invite[]>('GET', '/api/invites'),
  createInvite: (email: string) => request<EmailedLink & { id: number }>('POST', '/api/invites', { email }),
  cancelInvite: (id: number) => request<Ok>('DELETE', `/api/invites/${id}`),
  users: () => request<AdminUser[]>('GET', '/api/users'),
  setAdmin: (id: number, isAdmin: boolean) => request<Omit<AdminUser, 'created_at' | 'last_seen_at' | 'boards' | 'pins'>>('PATCH', `/api/users/${id}`, { is_admin: isAdmin }),
  deleteUser: (id: number) => request<Ok>('DELETE', `/api/users/${id}`),
  resetUser: (id: number) => request<EmailedLink>('POST', `/api/users/${id}/reset`),
  deletePins: (ids: number[]) => request<{ deleted: number }>('POST', '/api/pins/delete', { ids }),
  movePins: (ids: number[], boardId: number) => request<{ moved: number }>('POST', '/api/pins/move', { ids, board_id: boardId }),
  logout: () => request<Ok>('POST', '/api/logout'),
  tokens: () => request<Token[]>('GET', '/api/tokens'),
  revokeToken: (id: number) => request<Ok>('DELETE', `/api/tokens/${id}`),
  importZip: (file: File) => request<ImportSummary>('POST', '/api/import', file),
};

// The export zip is downloaded by navigation (cookie auth), not fetched.
export const exportUrl = (boardId?: number) => (boardId ? `/api/export?board=${boardId}` : '/api/export');

export const originalUrl = (pin: { sha256: string }) => `/i/${pin.sha256}`;
export const thumbUrl = (pin: { sha256: string }, size: number) => `/t/${size}/${pin.sha256}`;
