const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

function emptyStore() {
  return {
    devices: {},
    reports: [],
    blocks: []
  };
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(emptyStore(), null, 2));
  }
}

function loadStore() {
  ensureStore();

  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return emptyStore();
  }
}

let store = loadStore();

let saveTimer = null;

function save() {
  clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    try {
      const temp = DATA_FILE + ".tmp";
      fs.writeFileSync(temp, JSON.stringify(store, null, 2));
      fs.renameSync(temp, DATA_FILE);
    } catch (err) {
      console.error("Storage save error:", err.message);
    }
  }, 100);
}

class PersistentDeviceMap {
  get(key) {
    const value = store.devices[key];
    if (!value) return undefined;

    if (Array.isArray(value.blockedDeviceIds)) {
      value.blockedDeviceIds = new Set(value.blockedDeviceIds);
    }

    return value;
  }

  set(key, value) {
    const copy = { ...value };

    if (copy.blockedDeviceIds instanceof Set) {
      copy.blockedDeviceIds = [...copy.blockedDeviceIds];
    }

    store.devices[key] = copy;
    save();
    return this;
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(store.devices, key);
  }

  delete(key) {
    const exists = this.has(key);
    delete store.devices[key];

    if (exists) save();

    return exists;
  }

  get size() {
    return Object.keys(store.devices).length;
  }
}

class PersistentReports {
  push(report) {
    store.reports.push(report);
    save();
    return store.reports.length;
  }

  get length() {
    return store.reports.length;
  }
}

const deviceIdentities = new PersistentDeviceMap();
const reports = new PersistentReports();

module.exports = {
  deviceIdentities,
  reports,
  saveStore: save
};
