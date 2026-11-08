// Connect a mailbox from a terminal: MAIL_OWNER_ID=<owner id> mail-mcp-server connect [login_hint]

import { openInBrowser } from './browser.ts';
import { loadClient, loadOwner, loadTokenStore } from './config.ts';
import { Mail } from './mail.ts';

const [command, loginHint] = process.argv.slice(2);
if (command !== 'connect') {
  process.stderr.write('Usage: mail-mcp-server connect [login_hint]\n');
  process.exit(2);
}

try {
  const mail = new Mail({ client: loadClient(), store: loadTokenStore(loadOwner()) });
  const pending = await mail.connect(loginHint);
  process.stderr.write(`Opening Google's consent page. If no browser opens, visit:\n${pending.url}\n`);
  openInBrowser(pending.url);
  const { mailbox } = await pending.done;
  process.stdout.write(`connected ${mailbox}\n`);
} catch (e) {
  process.stderr.write(`ERROR: ${(e as Error).message}\n`);
  process.exit(1);
}
