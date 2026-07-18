#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();

function replaceOnce(relativePath, oldText, newText) {
  const filename = path.join(root, relativePath);
  const text = fs.readFileSync(filename, 'utf8');

  if (text.includes(newText)) {
    console.log(`[skip] ${relativePath}: already applied`);
    return;
  }

  const first = text.indexOf(oldText);
  const second = first === -1 ? -1 : text.indexOf(oldText, first + oldText.length);
  if (first === -1 || second !== -1) {
    throw new Error(`${relativePath}: expected exactly one matching block`);
  }

  fs.writeFileSync(
    filename,
    text.slice(0, first) + newText + text.slice(first + oldText.length),
    'utf8'
  );
  console.log(`[patch] ${relativePath}`);
}

replaceOnce(
  'server/drivers/bambu.js',
  `  const onPrinterFilename = path.basename(gcodeFullPath);\n  const ext = path.extname(onPrinterFilename).toLowerCase();\n  const normalizedAmsMapping = normalizeAmsMapping(amsMapping ?? amsSlot);\n  const isH2 = isH2Family(printer);\n`,
  `  const onPrinterFilename = path.basename(gcodeFullPath);\n  const ext = path.extname(onPrinterFilename).toLowerCase();\n  const normalizedAmsMapping = normalizeAmsMapping(amsMapping ?? amsSlot);\n  const isH2 = isH2Family(printer);\n  const isPreSlicedGcode3mf = onPrinterFilename.toLowerCase().endsWith('.gcode.3mf');\n  const useGcodeFileCommand = isPreSlicedGcode3mf && !isH2;\n`
);

replaceOnce(
  'server/drivers/bambu.js',
  `    await ftpClient.uploadFrom(gcodeFullPath, onPrinterFilename);\n    console.log(\`[bambu] Upload complete on \${printer.name}\`);\n`,
  `    if (useGcodeFileCommand) {\n      // X1/P1/A1 firmware expects pre-sliced .gcode.3mf files in /cache.\n      await ftpClient.ensureDir('/cache');\n    }\n\n    await ftpClient.uploadFrom(gcodeFullPath, onPrinterFilename);\n    console.log(\`[bambu] Upload complete on \${printer.name}\`);\n`
);

replaceOnce(
  'server/drivers/bambu.js',
  `  if (!conn.connected) {\n    throw new Error(\`Bambu printer \${printer.name} MQTT not connected — cannot trigger print\`);\n  }\n\n  // X1/P1/A1 and H2 firmware families require different mapping shapes.\n`,
  `  if (!conn.connected) {\n    throw new Error(\`Bambu printer \${printer.name} MQTT not connected — cannot trigger print\`);\n  }\n\n  // X1/P1/A1 firmware starts pre-sliced .gcode.3mf files directly from the\n  // SD-card cache. Sending these containers through project_file can enter\n  // PREPARE and heat successfully but never advance into the actual G-code.\n  if (useGcodeFileCommand) {\n    const remotePath = \`cache/\${onPrinterFilename}\`;\n    const printPayload = {\n      sequence_id: '0',\n      command: 'gcode_file',\n      param: remotePath,\n    };\n    const mqttPayload = JSON.stringify({ print: printPayload });\n    console.log(\`[bambu] MQTT payload → \${printer.name}: \${mqttPayload}\`);\n    conn.client.publish(\`device/\${printer.serial_number}/request\`, mqttPayload, (err) => {\n      if (err) console.error(\`[bambu] MQTT publish failed for \${printer.name}:\`, err.message);\n      else console.log(\`[bambu] MQTT publish confirmed for \${printer.name}\`);\n    });\n    return;\n  }\n\n  // X1/P1/A1 and H2 firmware families require different mapping shapes.\n`
);

replaceOnce(
  'server/drivers/bambu.js',
  `  // All Bambu uploads are .3mf files at the SD card root.\n  const remotePath = filename;\n`,
  `  // X1/P1/A1 pre-sliced .gcode.3mf files live in /cache; H2/project\n  // containers remain at the SD-card root.\n  const remotePath = !isH2Family(printer) && filename.toLowerCase().endsWith('.gcode.3mf')\n    ? \`cache/\${filename}\`\n    : filename;\n`
);

replaceOnce(
  'server/tests/bambu-driver.test.js',
  `    access:     jest.fn().mockResolvedValue(undefined),\n    uploadFrom: jest.fn().mockResolvedValue(undefined),\n    close:      jest.fn(),\n`,
  `    access:     jest.fn().mockResolvedValue(undefined),\n    ensureDir:  jest.fn().mockResolvedValue(undefined),\n    uploadFrom: jest.fn().mockResolvedValue(undefined),\n    close:      jest.fn(),\n`
);

replaceOnce(
  'server/tests/bambu-driver.test.js',
  `describe('uploadAndPrint — .3mf (project_file)', () => {\n  test('uses project_file MQTT command', async () => {\n`,
  `describe('uploadAndPrint — .3mf (project_file)', () => {\n  test('X1 pre-sliced .gcode.3mf uploads to cache and uses gcode_file', async () => {\n    const printer = nextPrinter();\n    bambu.getStatus(printer);\n    mockPublish.mockClear();\n\n    await bambu.uploadAndPrint(\n      printer,\n      '/tmp/1234_part.gcode.3mf',\n      'part.gcode.3mf',\n      { amsSlot: -1 }\n    );\n\n    expect(mockFtpClient.ensureDir).toHaveBeenCalledWith('/cache');\n    expect(mockFtpClient.uploadFrom).toHaveBeenCalledWith(\n      '/tmp/1234_part.gcode.3mf',\n      '1234_part.gcode.3mf'\n    );\n    expect(findPayload('gcode_file')).toEqual({\n      sequence_id: '0',\n      command: 'gcode_file',\n      param: 'cache/1234_part.gcode.3mf',\n    });\n    expect(findPayload('project_file')).toBeNull();\n  });\n\n  test('uses project_file MQTT command', async () => {\n`
);

console.log('X1 gcode.3mf routing patch applied.');
