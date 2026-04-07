const path = require('path');
const fs   = require('fs');

jest.mock('axios');
const axios = require('axios');

const Database     = require('better-sqlite3');
const JobScheduler = require('../scheduler');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const fakePrinter = { id: 1, name: 'Test Printer', ip: '192.168.1.1', api_key: 'key', model: 'mk4s' };

// Files created during tests — cleaned up in afterAll after all streams have closed
const filesToClean = [];

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
});

afterAll(() => {
  for (const p of filesToClean) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
});

beforeEach(() => {
  axios.delete.mockResolvedValue({});
  // Destroy any ReadStream passed as the body — mirrors what real axios does when
  // the upload completes. We also attach an error listener before destroying:
  // Node.js's async autoOpen is already in-flight when destroy() is called, so
  // when the open callback fires after the file is deleted (in afterAll) the stream
  // emits ENOENT. Without a listener that would be an unhandled error event.
  axios.put.mockImplementation((_url, data) => {
    if (data && typeof data.destroy === 'function') {
      data.on('error', () => {});
      data.destroy();
    }
    return Promise.resolve({});
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

function makeScheduler() {
  const db = new Database(':memory:');
  return new JobScheduler(db, { on: () => {} });
}

function createTestFile(filename) {
  const filePath = path.join(GCODE_DIR, filename);
  fs.writeFileSync(filePath, 'fake gcode');
  filesToClean.push(filePath);
  return filePath;
}

describe('_uploadGCode — 409 UPLOAD_CONFLICT', () => {
  test('throws UPLOAD_CONFLICT when PrusaLink DELETE returns 409', async () => {
    const scheduler = makeScheduler();
    const filename = `conflict_del_${Date.now()}.bgcode`;
    createTestFile(filename);

    axios.delete.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 409'), {
        response: { status: 409 },
      })
    );

    await expect(scheduler._uploadGCode(fakePrinter, { filename, filepath: filename }))
      .rejects.toMatchObject({ code: 'UPLOAD_CONFLICT' });

    // Should not have attempted the PUT when DELETE conflicted
    expect(axios.put).not.toHaveBeenCalled();
  });

  test('throws UPLOAD_CONFLICT when PrusaLink PUT returns 409', async () => {
    const scheduler = makeScheduler();
    const filename = `conflict_put_${Date.now()}.bgcode`;
    createTestFile(filename);

    // DELETE succeeds, PUT returns 409 — destroy stream to avoid unhandled ENOENT after cleanup
    axios.delete.mockResolvedValueOnce({});
    axios.put.mockImplementationOnce((_url, data) => {
      if (data && typeof data.destroy === 'function') {
        data.on('error', () => {});
        data.destroy();
      }
      return Promise.reject(
        Object.assign(new Error('Request failed with status code 409'), { response: { status: 409 } })
      );
    });

    await expect(scheduler._uploadGCode(fakePrinter, { filename, filepath: filename }))
      .rejects.toMatchObject({ code: 'UPLOAD_CONFLICT' });
  });

  test('does not throw UPLOAD_CONFLICT for non-409 PUT errors', async () => {
    const scheduler = makeScheduler();
    const filename = `timeout_err_${Date.now()}.bgcode`;
    createTestFile(filename);

    axios.delete.mockResolvedValueOnce({});
    // No .response — simulates a network-level failure, not an HTTP 409
    axios.put.mockImplementationOnce((_url, data) => {
      if (data && typeof data.destroy === 'function') {
        data.on('error', () => {});
        data.destroy();
      }
      return Promise.reject(new Error('ECONNRESET'));
    });

    await expect(scheduler._uploadGCode(fakePrinter, { filename, filepath: filename }))
      .rejects.toMatchObject({ message: 'ECONNRESET' });
  });
});

describe('_checkIfPrinting', () => {
  test('returns true when PrusaLink reports PRINTING', async () => {
    const scheduler = makeScheduler();
    axios.get.mockResolvedValueOnce({ data: { printer: { state: 'PRINTING' } } });

    const result = await scheduler._checkIfPrinting(fakePrinter);
    expect(result).toBe(true);
  });

  test('returns true when PrusaLink reports PAUSED', async () => {
    const scheduler = makeScheduler();
    axios.get.mockResolvedValueOnce({ data: { printer: { state: 'PAUSED' } } });

    const result = await scheduler._checkIfPrinting(fakePrinter);
    expect(result).toBe(true);
  });

  test('returns false when PrusaLink reports IDLE', async () => {
    const scheduler = makeScheduler();
    axios.get.mockResolvedValueOnce({ data: { printer: { state: 'IDLE' } } });

    const result = await scheduler._checkIfPrinting(fakePrinter);
    expect(result).toBe(false);
  });

  test('returns false when printer is unreachable (network error)', async () => {
    const scheduler = makeScheduler();
    axios.get.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const result = await scheduler._checkIfPrinting(fakePrinter);
    expect(result).toBe(false);
  });

  test('is case-insensitive — lowercase state still matches', async () => {
    const scheduler = makeScheduler();
    axios.get.mockResolvedValueOnce({ data: { printer: { state: 'printing' } } });

    const result = await scheduler._checkIfPrinting(fakePrinter);
    expect(result).toBe(true);
  });
});

describe('_uploadGCode — GCODE_MISSING', () => {
  test('throws with code GCODE_MISSING when file does not exist on disk', async () => {
    const scheduler = makeScheduler();
    const gcode = { filename: 'nonexistent.bgcode', filepath: 'nonexistent.bgcode' };

    await expect(scheduler._uploadGCode(fakePrinter, gcode))
      .rejects.toMatchObject({ code: 'GCODE_MISSING' });
  });

  test('does not call axios.put when file is missing', async () => {
    const scheduler = makeScheduler();
    const gcode = { filename: 'also_missing.bgcode', filepath: 'also_missing.bgcode' };

    await expect(scheduler._uploadGCode(fakePrinter, gcode)).rejects.toThrow();
    expect(axios.put).not.toHaveBeenCalled();
  });
});

describe('_uploadGCode — path resolution', () => {
  test('finds file when filepath is a bare filename', async () => {
    const scheduler = makeScheduler();
    const filename = `bare_${Date.now()}.bgcode`;
    createTestFile(filename);

    await scheduler._uploadGCode(fakePrinter, { filename, filepath: filename });
    expect(axios.put).toHaveBeenCalledTimes(1);
  });

  test('finds file when filepath is an old absolute Unix path', async () => {
    const scheduler = makeScheduler();
    const filename = `abs_unix_${Date.now()}.bgcode`;
    createTestFile(filename);

    const oldPath = `/Users/olduser/dev/print-farm-manager/server/gcode/${filename}`;
    await scheduler._uploadGCode(fakePrinter, { filename, filepath: oldPath });
    expect(axios.put).toHaveBeenCalledTimes(1);
  });

  test('finds file when filepath is an old absolute Windows path', async () => {
    const scheduler = makeScheduler();
    const filename = `abs_win_${Date.now()}.bgcode`;
    createTestFile(filename);

    const oldPath = `C:\\Users\\operator\\print-farm-manager\\server\\gcode\\${filename}`;
    await scheduler._uploadGCode(fakePrinter, { filename, filepath: oldPath });
    expect(axios.put).toHaveBeenCalledTimes(1);
  });

  test('throws GCODE_MISSING when basename of absolute path is not in GCODE_DIR', async () => {
    const scheduler = makeScheduler();
    // Absolute path whose basename doesn't exist in GCODE_DIR
    const gcode = {
      filename: 'ghost.bgcode',
      filepath: '/old/machine/path/ghost.bgcode',
    };

    await expect(scheduler._uploadGCode(fakePrinter, gcode))
      .rejects.toMatchObject({ code: 'GCODE_MISSING' });
  });
});
