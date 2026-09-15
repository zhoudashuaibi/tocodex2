import { errors } from '../../lib/http-errors.js';
import { allocateShortName, extractAccountEmail } from './names.js';

/**
 * Team 号池核心服务：卡密导入 + 后台会话（健康检查 / 提取找回）。
 * 会话为单实例内存态（仿 codex2api monitor），前端轮询 view() 获取进度。
 * 并发遵守官方限制：20 张卡密/批串行提交，下载小并发。
 */

const CARD_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{2,126}[A-Za-z0-9]$/;
const RECLAIM_BATCH_SIZE = 20;
const HEALTH_CHECK_BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 12_000;
const POLL_MAX_MS_PER_BATCH = 10 * 60_000;
const POLL_MAX_CONSECUTIVE_ERRORS = 5;
const DOWNLOAD_CONCURRENCY = 4;
const MAX_CARDS_PER_SESSION = 1000;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskOutcome(task) {
  switch (String(task.status || '').toLowerCase()) {
    case 'done':
      return task.no_action ? 'no_action' : 'updated';
    case 'unreclaimable':
      return 'unreclaimable';
    case 'failed':
      return 'failed';
    case 'not_owned':
      return 'not_owned';
    case 'skipped':
      return 'skipped';
    default:
      return 'other';
  }
}

