import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

import { useTheme } from '@/shared/hooks/useTheme';
import { getTerminalTheme } from '@/shared/lib/terminalTheme';
import { useTerminal } from '@/shared/hooks/useTerminal';

interface XTermInstanceProps {
  tabId: string;
  workspaceId: string;
  isActive: boolean;
  /**
   * When set, attach this terminal to the running headed agent's tmux session
   * (`vk-<executionProcessId>`) instead of opening a plain workspace shell.
   */
  executionProcessId?: string;
  onClose?: () => void;
}

export function XTermInstance({
  tabId,
  workspaceId,
  isActive,
  executionProcessId,
  onClose,
}: XTermInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initialSizeRef = useRef({ cols: 80, rows: 24 });
  const { theme } = useTheme();
  const {
    registerTerminalInstance,
    getTerminalInstance,
    createTerminalConnection,
    getTerminalConnection,
  } = useTerminal();

  const endpoint = useMemo(() => {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const host = window.location.host;
    const params = new URLSearchParams({
      workspace_id: workspaceId,
      cols: String(initialSizeRef.current.cols),
      rows: String(initialSizeRef.current.rows),
    });
    if (executionProcessId) {
      params.set('execution_process_id', executionProcessId);
    }
    return `${protocol}//${host}/api/terminal/ws?${params.toString()}`;
  }, [workspaceId, executionProcessId]);

  const fitTerminal = useCallback(() => {
    fitAddonRef.current?.fit();
    if (terminalRef.current) {
      const conn = getTerminalConnection(tabId);
      conn?.resize(terminalRef.current.cols, terminalRef.current.rows);
    }
  }, [tabId, getTerminalConnection]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // A single xterm instance per tab is shared between the in-sidebar terminal
    // and the expanded (full-pane) terminal: only one is mounted at a time, and
    // we move the terminal's DOM element into whichever container is live.
    const existing = getTerminalInstance(tabId);
    let terminal: Terminal;
    let fitAddon: FitAddon;

    if (existing) {
      terminal = existing.terminal;
      fitAddon = existing.fitAddon;
      if (terminal.element) {
        container.appendChild(terminal.element);
      }
    } else {
      terminal = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: '"IBM Plex Mono", monospace',
        theme: getTerminalTheme(),
      });

      fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();

      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(container);

      fitAddon.fit();
      initialSizeRef.current = { cols: terminal.cols, rows: terminal.rows };

      if (!getTerminalConnection(tabId)) {
        createTerminalConnection(
          tabId,
          endpoint,
          (data) => terminal.write(data),
          onClose
        );
      }

      registerTerminalInstance(tabId, terminal, fitAddon);

      terminal.onData((data) => {
        const conn = getTerminalConnection(tabId);
        conn?.send(data);
      });
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Re-fit and force a repaint on the next frame: a moved element keeps its
    // buffer, but the xterm renderer stays blank until it is refreshed, and the
    // new container's size may differ. Also re-sync the PTY size to the client.
    const raf = requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
      getTerminalConnection(tabId)?.resize(terminal.cols, terminal.rows);
    });

    return () => {
      cancelAnimationFrame(raf);
      // Only detach the element if it still lives in THIS container — never
      // steal it from another container that may have re-parented it (e.g.
      // when switching between the sidebar and expanded terminal views).
      const el = terminal.element;
      if (el && el.parentNode === container) {
        container.removeChild(el);
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    tabId,
    endpoint,
    onClose,
    getTerminalInstance,
    registerTerminalInstance,
    createTerminalConnection,
    getTerminalConnection,
  ]);

  useEffect(() => {
    if (!resizeRef.current) return;
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(resizeRef.current);
    return () => observer.disconnect();
  }, [fitTerminal]);

  useEffect(() => {
    if (isActive) terminalRef.current?.focus();
  }, [isActive]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTerminalTheme();
    }
  }, [theme]);

  return (
    <div ref={resizeRef} className="w-full h-full px-2 py-1">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
