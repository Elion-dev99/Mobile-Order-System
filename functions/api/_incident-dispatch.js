/**
 * Shared Cursor Cloud Agent dispatch + prompt builder (incident / debug).
 */

const DEFAULT_REPO = 'https://github.com/Elion-dev99/Mobile-Order-System';

export function buildAgentPrompt(incident = {}) {
  const role = incident.cardinalRole === 'guardian' ? 'guardian' : 'executor';
  const lines = [
    role === 'guardian'
      ? 'あなたは QuickOrder Cardinal の Guardian（監視体）です。障害を整理し、Executor 向けタスクと再起動判断を行ってください。'
      : 'QuickOrder（Mobile-Order-System）で本番障害が発生しました。あなたは Cardinal Executor（実行体）として自動対処してください。',
    '',
    '## 自律運営方針（約90%を Cursor が担う）',
    '- 人間の承認待ちを最小化。調査→修正→draft PR まで一気に進める',
    '- 人間ゲートはシークレット・mainマージ・escalate・破壊的操作のみ（docs/autonomy.md）',
    '',
    '## 方針',
    '1. まず原因を特定（Firestore / Cloudflare Pages Function / フロント / 回線）',
    '2. コードや設定で直せるなら修正し、draft PRを作成（Guardian なら起票・レビューに専念）',
    '3. 外部障害（Firebase/Cloudflare本体ダウン）なら、ユーザー向けフォールバックと監視を強化する変更を提案',
    '4. 客席注文の保留キュー（mos_pending_orders）や health/load/Cardinal 監視を壊さない',
    '5. docs/autonomy.md / docs/cardinal.md / docs/system-watchdog.md に従う',
    '',
    '## インシデント詳細',
    '```json',
    JSON.stringify(incident, null, 2).slice(0, 6000),
    '```',
    '',
    'リポジトリ: Elion-dev99/Mobile-Order-System / ベースブランチ main',
  ];
  return lines.join('\n');
}

export async function dispatchCursorAgent(env, incident) {
  const apiKey = env?.CURSOR_API_KEY || '';
  const repo = env?.CURSOR_REPO || DEFAULT_REPO;
  const results = { agent: null, automation: null };

  const autoUrl = env?.CURSOR_AUTOMATION_WEBHOOK_URL || '';
  const autoKey = env?.CURSOR_AUTOMATION_API_KEY || '';
  if (autoUrl && autoKey) {
    try {
      const res = await fetch(autoUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Basic ' + btoa(`${autoKey}:`),
        },
        body: JSON.stringify({
          text: buildAgentPrompt(incident),
          incident,
          source: incident.source || 'quickorder-incident',
        }),
      });
      const raw = await res.text();
      results.automation = { ok: res.ok, status: res.status, raw: raw.slice(0, 300) };
    } catch (e) {
      results.automation = { ok: false, error: String(e?.message || e) };
    }
  }

  if (apiKey) {
    const slug = String(incident.feature || 'debug').replace(/[^\w-]+/g, '-').slice(0, 24);
    try {
      const res = await fetch('https://api.cursor.com/v0/agents', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Basic ' + btoa(`${apiKey}:`),
        },
        body: JSON.stringify({
          prompt: { text: buildAgentPrompt(incident) },
          source: { repository: repo, ref: 'main' },
          target: {
            autoCreatePr: true,
            branchName: `cursor/${slug}-${Date.now().toString(36).slice(-6)}-a58c`,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      results.agent = { ok: res.ok, status: res.status, data };
    } catch (e) {
      results.agent = { ok: false, error: String(e?.message || e) };
    }
  }

  return results;
}
