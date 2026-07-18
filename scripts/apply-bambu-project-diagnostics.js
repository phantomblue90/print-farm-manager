const fs = require('fs');

function replaceSection(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Could not find start of ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Could not find end of ${label}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function replaceExact(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Could not find ${label}`);
  return source.replace(before, after);
}

const driverPath = 'server/drivers/bambu.js';
let driver = fs.readFileSync(driverPath, 'utf8');

const messageHandler = [
  "  client.on('message', (_topic, message) => {",
  "    try {",
  "      const data = JSON.parse(message.toString());",
  "      // All status fields arrive under data.print.",
  "      // Merge — Bambu sends partial updates, not a full snapshot each time.",
  "      if (data.print) {",
  "        const update = data.print;",
  "        const previous = conn.latestPrint || {};",
  "        conn.latestPrint = { ...previous, ...update };",
  "",
  "        // Surface command acknowledgements and meaningful state transitions.",
  "        // Without this, the scheduler only sees FAILED/PAUSE and hides the",
  "        // firmware's result/reason/error details that explain a rejected job.",
  "        const has = key => Object.prototype.hasOwnProperty.call(update, key);",
  "        const commandReply = has('command') && (has('result') || has('reason') || has('code'));",
  "        const enteredFailure =",
  "          ['FAILED', 'PAUSE'].includes(update.gcode_state) &&",
  "          update.gcode_state !== previous.gcode_state;",
  "        const printErrorChanged =",
  "          has('print_error') &&",
  "          Number(update.print_error) !== 0 &&",
  "          update.print_error !== previous.print_error;",
  "        const stageChanged =",
  "          has('mc_print_stage') &&",
  "          update.mc_print_stage !== previous.mc_print_stage;",
  "",
  "        if (commandReply || enteredFailure || printErrorChanged || stageChanged) {",
  "          const diagnostic = {};",
  "          for (const key of [",
  "            'sequence_id', 'command', 'result', 'reason', 'code', 'error_code',",
  "            'print_error', 'gcode_state', 'mc_print_stage', 'mc_percent',",
  "            'bed_temper', 'bed_target_temper', 'nozzle_temper',",
  "            'nozzle_target_temper', 'subtask_name',",
  "          ]) {",
  "            if (has(key)) diagnostic[key] = update[key];",
  "          }",
  "          console.log(`[bambu] MQTT report ← ${printer.name}: ${JSON.stringify(diagnostic)}`);",
  "        }",
  "      }",
  "    } catch (err) {",
  "      if (process.env.DEBUG_BAMBU) {",
  "        console.warn(`[bambu] ${printer.name} invalid MQTT report:`, err?.message || err);",
  "      }",
  "    }",
  "  });",
  "",
].join('\n');

driver = replaceSection(
  driver,
  "  client.on('message', (_topic, message) => {",
  "  client.on('reconnect', () => {",
  messageHandler,
  'MQTT message handler'
);

driver = replaceExact(
  driver,
  [
    "  const normalizedAmsMapping = normalizeAmsMapping(amsMapping ?? amsSlot);",
    "  const isH2 = isH2Family(printer);",
    "  const isPreSlicedGcode3mf = onPrinterFilename.toLowerCase().endsWith('.gcode.3mf');",
    "  const useGcodeFileCommand = isPreSlicedGcode3mf && !isH2;",
  ].join('\n'),
  [
    "  const normalizedAmsMapping = normalizeAmsMapping(amsMapping ?? amsSlot);",
    "  const isH2 = isH2Family(printer);",
  ].join('\n'),
  'gcode.3mf routing declarations'
);

driver = replaceExact(
  driver,
  [
    "    if (useGcodeFileCommand) {",
    "      // X1/P1/A1 firmware expects pre-sliced .gcode.3mf files in /cache.",
    "      await ftpClient.ensureDir('/cache');",
    "    }",
    "",
    "    await ftpClient.uploadFrom(gcodeFullPath, onPrinterFilename);",
  ].join('\n'),
  "    await ftpClient.uploadFrom(gcodeFullPath, onPrinterFilename);",
  'cache upload routing'
);

driver = replaceSection(
  driver,
  "  // X1/P1/A1 firmware starts pre-sliced .gcode.3mf files directly from the",
  "  // X1/P1/A1 and H2 firmware families require different mapping shapes.",
  '',
  'gcode_file command branch'
);

fs.writeFileSync(driverPath, driver);

const testPath = 'server/tests/bambu-driver.test.js';
let tests = fs.readFileSync(testPath, 'utf8');

const restoredTest = [
  "  test('X1 pre-sliced .gcode.3mf remains a project_file container', async () => {",
  "    const printer = nextPrinter();",
  "    bambu.getStatus(printer);",
  "    mockPublish.mockClear();",
  "",
  "    await bambu.uploadAndPrint(",
  "      printer,",
  "      '/tmp/1234_part.gcode.3mf',",
  "      'part.gcode.3mf',",
  "      { amsSlot: -1 }",
  "    );",
  "",
  "    expect(mockFtpClient.ensureDir).not.toHaveBeenCalled();",
  "    expect(mockFtpClient.uploadFrom).toHaveBeenCalledWith(",
  "      '/tmp/1234_part.gcode.3mf',",
  "      '1234_part.gcode.3mf'",
  "    );",
  "    const payload = findPayload('project_file');",
  "    expect(payload).not.toBeNull();",
  "    expect(payload.param).toBe('Metadata/plate_1.gcode');",
  "    expect(payload.ams_mapping).toEqual([-1, -1, -1, -1, -1]);",
  "    expect(findPayload('gcode_file')).toBeNull();",
  "  });",
].join('\n');

tests = replaceSection(
  tests,
  "  test('X1 pre-sliced .gcode.3mf uploads to cache and uses gcode_file', async () => {",
  "  test('uses project_file MQTT command', async () => {",
  restoredTest + '\n\n',
  'X1 gcode.3mf test'
);

fs.writeFileSync(testPath, tests);
console.log('Applied Bambu project_file revert and MQTT diagnostics.');
