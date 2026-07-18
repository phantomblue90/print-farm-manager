#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();

function replaceOnce(relativePath, oldText, newText) {
  const filename = path.join(root, relativePath);
  const text = fs.readFileSync(filename, 'utf8');

  if (text.includes(newText)) {
    console.log(`[skip] ${relativePath}: change already applied`);
    return false;
  }

  const first = text.indexOf(oldText);
  const second = first === -1 ? -1 : text.indexOf(oldText, first + oldText.length);

  if (first === -1 || second !== -1) {
    throw new Error(
      `${relativePath}: expected exactly one matching source block, found ${
        first === -1 ? 0 : 2
      }`
    );
  }

  fs.writeFileSync(
    filename,
    text.slice(0, first) + newText + text.slice(first + oldText.length),
    'utf8'
  );
  console.log(`[patch] ${relativePath}`);
  return true;
}

let changed = false;

// ─────────────────────────────────────────────────────────────────────────────
// Bambu driver: fix HMS 07FF-8012 and support one AMS tray per slicer filament.
// ─────────────────────────────────────────────────────────────────────────────

changed = replaceOnce(
  'server/drivers/bambu.js',
  `// Uploads the G-code file to the printer via FTPS, then triggers printing via MQTT.
// gcodeFullPath must be a resolved absolute path that already exists on disk.
// options.amsSlot: -1 = external spool, 0–N = AMS slot, null = default (external)
async function uploadAndPrint(printer, gcodeFullPath, _filename, options = {}) {
  const { amsSlot = null } = options;
`,
  `// Normalize legacy single-slot values and new per-filament arrays into the
// flat absolute-tray-ID array expected by Bambu's project_file command.
function normalizeAmsMapping(value) {
  let raw = value;

  if (raw == null || raw === '') return [-1];

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [-1];

    try {
      raw = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split(',');
    } catch (_) {
      throw new Error(
        'Invalid Bambu AMS mapping — expected a JSON array or comma-separated slot list'
      );
    }
  }

  if (!Array.isArray(raw)) raw = [raw];
  if (raw.length === 0) return [-1];

  const mapping = raw.map(item => Number(item));
  if (mapping.some(item => !Number.isInteger(item) || item < -1)) {
    throw new Error(
      'Invalid Bambu AMS mapping — slots must be integers greater than or equal to -1'
    );
  }

  return mapping;
}

function externalAmsIdForPrinter(printer) {
  const model = String(printer.model || '').toLowerCase();

  // True dual-nozzle machines use virtual tray 254. Single-nozzle machines,
  // including X1/P1/A1 and H2S, use virtual tray 255.
  return ['h2d', 'h2d-pro', 'h2c', 'x2d'].includes(model) ? 254 : 255;
}

function decodeAmsMappingEntry(trayId, externalAmsId) {
  if (trayId === -1) return { ams_id: externalAmsId, slot_id: 0 };
  if (trayId === 254 || trayId === 255) return { ams_id: trayId, slot_id: 0 };

  // AMS HT and other single-slot units use their AMS id directly.
  if (trayId >= 128) return { ams_id: trayId, slot_id: 0 };

  return {
    ams_id: Math.floor(trayId / 4),
    slot_id: trayId % 4,
  };
}

// Uploads the G-code file to the printer via FTPS, then triggers printing via MQTT.
// gcodeFullPath must be a resolved absolute path that already exists on disk.
// options.amsSlot accepts a legacy single slot, JSON-array string, or array.
// options.amsMapping is the preferred direct per-filament array.
async function uploadAndPrint(printer, gcodeFullPath, _filename, options = {}) {
  const { amsSlot = null, amsMapping = null } = options;
`
) || changed;

changed = replaceOnce(
  'server/drivers/bambu.js',
  `  const onPrinterFilename = path.basename(gcodeFullPath);
  const ext = path.extname(onPrinterFilename).toLowerCase();
`,
  `  const onPrinterFilename = path.basename(gcodeFullPath);
  const ext = path.extname(onPrinterFilename).toLowerCase();
  const normalizedAmsMapping = normalizeAmsMapping(amsMapping ?? amsSlot);
`
) || changed;

