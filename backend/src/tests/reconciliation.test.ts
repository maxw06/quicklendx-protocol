import Database from "better-sqlite3";
import express from "express";
import supertest from "supertest";
import {
  classifyReconciliationDriftSeverity,
  ReconciliationWorker,
} from "../services/reconciliationWorker";
import { MockDataProviders } from "../services/mockDataProviders";
import { rpcClient } from "../services/rpcClient";
import { derivedTableStore } from "../services/replayService";
import { Severity } from "../types/reconciliation";
import monitoringRoutes from "../routes/v1/monitoring";

let mockDb: any;

const statementCache = new Map<string, any>();

jest.mock("../lib/database", () => ({
  getDatabase: () => mockDb,
  closeDatabase: jest.fn(),
  getPreparedStatement: (sql: string) => {
    if (!statementCache.has(sql)) {
      const stmt = mockDb.prepare(sql);
      statementCache.set(sql, stmt);
    }
    return statementCache.get(sql);
  },
}));

jest.mock("../services/rpcClient", () => ({
  rpcClient: { call: jest.fn() },
}));

jest.mock("../services/replayService", () => ({
  derivedTableStore: { listInvoices: jest.fn() },
}));

describe("ReconciliationWorker", () => {
  beforeEach(() => {
    // Create a fresh in-memory database with required tables
    mockDb = new (Database as any)(":memory:");
    mockDb.exec(`
      CREATE TABLE IF NOT EXISTS backfill_progress (
        id TEXT PRIMARY KEY,
        audit_id INTEGER,
        run_id TEXT NOT NULL,
        last_processed_id TEXT,
        remaining_count INTEGER NOT NULL,
        total_count INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backfill_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        invoice_id TEXT
      );
      CREATE TABLE IF NOT EXISTS reconciliation_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at TEXT NOT NULL,
        checked_count INTEGER NOT NULL CHECK(checked_count >= 0),
        drift_count INTEGER NOT NULL CHECK(drift_count >= 0),
        severity TEXT NOT NULL CHECK(severity IN ('LOW', 'MEDIUM', 'HIGH'))
      );
      CREATE INDEX IF NOT EXISTS idx_reconciliation_snapshots_run_at
        ON reconciliation_snapshots(run_at DESC);
    `);
    // Reset internal state if needed (static members are shared)
    (ReconciliationWorker as any).reports = [];
    (ReconciliationWorker as any).isRunning = false;

    // Wire mock data sources
    (rpcClient.call as jest.Mock).mockResolvedValue(MockDataProviders.getOnChainInvoices());
    (derivedTableStore.listInvoices as jest.Mock).mockResolvedValue(MockDataProviders.getIndexedInvoices());
  });

  afterEach(() => {
    if (mockDb) {
      mockDb.close();
      mockDb = null;
    }
    statementCache.clear();
  });

  test("should detect drift accurately", async () => {
    const report = await ReconciliationWorker.runReconciliation();

    expect(report.totalRecordsChecked).toBe(3);
    expect(report.driftCount).toBe(2);
    
    const missing = report.drifts.find(d => d.driftType === "MISSING");
    const mismatch = report.drifts.find(d => d.driftType === "STATUS_MISMATCH");

    expect(missing).toBeDefined();
    expect(missing?.id).toBe("invoice_2");
    
    expect(mismatch).toBeDefined();
    expect(mismatch?.id).toBe("invoice_1");
  });

  test("persists a reconciliation drift snapshot for each run", async () => {
    const report = await ReconciliationWorker.runReconciliation();

    const row = mockDb
      .prepare("SELECT run_at, checked_count, drift_count, severity FROM reconciliation_snapshots")
      .get();

    expect(row).toEqual({
      run_at: new Date(report.timestamp * 1000).toISOString(),
      checked_count: 3,
      drift_count: 2,
      severity: Severity.MEDIUM,
    });
  });

  test("returns an empty drift trend when no snapshots exist", () => {
    expect(ReconciliationWorker.getDriftTrend()).toEqual([]);
  });

  test("returns recent drift snapshots ordered by run_at and clamps limit", () => {
    const insert = mockDb.prepare(`
      INSERT INTO reconciliation_snapshots (run_at, checked_count, drift_count, severity)
      VALUES (?, ?, ?, ?)
    `);

    for (let i = 0; i < 105; i += 1) {
      insert.run(
        new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        i,
        i % 3,
        classifyReconciliationDriftSeverity(i % 3),
      );
    }

    expect(ReconciliationWorker.getDriftTrend(2)).toEqual([
      {
        runAt: "2026-01-01T00:01:44.000Z",
        checkedCount: 104,
        driftCount: 2,
        severity: Severity.MEDIUM,
      },
      {
        runAt: "2026-01-01T00:01:43.000Z",
        checkedCount: 103,
        driftCount: 1,
        severity: Severity.LOW,
      },
    ]);

    expect(ReconciliationWorker.getDriftTrend(999)).toHaveLength(100);
    expect(ReconciliationWorker.getDriftTrend(0)).toHaveLength(1);
  });

  test("exposes the drift trend through the monitoring route", async () => {
    mockDb.prepare(`
      INSERT INTO reconciliation_snapshots (run_at, checked_count, drift_count, severity)
      VALUES (?, ?, ?, ?)
    `).run("2026-01-01T00:00:00.000Z", 12, 1, Severity.LOW);

    const previousSkipAuth = process.env.SKIP_API_KEY_AUTH;
    process.env.SKIP_API_KEY_AUTH = "true";

    try {
      const app = express();
      app.use("/api/v1/admin/monitoring", monitoringRoutes);

      const res = await supertest(app).get(
        "/api/v1/admin/monitoring/reconciliation/trend?limit=1",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        trend: [
          {
            runAt: "2026-01-01T00:00:00.000Z",
            checkedCount: 12,
            driftCount: 1,
            severity: Severity.LOW,
          },
        ],
      });
    } finally {
      if (previousSkipAuth === undefined) {
        delete process.env.SKIP_API_KEY_AUTH;
      } else {
        process.env.SKIP_API_KEY_AUTH = previousSkipAuth;
      }
    }
  });

  test("classifies drift snapshot severity at documented boundaries", () => {
    expect(classifyReconciliationDriftSeverity(0)).toBe(Severity.LOW);
    expect(classifyReconciliationDriftSeverity(1)).toBe(Severity.LOW);
    expect(classifyReconciliationDriftSeverity(2)).toBe(Severity.MEDIUM);
    expect(classifyReconciliationDriftSeverity(100)).toBe(Severity.MEDIUM);
    expect(classifyReconciliationDriftSeverity(101)).toBe(Severity.HIGH);
  });

  test("should handle missing reports during backfill", async () => {
    const result = await ReconciliationWorker.triggerBoundedBackfill({
      timestamp: 0,
      totalRecordsChecked: 0,
      driftCount: 0,
      drifts: []
    });

    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(0);
  });

  test("should trigger bounded backfill", async () => {
    const report = await ReconciliationWorker.runReconciliation();
    const result = await ReconciliationWorker.triggerBoundedBackfill(report);

    expect(result.successCount).toBe(2);
    expect(result.failCount).toBe(0);
  });

  test("should handle backfill failures", async () => {
    const report = await ReconciliationWorker.runReconciliation();
    ReconciliationWorker.failBackfill = true;
    
    try {
      const result = await ReconciliationWorker.triggerBoundedBackfill(report);
      expect(result.failCount).toBe(2);
      expect(result.errors[0]).toContain("Simulated failure");
    } finally {
      ReconciliationWorker.failBackfill = false;
    }
  });

  test("should prevent concurrent runs", async () => {
    const p1 = ReconciliationWorker.runReconciliation();
    
    await expect(ReconciliationWorker.runReconciliation()).rejects.toThrow("Reconciliation already in progress");
    
    await p1;
  });

  test("should retrieve latest report", async () => {
    expect(ReconciliationWorker.getLatestReport()).toBeNull();
    
    await ReconciliationWorker.runReconciliation();
    const report = ReconciliationWorker.getLatestReport();
    
    expect(report).not.toBeNull();
    expect(report?.driftCount).toBe(2);
  });

  test("should retrieve all reports", async () => {
    await ReconciliationWorker.runReconciliation();
    await ReconciliationWorker.runReconciliation().catch(() => {}); // ignore concurrent error
    
    const reports = ReconciliationWorker.getAllReports();
    expect(reports.length).toBeGreaterThan(0);
  });
});
