// Regression test for the backup export/restore round-trip.
//
// Reported (PR review): the restore side used a hand-maintained column list per table,
// which had drifted out of sync with migrations added to server/db.js over time. A backup
// containing printers.serial_number/loaded_material/loaded_color, projects.required_material/
// required_color, parts.print_time_seconds/material_grams, and gcodes.ams_slot/material_grams/
// allowed_groups/required_material/required_color restored successfully but silently dropped
// all of those fields back to null/default.
//
// Fixed by deriving each restore INSERT's column list from PRAGMA table_info(table) instead
// of a hardcoded list (see makeInserter() in server/routes/backup.js) — this test seeds every
// one of those previously-dropped columns with a distinctive value and asserts they all
// survive a real export → restore round trip through the actual HTTP endpoints. If a future
// migration adds a new column that the restore logic somehow stops picking up, this is the
// test that should catch it.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Full current schema (base CREATE TABLE + every migration in server/db.js), so
  // PRAGMA table_info in makeInserter() sees exactly what a real installation would.
  db.exec(`
    CREATE TABLE printers (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT NOT NULL UNIQUE,
      ip                  TEXT NOT NULL,
      api_key             TEXT NOT NULL,
      group_name          TEXT,
      type                TEXT DEFAULT 'prusa',
      model               TEXT NOT NULL,
      status              TEXT DEFAULT 'UNKNOWN',
      is_held             INTEGER DEFAULT 1,
      is_active           INTEGER DEFAULT 1,
      created_at          INTEGER NOT NULL,
      decommissioned_at   INTEGER,
      decommission_note   TEXT,
      job_name            TEXT,
      job_progress        REAL,
      job_time_remaining  INTEGER,
      serial_number       TEXT DEFAULT '',
      loaded_material     TEXT,
      loaded_color        TEXT
    );
    CREATE TABLE projects (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      description       TEXT,
      status            TEXT DEFAULT 'draft',
      priority          INTEGER DEFAULT 0,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      required_material TEXT,
      required_color    TEXT
    );
    CREATE TABLE parts (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id          INTEGER NOT NULL REFERENCES projects(id),
      name                TEXT NOT NULL,
      target_qty          INTEGER NOT NULL,
      completed_qty       INTEGER DEFAULT 0,
      status              TEXT DEFAULT 'open',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      print_time_seconds  INTEGER,
      material_grams      REAL
    );
    CREATE TABLE gcodes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id           INTEGER NOT NULL REFERENCES parts(id),
      printer_model     TEXT NOT NULL,
      filename          TEXT NOT NULL,
      filepath          TEXT NOT NULL,
      parts_per_plate   INTEGER NOT NULL,
      est_print_secs    INTEGER,
      created_at        INTEGER NOT NULL,
      ams_slot          INTEGER,
      material_grams    REAL,
      allowed_groups    TEXT,
      required_material TEXT,
      required_color    TEXT
    );
    CREATE TABLE jobs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id          INTEGER NOT NULL REFERENCES parts(id),
      printer_id       INTEGER NOT NULL REFERENCES printers(id),
      gcode_id         INTEGER REFERENCES gcodes(id),
      parts_per_plate  INTEGER NOT NULL,
      status           TEXT DEFAULT 'queued',
      started_at       INTEGER,
      finished_at      INTEGER,
      created_at       INTEGER NOT NULL
    );
    CREATE TABLE printer_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id  INTEGER NOT NULL,
      event_type  TEXT NOT NULL,
      note        TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE printer_models (
      model_id   TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      connector  TEXT NOT NULL
    );
    CREATE TABLE filament_types (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL UNIQUE
    );
    CREATE TABLE filament_colors (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id   INTEGER NOT NULL REFERENCES filament_types(id),
      name      TEXT NOT NULL,
      hex_color TEXT,
      UNIQUE(type_id, name)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const now = Date.now();

  db.prepare(`
    INSERT INTO printers
      (name, ip, api_key, group_name, type, model, status, is_held, is_active, created_at,
       serial_number, loaded_material, loaded_color)
    VALUES
      ('Bambu_01', '192.168.1.50', 'ac1B2c', 'Bambu Farm', 'bambu', 'x1c', 'IDLE', 0, 1, ?,
       '01S00A123456789', 'PLA', 'Galaxy Black')
  `).run(now);

  db.prepare(`
    INSERT INTO projects (name, description, status, priority, created_at, updated_at, required_material, required_color)
    VALUES ('Targeted Project', 'test', 'active', 0, ?, ?, 'PETG', 'Red')
  `).run(now, now);

  db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at, sort_order, print_time_seconds, material_grams)
    VALUES (1, 'Estimated Part', 10, 0, 'open', ?, ?, 0, 7350, 42.5)
  `).run(now, now);

  db.prepare(`
    INSERT INTO gcodes
      (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, created_at,
       ams_slot, material_grams, allowed_groups, required_material, required_color)
    VALUES
      (1, 'x1c', 'part.gcode', 'part_stub.gcode', 4, 3600, ?,
       2, 45.5, '["Bambu Farm"]', 'PETG', 'Red')
  `).run(now);

  // server/routes/backup.js declares its Express router at module scope, like every
  // route file in this codebase. Node's require() cache means a second require() in the
  // same process would reuse that router with a stale db closure from a previous test's
  // beforeEach — jest.resetModules() forces a fresh module (and router) each time.
  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/backup', require('../routes/backup')(db));
});

