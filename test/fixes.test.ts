// Regression tests for the review fixes (2026-04-25)

import { OutputManager } from '../src/core/output.js';

let pass = 0, fail = 0;
function t(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`  ✅ ${name}`); pass++; },
    (e: any) => { console.log(`  ❌ ${name}: ${e.message}`); fail++; },
  );
}

// ─── Mock Feishu client that records and can simulate slow replies ───
class MockFeishu {
  public replyCount = 0;
  public updateCount = 0;
  public replyDelayMs = 0;
  public idCounter = 0;

  async replyCard(_msgId: string, _card: any) {
    this.replyCount++;
    const id = `msg_${++this.idCounter}`;
    if (this.replyDelayMs) await new Promise(r => setTimeout(r, this.replyDelayMs));
    return id;
  }
  async updateCard(_msgId: string, _card: any) {
    this.updateCount++;
  }
  async sendCard(): Promise<string> { return 'sendCard'; }
  async sendText(): Promise<string> { return 'sendText'; }
  async replyText(): Promise<string> { return 'replyText'; }
  client: any = {};
}

async function main() {
  console.log('── OutputManager ──');

  await t('concurrent flush → single first card (no double reply)', async () => {
    const mock = new MockFeishu() as any;
    mock.replyDelayMs = 100;
    const om = new OutputManager(mock, 'chat1', 'srv1', 'msg_parent');
    // Two updates that race to flush during the first replyCard
    om.updateText('hello');
    om.addToolLog('tool a');
    // Force two immediate flushes
    await Promise.all([om.flush(), om.flush(), om.flush()]);
    if (mock.replyCount !== 1) throw new Error(`expected 1 reply, got ${mock.replyCount}`);
  });

  await t('after first card, subsequent flushes use update (not reply)', async () => {
    const mock = new MockFeishu() as any;
    const om = new OutputManager(mock, 'chat1', 'srv1', 'msg_parent');
    om.updateText('x');
    await om.flush();
    om.updateText('y');
    await om.flush();
    om.addToolLog('z');
    await om.flush();
    if (mock.replyCount !== 1) throw new Error(`expected 1 reply, got ${mock.replyCount}`);
    if (mock.updateCount < 2) throw new Error(`expected ≥2 updates, got ${mock.updateCount}`);
  });

  await t('replaceWithCard waits for in-flight flush', async () => {
    const mock = new MockFeishu() as any;
    mock.replyDelayMs = 80;
    const om = new OutputManager(mock, 'chat1', 'srv1', 'msg_parent');
    om.updateText('progress');
    const p = om.flush();
    await om.replaceWithCard({ header: 'done' });
    await p;
    if (mock.replyCount !== 1) throw new Error(`expected 1 reply, got ${mock.replyCount}`);
    if (mock.updateCount < 1) throw new Error(`expected at least 1 update (for replace)`);
  });

  await t('flush swallows feishu errors', async () => {
    const mock = new MockFeishu() as any;
    mock.replyCard = async () => { throw new Error('api boom'); };
    const om = new OutputManager(mock, 'chat1', 'srv1', 'msg_parent');
    om.updateText('boom');
    await om.flush(); // should not throw
  });

  console.log('\n── Auth-failed regex (executor.testServer) ──');
  const authFailedRe = /not\s+logged\s+in|not\s+authenticated|please\s+log\s+in|unauthorized|no\s+credentials/i;
  await t('matches "Not logged in"', () => {
    if (!authFailedRe.test('Not logged in')) throw new Error('expected match');
  });
  await t('matches "unauthorized"', () => {
    if (!authFailedRe.test('HTTP 401 unauthorized')) throw new Error('expected match');
  });
  await t('does NOT match "Node version v22"', () => {
    if (authFailedRe.test('Node version v22')) throw new Error('false positive');
  });
  await t('does NOT match "All good"', () => {
    if (authFailedRe.test('All good')) throw new Error('false positive');
  });

  console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
