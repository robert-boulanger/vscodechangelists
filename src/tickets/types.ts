export interface Ticket {
  /** Ticket key/number (e.g. "PROJ-123" or "#42") */
  key: string;
  /** Ticket title/summary */
  title: string;
  /** Combined label for QuickPick: "PROJ-123: Fix login bug" */
  label: string;
  /** Optional: ticket status */
  status?: string;
}

export interface TicketProvider {
  /** Provider name for display */
  readonly name: string;

  /** Search/filter tickets by query string */
  search(query: string): Promise<Ticket[]>;

  /** Test if the provider is configured and reachable */
  isAvailable(): Promise<boolean>;
}