function writeTempBackupFile(backup) {
  const p = path.join(os.tmpdir(), `backup-restore-test-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify(backup));
  return p;
}

describe('Backup export/restore — column round-trip regression', () => {
  test('export includes the migrated columns', async () => {
    const res = await request(app).get('/api/backup');
    expect(res.status).toBe(200);

    expect(res.body.printers[0]).toMatchObject({
      serial_number: '01S00A123456789',
      loaded_material: 'PLA',
      loaded_color: 'Galaxy Black',
    });
    expect(res.body.projects[0]).toMatchObject({
      required_material: 'PETG',
      required_color: 'Red',
    });
    expect(res.body.parts[0]).toMatchObject({
      print_time_seconds: 7350,
      material_grams: 42.5,
    });
    expect(res.body.gcodes[0]).toMatchObject({
      ams_slot: 2,
      material_grams: 45.5,
      allowed_groups: '["Bambu Farm"]',
      required_material: 'PETG',
      required_color: 'Red',
    });
  });

  test('restore preserves every migrated column, not just the base schema', async () => {
    const exportRes = await request(app).get('/api/backup');
    expect(exportRes.status).toBe(200);
    const backupFile = writeTempBackupFile(exportRes.body);

    try {
      // Wipe the columns under test so a false-positive (restore is a no-op / DB untouched)
      // can't slip through — restore must be what puts these values back.
      db.prepare("UPDATE printers SET serial_number = '', loaded_material = NULL, loaded_color = NULL").run();
      db.prepare("UPDATE projects SET required_material = NULL, required_color = NULL").run();
      db.prepare("UPDATE parts SET print_time_seconds = NULL, material_grams = NULL").run();
      db.prepare("UPDATE gcodes SET ams_slot = NULL, material_grams = NULL, allowed_groups = NULL, required_material = NULL, required_color = NULL").run();

      const restoreRes = await request(app)
        .post('/api/backup/restore')
        .attach('file', backupFile);

      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.ok).toBe(true);

      const printer = db.prepare('SELECT * FROM printers WHERE id = 1').get();
      expect(printer.serial_number).toBe('01S00A123456789');
      expect(printer.loaded_material).toBe('PLA');
      expect(printer.loaded_color).toBe('Galaxy Black');

      const project = db.prepare('SELECT * FROM projects WHERE id = 1').get();
      expect(project.required_material).toBe('PETG');
      expect(project.required_color).toBe('Red');

      const part = db.prepare('SELECT * FROM parts WHERE id = 1').get();
      expect(part.print_time_seconds).toBe(7350);
      expect(part.material_grams).toBe(42.5);

      const gcode = db.prepare('SELECT * FROM gcodes WHERE id = 1').get();
      expect(gcode.ams_slot).toBe(2);
      expect(gcode.material_grams).toBe(45.5);
      expect(gcode.allowed_groups).toBe('["Bambu Farm"]');
      expect(gcode.required_material).toBe('PETG');
      expect(gcode.required_color).toBe('Red');
    } finally {
      fs.unlinkSync(backupFile);
    }
  });

  test('restore tolerates an older backup missing a since-added column (defaults to null, does not throw)', async () => {
    const exportRes = await request(app).get('/api/backup');
    const backup = exportRes.body;
    // Simulate a pre-migration backup: strip a column that was added later.
    delete backup.printers[0].loaded_color;
    delete backup.gcodes[0].required_color;
    const backupFile = writeTempBackupFile(backup);

    try {
      const restoreRes = await request(app).post('/api/backup/restore').attach('file', backupFile);
      expect(restoreRes.status).toBe(200);

      const printer = db.prepare('SELECT * FROM printers WHERE id = 1').get();
      expect(printer.loaded_color).toBeNull();
      const gcode = db.prepare('SELECT * FROM gcodes WHERE id = 1').get();
      expect(gcode.required_color).toBeNull();
    } finally {
      fs.unlinkSync(backupFile);
    }
  });
});
