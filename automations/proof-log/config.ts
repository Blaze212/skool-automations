import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_PATH = path.join(os.homedir(), '.config', 'skool-automations', 'proof-log.json');

export interface ProofLogConfig {
  inboxDir: string;
  doneDir: string;
  driveFolderId: string;
  sheetId: string;
}

export function readConfig(): ProofLogConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Proof log config not found at ${CONFIG_PATH}.\n` +
        'Run the first-run wizard: create the file with inboxDir, doneDir, driveFolderId, sheetId.',
    );
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as ProofLogConfig;
}

export function writeConfig(config: ProofLogConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`Config saved to ${CONFIG_PATH}`);
}

export { CONFIG_PATH };
