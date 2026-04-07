const express = require('express');
const path    = require('path');

const db             = require('./db');
const PrinterPoller  = require('./poller');
const JobScheduler   = require('./scheduler');
const notifications  = require('./notifications');

const printersRouter  = require('./routes/printers')(db);
const partsRouter     = require('./routes/parts')(db);
const gcodesRouter    = require('./routes/gcodes')(db);
const jobsRouter      = require('./routes/jobs')(db);
const backupRouter    = require('./routes/backup')(db);
const dashboardRouter = require('./routes/dashboard')(db);
const settingsRouter  = require('./routes/settings')(db);

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// API routes
app.use('/api/printers',  printersRouter);
app.use('/api/parts',     partsRouter);
app.use('/api/gcodes',    gcodesRouter);
app.use('/api/jobs',      jobsRouter);
app.use('/api/backup',    backupRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/settings',  settingsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Server notifications — surfaced in the Settings UI
app.get('/api/notifications', (_req, res) => res.json(notifications.list()));
app.delete('/api/notifications/:id', (req, res) => {
  const ok = notifications.dismiss(parseInt(req.params.id, 10));
  if (!ok) return res.status(404).json({ error: 'Notification not found' });
  res.json({ ok: true });
});

// Serve built React client (production mode)
const clientDist = path.join(__dirname, '../client/dist');
app.use(express.static(clientDist));
// SPA catch-all — non-API routes serve index.html
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`[server] Express running on http://localhost:${PORT}`);

  const poller    = new PrinterPoller(db);
  const scheduler = new JobScheduler(db, poller);

  // Mount projects router here so it has access to the scheduler for complete/reactivate
  app.use('/api/projects', require('./routes/projects')(db, scheduler));

  scheduler.start();
  poller.start();

  // Wait for the first poll to complete before sweeping — ensures DB status reflects
  // live printer state rather than whatever was last persisted before shutdown.
  // This prevents dispatching to a printer that started printing while the server was down.
  poller.once('pollComplete', () => {
    console.log('[server] Initial poll complete — sweeping for idle printers');
    scheduler.sweepIdlePrinters();
  });

  // Dispatch trigger — called by the UI when a project is activated
  app.post('/api/scheduler/dispatch', (req, res) => {
    scheduler.sweepIdlePrinters();
    res.json({ ok: true });
  });

  // Bulk set-ready — releases hold for multiple printers and dispatches through the
  // batched sweep (10 at a time, waits for each batch to reach printing before the next).
  // Used by the "Set Ready (N)" action in the Fleet UI.
  app.post('/api/printers/set-ready-batch', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE printers SET is_held = 0 WHERE id IN (${placeholders})`).run(...ids);
    const printers = db.prepare(`SELECT * FROM printers WHERE id IN (${placeholders}) AND is_active = 1`).all(...ids);
    console.log(`[server] Batch set-ready: ${printers.length} printer(s) — dispatching in batches of 10`);
    scheduler._sweepInBatches(printers).catch(err =>
      console.error('[scheduler] Batch set-ready sweep error:', err)
    );
    res.json({ ok: true, count: printers.length });
  });

  // Recommission a printer — returns it to the active fleet and immediately dispatches
  // a job if one is available. Operator has completed investigation; no hold needed.
  app.post('/api/printers/:id/recommission', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    db.prepare(`
      UPDATE printers
      SET is_active = 1, is_held = 0, decommissioned_at = NULL, decommission_note = NULL
      WHERE id = ?
    `).run(printer.id);
    const updated = db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id);
    console.log(`[server] ${printer.name} recommissioned — dispatching...`);
    scheduler._dispatchToPrinter(updated).then(jobId => {
      if (jobId) console.log(`[server] ${printer.name} recommissioned and dispatched — job ${jobId}`);
      else console.log(`[server] ${printer.name} recommissioned — nothing to dispatch right now`);
    }).catch(err => console.error(`[scheduler] recommission dispatch error for ${printer.name}:`, err));
    res.json(updated);
  });

  // Set a held printer ready — releases hold and dispatches next job to it.
  // Accepts optional confirmed_qty in the body. If provided and different from the
  // parts_per_plate that was already credited when the job finished, the delta is
  // applied to completed_qty (e.g. operator confirms 24 good out of 25 → subtract 1).
  app.post('/api/printers/:id/set-ready', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const { confirmed_qty } = req.body || {};
    if (confirmed_qty != null) {
      const confirmedQty = parseInt(confirmed_qty, 10);
      if (!isNaN(confirmedQty)) {
        const job = db.prepare(`
          SELECT * FROM jobs WHERE printer_id = ? AND status = 'finished'
          ORDER BY finished_at DESC LIMIT 1
        `).get(printer.id);

        if (job && confirmedQty !== job.parts_per_plate) {
          const delta = confirmedQty - job.parts_per_plate; // negative = fewer good parts
          const now = Date.now();
          db.prepare(`
            UPDATE parts SET completed_qty = MAX(0, completed_qty + ?), updated_at = ? WHERE id = ?
          `).run(delta, now, job.part_id);

          // Sync part open/closed status with the adjusted qty
          const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(job.part_id);
          if (part.completed_qty < part.target_qty && part.status === 'closed') {
            db.prepare(`UPDATE parts SET status = 'open', updated_at = ? WHERE id = ?`).run(now, part.id);
            console.log(`[server] Part "${part.name}" reopened — confirmed qty reduced`);
          } else if (part.completed_qty >= part.target_qty && part.status === 'open') {
            db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, part.id);
          }
          console.log(`[server] ${printer.name} confirmed ${confirmedQty}/${job.parts_per_plate} good (delta ${delta > 0 ? '+' : ''}${delta})`);
        }
      }
    }

    db.prepare('UPDATE printers SET is_held = 0 WHERE id = ?').run(printer.id);
    const updated = db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id);
    console.log(`[server] ${printer.name} set ready by operator — dispatching...`);
    scheduler._dispatchToPrinter(updated).then((jobId) => {
      if (jobId) console.log(`[server] ${printer.name} dispatched — job ${jobId}`);
      else console.log(`[server] ${printer.name} set ready but nothing to dispatch`);
    }).catch((err) =>
      console.error(`[scheduler] set-ready dispatch error for ${printer.name}:`, err)
    );
    res.json(updated);
  });
});

module.exports = { app, server };
