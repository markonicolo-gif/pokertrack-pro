const STORAGE_KEY = 'pokerSessions';

export function getSessions() {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function saveSessions(sessions) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

export function addSession(session) {
  const sessions = getSessions();
  session.id = crypto.randomUUID();
  sessions.push(session);
  saveSessions(sessions);
  return sessions;
}

export function updateSession(id, updates) {
  const sessions = getSessions();
  const idx = sessions.findIndex(s => s.id === id);
  if (idx === -1) return sessions;
  sessions[idx] = { ...sessions[idx], ...updates };
  saveSessions(sessions);
  return sessions;
}

export function deleteSession(id) {
  const sessions = getSessions().filter(s => s.id !== id);
  saveSessions(sessions);
  return sessions;
}

export function clearAll() {
  localStorage.removeItem(STORAGE_KEY);
}