changed = replaceOnce(
  'server/drivers/bambu.js',
  `  // ams_mapping format for LAN printing: a flat array where index = filament slot
  // in the .3mf (0-based) and value = physical AMS tray ID (0-15).
  // For single-color prints: [amsSlot] (one element).
  // For external spool or no AMS: [] (empty).
  // Ref: https://github.com/Doridian/OpenBambuAPI (issue #38 + mqtt.md)
  const subtaskName = path.basename(onPrinterFilename, '.3mf');
  const useAms      = amsSlot != null && amsSlot >= 0;
`,
  `  // Send one entry for every slicer filament. Current firmware requires an
  // explicit external-spool table; an empty table raises HMS 07FF-8012.
  const subtaskName   = path.basename(onPrinterFilename, '.3mf');
  const externalAmsId = externalAmsIdForPrinter(printer);
  const useAms        = normalizedAmsMapping.some(slot => slot >= 0 && slot < 254);
  const flatMapping   = normalizedAmsMapping.map(slot =>
    slot === 254 || slot === 255 ? -1 : slot
  );
  const mapping2      = normalizedAmsMapping.map(slot =>
    decodeAmsMappingEntry(slot, externalAmsId)
  );
`
) || changed;

changed = replaceOnce(
  'server/drivers/bambu.js',
  `    param:           'Metadata/plate_1.gcode',
    subtask_name:    subtaskName,
    url:             \`ftp:///\${onPrinterFilename}\`,
`,
  `    param:           'Metadata/plate_1.gcode',
    subtask_name:    subtaskName,
    file:            onPrinterFilename,
    url:             \`ftp:///\${onPrinterFilename}\`,
`
) || changed;

changed = replaceOnce(
  'server/drivers/bambu.js',
  `    use_ams:         useAms,
    ams_mapping:     useAms ? [amsSlot] : [],
`,
  `    use_ams:         useAms,
    ams_mapping:     flatMapping,
    ams_mapping2:    mapping2,
`
) || changed;

// ─────────────────────────────────────────────────────────────────────────────
// Upload API: accept ams_mapping JSON while preserving the existing DB schema.
// SQLite INTEGER affinity still permits TEXT, so multi arrays live in ams_slot.
// ─────────────────────────────────────────────────────────────────────────────

changed = replaceOnce(
  'server/routes/gcodes.js',
  `function normalizeMaterialGrams(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (/^\\d+(\\.\\d+)?$/.test(s)) return parseFloat(s);
  let m = s.match(/^(\\d+(?:\\.\\d+)?)\\s*kg(?:ilograms?)?$/i);
  if (m) return parseFloat(m[1]) * 1000;
  m = s.match(/^(\\d+(?:\\.\\d+)?)\\s*g(?:rams?)?$/i);
  if (m) return parseFloat(m[1]);
  return null;
}
`,
  `function normalizeMaterialGrams(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (/^\\d+(\\.\\d+)?$/.test(s)) return parseFloat(s);
  let m = s.match(/^(\\d+(?:\\.\\d+)?)\\s*kg(?:ilograms?)?$/i);
  if (m) return parseFloat(m[1]) * 1000;
  m = s.match(/^(\\d+(?:\\.\\d+)?)\\s*g(?:rams?)?$/i);
  if (m) return parseFloat(m[1]);
  return null;
}

// Multi-filament mappings are stored as JSON in the existing ams_slot field.
// Single selections remain integers for backward compatibility.
function normalizeAmsSelection(amsMapping, amsSlot) {
  if (amsMapping !== undefined && amsMapping !== '') {
    let parsed;

    try {
      parsed = typeof amsMapping === 'string'
        ? JSON.parse(amsMapping)
        : amsMapping;
    } catch (_) {
      throw new Error('ams_mapping must be a JSON array of AMS slots');
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('ams_mapping must contain at least one AMS slot');
    }

    const mapping = parsed.map(item => Number(item));
    if (mapping.some(item => !Number.isInteger(item) || item < -1)) {
      throw new Error(
        'ams_mapping slots must be integers greater than or equal to -1'
      );
    }

    return mapping.length === 1 ? mapping[0] : JSON.stringify(mapping);
  }

  if (amsSlot === undefined || amsSlot === '') return null;

  const slot = Number(amsSlot);
  if (!Number.isInteger(slot) || slot < -1) {
    throw new Error('ams_slot must be an integer greater than or equal to -1');
  }

  return slot;
}
`
) || changed;

changed = replaceOnce(
  'server/routes/gcodes.js',
  `    const { part_id, parts_per_plate, printer_model, est_print_secs, ams_slot, material_grams,
            allowed_groups, required_material, required_color } = req.body;
`,
  `    const { part_id, parts_per_plate, printer_model, est_print_secs, ams_slot, ams_mapping, material_grams,
            allowed_groups, required_material, required_color } = req.body;
`
) || changed;

changed = replaceOnce(
  'server/routes/gcodes.js',
  `    // ams_slot: -1 = external spool, 0–N = AMS slot, null = not applicable (non-Bambu)
    const parsedAmsSlot = ams_slot !== undefined && ams_slot !== '' ? parseInt(ams_slot, 10) : null;
`,
  `    // ams_slot is the legacy single selection; ams_mapping has one slot per filament.
    let parsedAmsSlot;
    try {
      parsedAmsSlot = normalizeAmsSelection(ams_mapping, ams_slot);
    } catch (err) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: err.message });
    }
`
) || changed;

