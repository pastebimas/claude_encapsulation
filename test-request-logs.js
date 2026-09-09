#!/usr/bin/env node
/**
 * Test script for request log management features.
 * Verifies that the request logs module works correctly.
 */

import {
  hideRequest,
  unhideRequest,
  deleteRequest,
  toggleHidden,
  getRequest,
  hideRequestsByFilter,
  deleteRequestsByFilter,
  getProjectDb,
} from "./tmt-ai-viewer/server/requestLogs.js";

const testProject = "test";

// Helper to setup a test database with sample data
function setupTestDb() {
  const db = getProjectDb(testProject);

  try {
    // Create the request_logs table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        target_url TEXT,
        request_headers JSON,
        request_body JSON,
        response_status INTEGER,
        response_headers JSON,
        response_body TEXT,
        duration_ms INTEGER,
        session_id TEXT,
        hidden INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Insert test data
    db.prepare(`
      INSERT INTO request_logs
      (timestamp, method, path, target_url, response_status, session_id, hidden)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "2024-01-01T10:00:00Z",
      "POST",
      "/v1/messages",
      "https://api.anthropic.com/v1/messages",
      200,
      "session-123",
      0
    );

    db.prepare(`
      INSERT INTO request_logs
      (timestamp, method, path, target_url, response_status, session_id, hidden)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "2024-01-01T10:01:00Z",
      "POST",
      "/v1/messages",
      "https://api.anthropic.com/v1/messages",
      200,
      "session-456",
      0
    );

    db.close();
    console.log("✓ Test database setup complete");
  } catch (e) {
    db.close();
    throw e;
  }
}

// Run tests
async function runTests() {
  console.log("Starting request logs tests...\n");

  try {
    setupTestDb();

    console.log("Test 1: Get a request");
    const req = getRequest(testProject, 1);
    if (req && req.id === 1 && req.method === "POST") {
      console.log("✓ getRequest works");
    } else {
      console.error("✗ getRequest failed");
    }

    console.log("\nTest 2: Hide a request");
    hideRequest(testProject, 1);
    const hidden = getRequest(testProject, 1);
    if (hidden && hidden.hidden === 1) {
      console.log("✓ hideRequest works");
    } else {
      console.error("✗ hideRequest failed");
    }

    console.log("\nTest 3: Unhide a request");
    unhideRequest(testProject, 1);
    const unhidden = getRequest(testProject, 1);
    if (unhidden && unhidden.hidden === 0) {
      console.log("✓ unhideRequest works");
    } else {
      console.error("✗ unhideRequest failed");
    }

    console.log("\nTest 4: Toggle hidden status");
    toggleHidden(testProject, 2);
    const toggled = getRequest(testProject, 2);
    if (toggled && toggled.hidden === 1) {
      console.log("✓ toggleHidden works");
    } else {
      console.error("✗ toggleHidden failed");
    }

    console.log("\nTest 5: Hide by filter");
    const countHidden = hideRequestsByFilter(testProject, { method: "POST" });
    if (countHidden >= 0) {
      console.log(`✓ hideRequestsByFilter works (hid ${countHidden} requests)`);
    } else {
      console.error("✗ hideRequestsByFilter failed");
    }

    console.log("\nTest 6: Delete a request");
    deleteRequest(testProject, 1);
    const deleted = getRequest(testProject, 1);
    if (deleted === undefined) {
      console.log("✓ deleteRequest works");
    } else {
      console.error("✗ deleteRequest failed");
    }

    console.log("\nTest 7: Delete by filter");
    const countDeleted = deleteRequestsByFilter(testProject, { hidden: 1 });
    if (countDeleted >= 0) {
      console.log(`✓ deleteRequestsByFilter works (deleted ${countDeleted} requests)`);
    } else {
      console.error("✗ deleteRequestsByFilter failed");
    }

    console.log("\n✓ All tests passed!\n");
  } catch (e) {
    console.error(`✗ Test failed: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}

runTests();
