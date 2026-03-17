import * as vscode from 'vscode';
import { Ticket, TicketProvider } from './types';

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string }>;
}

export class GitHubTicketProvider implements TicketProvider {
  readonly name = 'GitHub';

  private cache: Map<string, { tickets: Ticket[]; timestamp: number }> = new Map();
  private readonly cacheTtlMs = 60_000; // 1 minute

  private getConfig() {
    const config = vscode.workspace.getConfiguration('changelists');
    return {
      token: config.get<string>('github.token', '').trim(),
      owner: config.get<string>('github.owner', '').trim(),
      repo: config.get<string>('github.repo', '').trim(),
    };
  }

  async isAvailable(): Promise<boolean> {
    const { token, owner, repo } = this.getConfig();
    if (!token || !owner || !repo) return false;

    try {
      const response = await this.fetch(`https://api.github.com/repos/${owner}/${repo}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async search(query: string): Promise<Ticket[]> {
    const { owner, repo, token } = this.getConfig();
    if (!owner || !repo || !token) return [];

    const cacheKey = `${owner}/${repo}:${query}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.tickets;
    }

    try {
      let url: string;

      if (query.trim()) {
        const q = encodeURIComponent(`repo:${owner}/${repo} is:issue is:open ${query}`);
        url = `https://api.github.com/search/issues?q=${q}&per_page=20&sort=updated`;
      } else {
        url = `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=20&sort=updated`;
      }

      const response = await this.fetch(url);
      if (!response.ok) return [];

      const data = await response.json();
      const issues: GitHubIssue[] = query.trim()
        ? (data as { items: GitHubIssue[] }).items
        : (data as GitHubIssue[]);

      const tickets: Ticket[] = (issues ?? [])
        .filter(issue => !(issue as unknown as { pull_request?: unknown }).pull_request)
        .map(issue => ({
          key: `#${issue.number}`,
          title: issue.title,
          label: `#${issue.number}: ${issue.title}`,
          status: issue.state,
        }));

      this.cache.set(cacheKey, { tickets, timestamp: Date.now() });
      return tickets;
    } catch {
      return [];
    }
  }

  private async fetch(url: string): Promise<Response> {
    const { token } = this.getConfig();

    return globalThis.fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }
}
