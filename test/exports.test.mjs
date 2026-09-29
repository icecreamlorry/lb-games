// test/exports.test.mjs — ES Module Named Export Integrity Test for LB Games

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const REQUIRED_CONFIG_EXPORTS = ['GAME_SLUG', 'GAME_NAME', 'configReady', 'API_BASE'];
const REQUIRED_NOTIFY_EXPORTS = ['notificationsSupported', 'notificationPermission', 'isEnabled', 'subscribeToPush', 'registerServiceWorker'];

const games = ['reversi', 'dominoes', 'chrono', 'chess', 'backgammon', 'weiqi', 'flagz', 'atlaz', 'atomyx', 'buffz', 'draughts', 'rummikub'];

let passed = true;

console.log('Running ES Module Export Verification Test...\n');

games.forEach((game) => {
  const configPath = path.join(rootDir, game, 'js', 'config.js');
  const notifyPath = path.join(rootDir, game, 'js', 'notify.js');

  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf8');
    REQUIRED_CONFIG_EXPORTS.forEach((exp) => {
      if (!content.includes(exp)) {
        console.error(`❌ [${game}/js/config.js] Missing required export '${exp}'`);
        passed = false;
      }
    });
  }

  if (fs.existsSync(notifyPath)) {
    const content = fs.readFileSync(notifyPath, 'utf8');
    REQUIRED_NOTIFY_EXPORTS.forEach((exp) => {
      if (!content.includes(exp)) {
        console.error(`❌ [${game}/js/notify.js] Missing required export '${exp}'`);
        passed = false;
      }
    });
  }
});

if (!passed) {
  console.error('\n❌ Export verification failed!');
  process.exit(1);
} else {
  console.log('✅ All game config.js and notify.js modules provide 100% required named exports!');
}