// ─────────────────────────────────────────────────────────────────────────────
// Project upload UI: add/remove one physical tray selector per slicer filament.
// ─────────────────────────────────────────────────────────────────────────────

changed = replaceOnce(
  'client/src/pages/Projects.jsx',
  `const uploadLabelSx = {
  fontSize: 10.5,
  fontWeight: 600,
  color: '#64748b',
  marginBottom: 3,
};
`,
  `const uploadLabelSx = {
  fontSize: 10.5,
  fontWeight: 600,
  color: '#64748b',
  marginBottom: 3,
};

function formatAmsSlotLabel(slot) {
  if (slot === -1) return 'External Spool';
  if (slot >= 128) return \`AMS HT \${slot - 127}\`;

  const amsUnit = Math.floor(slot / 4);
  const tray = (slot % 4) + 1;
  return \`AMS \${String.fromCharCode(65 + amsUnit)}\${tray}\`;
}
`
) || changed;

changed = replaceOnce(
  'client/src/pages/Projects.jsx',
  `  const [amsSlots, setAmsSlots]     = useState([]);
  const [amsSlot, setAmsSlot]       = useState('');
`,
  `  const [amsSlots, setAmsSlots]     = useState([]);
  const [amsMapping, setAmsMapping] = useState(['']);
`
) || changed;

changed = replaceOnce(
  'client/src/pages/Projects.jsx',
  `  useEffect(() => {
    if (!model) { setAmsSlots([]); setAmsSlot(''); return; }
    fetch(\`/api/printers/ams?model=\${encodeURIComponent(model)}\`)
      .then(r => r.json())
      .then(slots => { setAmsSlots(slots); setAmsSlot(''); })
      .catch(() => { setAmsSlots([]); setAmsSlot(''); });
  }, [model]);
`,
  `  useEffect(() => {
    if (!model) { setAmsSlots([]); setAmsMapping(['']); return; }
    fetch(\`/api/printers/ams?model=\${encodeURIComponent(model)}\`)
      .then(r => r.json())
      .then(slots => { setAmsSlots(slots); setAmsMapping(['']); })
      .catch(() => { setAmsSlots([]); setAmsMapping(['']); });
  }, [model]);
`
) || changed;

changed = replaceOnce(
  'client/src/pages/Projects.jsx',
  `    if (amsSlots.length > 0 && amsSlot === '') {
      setError('Select an AMS slot or External Spool.'); return;
    }
`,
  `    if (amsSlots.length > 0 && amsMapping.some(slot => slot === '')) {
      setError('Select an AMS slot or External Spool for every filament.'); return;
    }
`
) || changed;

changed = replaceOnce(
  'client/src/pages/Projects.jsx',
  `    if (amsSlots.length > 0) fd.append('ams_slot', amsSlot);
`,
  `    if (amsSlots.length > 0) {
      const numericMapping = amsMapping.map(Number);
      if (numericMapping.length === 1) {
        fd.append('ams_slot', String(numericMapping[0]));
      } else {
        fd.append('ams_mapping', JSON.stringify(numericMapping));
      }
    }
`
) || changed;

changed = replaceOnce(
  'client/src/pages/Projects.jsx',
  `        setFile(null); setPPP(''); setModel(''); setAmsSlot(''); setAmsSlots([]);
`,
  `        setFile(null); setPPP(''); setModel(''); setAmsMapping(['']); setAmsSlots([]);
`
) || changed;

changed = replaceOnce(
  'client/src/pages/Projects.jsx',
  `        {amsSlots.length > 0 && (
          <div>
            <div style={uploadLabelSx}>AMS slot *</div>
            <select
              value={amsSlot}
              onChange={(e) => setAmsSlot(e.target.value)}
              style={{ ...inputSx, width: 160 }}
            >
              <option value="">Select…</option>
              {amsSlots.map(s => s.slot === -1
                ? <option key="ext" value="-1">External Spool{s.type ? \` — \${s.type}\` : ''}</option>
                : <option key={s.slot} value={String(s.slot)}>Slot {s.slot} — {s.type || 'unknown'}</option>
              )}
            </select>
          </div>
        )}
`,
  `        {amsSlots.length > 0 && (
          <div style={{ minWidth: 225 }}>
            <div style={uploadLabelSx}>Filament mapping *</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {amsMapping.map((selectedSlot, index) => (
                <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ color: '#64748b', fontSize: 11, width: 20 }}>
                    F{index + 1}
                  </span>
                  <select
                    value={selectedSlot}
                    onChange={(e) => setAmsMapping(current =>
                      current.map((slot, i) => i === index ? e.target.value : slot)
                    )}
                    style={{ ...inputSx, width: 180 }}
                  >
                    <option value="">Select…</option>
                    {amsSlots.map(s => (
                      <option key={s.slot} value={String(s.slot)}>
                        {formatAmsSlotLabel(s.slot)}
                        {s.type ? \` — \${s.type}\` : ''}
                      </option>
                    ))}
                  </select>
                  {amsMapping.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setAmsMapping(current =>
                        current.filter((_, i) => i !== index)
                      )}
                      title={\`Remove filament \${index + 1}\`}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#ef4444',
                        cursor: 'pointer',
                        fontSize: 16,
                        padding: 2,
                      }}
                    >×</button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setAmsMapping(current => [...current, ''])}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#60a5fa',
                  cursor: 'pointer',
                  fontSize: 11,
                  padding: '2px 0',
                  textAlign: 'left',
                }}
              >+ Add filament</button>
            </div>
          </div>
        )}
`
) || changed;

