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
    throw new Error(`${relativePath}: expected exactly one source block, found ${first === -1 ? 0 : 2}`);
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

changed = replaceOnce(
  'server/drivers/bambu.js',
`function externalAmsIdForPrinter(printer) {
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
`,
`function normalizedModelName(printer) {
  return String(printer.model || '')
    .trim()
    .toLowerCase()
    .replace(/[\\s_-]+/g, '');
}

function isH2Family(printer) {
  return new Set(['h2', 'h2c', 'h2d', 'h2dpro', 'h2s', 'x2d'])
    .has(normalizedModelName(printer));
}

function buildAmsPayload(printer, requestedMapping) {
  if (!isH2Family(printer)) {
    // X1/P1/A1 firmware uses the historical fixed five-entry lookup table.
    // The requested project filaments are left-aligned and unused positions
    // are padded with -1. A one-entry [-1] table is incomplete and can leave
    // the printer paused at the heatbed stage with HMS 07FF-8012.
    if (requestedMapping.length > 5) {
      throw new Error(
        'Bambu X1/P1/A1 AMS mapping supports at most five project filament entries'
      );
    }

    const amsMapping = Array.from(
      { length: 5 },
      (_, index) => index < requestedMapping.length ? requestedMapping[index] : -1
    );

    return {
      use_ams: amsMapping.some(slot => slot >= 0 && slot < 254),
      ams_mapping: amsMapping,
    };
  }

  // H2-family firmware uses a project-length table plus a parallel structured
  // table. The upload UI's -1 means "use the external spool" for a used
  // filament, which H2 represents as virtual tray 254.
  const amsMapping = requestedMapping.map(slot =>
    slot === -1 || slot === 255 ? 254 : slot
  );

  const amsMapping2 = amsMapping.map(slot => {
    if (slot === 254) return { ams_id: 254, slot_id: 254 };
    if (slot < 0 || slot === 255) return { ams_id: 255, slot_id: 255 };
    if (slot >= 128) return { ams_id: 128, slot_id: slot - 128 };

    return {
      ams_id: Math.floor(slot / 4),
      slot_id: slot % 4,
    };
  });

  return {
    // Current H2 firmware still performs mapping lookup for external-feed jobs.
    use_ams: true,
    ams_mapping: amsMapping,
    ams_mapping2: amsMapping2,
  };
}
`
) || changed;

changed = replaceOnce(
  'server/drivers/bambu.js',
`  const onPrinterFilename = path.basename(gcodeFullPath);
  const ext = path.extname(onPrinterFilename).toLowerCase();
  const normalizedAmsMapping = normalizeAmsMapping(amsMapping ?? amsSlot);
`,
`  const onPrinterFilename = path.basename(gcodeFullPath);
  const ext = path.extname(onPrinterFilename).toLowerCase();
  const normalizedAmsMapping = normalizeAmsMapping(amsMapping ?? amsSlot);
  const isH2 = isH2Family(printer);
`
) || changed;

changed = replaceOnce(
  'server/drivers/bambu.js',
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
`,
`  // X1/P1/A1 and H2 firmware families require different mapping shapes.
  const subtaskName = path.basename(_filename || onPrinterFilename, '.3mf');
  const amsPayload = buildAmsPayload(printer, normalizedAmsMapping);
`
) || changed;

changed = replaceOnce(
  'server/drivers/bambu.js',
`    subtask_name:    subtaskName,
    file:            onPrinterFilename,
    url:             \`ftp:///\${onPrinterFilename}\`,
    bed_type:        'auto',
`,
`    subtask_name:    subtaskName,
    url:             \`ftp:///\${onPrinterFilename}\`,
    md5:             '',
    bed_type:        'auto',
`
) || changed;

changed = replaceOnce(
  'server/drivers/bambu.js',
`    layer_inspect:   false,
    use_ams:         useAms,
    ams_mapping:     flatMapping,
    ams_mapping2:    mapping2,
    profile_id:      '0',
`,
`    layer_inspect:   false,
    ...amsPayload,
    profile_id:      '0',
`
) || changed;

changed = replaceOnce(
  'server/drivers/bambu.js',
`  };

  const mqttPayload = JSON.stringify({ print: printPayload });
`,
`  };

  // H2 firmware expects the remote file field; X1/P1/A1 uses the legacy
  // project_file shape and should not receive H2-only fields.
  if (isH2) printPayload.file = onPrinterFilename;

  const mqttPayload = JSON.stringify({ print: printPayload });
`
) || changed;

changed = replaceOnce(
  'server/tests/bambu-driver.test.js',
`  test('AMS slot 0: sends both mapping formats', async () => {
`,
`  test('X1C AMS slot 0: sends fixed five-entry legacy mapping', async () => {
`
) || changed;

changed = replaceOnce(
  'server/tests/bambu-driver.test.js',
`    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([0]);
    expect(p.ams_mapping2).toEqual([{ ams_id: 0, slot_id: 0 }]);
`,
`    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([0, -1, -1, -1, -1]);
    expect(p.ams_mapping2).toBeUndefined();
`
) || changed;

changed = replaceOnce(
  'server/tests/bambu-driver.test.js',
`  test('AMS slot 3: ams_mapping is [3]', async () => {
`,
`  test('X1C AMS slot 3 is left-aligned and padded', async () => {
`
) || changed;

changed = replaceOnce(
  'server/tests/bambu-driver.test.js',
`    expect(findPayload('project_file').ams_mapping).toEqual([3]);
`,
`    expect(findPayload('project_file').ams_mapping).toEqual([3, -1, -1, -1, -1]);
`
) || changed;

changed = replaceOnce(
  'server/tests/bambu-driver.test.js',
`    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([0, 3, 6]);
    expect(p.ams_mapping2).toEqual([
      { ams_id: 0, slot_id: 0 },
      { ams_id: 0, slot_id: 3 },
      { ams_id: 1, slot_id: 2 },
    ]);
`,
`    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([0, 3, 6, -1, -1]);
    expect(p.ams_mapping2).toBeUndefined();
`
) || changed;

changed = replaceOnce(
  'server/tests/bambu-driver.test.js',
`    expect(p.use_ams).toBe(false);
    expect(p.ams_mapping).toEqual([-1]);
    expect(p.ams_mapping2).toEqual([{ ams_id: 255, slot_id: 0 }]);
  });

  test('null amsSlot defaults to use_ams false (external spool)', async () => {
`,
`    expect(p.use_ams).toBe(false);
    expect(p.ams_mapping).toEqual([-1, -1, -1, -1, -1]);
    expect(p.ams_mapping2).toBeUndefined();
  });

  test('H2D uses project-length mapping and structured mapping2', async () => {
    const printer = { ...nextPrinter(), model: 'h2d' };
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(
      printer,
      '/tmp/1234_part.gcode.3mf',
      'part.gcode.3mf',
      { amsSlot: '[-1,0,128]' }
    );

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([254, 0, 128]);
    expect(p.ams_mapping2).toEqual([
      { ams_id: 254, slot_id: 254 },
      { ams_id: 0, slot_id: 0 },
      { ams_id: 128, slot_id: 0 },
    ]);
    expect(p.file).toBe('1234_part.gcode.3mf');
  });

  test('null amsSlot defaults to use_ams false (external spool)', async () => {
`
) || changed;

console.log(changed
  ? '\nX1/P1/A1 AMS mapping fix applied.'
  : '\nX1/P1/A1 AMS mapping fix already present.');
