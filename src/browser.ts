import { spawn } from 'node:child_process';

// Best effort: the consent URL is always shown too, for when no browser opens.
export function openInBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  const child = spawn(command, args as string[], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}
