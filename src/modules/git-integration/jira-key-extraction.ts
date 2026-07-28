// Standard Jira key shape: one or more uppercase letters/digits (starting with a
// letter), a dash, then digits — e.g. SIM40-1234.
const JIRA_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;

export function extractJiraKeys(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(JIRA_KEY_PATTERN)) {
      found.add(match[0]);
    }
  }
  return [...found];
}
