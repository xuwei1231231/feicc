// 卡片构建 + 命令处理自动化测试

import {
  progressCard, doneCard, errorCard, authErrorCard,
  serverListCard, workspaceListCard, permissionModeCard,
  menuCard, helpCard, statusCard, testResultCard,
  confirmCard, toastCard, addServerFormCard, addWorkspaceFormCard,
  uploadKeyPromptCard,
} from '../src/feishu/cards.js';
import { handleCommand } from '../src/core/commands.js';

let pass = 0, fail = 0;

function assertCard(name: string, result: any) {
  if (!result.header || !result.elements) throw new Error('missing header or elements');
  function checkValues(obj: any) {
    if (Array.isArray(obj)) return obj.forEach(checkValues);
    if (!obj || typeof obj !== 'object') return;
    if (obj.tag === 'button' && obj.value !== undefined && typeof obj.value === 'string') {
      throw new Error(`button value is string: ${JSON.stringify(obj.value)}`);
    }
    Object.values(obj).forEach(checkValues);
  }
  checkValues(result);
}

function test(name: string, fn: () => any) {
  try {
    assertCard(name, fn());
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (e: any) {
    console.log(`  ❌ ${name}: ${e.message}`);
    fail++;
  }
}

async function main() {
  console.log('\n── Card builders ──');
  test('progressCard', () => progressCard('s1', ['📁 read file.ts'], 'output'));
  test('progressCard (empty)', () => progressCard('s1', [], ''));
  test('doneCard', () => doneCard('s1', 'home', 'result', 0.01, { input_tokens: 100, output_tokens: 50 }, 3500));
  test('errorCard', () => errorCard('s1', 'SSH error'));
  test('authErrorCard', () => authErrorCard('s1', 'host.com', 'not logged in'));
  test('serverListCard (empty)', () => serverListCard([]));
  test('serverListCard', () => serverListCard([
    { id: 'gpu0', name: 'GPU', status: 'configured', host: 'h1', workspaces: ['home'] },
    { id: 'web0', name: 'Web', status: 'configured', host: 'h2', workspaces: ['api'] },
  ], 'gpu0'));
  test('workspaceListCard (empty)', () => workspaceListCard('s1', []));
  test('workspaceListCard', () => workspaceListCard('s1', [
    { id: 'home', name: 'Home', cwd: '/home/u' },
    { id: 'proj', name: 'Project', cwd: '/home/u/proj' },
  ], 'home'));
  test('permissionModeCard', () => permissionModeCard('bypassPermissions'));
  test('menuCard (no session)', () => menuCard());
  test('menuCard (with session)', () => menuCard('gpu0', 'home', 'bypassPermissions'));
  test('helpCard', () => helpCard());
  test('statusCard', () => statusCard({ serverCount: 2, servers: 'gpu0, web0' }));
  test('testResultCard (ok)', () => testResultCard('s1', true, 'OK'));
  test('testResultCard (fail)', () => testResultCard('s1', false, 'Error'));
  test('confirmCard', () => confirmCard('Title', 'Msg', 'action'));
  test('toastCard', () => toastCard('Done'));
  test('addServerFormCard', () => addServerFormCard());
  test('addWorkspaceFormCard', () => addWorkspaceFormCard('s1'));
  test('uploadKeyPromptCard', () => uploadKeyPromptCard('s1'));

  console.log('\n── Commands ──');
  const mockCtx = {
    feishu: { replyCard: async () => 'msg', replyText: async () => 'msg', sendCard: async () => 'msg' } as any,
    router: {
      getServer: (id: string) => id === 'gpu0' ? { id: 'gpu0', name: 'GPU', host: 'h1', workspaces: [{ id: 'home', name: 'Home', cwd: '/home/u' }] } : undefined,
      getServers: () => [{ id: 'gpu0', name: 'GPU', host: 'h1', workspaces: [{ id: 'home', name: 'Home', cwd: '/home/u' }] }],
      abortTask: () => true,
      testServerConnection: async () => ({ ok: true, version: '1.0', auth: 'ok' }),
    } as any,
    store: { updateSessionServer: () => {}, updateSessionClaudeId: () => {}, updateSessionPermission: () => {} } as any,
    chatId: 'oc_test', userId: 'ou_test', messageId: 'om_test',
    session: { id: 's1', server_id: 'gpu0', workspace_id: 'home', permission_mode: 'bypassPermissions' } as any,
  };

  async function testCmd(name: string, text: string, expectHandled = true) {
    try {
      const result = await handleCommand(text, mockCtx);
      if (result.handled !== expectHandled) throw new Error(`handled=${result.handled}`);
      if (expectHandled && !result.card && !result.reply) throw new Error('no output');
      if (result.card) assertCard(name, result.card);
      console.log(`  ✅ ${name}`);
      pass++;
    } catch (e: any) {
      console.log(`  ❌ ${name}: ${e.message}`);
      fail++;
    }
  }

  await testCmd('/menu', '/menu');
  await testCmd('/help', '/help');
  await testCmd('/server', '/server');
  await testCmd('/server use gpu0', '/server use gpu0');
  await testCmd('/server use unknown', '/server use bad');
  await testCmd('/ws', '/ws');
  await testCmd('/ws use home', '/ws use home');
  await testCmd('/perm', '/perm');
  await testCmd('/new', '/new');
  await testCmd('/stop', '/stop');
  await testCmd('/status', '/status');
  await testCmd('normal msg (not handled)', 'hello', false);
  await testCmd('unknown cmd (not handled)', '/unknown', false);

  console.log(`\n── Result: ${pass} passed, ${fail} failed ──\n`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
