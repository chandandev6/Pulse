// Remembers the last project you looked at, so "/" can bring you back to it.
// Browser storage can be blocked (private mode), so failures are simply ignored.
const KEY = "pulse:lastProject";

export function rememberProject(projectId: string) {
  try {
    if (projectId) localStorage.setItem(KEY, projectId);
  } catch {
    // ignore
  }
}

export function lastProject(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