// ─────────────────────────────────────────────────────────────────────────────
// Regression tests.
// ─────────────────────────────────────────────────────────────────────────────

changed = replaceOnce(
  'server/tests/bambu-driver.test.js',
  `  test('AMS slot 0: use_ams true, ams_mapping [0]', async () => {
`,
  `  test('AMS slot 0: sends both mapping formats', async () => {
`
) || changed;

changed = replaceOnce(
  'server/tests/bambu-driver.test.js',
  `    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([0]);
  });

  test('AMS slot 3: ams_mapping is [3]', async () => {
`,
  `    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([0]);
    expect(p.ams_mapping2).toEqual([{ ams_id: 0, slot_id: 0 }]);
  });

  test('AMS slot 3: ams_mapping is [3]', async () => {
`
) || changed;

changed = replaceOnce(
  'server/tests/bambu-driver.test.js',
  `    expect(findPayload('project_file').ams_mapping).toEqual([3]);
  });

  test('external spool (amsSlot: -1): use_ams false, ams_mapping empty array', async () => {
`,
  `    expect(findPayload('project_file').ams_mapping).toEqual([3]);
  });

  test('multi-filament mapping supports multiple AMS units', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(
      printer,
      '/tmp/1234_part.3mf',
      'part.3mf',
      { amsSlot: '[0,3,6]' }
    );

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([0, 3, 6]);
    expect(p.ams_mapping2).toEqual([
      { ams_id: 0, slot_id: 0 },
      { ams_id: 0, slot_id: 3 },
      { ams_id: 1, slot_id: 2 },
    ]);
  });

  test('external spool (amsSlot: -1): sends firmware-compatible mapping', async () => {
`
) || changed;

changed = replaceOnce(
  'server/tests/bambu-driver.test.js',
  `    const p = findPayload('project_file');
    expect(p.use_ams).toBe(false);
    expect(p.ams_mapping).toEqual([]);
  });
`,
  `    const p = findPayload('project_file');
    expect(p.use_ams).toBe(false);
    expect(p.ams_mapping).toEqual([-1]);
    expect(p.ams_mapping2).toEqual([{ ams_id: 255, slot_id: 0 }]);
  });
`
) || changed;

changed = replaceOnce(
  'server/tests/gcodes.test.js',
  `  db.exec(\`INSERT INTO printer_models VALUES ('p1s',  'P1S',        'bambu')\`);
`,
  `  db.exec(\`INSERT INTO printer_models VALUES ('p1s',  'P1S',        'bambu')\`);
  db.exec(\`INSERT INTO printer_models VALUES ('p1p',  'P1P',        'bambu')\`);
`
) || changed;

changed = replaceOnce(
  'server/tests/gcodes.test.js',
  `  test('ams_slot is null when not provided (non-Bambu upload)', async () => {
`,
  `  test('stores a multi-filament AMS mapping as JSON', async () => {
    const tmpFile = makeTempGcode('bambu_multi.3mf');

    const res = await request(app)
      .post('/api/gcodes/upload')
      .attach('file', tmpFile)
      .field('part_id', '1')
      .field('parts_per_plate', '1')
      .field('printer_model', 'p1p')
      .field('ams_mapping', '[0,3,6]');

    fs.unlinkSync(tmpFile);

    expect(res.status).toBe(201);
    expect(res.body.ams_slot).toBe('[0,3,6]');
    uploadedPath = res.body.filepath;
  });

  test('ams_slot is null when not provided (non-Bambu upload)', async () => {
`
) || changed;

console.log(
  changed
    ? '\nBambu AMS fix applied. Run: npm test -- --runInBand && npm run build'
    : '\nBambu AMS fix was already applied.'
);
