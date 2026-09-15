export function createDashboardModule() {
  return async function dashboardModule(app) {
    const db = app.db;

    app.get('/api/v1/dashboard/summary', async () => {
      const pools = {
        reserve: db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE pool='reserve'`).get().n,
        main: db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE pool='main'`).get().n,
        discard: db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE pool='discard'`).get().n,
      };
      const reserveAvailable = db
        .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE pool='reserve' AND banned=0 AND status != 'joining'`)
        .get().n;
      const mainActive = db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE pool='main' AND status='active'`).get().n;
      const mainTotalBalance = db
        .prepare(`SELECT COALESCE(SUM(balance),0) AS total FROM accounts WHERE pool='main'`)
        .get().total;
      const proxyRows = db.prepare(`SELECT status, COUNT(*) AS n FROM proxies GROUP BY status`).all();
      const proxies = { alive: 0, dead: 0, cf_challenge: 0, unknown: 0 };
      for (const row of proxyRows) proxies[row.status] = row.n;
      const jobRows = db
        .prepare(`SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','awaiting_input') GROUP BY status`)
        .all();
      const jobs = { queued: 0, running: 0, awaiting_input: 0 };
      for (const row of jobRows) jobs[row.status] = row.n;

      const recentEvents = db
        .prepare(
          `SELECT e.type, e.detail, e.created_at, a.email
           FROM account_events e JOIN accounts a ON a.id = e.account_id
           ORDER BY e.created_at DESC LIMIT 15`,
        )
        .all();

      const monitor = app.codex2apiMonitor?.view?.() || {};

      return {
        pools,
        reserve_available: reserveAvailable,
        main_active: mainActive,
        main_total_balance: Number(mainTotalBalance || 0),
        proxies,
        jobs,
        monitor: {
          enabled: Boolean(monitor.enabled),
          last_check_at: monitor.last_check_at ?? null,
          last_error: monitor.last_error ?? null,
          last_result: monitor.last_result ?? null,
        },
        recent_events: recentEvents.map((row) => {
          let detail = row.detail;
          try {
            detail = JSON.parse(row.detail);
          } catch {}
          return { email: row.email, type: row.type, detail, created_at: row.created_at };
        }),
      };
    });
  };
}
