const express = require('express');
const router = express.Router();

// scheduler is optional — only needed at runtime for sweepIdlePrinters on reactivate.
// Tests pass null so there is no live scheduler dependency.
module.exports = (db, scheduler = null) => {
  router.get('/', (req, res) => {
    const projects = db.prepare('SELECT * FROM projects ORDER BY priority ASC, created_at ASC').all();
    res.json(projects);
  });

  router.get('/:id', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

  router.post('/', (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO projects (name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(name, description || null, now, now);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(project);
  });

  // PUT /reorder — set priority for an ordered list of project IDs.
  // Body: { ids: [3, 1, 2] } — index becomes priority (0 = highest).
  // Must be defined before /:id so Express doesn't match 'reorder' as an id.
  router.put('/reorder', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    const update = db.prepare('UPDATE projects SET priority = ?, updated_at = ? WHERE id = ?');
    const now = Date.now();
    db.transaction(() => {
      ids.forEach((id, index) => update.run(index, now, id));
    })();
    res.json({ success: true });
  });

  router.put('/:id', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { name, description, status } = req.body;
    db.prepare(`
      UPDATE projects
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          status = COALESCE(?, status),
          updated_at = ?
      WHERE id = ?
    `).run(name, description, status, Date.now(), req.params.id);
    res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
  });

  router.delete('/:id', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // POST /:id/complete — force-close a project before all parts hit their target qty.
  // Closes all open parts and cancels any queued/uploading jobs for them.
  router.post('/:id/complete', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.status === 'completed') return res.status(400).json({ error: 'Project is already completed' });

    const now = Date.now();
    const openParts = db.prepare("SELECT * FROM parts WHERE project_id = ? AND status = 'open'").all(project.id);

    db.prepare("UPDATE parts SET status = 'closed', updated_at = ? WHERE project_id = ? AND status = 'open'").run(now, project.id);

    let cancelledJobs = 0;
    if (openParts.length > 0) {
      const placeholders = openParts.map(() => '?').join(',');
      const result = db.prepare(
        `UPDATE jobs SET status = 'cancelled' WHERE part_id IN (${placeholders}) AND status IN ('queued', 'uploading')`
      ).run(...openParts.map(p => p.id));
      cancelledJobs = result.changes;
    }

    db.prepare("UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?").run(now, project.id);
    console.log(`[server] Project ${project.id} "${project.name}" force-completed — ${openParts.length} part(s) closed, ${cancelledJobs} job(s) cancelled`);

    res.json({
      project: db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id),
      closed_parts: openParts.length,
      cancelled_jobs: cancelledJobs,
    });
  });

  // POST /:id/reactivate — re-open a completed project.
  // Reopens closed parts that still have remaining qty. Returns nothing_to_reopen: true
  // if all parts are already at or above target so the UI can warn before dispatching nothing.
  router.post('/:id/reactivate', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const now = Date.now();
    const eligible = db.prepare(`
      SELECT * FROM parts
      WHERE project_id = ? AND status = 'closed' AND completed_qty < target_qty
    `).all(project.id);

    if (eligible.length === 0) {
      return res.json({ nothing_to_reopen: true, project });
    }

    const placeholders = eligible.map(() => '?').join(',');
    db.prepare(`UPDATE parts SET status = 'open', updated_at = ? WHERE id IN (${placeholders})`)
      .run(now, ...eligible.map(p => p.id));

    db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);
    console.log(`[server] Project ${project.id} "${project.name}" re-activated — ${eligible.length} part(s) reopened`);

    if (scheduler) scheduler.sweepIdlePrinters();

    res.json({
      project: db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id),
      reopened_parts: eligible.length,
    });
  });

  return router;
};
