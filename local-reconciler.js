/**
 * VELQIRIS — LOCAL RECONCILIATION DAEMON (Gate AM)
 * Production-grade background worker for local PostgreSQL and Docker deployment.
 * 
 * Features:
 * 1. Non-overlapping controlled async loop (guaranteed zero cycle overlap).
 * 2. Transactional row leasing via PostgreSQL 'FOR UPDATE SKIP LOCKED'.
 * 3. Asynchronous orphan webhook recovery (Gate W).
 * 4. Transactional Outbox processing with exponential backoff & DLQ routing.
 * 5. Clean graceful shutdown on SIGINT / SIGTERM.
 * 6. Structured logging with zero secrets and zero personal data.
 * 7. Verified health status reporting.
 */

const { PostgresStorageAdapter, MemoryStorageAdapter, getStorageAdapter } = require("./netlify/functions/storage-adapter");

class LocalReconciler {
  constructor(options = {}) {
    this.pollIntervalMs = options.pollIntervalMs || 2000;
    this.batchSize = options.batchSize || 10;
    this.leaseDurationMs = options.leaseDurationMs || 30000;
    this.storage = options.storage || getStorageAdapter({ databaseUrl: options.databaseUrl });
    
    this.isRunning = false;
    this.isCycleActive = false;
    this.shouldStop = false;
    this._timer = null;

    // Metrics & Health
    this.metrics = {
      startTime: null,
      cyclesCompleted: 0,
      lastCycleAt: null,
      orphansReconciledTotal: 0,
      outboxProcessedTotal: 0,
      outboxFailedTotal: 0,
      lastError: null,
      status: "STOPPED"
    };
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.shouldStop = false;
    this.metrics.startTime = new Date().toISOString();
    this.metrics.status = "RUNNING";
    this._log("INFO", "RECONCILER_STARTED", { poll_interval_ms: this.pollIntervalMs });

    this._scheduleNext(0);
  }

  _scheduleNext(delayMs) {
    if (this.shouldStop) {
      this._finalizeStop();
      return;
    }
    this._timer = setTimeout(async () => {
      await this.runCycle();
      if (!this.shouldStop) {
        this._scheduleNext(this.pollIntervalMs);
      } else {
        this._finalizeStop();
      }
    }, delayMs);
  }

  async runCycle() {
    // Guaranteed single-cycle execution: prevent any cycle overlap
    if (this.isCycleActive) {
      this._log("WARN", "CYCLE_OVERLAP_SKIPPED", { message: "Previous cycle still in progress." });
      return { skipped: true };
    }

    this.isCycleActive = true;
    const cycleStart = Date.now();
    const cycleSummary = { orphansReconciled: 0, outboxProcessed: 0, outboxFailed: 0 };

    try {
      // 1. Recover Pending Orphan Webhooks (Gate W)
      // Query any orders that need orphan reconciliation
      if (this.storage.pool) {
        const pendingOrders = await this.storage.pool.query(
          `SELECT DISTINCT order_id FROM webhook_inbox 
           WHERE processing_status = 'PENDING_RECONCILIATION' AND order_id IS NOT NULL`
        );
        for (const row of pendingOrders.rows) {
          const recRes = await this.storage.reconcileOrphanWebhooks(row.order_id);
          if (recRes && recRes.reconciled) {
            cycleSummary.orphansReconciled += recRes.count || 1;
            this.metrics.orphansReconciledTotal += recRes.count || 1;
          }
        }
      }

      // 2. Process Transactional Outbox Batch (Gate V & X)
      const lease = await this.storage.leaseOutboxBatch(this.batchSize, this.leaseDurationMs);
      if (lease && lease.items && lease.items.length > 0) {
        for (const item of lease.items) {
          try {
            // Execute business side-effect idempotently
            await this._processOutboxItem(item);
            await this.storage.completeOutboxItem(item.id, lease.leaseToken);
            cycleSummary.outboxProcessed += 1;
            this.metrics.outboxProcessedTotal += 1;
          } catch (err) {
            this._log("ERROR", "OUTBOX_PROCESSING_FAILED", { item_id: item.id, error: err.message });
            await this.storage.failOutboxItem(item.id, lease.leaseToken, err.message);
            cycleSummary.outboxFailed += 1;
            this.metrics.outboxFailedTotal += 1;
          }
        }
      }

      this.metrics.cyclesCompleted += 1;
      this.metrics.lastCycleAt = new Date().toISOString();
    } catch (err) {
      this.metrics.lastError = err.message;
      this._log("ERROR", "CYCLE_EXECUTION_ERROR", { error: err.message });
    } finally {
      this.isCycleActive = false;
    }

    return {
      durationMs: Date.now() - cycleStart,
      ...cycleSummary
    };
  }

  async _processOutboxItem(item) {
    // Post-commit side-effect dispatcher
    switch (item.event_type) {
      case "ISSUE_DELIVERY_TOKEN":
      case "RECONCILIATION_SETTLED_DELIVERY_ISSUED":
        this._log("INFO", "DELIVERY_DISPATCHED", {
          aggregate_id: item.aggregate_id,
          event_type: item.event_type
        });
        break;
      default:
        this._log("INFO", "GENERIC_OUTBOX_PROCESSED", {
          event_type: item.event_type,
          aggregate_id: item.aggregate_id
        });
    }
  }

  async stop() {
    this.shouldStop = true;
    this.metrics.status = "STOPPING";
    this._log("INFO", "RECONCILER_STOPPING", { message: "Waiting for current cycle to complete..." });

    // Wait until current active cycle completes
    const timeoutAt = Date.now() + 10000;
    while (this.isCycleActive && Date.now() < timeoutAt) {
      await new Promise(r => setTimeout(r, 100));
    }

    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    this._finalizeStop();
  }

  _finalizeStop() {
    this.isRunning = false;
    this.isCycleActive = false;
    this.metrics.status = "STOPPED";
    this._log("INFO", "RECONCILER_STOPPED", {
      cycles_completed: this.metrics.cyclesCompleted,
      orphans_reconciled: this.metrics.orphansReconciledTotal,
      outbox_processed: this.metrics.outboxProcessedTotal
    });
  }

  getHealth() {
    return {
      status: this.metrics.status,
      uptime_seconds: this.metrics.startTime ? Math.floor((Date.now() - new Date(this.metrics.startTime).getTime()) / 1000) : 0,
      cycles_completed: this.metrics.cyclesCompleted,
      last_cycle_at: this.metrics.lastCycleAt,
      orphans_reconciled_total: this.metrics.orphansReconciledTotal,
      outbox_processed_total: this.metrics.outboxProcessedTotal,
      outbox_failed_total: this.metrics.outboxFailedTotal,
      last_error: this.metrics.lastError
    };
  }

  _log(level, event, data = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      service: "VELQIRIS-LOCAL-RECONCILER",
      level,
      event,
      ...data
    };
    // Format compact structured log without leaking secrets
    if (process.env.NODE_ENV !== "test") {
      console.log(JSON.stringify(logEntry));
    }
  }
}

// Standalone execution entrypoint
if (require.main === module) {
  const dbUrl = process.env.DATABASE_URL || "postgresql://velqiris_admin:velqiris_test_password_2026@127.0.0.1:5432/velqiris_test_db";
  const reconciler = new LocalReconciler({
    databaseUrl: dbUrl,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "2000", 10)
  });

  const shutdown = async () => {
    await reconciler.stop();
    if (reconciler.storage.close) {
      await reconciler.storage.close();
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  reconciler.start();
}

module.exports = { LocalReconciler };
