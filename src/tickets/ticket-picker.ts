import * as vscode from 'vscode';
import { TicketProvider, Ticket } from './types';

interface TicketQuickPickItem extends vscode.QuickPickItem {
  ticket?: Ticket;
}

/**
 * Shows a QuickPick with tickets from the provider.
 * Loads tickets once, then uses VSCode's built-in instant filtering.
 * Returns the selected name or undefined if cancelled.
 */
export async function showTicketPicker(provider: TicketProvider): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<TicketQuickPickItem>();
    quickPick.title = 'New Changelist';
    quickPick.placeholder = `Search ${provider.name} tickets or type a custom name...`;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.busy = true;

    let resolved = false;

    // Load tickets once, then let VSCode filter locally
    void provider.search('').then(tickets => {
      quickPick.items = tickets.map(ticket => ({
        label: ticket.label,
        description: ticket.status,
        detail: ticket.key,
        ticket,
      }));
      quickPick.busy = false;
    }).catch(() => {
      quickPick.items = [];
      quickPick.busy = false;
    });

    quickPick.onDidAccept(() => {
      if (resolved) return;
      resolved = true;

      const selected = quickPick.selectedItems[0];
      if (selected?.ticket) {
        resolve(selected.ticket.label);
      } else if (quickPick.value.trim()) {
        // User typed a custom name (no ticket selected)
        resolve(quickPick.value.trim());
      } else {
        resolve(undefined);
      }
      quickPick.dispose();
    });

    quickPick.onDidHide(() => {
      if (!resolved) {
        resolved = true;
        resolve(undefined);
      }
      quickPick.dispose();
    });

    quickPick.show();
  });
}