export function createTeamService({ db, crypto, redeemClient, getTeamConfig, uploader, logger }) {
  const state = {
    running: false,
    kind: null,
    phase: null,
    message: '',
    progress: null,
    result: null,
    error: null,
    started_at: null,
    updated_at: null,
  };

  function view() {
    return { ...state };
  }

  function touch(phase, message, progress = state.progress) {
    state.phase = phase;
    state.message = message || '';
    state.progress = progress;
    state.updated_at = new Date().toISOString();
  }

  function beginSession(kind) {
    if (state.running) {
      throw errors.conflict('Team 会话进行中，请等待完成后再操作', 'TEAM_SESSION_BUSY');
    }
    state.running = true;
    state.kind = kind;
    state.phase = 'starting';
    state.message = '';
    state.progress = null;
    state.result = null;
    state.error = null;
    state.started_at = new Date().toISOString();
    state.updated_at = state.started_at;
  }

  function finishSession(result) {
    state.running = false;
    state.phase = 'done';
    state.result = result;
    state.progress = null;
    state.updated_at = new Date().toISOString();
  }

  function failSession(error) {
    state.running = false;
    state.phase = 'error';
    state.error = String(error?.message || error).slice(0, 400);
    state.updated_at = new Date().toISOString();
  }

  function loadCards(ids) {
    if (!Array.isArray(ids) || !ids.length) throw errors.validation('请选择卡密');
    const unique = [...new Set(ids.map(Number).filter((v) => Number.isSafeInteger(v) && v > 0))];
    if (!unique.length) throw errors.validation('卡密 ID 不合法');
    if (unique.length > MAX_CARDS_PER_SESSION) throw errors.validation(`单次最多处理 ${MAX_CARDS_PER_SESSION} 张卡密`);
    const cards = [];
    for (const part of chunk(unique, 500)) {
      const rows = db
        .prepare(`SELECT * FROM team_cards WHERE id IN (${part.map(() => '?').join(',')})`)
        .all(...part);
      cards.push(...rows);
    }
    if (!cards.length) throw errors.notFound('卡密不存在');
    return cards;
  }

  // ---- 卡密导入 ----

  function importCards(text) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const invalid = [];
    const seen = new Set();
    const dupInBatch = [];
    const unique = [];
    lines.forEach((line, index) => {
      const code = line.split(/\s+/)[0];
      if (!CARD_CODE_PATTERN.test(code)) {
        invalid.push({ line: index + 1, value: line.slice(0, 80) });
        return;
      }
      if (seen.has(code)) {
        if (!dupInBatch.includes(code)) dupInBatch.push(code);
        return;
      }
      seen.add(code);
      unique.push(code);
    });
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO team_cards(card_code, status, created_at, updated_at) VALUES(?, 'unextracted', ?, ?)`,
    );
    const findByCode = db.prepare('SELECT id FROM team_cards WHERE card_code = ?');
    const dupExisting = [];
    const importedIds = [];
    let imported = 0;
    db.transaction(() => {
      for (const code of unique) {
        if (findByCode.get(code)) {
          dupExisting.push(code);
          continue;
        }
        const result = insert.run(code, now, now);
        imported += 1;
        importedIds.push(Number(result.lastInsertRowid));
      }
    })();
    return { imported, imported_ids: importedIds, duplicates_in_batch: dupInBatch, duplicates_existing: dupExisting, invalid };
  }

  function deleteCards(ids) {
    if (!Array.isArray(ids) || !ids.length) throw errors.validation('请选择要删除的卡密');
    const del = db.prepare('DELETE FROM team_cards WHERE id = ?');
    let deleted = 0;
    db.transaction(() => {
      for (const id of ids) deleted += del.run(Number(id)).changes;
    })();
    return { deleted };
  }

  // ---- 凭据入库（下载的 codex2api JSON → team_accounts，按 (card_id,email) upsert） ----

  function upsertAccounts(card, orderNo, exportJson) {
    const accounts = Array.isArray(exportJson?.accounts) ? exportJson.accounts : [];
    const now = new Date().toISOString();
    const changed = [];
    let inserted = 0;
    let updated = 0;
    db.transaction(() => {
      for (const account of accounts) {
        if (!account || typeof account !== 'object' || !account.credentials) continue;
        const email = extractAccountEmail(account);
        if (!email) continue;
        const enc = crypto.encryptJson(account, 'team_accounts.account_enc');
        const existing = db.prepare('SELECT id FROM team_accounts WHERE card_id = ? AND email = ?').get(card.id, email);
        if (existing) {
          db.prepare(
            `UPDATE team_accounts SET account_enc = ?, name = ?, order_no = ?, health_status = 'healthy', updated_at = ? WHERE id = ?`,
          ).run(enc, String(account.name || ''), orderNo, now, existing.id);
          updated += 1;
          changed.push(existing.id);
        } else {
          const result = db
            .prepare(
              `INSERT INTO team_accounts(card_id, email, short_name, name, order_no, account_enc, health_status, created_at, updated_at)
               VALUES(?,?,?,?,?,?, 'healthy', ?, ?)`,
            )
            .run(card.id, email, allocateShortName(db), String(account.name || ''), orderNo, enc, now, now);
          inserted += 1;
          changed.push(Number(result.lastInsertRowid));
        }
      }
    })();
    return { inserted, updated, changed };
  }

  function cardHasAccounts(cardId) {
    return db.prepare('SELECT 1 FROM team_accounts WHERE card_id = ? LIMIT 1').get(cardId) != null;
  }

  function updateCardsAfterBatch(cardByCode, codes, tasks, mode, now) {
    for (const code of codes) {
      const card = cardByCode.get(code);
      if (!card) continue;
      const cardTasks = tasks.filter((t) => t.card_code === code);
      const outcomes = cardTasks.map(taskOutcome);
      const counts = {
        updated: outcomes.filter((o) => o === 'updated').length,
        no_action: outcomes.filter((o) => o === 'no_action').length,
        unreclaimable: outcomes.filter((o) => o === 'unreclaimable').length,
        failed: outcomes.filter((o) => o === 'failed').length,
        not_owned: outcomes.filter((o) => o === 'not_owned').length,
        skipped: outcomes.filter((o) => o === 'skipped').length,
      };
      let status;
      if (!cardHasAccounts(card.id)) {
        status = counts.unreclaimable || counts.failed || counts.not_owned ? 'mixed' : 'unextracted';
      } else if (counts.unreclaimable > 0 && counts.updated === 0 && counts.no_action === 0) {
        status = 'cannot_reclaim';
      } else if (counts.failed > 0 || counts.unreclaimable > 0 || counts.not_owned > 0) {
        status = 'mixed';
      } else {
        status = 'healthy';
      }
      db.prepare(
        `UPDATE team_cards
           SET status = ?, health = ?, last_reclaim_at = COALESCE(?, last_reclaim_at),
               last_extracted_at = COALESCE(?, last_extracted_at), updated_at = ?
         WHERE id = ?`,
      ).run(
        status,
        JSON.stringify({ summary: counts, checked_at: now }),
        mode === '401' ? now : null,
        mode === 'all' ? now : null,
        now,
        card.id,
      );
    }
  }

  // ---- 健康检查会话 ----

  function normalizeHealthStatus(value) {
    const s = String(value || '').toLowerCase();
    if (s.includes('cannot') || s.includes('permanent')) return 'cannot_reclaim';
    if (s.includes('need') || s.includes('401') || s.includes('reclaim')) return 'need_reclaim';
    if (s.includes('healthy') || s === 'ok' || s === 'normal' || s === 'active') return 'healthy';
    return 'unknown';
  }

  function applyHealthResult(cardByCode, cardCodes, payload, checkedAt) {
    const entries = payload.credentials || [];
    const groupable = entries.length > 0 && entries.every((entry) => entry.card_code);
    const perCardStatuses = new Map(cardCodes.map((code) => [code, []]));

    if (groupable) {
      const stmtUpdateAccount = db.prepare(
        `UPDATE team_accounts SET health_status = ?, updated_at = ? WHERE card_id = ? AND email = ?`,
      );
      db.transaction(() => {
        for (const entry of entries) {
          const card = cardByCode.get(String(entry.card_code));
          if (!card) continue;
          const status = normalizeHealthStatus(entry.status ?? entry.health ?? entry.state);
          perCardStatuses.get(String(entry.card_code))?.push(status);
          const email = String(entry.email || entry.account_email || '').trim().toLowerCase();
          if (email) stmtUpdateAccount.run(status, new Date().toISOString(), card.id, email);
        }
        for (const [code, statuses] of perCardStatuses) {
          const card = cardByCode.get(code);
          if (!card) continue;
          const summary = {
            healthy: statuses.filter((s) => s === 'healthy').length,
            need_reclaim: statuses.filter((s) => s === 'need_reclaim').length,
            cannot_reclaim: statuses.filter((s) => s === 'cannot_reclaim').length,
            unknown: statuses.filter((s) => s === 'unknown').length,
          };
          const derived = deriveCardStatus(card.id, statuses);
          db.prepare(`UPDATE team_cards SET status = ?, health = ?, updated_at = ? WHERE id = ?`).run(
            derived,
            JSON.stringify({ summary, checked_at: checkedAt }),
            checkedAt,
            card.id,
          );
        }
      })();
    } else {
      // 无法按卡密细分：只记检查时间，状态不变，汇总挂在会话结果上
      db.transaction(() => {
        for (const code of cardCodes) {
          const card = cardByCode.get(code);
          if (!card) continue;
          db.prepare(`UPDATE team_cards SET health = ?, updated_at = ? WHERE id = ?`).run(
            JSON.stringify({ summary: null, aggregate_only: true, checked_at: checkedAt }),
            checkedAt,
            card.id,
          );
        }
      })();
    }
  }

  function deriveCardStatus(cardId, statuses) {
    if (!cardHasAccounts(cardId)) return 'unextracted';
    const set = new Set(statuses.length ? statuses : ['unknown']);
    if (set.has('need_reclaim')) return 'need_reclaim';
    if (set.size === 1 && set.has('healthy')) return 'healthy';
    if (set.size === 1 && set.has('cannot_reclaim')) return 'cannot_reclaim';
    return 'mixed';
  }

  async function runHealthCheck(cards) {
    const result = {
      kind: 'health_check',
      cards: cards.length,
      need_reclaim: 0,
      healthy: 0,
      cannot_reclaim: 0,
      unknown: 0,
      not_loadable: 0,
      errors: [],
    };
    const batches = chunk(cards, HEALTH_CHECK_BATCH_SIZE);
    let processed = 0;
    for (const [index, batch] of batches.entries()) {
      touch('checking', `健康检查 ${processed + 1}-${processed + batch.length}/${cards.length}`, {
        done: processed,
        total: cards.length,
      });
      const cardByCode = new Map(batch.map((card) => [card.card_code, card]));
      try {
        const payload = await redeemClient.healthCheck(batch.map((card) => card.card_code));
        result.need_reclaim += payload.need_reclaim;
        result.healthy += payload.healthy;
        result.cannot_reclaim += payload.cannot_reclaim;
        result.unknown += payload.unknown;
        result.not_loadable += payload.not_loadable;
        applyHealthResult(cardByCode, batch.map((card) => card.card_code), payload, new Date().toISOString());
      } catch (error) {
        logger?.warn?.({ err: error.message }, 'team health check batch failed');
        result.errors.push(String(error.message || error).slice(0, 300));
      }
      processed += batch.length;
      touch('checking', `健康检查 ${processed}/${cards.length}`, { done: processed, total: cards.length });
    }
    return result;
  }

  // ---- 提取 / 找回会话 ----

  async function pollBatch(cardCodes, submitted, batchLabel) {
    if (submitted.queued === 0 && submitted.already_running === 0) return { snapshot: submitted, timedOut: false };
    const deadline = Date.now() + POLL_MAX_MS_PER_BATCH;
    let consecutiveErrors = 0;
    let last = submitted;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      try {
        last = await redeemClient.batchCards(cardCodes, { mode: 'all', queryOnly: true });
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        logger?.warn?.({ err: error.message }, 'team reclaim poll failed');
        if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) throw error;
        continue;
      }
      const pending = last.queued + last.already_running;
      touch(
        'polling',
        `${batchLabel}：${last.done}/${last.tracked_tasks} 完成，${pending} 处理中`,
        {
          ...state.progress,
          tasks_done: last.done,
          tasks_total: last.tracked_tasks,
          pending,
        },
      );
      if (pending === 0) return { snapshot: last, timedOut: false };
    }
    return { snapshot: last, timedOut: true };
  }

  async function downloadAndSave(cardByCode, tasks) {
    const changed = [];
    let downloaded = 0;
    let inserted = 0;
    let updated = 0;
    const downloadErrors = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++];
        const card = cardByCode.get(task.card_code);
        if (!card) continue;
        try {
          const exportJson = await redeemClient.downloadOrder(task.order_no, task.download_token);
          const saved = upsertAccounts(card, task.order_no, exportJson);
          downloaded += 1;
          inserted += saved.inserted;
          updated += saved.updated;
          changed.push(...saved.changed);
        } catch (error) {
          logger?.warn?.({ orderNo: task.order_no, err: error.message }, 'team credential download failed');
          downloadErrors.push({ order_no: task.order_no, error: String(error.message || error).slice(0, 300) });
        }
        touch('downloading', `下载凭据 ${downloaded}/${tasks.length}`, { ...state.progress, downloaded, download_total: tasks.length });
      }
    });
    await Promise.all(workers);
    return { downloaded, inserted, updated, changed, downloadErrors };
  }

  async function runReclaim(cards, mode) {
    const result = {
      kind: 'reclaim',
      mode,
      cards: cards.length,
      batches: 0,
      timed_out_batches: 0,
      updated: 0,
      no_action: 0,
      unreclaimable: 0,
      failed: 0,
      not_owned: 0,
      skipped: 0,
      downloaded: 0,
      accounts_inserted: 0,
      accounts_updated: 0,
      download_errors: [],
      upload: null,
      errors: [],
    };
    const cardByCode = new Map(cards.map((card) => [card.card_code, card]));
    const changedAccountIds = [];
    const batches = chunk(cards, RECLAIM_BATCH_SIZE);

    for (const [index, batch] of batches.entries()) {
      const label = `第 ${index + 1}/${batches.length} 批`;
      const codes = batch.map((card) => card.card_code);
      touch('submitting', `${label}提交中（${codes.length} 张卡密）`, {
        batch: index + 1,
        batches: batches.length,
      });
      let submitted;
      try {
        submitted = await redeemClient.batchCards(codes, { mode, queryOnly: false });
      } catch (error) {
        result.errors.push(`${label}提交失败：${String(error.message || error).slice(0, 200)}`);
        continue;
      }
      result.batches += 1;

      const { snapshot, timedOut } = await pollBatch(codes, submitted, label);
      if (timedOut) {
        result.timed_out_batches += 1;
        result.errors.push(`${label}轮询超时（10 分钟），已按当前进度继续`);
      }

      const tasks = snapshot.all_tasks.filter((t) => codes.includes(t.card_code));
      const outcomes = tasks.map(taskOutcome);
      result.updated += outcomes.filter((o) => o === 'updated').length;
      result.no_action += outcomes.filter((o) => o === 'no_action').length;
      result.unreclaimable += outcomes.filter((o) => o === 'unreclaimable').length;
      result.failed += outcomes.filter((o) => o === 'failed').length;
      result.not_owned += outcomes.filter((o) => o === 'not_owned').length;
      result.skipped += outcomes.filter((o) => o === 'skipped').length;

      const downloadables = tasks.filter((t) => t.status === 'done' && t.download_token && t.order_no);
      if (downloadables.length) {
        const saved = await downloadAndSave(cardByCode, downloadables);
        result.downloaded += saved.downloaded;
        result.accounts_inserted += saved.inserted;
        result.accounts_updated += saved.updated;
        result.download_errors.push(...saved.downloadErrors);
        changedAccountIds.push(...saved.changed);
      }

      updateCardsAfterBatch(cardByCode, codes, tasks, mode, new Date().toISOString());
    }

    // 凭据更新后自动上传 codex2api（默认开启）
    const config = getTeamConfig() || {};
    if (config.auto_upload_after_reclaim !== false && changedAccountIds.length) {
      touch('uploading', `自动上传 ${changedAccountIds.length} 个账号至 codex2api`, null);
      try {
        result.upload = await uploader.uploadTeamAccounts([...new Set(changedAccountIds)]);
      } catch (error) {
        result.upload = { error: String(error.message || error).slice(0, 300) };
      }
    }
    return result;
  }

  // ---- 会话入口 ----

  function startHealthCheck(ids) {
    const cards = loadCards(ids);
    beginSession('health_check');
    void (async () => {
      try {
        const result = await runHealthCheck(cards);
        finishSession(result);
      } catch (error) {
        logger?.error?.({ err: error }, 'team health check session failed');
        failSession(error);
      }
    })();
    return view();
  }

  function startReclaim(ids, mode = '401') {
    if (!['401', 'all'].includes(mode)) throw errors.validation('mode 只支持 401 或 all');
    const cards = loadCards(ids);
    beginSession('reclaim');
    void (async () => {
      try {
        const result = await runReclaim(cards, mode);
        finishSession(result);
      } catch (error) {
        logger?.error?.({ err: error }, 'team reclaim session failed');
        failSession(error);
      }
    })();
    return view();
  }

  return {
    view,
    importCards,
    deleteCards,
    startHealthCheck,
    startReclaim,
    isBusy: () => state.running,
  };
}
