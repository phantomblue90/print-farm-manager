const express = require('express');

module.exports = (db) => {
  const router = express.Router();

  // ── Filament Types ────────────────────────────────────────────────────────

  router.get('/types', (_req, res) => {
    res.json(db.prepare('SELECT * FROM filament_types ORDER BY name').all());
  });

  router.post('/types', (req, res) => {
    const name = req.body?.name?.trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
      const result = db.prepare('INSERT INTO filament_types (name) VALUES (?)').run(name);
      res.status(201).json(db.prepare('SELECT * FROM filament_types WHERE id = ?').get(result.lastInsertRowid));
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: `"${name}" already exists` });
      throw err;
    }
  });

  router.delete('/types/:id', (req, res) => {
    const result = db.prepare('DELETE FROM filament_types WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ── Filament Colors ───────────────────────────────────────────────────────

  router.get('/colors', (_req, res) => {
    res.json(db.prepare('SELECT * FROM filament_colors ORDER BY name').all());
  });

  router.post('/colors', (req, res) => {
    const name = req.body?.name?.trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const hex = req.body?.hex_color?.trim() || null;
    try {
      const result = db.prepare('INSERT INTO filament_colors (name, hex_color) VALUES (?, ?)').run(name, hex);
      res.status(201).json(db.prepare('SELECT * FROM filament_colors WHERE id = ?').get(result.lastInsertRowid));
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: `"${name}" already exists` });
      throw err;
    }
  });

  router.delete('/colors/:id', (req, res) => {
    const result = db.prepare('DELETE FROM filament_colors WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  return router;
};
