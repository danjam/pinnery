// Thin fetch wrapper for /api. A 401 means the session is gone: back to the login page. A 403
// with code password_change_required means the account must choose a new password first.
async function request(method, path, body, headers = {}) {
  const init = { method, headers };
  if (body !== undefined) {
    if (body instanceof Blob) {
      init.body = body;
      init.headers['Content-Type'] = body.type || 'application/octet-stream';
    } else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('signed out');
  }
  if (res.status === 403 && data.code === 'password_change_required') {
    location.href = '/password';
    throw new Error('password change required');
  }
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  boards: () => request('GET', '/api/boards'),
  createBoard: (name) => request('POST', '/api/boards', { name }),
  updateBoard: (id, patch) => request('PATCH', `/api/boards/${id}`, patch),
  deleteBoard: (id, moveTo) => request('DELETE', `/api/boards/${id}`, { move_to: moveTo ?? null }),
  boardPins: (id) => request('GET', `/api/boards/${id}/pins`),
  shares: (id) => request('GET', `/api/boards/${id}/shares`),
  setShare: (id, userId, role) => request('PUT', `/api/boards/${id}/shares/${userId}`, { role }),
  removeShare: (id, userId) => request('DELETE', `/api/boards/${id}/shares/${userId}`),
  directory: () => request('GET', '/api/users/directory'),
  pinFromUrl: (boardId, url) => request('POST', '/api/pins/url', { board_id: boardId, url }),
  upload: (boardId, file) => request('POST', `/api/pins/upload?board_id=${boardId}&name=${encodeURIComponent(file.name || '')}`, file),
  me: () => request('GET', '/api/me'),
  updateMe: (patch) => request('PATCH', '/api/me', patch),
  changePassword: (current, next) => request('POST', '/api/password', { current, new: next }),
  mail: () => request('GET', '/api/mail'),
  requestEmailChange: (email, password) => request('POST', '/api/email', { email, password }),
  invites: () => request('GET', '/api/invites'),
  createInvite: (email) => request('POST', '/api/invites', { email }),
  cancelInvite: (id) => request('DELETE', `/api/invites/${id}`),
  users: () => request('GET', '/api/users'),
  setAdmin: (id, isAdmin) => request('PATCH', `/api/users/${id}`, { is_admin: isAdmin }),
  deleteUser: (id) => request('DELETE', `/api/users/${id}`),
  resetUser: (id) => request('POST', `/api/users/${id}/reset`),
  deletePins: (ids) => request('POST', '/api/pins/delete', { ids }),
  movePins: (ids, boardId) => request('POST', '/api/pins/move', { ids, board_id: boardId }),
  logout: () => request('POST', '/api/logout'),
  tokens: () => request('GET', '/api/tokens'),
  revokeToken: (id) => request('DELETE', `/api/tokens/${id}`),
  importZip: (file) => request('POST', '/api/import', file),
};

// The export zip is downloaded by navigation (cookie auth), not fetched.
export const exportUrl = (boardId) => (boardId ? `/api/export?board=${boardId}` : '/api/export');

export const originalUrl = (pin) => `/i/${pin.sha256}`;
export const thumbUrl = (pin, size) => `/t/${size}/${pin.sha256}`;
