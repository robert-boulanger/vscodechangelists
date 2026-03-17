import * as vscode from 'vscode';
import { Ticket, TicketProvider } from './types';

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status?: { name: string };
  };
}

interface JiraSearchResponse {
  issues: JiraIssue[];
}

export class JiraTicketProvider implements TicketProvider {
  readonly name = 'Jira';

  private cache: Map<string, { tickets: Ticket[]; timestamp: number }> = new Map();
  private readonly cacheTtlMs = 60_000; // 1 minute

  private getConfig() {
    const config = vscode.workspace.getConfiguration('changelists');
    return {
      baseUrl: config.get<string>('jira.baseUrl', '').replace(/\/$/, ''),
      projectKey: config.get<string>('jira.projectKey', ''),
      token: config.get<string>('jira.token', ''),
      email: config.get<string>('jira.email', ''),
    };
  }

  async isAvailable(): Promise<boolean> {
    const { baseUrl, token } = this.getConfig();
    if (!baseUrl || !token) return false;

    try {
      const response = await this.fetchGet(`${baseUrl}/rest/api/3/myself`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async search(query: string): Promise<Ticket[]> {
    const { baseUrl, projectKey, token } = this.getConfig();
    if (!baseUrl || !token) return [];

    const cacheKey = `${projectKey}:${query}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.tickets;
    }

    try {
      const jql = this.buildJql(query, projectKey);

      // New API v3 endpoint: POST /rest/api/3/search/jql
      const url = `${baseUrl}/rest/api/3/search/jql`;
      const response = await this.fetchPost(url, {
        jql,
        maxResults: 20,
        fields: ['summary', 'status'],
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.error(`Jira API ${response.status}: ${body}`);
        return [];
      }

      const data = (await response.json()) as JiraSearchResponse;
      const tickets: Ticket[] = data.issues.map(issue => ({
        key: issue.key,
        title: issue.fields.summary,
        label: `${issue.key}: ${issue.fields.summary}`,
        status: issue.fields.status?.name,
      }));

      this.cache.set(cacheKey, { tickets, timestamp: Date.now() });
      return tickets;
    } catch (err) {
      console.error('Jira search failed:', err);
      return [];
    }
  }

  private buildJql(query: string, projectKey: string): string {
    const conditions: string[] = [];

    if (projectKey) {
      conditions.push(`project = "${projectKey}"`);
    }

    conditions.push('statusCategory != Done');

    if (query.trim()) {
      // Check if query looks like a ticket key (e.g., PROJ-123)
      const keyMatch = query.match(/^([A-Z]+-\d+)$/i);
      if (keyMatch) {
        return `key = "${keyMatch[1].toUpperCase()}" OR (${conditions.join(' AND ')}) ORDER BY updated DESC`;
      }

      // Text search
      conditions.push(`text ~ "${query}"`);
    }

    return `${conditions.join(' AND ')} ORDER BY updated DESC`;
  }

  private getAuthHeaders(): Record<string, string> {
    const { token, email } = this.getConfig();

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    if (email) {
      // Basic auth: email:token (required for Atlassian Cloud)
      headers['Authorization'] = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    } else {
      // Bearer token (PAT)
      headers['Authorization'] = `Bearer ${token}`;
    }

    return headers;
  }

  private fetchGet(url: string): Promise<Response> {
    return globalThis.fetch(url, { headers: this.getAuthHeaders() });
  }

  private fetchPost(url: string, body: Record<string, unknown>): Promise<Response> {
    return globalThis.fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(body),
    });
  }
}
