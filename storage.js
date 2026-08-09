const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({
        devices: {},
        reports: [],
        bans: [],
        blocks: []
      }, null, 2)
    );
  }
}

function loadStore() {
  ensureStore();

  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {
      devices: {},
      reports: [],
      bans: [],
      blocks: []
    };
  }
}

let store = loadStore();

function saveStore() {
  ensureStore();

  const tempFile = DATA_FILE + ".tmp";

  fs.writeFileSync(
    tempFile,
    JSON.stringify(store, null, 2)
  );

  fs.renameSync(tempFile, DATA_FILE);
}

function getDevice(deviceId) {
  return store.devices[deviceId] || null;
}

function createDevice(deviceId) {
  if (!store.devices[deviceId]) {
    store.devices[deviceId] = {
      deviceId,
      birthDate: null,
      ageVerifiedAtLeast18: false,
      reportsAgainst: 0,
      bannedUntil: null,
      banReason: null,
      blockedDeviceIds: [],
      firstSeen: Date.now()
    };

    saveStore();
  }

  return store.devices[deviceId];
}

function saveDevice(device) {
  store.devices[device.deviceId] = device;
  saveStore();
}

function addReport(report) {
  store.reports.push(report);
  saveStore();
}

function addBan(ban) {
  store.bans.push(ban);
  saveStore();
}

function addBlock(deviceA, deviceB) {
  if (!store.blocks.some(
    b => b.deviceA === deviceA && b.deviceB === deviceB
  )) {
    store.blocks.push({
      deviceA,
      deviceB,
      createdAt: Date.now()
    });

    saveStore();
  }
}

function isBlocked(deviceA, deviceB) {
  return store.blocks.some(
    b =>
      (b.deviceA === deviceA && b.deviceB === deviceB) ||
      (b.deviceA === deviceB && b.deviceB === deviceA)
  );
}

module.exports = {
  getDevice,
  createDevice,
  saveDevice,
  addReport,
  addBan,
  addBlock,
  isBlocked
};
