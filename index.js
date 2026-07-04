"use strict";
const electron = require("electron");
const fs = require("fs");
const path = require("path");
const node_events = require("node:events");
const node_fs = require("node:fs");
const promises = require("node:fs/promises");
const sp = require("node:path");
const node_stream = require("node:stream");
const node_os = require("node:os");
const child_process = require("child_process");
const util = require("util");
const pty = require("node-pty");
const os = require("os");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const sp__namespace = /* @__PURE__ */ _interopNamespaceDefault(sp);
const pty__namespace = /* @__PURE__ */ _interopNamespaceDefault(pty);
const is = {
  dev: !electron.app.isPackaged
};
const platform = {
  isWindows: process.platform === "win32",
  isMacOS: process.platform === "darwin",
  isLinux: process.platform === "linux"
};
const electronApp = {
  setAppUserModelId(id) {
    if (platform.isWindows)
      electron.app.setAppUserModelId(is.dev ? process.execPath : id);
  },
  setAutoLaunch(auto) {
    if (platform.isLinux)
      return false;
    const isOpenAtLogin = () => {
      return electron.app.getLoginItemSettings().openAtLogin;
    };
    if (isOpenAtLogin() !== auto) {
      electron.app.setLoginItemSettings({
        openAtLogin: auto,
        path: process.execPath
      });
      return isOpenAtLogin() === auto;
    } else {
      return true;
    }
  },
  skipProxy() {
    return electron.session.defaultSession.setProxy({ mode: "direct" });
  }
};
const optimizer = {
  watchWindowShortcuts(window, shortcutOptions) {
    if (!window)
      return;
    const { webContents } = window;
    const { escToCloseWindow = false, zoom = false } = shortcutOptions || {};
    webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown") {
        if (!is.dev) {
          if (input.code === "KeyR" && (input.control || input.meta))
            event.preventDefault();
        } else {
          if (input.code === "F12") {
            if (webContents.isDevToolsOpened()) {
              webContents.closeDevTools();
            } else {
              webContents.openDevTools({ mode: "undocked" });
              console.log("Open dev tool...");
            }
          }
        }
        if (escToCloseWindow) {
          if (input.code === "Escape" && input.key !== "Process") {
            window.close();
            event.preventDefault();
          }
        }
        if (!zoom) {
          if (input.code === "Minus" && (input.control || input.meta))
            event.preventDefault();
          if (input.code === "Equal" && input.shift && (input.control || input.meta))
            event.preventDefault();
        }
      }
    });
  },
  registerFramelessWindowIpc() {
    electron.ipcMain.on("win:invoke", (event, action) => {
      const win2 = electron.BrowserWindow.fromWebContents(event.sender);
      if (win2) {
        if (action === "show") {
          win2.show();
        } else if (action === "showInactive") {
          win2.showInactive();
        } else if (action === "min") {
          win2.minimize();
        } else if (action === "max") {
          const isMaximized = win2.isMaximized();
          if (isMaximized) {
            win2.unmaximize();
          } else {
            win2.maximize();
          }
        } else if (action === "close") {
          win2.close();
        }
      }
    });
  }
};
const EntryTypes = {
  FILE_TYPE: "files",
  DIR_TYPE: "directories",
  FILE_DIR_TYPE: "files_directories",
  EVERYTHING_TYPE: "all"
};
const defaultOptions = {
  root: ".",
  fileFilter: (_entryInfo) => true,
  directoryFilter: (_entryInfo) => true,
  type: EntryTypes.FILE_TYPE,
  lstat: false,
  depth: 2147483648,
  alwaysStat: false,
  highWaterMark: 4096
};
Object.freeze(defaultOptions);
const RECURSIVE_ERROR_CODE = "READDIRP_RECURSIVE_ERROR";
const NORMAL_FLOW_ERRORS = /* @__PURE__ */ new Set(["ENOENT", "EPERM", "EACCES", "ELOOP", RECURSIVE_ERROR_CODE]);
const ALL_TYPES = [
  EntryTypes.DIR_TYPE,
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE,
  EntryTypes.FILE_TYPE
];
const DIR_TYPES = /* @__PURE__ */ new Set([
  EntryTypes.DIR_TYPE,
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE
]);
const FILE_TYPES = /* @__PURE__ */ new Set([
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE,
  EntryTypes.FILE_TYPE
]);
const isNormalFlowError = (error) => NORMAL_FLOW_ERRORS.has(error.code);
const wantBigintFsStats = process.platform === "win32";
const emptyFn = (_entryInfo) => true;
const normalizeFilter = (filter) => {
  if (filter === void 0)
    return emptyFn;
  if (typeof filter === "function")
    return filter;
  if (typeof filter === "string") {
    const fl = filter.trim();
    return (entry) => entry.basename === fl;
  }
  if (Array.isArray(filter)) {
    const trItems = filter.map((item) => item.trim());
    return (entry) => trItems.some((f) => entry.basename === f);
  }
  return emptyFn;
};
class ReaddirpStream extends node_stream.Readable {
  parents;
  reading;
  parent;
  _stat;
  _maxDepth;
  _wantsDir;
  _wantsFile;
  _wantsEverything;
  _root;
  _isDirent;
  _statsProp;
  _rdOptions;
  _fileFilter;
  _directoryFilter;
  constructor(options = {}) {
    super({
      objectMode: true,
      autoDestroy: true,
      highWaterMark: options.highWaterMark
    });
    const opts = { ...defaultOptions, ...options };
    const { root, type } = opts;
    this._fileFilter = normalizeFilter(opts.fileFilter);
    this._directoryFilter = normalizeFilter(opts.directoryFilter);
    const statMethod = opts.lstat ? promises.lstat : promises.stat;
    if (wantBigintFsStats) {
      this._stat = (path2) => statMethod(path2, { bigint: true });
    } else {
      this._stat = statMethod;
    }
    this._maxDepth = opts.depth != null && Number.isSafeInteger(opts.depth) ? opts.depth : defaultOptions.depth;
    this._wantsDir = type ? DIR_TYPES.has(type) : false;
    this._wantsFile = type ? FILE_TYPES.has(type) : false;
    this._wantsEverything = type === EntryTypes.EVERYTHING_TYPE;
    this._root = sp.resolve(root);
    this._isDirent = !opts.alwaysStat;
    this._statsProp = this._isDirent ? "dirent" : "stats";
    this._rdOptions = { encoding: "utf8", withFileTypes: this._isDirent };
    this.parents = [this._exploreDir(root, 1)];
    this.reading = false;
    this.parent = void 0;
  }
  async _read(batch) {
    if (this.reading)
      return;
    this.reading = true;
    try {
      while (!this.destroyed && batch > 0) {
        const par = this.parent;
        const fil = par && par.files;
        if (fil && fil.length > 0) {
          const { path: path2, depth } = par;
          const slice = fil.splice(0, batch).map((dirent) => this._formatEntry(dirent, path2));
          const awaited = await Promise.all(slice);
          for (const entry of awaited) {
            if (!entry)
              continue;
            if (this.destroyed)
              return;
            const entryType = await this._getEntryType(entry);
            if (entryType === "directory" && this._directoryFilter(entry)) {
              if (depth <= this._maxDepth) {
                this.parents.push(this._exploreDir(entry.fullPath, depth + 1));
              }
              if (this._wantsDir) {
                this.push(entry);
                batch--;
              }
            } else if ((entryType === "file" || this._includeAsFile(entry)) && this._fileFilter(entry)) {
              if (this._wantsFile) {
                this.push(entry);
                batch--;
              }
            }
          }
        } else {
          const parent = this.parents.pop();
          if (!parent) {
            this.push(null);
            break;
          }
          this.parent = await parent;
          if (this.destroyed)
            return;
        }
      }
    } catch (error) {
      this.destroy(error);
    } finally {
      this.reading = false;
    }
  }
  async _exploreDir(path2, depth) {
    let files;
    try {
      files = await promises.readdir(path2, this._rdOptions);
    } catch (error) {
      this._onError(error);
    }
    return { files, depth, path: path2 };
  }
  async _formatEntry(dirent, path2) {
    let entry;
    const basename = this._isDirent ? dirent.name : dirent;
    try {
      const fullPath = sp.resolve(sp.join(path2, basename));
      entry = { path: sp.relative(this._root, fullPath), fullPath, basename };
      entry[this._statsProp] = this._isDirent ? dirent : await this._stat(fullPath);
    } catch (err) {
      this._onError(err);
      return;
    }
    return entry;
  }
  _onError(err) {
    if (isNormalFlowError(err) && !this.destroyed) {
      this.emit("warn", err);
    } else {
      this.destroy(err);
    }
  }
  async _getEntryType(entry) {
    if (!entry && this._statsProp in entry) {
      return "";
    }
    const stats = entry[this._statsProp];
    if (stats.isFile())
      return "file";
    if (stats.isDirectory())
      return "directory";
    if (stats && stats.isSymbolicLink()) {
      const full = entry.fullPath;
      try {
        const entryRealPath = await promises.realpath(full);
        const entryRealPathStats = await promises.lstat(entryRealPath);
        if (entryRealPathStats.isFile()) {
          return "file";
        }
        if (entryRealPathStats.isDirectory()) {
          const len = entryRealPath.length;
          if (full.startsWith(entryRealPath) && full.substr(len, 1) === sp.sep) {
            const recursiveError = new Error(`Circular symlink detected: "${full}" points to "${entryRealPath}"`);
            recursiveError.code = RECURSIVE_ERROR_CODE;
            return this._onError(recursiveError);
          }
          return "directory";
        }
      } catch (error) {
        this._onError(error);
        return "";
      }
    }
  }
  _includeAsFile(entry) {
    const stats = entry && entry[this._statsProp];
    return stats && this._wantsEverything && !stats.isDirectory();
  }
}
function readdirp(root, options = {}) {
  let type = options.entryType || options.type;
  if (type === "both")
    type = EntryTypes.FILE_DIR_TYPE;
  if (type)
    options.type = type;
  if (!root) {
    throw new Error("readdirp: root argument is required. Usage: readdirp(root, options)");
  } else if (typeof root !== "string") {
    throw new TypeError("readdirp: root argument must be a string. Usage: readdirp(root, options)");
  } else if (type && !ALL_TYPES.includes(type)) {
    throw new Error(`readdirp: Invalid type passed. Use one of ${ALL_TYPES.join(", ")}`);
  }
  options.root = root;
  return new ReaddirpStream(options);
}
const STR_DATA = "data";
const STR_END = "end";
const STR_CLOSE = "close";
const EMPTY_FN = () => {
};
const pl = process.platform;
const isWindows = pl === "win32";
const isMacos = pl === "darwin";
const isLinux = pl === "linux";
const isFreeBSD = pl === "freebsd";
const isIBMi = node_os.type() === "OS400";
const EVENTS = {
  ALL: "all",
  READY: "ready",
  ADD: "add",
  CHANGE: "change",
  ADD_DIR: "addDir",
  UNLINK: "unlink",
  UNLINK_DIR: "unlinkDir",
  RAW: "raw",
  ERROR: "error"
};
const EV = EVENTS;
const THROTTLE_MODE_WATCH = "watch";
const statMethods = { lstat: promises.lstat, stat: promises.stat };
const KEY_LISTENERS = "listeners";
const KEY_ERR = "errHandlers";
const KEY_RAW = "rawEmitters";
const HANDLER_KEYS = [KEY_LISTENERS, KEY_ERR, KEY_RAW];
const binaryExtensions = /* @__PURE__ */ new Set([
  "3dm",
  "3ds",
  "3g2",
  "3gp",
  "7z",
  "a",
  "aac",
  "adp",
  "afdesign",
  "afphoto",
  "afpub",
  "ai",
  "aif",
  "aiff",
  "alz",
  "ape",
  "apk",
  "appimage",
  "ar",
  "arj",
  "asf",
  "au",
  "avi",
  "bak",
  "baml",
  "bh",
  "bin",
  "bk",
  "bmp",
  "btif",
  "bz2",
  "bzip2",
  "cab",
  "caf",
  "cgm",
  "class",
  "cmx",
  "cpio",
  "cr2",
  "cur",
  "dat",
  "dcm",
  "deb",
  "dex",
  "djvu",
  "dll",
  "dmg",
  "dng",
  "doc",
  "docm",
  "docx",
  "dot",
  "dotm",
  "dra",
  "DS_Store",
  "dsk",
  "dts",
  "dtshd",
  "dvb",
  "dwg",
  "dxf",
  "ecelp4800",
  "ecelp7470",
  "ecelp9600",
  "egg",
  "eol",
  "eot",
  "epub",
  "exe",
  "f4v",
  "fbs",
  "fh",
  "fla",
  "flac",
  "flatpak",
  "fli",
  "flv",
  "fpx",
  "fst",
  "fvt",
  "g3",
  "gh",
  "gif",
  "graffle",
  "gz",
  "gzip",
  "h261",
  "h263",
  "h264",
  "icns",
  "ico",
  "ief",
  "img",
  "ipa",
  "iso",
  "jar",
  "jpeg",
  "jpg",
  "jpgv",
  "jpm",
  "jxr",
  "key",
  "ktx",
  "lha",
  "lib",
  "lvp",
  "lz",
  "lzh",
  "lzma",
  "lzo",
  "m3u",
  "m4a",
  "m4v",
  "mar",
  "mdi",
  "mht",
  "mid",
  "midi",
  "mj2",
  "mka",
  "mkv",
  "mmr",
  "mng",
  "mobi",
  "mov",
  "movie",
  "mp3",
  "mp4",
  "mp4a",
  "mpeg",
  "mpg",
  "mpga",
  "mxu",
  "nef",
  "npx",
  "numbers",
  "nupkg",
  "o",
  "odp",
  "ods",
  "odt",
  "oga",
  "ogg",
  "ogv",
  "otf",
  "ott",
  "pages",
  "pbm",
  "pcx",
  "pdb",
  "pdf",
  "pea",
  "pgm",
  "pic",
  "png",
  "pnm",
  "pot",
  "potm",
  "potx",
  "ppa",
  "ppam",
  "ppm",
  "pps",
  "ppsm",
  "ppsx",
  "ppt",
  "pptm",
  "pptx",
  "psd",
  "pya",
  "pyc",
  "pyo",
  "pyv",
  "qt",
  "rar",
  "ras",
  "raw",
  "resources",
  "rgb",
  "rip",
  "rlc",
  "rmf",
  "rmvb",
  "rpm",
  "rtf",
  "rz",
  "s3m",
  "s7z",
  "scpt",
  "sgi",
  "shar",
  "snap",
  "sil",
  "sketch",
  "slk",
  "smv",
  "snk",
  "so",
  "stl",
  "suo",
  "sub",
  "swf",
  "tar",
  "tbz",
  "tbz2",
  "tga",
  "tgz",
  "thmx",
  "tif",
  "tiff",
  "tlz",
  "ttc",
  "ttf",
  "txz",
  "udf",
  "uvh",
  "uvi",
  "uvm",
  "uvp",
  "uvs",
  "uvu",
  "viv",
  "vob",
  "war",
  "wav",
  "wax",
  "wbmp",
  "wdp",
  "weba",
  "webm",
  "webp",
  "whl",
  "wim",
  "wm",
  "wma",
  "wmv",
  "wmx",
  "woff",
  "woff2",
  "wrm",
  "wvx",
  "xbm",
  "xif",
  "xla",
  "xlam",
  "xls",
  "xlsb",
  "xlsm",
  "xlsx",
  "xlt",
  "xltm",
  "xltx",
  "xm",
  "xmind",
  "xpi",
  "xpm",
  "xwd",
  "xz",
  "z",
  "zip",
  "zipx"
]);
const isBinaryPath = (filePath) => binaryExtensions.has(sp__namespace.extname(filePath).slice(1).toLowerCase());
const foreach = (val, fn) => {
  if (val instanceof Set) {
    val.forEach(fn);
  } else {
    fn(val);
  }
};
const addAndConvert = (main, prop, item) => {
  let container = main[prop];
  if (!(container instanceof Set)) {
    main[prop] = container = /* @__PURE__ */ new Set([container]);
  }
  container.add(item);
};
const clearItem = (cont) => (key) => {
  const set = cont[key];
  if (set instanceof Set) {
    set.clear();
  } else {
    delete cont[key];
  }
};
const delFromSet = (main, prop, item) => {
  const container = main[prop];
  if (container instanceof Set) {
    container.delete(item);
  } else if (container === item) {
    delete main[prop];
  }
};
const isEmptySet = (val) => val instanceof Set ? val.size === 0 : !val;
const FsWatchInstances = /* @__PURE__ */ new Map();
function createFsWatchInstance(path2, options, listener, errHandler, emitRaw) {
  const handleEvent = (rawEvent, evPath) => {
    listener(path2);
    emitRaw(rawEvent, evPath, { watchedPath: path2 });
    if (evPath && path2 !== evPath) {
      fsWatchBroadcast(sp__namespace.resolve(path2, evPath), KEY_LISTENERS, sp__namespace.join(path2, evPath));
    }
  };
  try {
    return node_fs.watch(path2, {
      persistent: options.persistent
    }, handleEvent);
  } catch (error) {
    errHandler(error);
    return void 0;
  }
}
const fsWatchBroadcast = (fullPath, listenerType, val1, val2, val3) => {
  const cont = FsWatchInstances.get(fullPath);
  if (!cont)
    return;
  foreach(cont[listenerType], (listener) => {
    listener(val1, val2, val3);
  });
};
const setFsWatchListener = (path2, fullPath, options, handlers) => {
  const { listener, errHandler, rawEmitter } = handlers;
  let cont = FsWatchInstances.get(fullPath);
  let watcher;
  if (!options.persistent) {
    watcher = createFsWatchInstance(path2, options, listener, errHandler, rawEmitter);
    if (!watcher)
      return;
    return watcher.close.bind(watcher);
  }
  if (cont) {
    addAndConvert(cont, KEY_LISTENERS, listener);
    addAndConvert(cont, KEY_ERR, errHandler);
    addAndConvert(cont, KEY_RAW, rawEmitter);
  } else {
    watcher = createFsWatchInstance(
      path2,
      options,
      fsWatchBroadcast.bind(null, fullPath, KEY_LISTENERS),
      errHandler,
      // no need to use broadcast here
      fsWatchBroadcast.bind(null, fullPath, KEY_RAW)
    );
    if (!watcher)
      return;
    watcher.on(EV.ERROR, async (error) => {
      const broadcastErr = fsWatchBroadcast.bind(null, fullPath, KEY_ERR);
      if (cont)
        cont.watcherUnusable = true;
      if (isWindows && error.code === "EPERM") {
        try {
          const fd = await promises.open(path2, "r");
          await fd.close();
          broadcastErr(error);
        } catch (err) {
        }
      } else {
        broadcastErr(error);
      }
    });
    cont = {
      listeners: listener,
      errHandlers: errHandler,
      rawEmitters: rawEmitter,
      watcher
    };
    FsWatchInstances.set(fullPath, cont);
  }
  return () => {
    delFromSet(cont, KEY_LISTENERS, listener);
    delFromSet(cont, KEY_ERR, errHandler);
    delFromSet(cont, KEY_RAW, rawEmitter);
    if (isEmptySet(cont.listeners)) {
      cont.watcher.close();
      FsWatchInstances.delete(fullPath);
      HANDLER_KEYS.forEach(clearItem(cont));
      cont.watcher = void 0;
      Object.freeze(cont);
    }
  };
};
const FsWatchFileInstances = /* @__PURE__ */ new Map();
const setFsWatchFileListener = (path2, fullPath, options, handlers) => {
  const { listener, rawEmitter } = handlers;
  let cont = FsWatchFileInstances.get(fullPath);
  const copts = cont && cont.options;
  if (copts && (copts.persistent < options.persistent || copts.interval > options.interval)) {
    node_fs.unwatchFile(fullPath);
    cont = void 0;
  }
  if (cont) {
    addAndConvert(cont, KEY_LISTENERS, listener);
    addAndConvert(cont, KEY_RAW, rawEmitter);
  } else {
    cont = {
      listeners: listener,
      rawEmitters: rawEmitter,
      options,
      watcher: node_fs.watchFile(fullPath, options, (curr, prev) => {
        foreach(cont.rawEmitters, (rawEmitter2) => {
          rawEmitter2(EV.CHANGE, fullPath, { curr, prev });
        });
        const currmtime = curr.mtimeMs;
        if (curr.size !== prev.size || currmtime > prev.mtimeMs || currmtime === 0) {
          foreach(cont.listeners, (listener2) => listener2(path2, curr));
        }
      })
    };
    FsWatchFileInstances.set(fullPath, cont);
  }
  return () => {
    delFromSet(cont, KEY_LISTENERS, listener);
    delFromSet(cont, KEY_RAW, rawEmitter);
    if (isEmptySet(cont.listeners)) {
      FsWatchFileInstances.delete(fullPath);
      node_fs.unwatchFile(fullPath);
      cont.options = cont.watcher = void 0;
      Object.freeze(cont);
    }
  };
};
class NodeFsHandler {
  fsw;
  _boundHandleError;
  constructor(fsW) {
    this.fsw = fsW;
    this._boundHandleError = (error) => fsW._handleError(error);
  }
  /**
   * Watch file for changes with fs_watchFile or fs_watch.
   * @param path to file or dir
   * @param listener on fs change
   * @returns closer for the watcher instance
   */
  _watchWithNodeFs(path2, listener) {
    const opts = this.fsw.options;
    const directory = sp__namespace.dirname(path2);
    const basename = sp__namespace.basename(path2);
    const parent = this.fsw._getWatchedDir(directory);
    parent.add(basename);
    const absolutePath = sp__namespace.resolve(path2);
    const options = {
      persistent: opts.persistent
    };
    if (!listener)
      listener = EMPTY_FN;
    let closer;
    if (opts.usePolling) {
      const enableBin = opts.interval !== opts.binaryInterval;
      options.interval = enableBin && isBinaryPath(basename) ? opts.binaryInterval : opts.interval;
      closer = setFsWatchFileListener(path2, absolutePath, options, {
        listener,
        rawEmitter: this.fsw._emitRaw
      });
    } else {
      closer = setFsWatchListener(path2, absolutePath, options, {
        listener,
        errHandler: this._boundHandleError,
        rawEmitter: this.fsw._emitRaw
      });
    }
    return closer;
  }
  /**
   * Watch a file and emit add event if warranted.
   * @returns closer for the watcher instance
   */
  _handleFile(file, stats, initialAdd) {
    if (this.fsw.closed) {
      return;
    }
    const dirname = sp__namespace.dirname(file);
    const basename = sp__namespace.basename(file);
    const parent = this.fsw._getWatchedDir(dirname);
    let prevStats = stats;
    if (parent.has(basename))
      return;
    const listener = async (path2, newStats) => {
      if (!this.fsw._throttle(THROTTLE_MODE_WATCH, file, 5))
        return;
      if (!newStats || newStats.mtimeMs === 0) {
        try {
          const newStats2 = await promises.stat(file);
          if (this.fsw.closed)
            return;
          const at = newStats2.atimeMs;
          const mt = newStats2.mtimeMs;
          if (!at || at <= mt || mt !== prevStats.mtimeMs) {
            this.fsw._emit(EV.CHANGE, file, newStats2);
          }
          if ((isMacos || isLinux || isFreeBSD) && prevStats.ino !== newStats2.ino) {
            this.fsw._closeFile(path2);
            prevStats = newStats2;
            const closer2 = this._watchWithNodeFs(file, listener);
            if (closer2)
              this.fsw._addPathCloser(path2, closer2);
          } else {
            prevStats = newStats2;
          }
        } catch (error) {
          this.fsw._remove(dirname, basename);
        }
      } else if (parent.has(basename)) {
        const at = newStats.atimeMs;
        const mt = newStats.mtimeMs;
        if (!at || at <= mt || mt !== prevStats.mtimeMs) {
          this.fsw._emit(EV.CHANGE, file, newStats);
        }
        prevStats = newStats;
      }
    };
    const closer = this._watchWithNodeFs(file, listener);
    if (!(initialAdd && this.fsw.options.ignoreInitial) && this.fsw._isntIgnored(file)) {
      if (!this.fsw._throttle(EV.ADD, file, 0))
        return;
      this.fsw._emit(EV.ADD, file, stats);
    }
    return closer;
  }
  /**
   * Handle symlinks encountered while reading a dir.
   * @param entry returned by readdirp
   * @param directory path of dir being read
   * @param path of this item
   * @param item basename of this item
   * @returns true if no more processing is needed for this entry.
   */
  async _handleSymlink(entry, directory, path2, item) {
    if (this.fsw.closed) {
      return;
    }
    const full = entry.fullPath;
    const dir = this.fsw._getWatchedDir(directory);
    if (!this.fsw.options.followSymlinks) {
      this.fsw._incrReadyCount();
      let linkPath;
      try {
        linkPath = await promises.realpath(path2);
      } catch (e) {
        this.fsw._emitReady();
        return true;
      }
      if (this.fsw.closed)
        return;
      if (dir.has(item)) {
        if (this.fsw._symlinkPaths.get(full) !== linkPath) {
          this.fsw._symlinkPaths.set(full, linkPath);
          this.fsw._emit(EV.CHANGE, path2, entry.stats);
        }
      } else {
        dir.add(item);
        this.fsw._symlinkPaths.set(full, linkPath);
        this.fsw._emit(EV.ADD, path2, entry.stats);
      }
      this.fsw._emitReady();
      return true;
    }
    if (this.fsw._symlinkPaths.has(full)) {
      return true;
    }
    this.fsw._symlinkPaths.set(full, true);
  }
  _handleRead(directory, initialAdd, wh, target, dir, depth, throttler) {
    directory = sp__namespace.join(directory, "");
    const throttleKey = target ? `${directory}:${target}` : directory;
    throttler = this.fsw._throttle("readdir", throttleKey, 1e3);
    if (!throttler)
      return;
    const previous = this.fsw._getWatchedDir(wh.path);
    const current = /* @__PURE__ */ new Set();
    let stream = this.fsw._readdirp(directory, {
      fileFilter: (entry) => wh.filterPath(entry),
      directoryFilter: (entry) => wh.filterDir(entry)
    });
    if (!stream)
      return;
    stream.on(STR_DATA, async (entry) => {
      if (this.fsw.closed) {
        stream = void 0;
        return;
      }
      const item = entry.path;
      let path2 = sp__namespace.join(directory, item);
      current.add(item);
      if (entry.stats.isSymbolicLink() && await this._handleSymlink(entry, directory, path2, item)) {
        return;
      }
      if (this.fsw.closed) {
        stream = void 0;
        return;
      }
      if (item === target || !target && !previous.has(item)) {
        this.fsw._incrReadyCount();
        path2 = sp__namespace.join(dir, sp__namespace.relative(dir, path2));
        this._addToNodeFs(path2, initialAdd, wh, depth + 1);
      }
    }).on(EV.ERROR, this._boundHandleError);
    return new Promise((resolve, reject) => {
      if (!stream)
        return reject();
      stream.once(STR_END, () => {
        if (this.fsw.closed) {
          stream = void 0;
          return;
        }
        const wasThrottled = throttler ? throttler.clear() : false;
        resolve(void 0);
        previous.getChildren().filter((item) => {
          return item !== directory && !current.has(item);
        }).forEach((item) => {
          this.fsw._remove(directory, item);
        });
        stream = void 0;
        if (wasThrottled)
          this._handleRead(directory, false, wh, target, dir, depth, throttler);
      });
    });
  }
  /**
   * Read directory to add / remove files from `@watched` list and re-read it on change.
   * @param dir fs path
   * @param stats
   * @param initialAdd
   * @param depth relative to user-supplied path
   * @param target child path targeted for watch
   * @param wh Common watch helpers for this path
   * @param realpath
   * @returns closer for the watcher instance.
   */
  async _handleDir(dir, stats, initialAdd, depth, target, wh, realpath) {
    const parentDir = this.fsw._getWatchedDir(sp__namespace.dirname(dir));
    const tracked = parentDir.has(sp__namespace.basename(dir));
    if (!(initialAdd && this.fsw.options.ignoreInitial) && !target && !tracked) {
      this.fsw._emit(EV.ADD_DIR, dir, stats);
    }
    parentDir.add(sp__namespace.basename(dir));
    this.fsw._getWatchedDir(dir);
    let throttler;
    let closer;
    const oDepth = this.fsw.options.depth;
    if ((oDepth == null || depth <= oDepth) && !this.fsw._symlinkPaths.has(realpath)) {
      if (!target) {
        await this._handleRead(dir, initialAdd, wh, target, dir, depth, throttler);
        if (this.fsw.closed)
          return;
      }
      closer = this._watchWithNodeFs(dir, (dirPath, stats2) => {
        if (stats2 && stats2.mtimeMs === 0)
          return;
        this._handleRead(dirPath, false, wh, target, dir, depth, throttler);
      });
    }
    return closer;
  }
  /**
   * Handle added file, directory, or glob pattern.
   * Delegates call to _handleFile / _handleDir after checks.
   * @param path to file or ir
   * @param initialAdd was the file added at watch instantiation?
   * @param priorWh depth relative to user-supplied path
   * @param depth Child path actually targeted for watch
   * @param target Child path actually targeted for watch
   */
  async _addToNodeFs(path2, initialAdd, priorWh, depth, target) {
    const ready = this.fsw._emitReady;
    if (this.fsw._isIgnored(path2) || this.fsw.closed) {
      ready();
      return false;
    }
    const wh = this.fsw._getWatchHelpers(path2);
    if (priorWh) {
      wh.filterPath = (entry) => priorWh.filterPath(entry);
      wh.filterDir = (entry) => priorWh.filterDir(entry);
    }
    try {
      const stats = await statMethods[wh.statMethod](wh.watchPath);
      if (this.fsw.closed)
        return;
      if (this.fsw._isIgnored(wh.watchPath, stats)) {
        ready();
        return false;
      }
      const follow = this.fsw.options.followSymlinks;
      let closer;
      if (stats.isDirectory()) {
        const absPath = sp__namespace.resolve(path2);
        const targetPath = follow ? await promises.realpath(path2) : path2;
        if (this.fsw.closed)
          return;
        closer = await this._handleDir(wh.watchPath, stats, initialAdd, depth, target, wh, targetPath);
        if (this.fsw.closed)
          return;
        if (absPath !== targetPath && targetPath !== void 0) {
          this.fsw._symlinkPaths.set(absPath, targetPath);
        }
      } else if (stats.isSymbolicLink()) {
        const targetPath = follow ? await promises.realpath(path2) : path2;
        if (this.fsw.closed)
          return;
        const parent = sp__namespace.dirname(wh.watchPath);
        this.fsw._getWatchedDir(parent).add(wh.watchPath);
        this.fsw._emit(EV.ADD, wh.watchPath, stats);
        closer = await this._handleDir(parent, stats, initialAdd, depth, path2, wh, targetPath);
        if (this.fsw.closed)
          return;
        if (targetPath !== void 0) {
          this.fsw._symlinkPaths.set(sp__namespace.resolve(path2), targetPath);
        }
      } else {
        closer = this._handleFile(wh.watchPath, stats, initialAdd);
      }
      ready();
      if (closer)
        this.fsw._addPathCloser(path2, closer);
      return false;
    } catch (error) {
      if (this.fsw._handleError(error)) {
        ready();
        return path2;
      }
    }
  }
}
/*! chokidar - MIT License (c) 2012 Paul Miller (paulmillr.com) */
const SLASH = "/";
const SLASH_SLASH = "//";
const ONE_DOT = ".";
const TWO_DOTS = "..";
const STRING_TYPE = "string";
const BACK_SLASH_RE = /\\/g;
const DOUBLE_SLASH_RE = /\/\//g;
const DOT_RE = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;
const REPLACER_RE = /^\.[/\\]/;
function arrify(item) {
  return Array.isArray(item) ? item : [item];
}
const isMatcherObject = (matcher) => typeof matcher === "object" && matcher !== null && !(matcher instanceof RegExp);
function createPattern(matcher) {
  if (typeof matcher === "function")
    return matcher;
  if (typeof matcher === "string")
    return (string) => matcher === string;
  if (matcher instanceof RegExp)
    return (string) => matcher.test(string);
  if (typeof matcher === "object" && matcher !== null) {
    return (string) => {
      if (matcher.path === string)
        return true;
      if (matcher.recursive) {
        const relative = sp__namespace.relative(matcher.path, string);
        if (!relative) {
          return false;
        }
        return !relative.startsWith("..") && !sp__namespace.isAbsolute(relative);
      }
      return false;
    };
  }
  return () => false;
}
function normalizePath(path2) {
  if (typeof path2 !== "string")
    throw new Error("string expected");
  path2 = sp__namespace.normalize(path2);
  path2 = path2.replace(/\\/g, "/");
  let prepend = false;
  if (path2.startsWith("//"))
    prepend = true;
  path2 = path2.replace(DOUBLE_SLASH_RE, "/");
  if (prepend)
    path2 = "/" + path2;
  return path2;
}
function matchPatterns(patterns, testString, stats) {
  const path2 = normalizePath(testString);
  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index];
    if (pattern(path2, stats)) {
      return true;
    }
  }
  return false;
}
function anymatch(matchers, testString) {
  if (matchers == null) {
    throw new TypeError("anymatch: specify first argument");
  }
  const matchersArray = arrify(matchers);
  const patterns = matchersArray.map((matcher) => createPattern(matcher));
  {
    return (testString2, stats) => {
      return matchPatterns(patterns, testString2, stats);
    };
  }
}
const unifyPaths = (paths_) => {
  const paths = arrify(paths_).flat();
  if (!paths.every((p) => typeof p === STRING_TYPE)) {
    throw new TypeError(`Non-string provided as watch path: ${paths}`);
  }
  return paths.map(normalizePathToUnix);
};
const toUnix = (string) => {
  let str = string.replace(BACK_SLASH_RE, SLASH);
  let prepend = false;
  if (str.startsWith(SLASH_SLASH)) {
    prepend = true;
  }
  str = str.replace(DOUBLE_SLASH_RE, SLASH);
  if (prepend) {
    str = SLASH + str;
  }
  return str;
};
const normalizePathToUnix = (path2) => toUnix(sp__namespace.normalize(toUnix(path2)));
const normalizeIgnored = (cwd = "") => (path2) => {
  if (typeof path2 === "string") {
    return normalizePathToUnix(sp__namespace.isAbsolute(path2) ? path2 : sp__namespace.join(cwd, path2));
  } else {
    return path2;
  }
};
const getAbsolutePath = (path2, cwd) => {
  if (sp__namespace.isAbsolute(path2)) {
    return path2;
  }
  return sp__namespace.join(cwd, path2);
};
const EMPTY_SET = Object.freeze(/* @__PURE__ */ new Set());
class DirEntry {
  path;
  _removeWatcher;
  items;
  constructor(dir, removeWatcher) {
    this.path = dir;
    this._removeWatcher = removeWatcher;
    this.items = /* @__PURE__ */ new Set();
  }
  add(item) {
    const { items } = this;
    if (!items)
      return;
    if (item !== ONE_DOT && item !== TWO_DOTS)
      items.add(item);
  }
  async remove(item) {
    const { items } = this;
    if (!items)
      return;
    items.delete(item);
    if (items.size > 0)
      return;
    const dir = this.path;
    try {
      await promises.readdir(dir);
    } catch (err) {
      if (this._removeWatcher) {
        this._removeWatcher(sp__namespace.dirname(dir), sp__namespace.basename(dir));
      }
    }
  }
  has(item) {
    const { items } = this;
    if (!items)
      return;
    return items.has(item);
  }
  getChildren() {
    const { items } = this;
    if (!items)
      return [];
    return [...items.values()];
  }
  dispose() {
    this.items.clear();
    this.path = "";
    this._removeWatcher = EMPTY_FN;
    this.items = EMPTY_SET;
    Object.freeze(this);
  }
}
const STAT_METHOD_F = "stat";
const STAT_METHOD_L = "lstat";
class WatchHelper {
  fsw;
  path;
  watchPath;
  fullWatchPath;
  dirParts;
  followSymlinks;
  statMethod;
  constructor(path2, follow, fsw) {
    this.fsw = fsw;
    const watchPath = path2;
    this.path = path2 = path2.replace(REPLACER_RE, "");
    this.watchPath = watchPath;
    this.fullWatchPath = sp__namespace.resolve(watchPath);
    this.dirParts = [];
    this.dirParts.forEach((parts) => {
      if (parts.length > 1)
        parts.pop();
    });
    this.followSymlinks = follow;
    this.statMethod = follow ? STAT_METHOD_F : STAT_METHOD_L;
  }
  entryPath(entry) {
    return sp__namespace.join(this.watchPath, sp__namespace.relative(this.watchPath, entry.fullPath));
  }
  filterPath(entry) {
    const { stats } = entry;
    if (stats && stats.isSymbolicLink())
      return this.filterDir(entry);
    const resolvedPath = this.entryPath(entry);
    return this.fsw._isntIgnored(resolvedPath, stats) && this.fsw._hasReadPermissions(stats);
  }
  filterDir(entry) {
    return this.fsw._isntIgnored(this.entryPath(entry), entry.stats);
  }
}
class FSWatcher extends node_events.EventEmitter {
  closed;
  options;
  _closers;
  _ignoredPaths;
  _throttled;
  _streams;
  _symlinkPaths;
  _watched;
  _pendingWrites;
  _pendingUnlinks;
  _readyCount;
  _emitReady;
  _closePromise;
  _userIgnored;
  _readyEmitted;
  _emitRaw;
  _boundRemove;
  _nodeFsHandler;
  // Not indenting methods for history sake; for now.
  constructor(_opts = {}) {
    super();
    this.closed = false;
    this._closers = /* @__PURE__ */ new Map();
    this._ignoredPaths = /* @__PURE__ */ new Set();
    this._throttled = /* @__PURE__ */ new Map();
    this._streams = /* @__PURE__ */ new Set();
    this._symlinkPaths = /* @__PURE__ */ new Map();
    this._watched = /* @__PURE__ */ new Map();
    this._pendingWrites = /* @__PURE__ */ new Map();
    this._pendingUnlinks = /* @__PURE__ */ new Map();
    this._readyCount = 0;
    this._readyEmitted = false;
    const awf = _opts.awaitWriteFinish;
    const DEF_AWF = { stabilityThreshold: 2e3, pollInterval: 100 };
    const opts = {
      // Defaults
      persistent: true,
      ignoreInitial: false,
      ignorePermissionErrors: false,
      interval: 100,
      binaryInterval: 300,
      followSymlinks: true,
      usePolling: false,
      // useAsync: false,
      atomic: true,
      // NOTE: overwritten later (depends on usePolling)
      ..._opts,
      // Change format
      ignored: _opts.ignored ? arrify(_opts.ignored) : arrify([]),
      awaitWriteFinish: awf === true ? DEF_AWF : typeof awf === "object" ? { ...DEF_AWF, ...awf } : false
    };
    if (isIBMi)
      opts.usePolling = true;
    if (opts.atomic === void 0)
      opts.atomic = !opts.usePolling;
    const envPoll = process.env.CHOKIDAR_USEPOLLING;
    if (envPoll !== void 0) {
      const envLower = envPoll.toLowerCase();
      if (envLower === "false" || envLower === "0")
        opts.usePolling = false;
      else if (envLower === "true" || envLower === "1")
        opts.usePolling = true;
      else
        opts.usePolling = !!envLower;
    }
    const envInterval = process.env.CHOKIDAR_INTERVAL;
    if (envInterval)
      opts.interval = Number.parseInt(envInterval, 10);
    let readyCalls = 0;
    this._emitReady = () => {
      readyCalls++;
      if (readyCalls >= this._readyCount) {
        this._emitReady = EMPTY_FN;
        this._readyEmitted = true;
        process.nextTick(() => this.emit(EVENTS.READY));
      }
    };
    this._emitRaw = (...args) => this.emit(EVENTS.RAW, ...args);
    this._boundRemove = this._remove.bind(this);
    this.options = opts;
    this._nodeFsHandler = new NodeFsHandler(this);
    Object.freeze(opts);
  }
  _addIgnoredPath(matcher) {
    if (isMatcherObject(matcher)) {
      for (const ignored of this._ignoredPaths) {
        if (isMatcherObject(ignored) && ignored.path === matcher.path && ignored.recursive === matcher.recursive) {
          return;
        }
      }
    }
    this._ignoredPaths.add(matcher);
  }
  _removeIgnoredPath(matcher) {
    this._ignoredPaths.delete(matcher);
    if (typeof matcher === "string") {
      for (const ignored of this._ignoredPaths) {
        if (isMatcherObject(ignored) && ignored.path === matcher) {
          this._ignoredPaths.delete(ignored);
        }
      }
    }
  }
  // Public methods
  /**
   * Adds paths to be watched on an existing FSWatcher instance.
   * @param paths_ file or file list. Other arguments are unused
   */
  add(paths_, _origAdd, _internal) {
    const { cwd } = this.options;
    this.closed = false;
    this._closePromise = void 0;
    let paths = unifyPaths(paths_);
    if (cwd) {
      paths = paths.map((path2) => {
        const absPath = getAbsolutePath(path2, cwd);
        return absPath;
      });
    }
    paths.forEach((path2) => {
      this._removeIgnoredPath(path2);
    });
    this._userIgnored = void 0;
    if (!this._readyCount)
      this._readyCount = 0;
    this._readyCount += paths.length;
    Promise.all(paths.map(async (path2) => {
      const res = await this._nodeFsHandler._addToNodeFs(path2, !_internal, void 0, 0, _origAdd);
      if (res)
        this._emitReady();
      return res;
    })).then((results) => {
      if (this.closed)
        return;
      results.forEach((item) => {
        if (item)
          this.add(sp__namespace.dirname(item), sp__namespace.basename(_origAdd || item));
      });
    });
    return this;
  }
  /**
   * Close watchers or start ignoring events from specified paths.
   */
  unwatch(paths_) {
    if (this.closed)
      return this;
    const paths = unifyPaths(paths_);
    const { cwd } = this.options;
    paths.forEach((path2) => {
      if (!sp__namespace.isAbsolute(path2) && !this._closers.has(path2)) {
        if (cwd)
          path2 = sp__namespace.join(cwd, path2);
        path2 = sp__namespace.resolve(path2);
      }
      this._closePath(path2);
      this._addIgnoredPath(path2);
      if (this._watched.has(path2)) {
        this._addIgnoredPath({
          path: path2,
          recursive: true
        });
      }
      this._userIgnored = void 0;
    });
    return this;
  }
  /**
   * Close watchers and remove all listeners from watched paths.
   */
  close() {
    if (this._closePromise) {
      return this._closePromise;
    }
    this.closed = true;
    this.removeAllListeners();
    const closers = [];
    this._closers.forEach((closerList) => closerList.forEach((closer) => {
      const promise = closer();
      if (promise instanceof Promise)
        closers.push(promise);
    }));
    this._streams.forEach((stream) => stream.destroy());
    this._userIgnored = void 0;
    this._readyCount = 0;
    this._readyEmitted = false;
    this._watched.forEach((dirent) => dirent.dispose());
    this._closers.clear();
    this._watched.clear();
    this._streams.clear();
    this._symlinkPaths.clear();
    this._throttled.clear();
    this._closePromise = closers.length ? Promise.all(closers).then(() => void 0) : Promise.resolve();
    return this._closePromise;
  }
  /**
   * Expose list of watched paths
   * @returns for chaining
   */
  getWatched() {
    const watchList = {};
    this._watched.forEach((entry, dir) => {
      const key = this.options.cwd ? sp__namespace.relative(this.options.cwd, dir) : dir;
      const index = key || ONE_DOT;
      watchList[index] = entry.getChildren().sort();
    });
    return watchList;
  }
  emitWithAll(event, args) {
    this.emit(event, ...args);
    if (event !== EVENTS.ERROR)
      this.emit(EVENTS.ALL, event, ...args);
  }
  // Common helpers
  // --------------
  /**
   * Normalize and emit events.
   * Calling _emit DOES NOT MEAN emit() would be called!
   * @param event Type of event
   * @param path File or directory path
   * @param stats arguments to be passed with event
   * @returns the error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  async _emit(event, path2, stats) {
    if (this.closed)
      return;
    const opts = this.options;
    if (isWindows)
      path2 = sp__namespace.normalize(path2);
    if (opts.cwd)
      path2 = sp__namespace.relative(opts.cwd, path2);
    const args = [path2];
    if (stats != null)
      args.push(stats);
    const awf = opts.awaitWriteFinish;
    let pw;
    if (awf && (pw = this._pendingWrites.get(path2))) {
      pw.lastChange = /* @__PURE__ */ new Date();
      return this;
    }
    if (opts.atomic) {
      if (event === EVENTS.UNLINK) {
        this._pendingUnlinks.set(path2, [event, ...args]);
        setTimeout(() => {
          this._pendingUnlinks.forEach((entry, path22) => {
            this.emit(...entry);
            this.emit(EVENTS.ALL, ...entry);
            this._pendingUnlinks.delete(path22);
          });
        }, typeof opts.atomic === "number" ? opts.atomic : 100);
        return this;
      }
      if (event === EVENTS.ADD && this._pendingUnlinks.has(path2)) {
        event = EVENTS.CHANGE;
        this._pendingUnlinks.delete(path2);
      }
    }
    if (awf && (event === EVENTS.ADD || event === EVENTS.CHANGE) && this._readyEmitted) {
      const awfEmit = (err, stats2) => {
        if (err) {
          event = EVENTS.ERROR;
          args[0] = err;
          this.emitWithAll(event, args);
        } else if (stats2) {
          if (args.length > 1) {
            args[1] = stats2;
          } else {
            args.push(stats2);
          }
          this.emitWithAll(event, args);
        }
      };
      this._awaitWriteFinish(path2, awf.stabilityThreshold, event, awfEmit);
      return this;
    }
    if (event === EVENTS.CHANGE) {
      const isThrottled = !this._throttle(EVENTS.CHANGE, path2, 50);
      if (isThrottled)
        return this;
    }
    if (opts.alwaysStat && stats === void 0 && (event === EVENTS.ADD || event === EVENTS.ADD_DIR || event === EVENTS.CHANGE)) {
      const fullPath = opts.cwd ? sp__namespace.join(opts.cwd, path2) : path2;
      let stats2;
      try {
        stats2 = await promises.stat(fullPath);
      } catch (err) {
      }
      if (!stats2 || this.closed)
        return;
      args.push(stats2);
    }
    this.emitWithAll(event, args);
    return this;
  }
  /**
   * Common handler for errors
   * @returns The error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  _handleError(error) {
    const code = error && error.code;
    if (error && code !== "ENOENT" && code !== "ENOTDIR" && (!this.options.ignorePermissionErrors || code !== "EPERM" && code !== "EACCES")) {
      this.emit(EVENTS.ERROR, error);
    }
    return error || this.closed;
  }
  /**
   * Helper utility for throttling
   * @param actionType type being throttled
   * @param path being acted upon
   * @param timeout duration of time to suppress duplicate actions
   * @returns tracking object or false if action should be suppressed
   */
  _throttle(actionType, path2, timeout) {
    if (!this._throttled.has(actionType)) {
      this._throttled.set(actionType, /* @__PURE__ */ new Map());
    }
    const action = this._throttled.get(actionType);
    if (!action)
      throw new Error("invalid throttle");
    const actionPath = action.get(path2);
    if (actionPath) {
      actionPath.count++;
      return false;
    }
    let timeoutObject;
    const clear = () => {
      const item = action.get(path2);
      const count = item ? item.count : 0;
      action.delete(path2);
      clearTimeout(timeoutObject);
      if (item)
        clearTimeout(item.timeoutObject);
      return count;
    };
    timeoutObject = setTimeout(clear, timeout);
    const thr = { timeoutObject, clear, count: 0 };
    action.set(path2, thr);
    return thr;
  }
  _incrReadyCount() {
    return this._readyCount++;
  }
  /**
   * Awaits write operation to finish.
   * Polls a newly created file for size variations. When files size does not change for 'threshold' milliseconds calls callback.
   * @param path being acted upon
   * @param threshold Time in milliseconds a file size must be fixed before acknowledging write OP is finished
   * @param event
   * @param awfEmit Callback to be called when ready for event to be emitted.
   */
  _awaitWriteFinish(path2, threshold, event, awfEmit) {
    const awf = this.options.awaitWriteFinish;
    if (typeof awf !== "object")
      return;
    const pollInterval = awf.pollInterval;
    let timeoutHandler;
    let fullPath = path2;
    if (this.options.cwd && !sp__namespace.isAbsolute(path2)) {
      fullPath = sp__namespace.join(this.options.cwd, path2);
    }
    const now = /* @__PURE__ */ new Date();
    const writes = this._pendingWrites;
    function awaitWriteFinishFn(prevStat) {
      node_fs.stat(fullPath, (err, curStat) => {
        if (err || !writes.has(path2)) {
          if (err && err.code !== "ENOENT")
            awfEmit(err);
          return;
        }
        const now2 = Number(/* @__PURE__ */ new Date());
        if (prevStat && curStat.size !== prevStat.size) {
          writes.get(path2).lastChange = now2;
        }
        const pw = writes.get(path2);
        const df = now2 - pw.lastChange;
        if (df >= threshold) {
          writes.delete(path2);
          awfEmit(void 0, curStat);
        } else {
          timeoutHandler = setTimeout(awaitWriteFinishFn, pollInterval, curStat);
        }
      });
    }
    if (!writes.has(path2)) {
      writes.set(path2, {
        lastChange: now,
        cancelWait: () => {
          writes.delete(path2);
          clearTimeout(timeoutHandler);
          return event;
        }
      });
      timeoutHandler = setTimeout(awaitWriteFinishFn, pollInterval);
    }
  }
  /**
   * Determines whether user has asked to ignore this path.
   */
  _isIgnored(path2, stats) {
    if (this.options.atomic && DOT_RE.test(path2))
      return true;
    if (!this._userIgnored) {
      const { cwd } = this.options;
      const ign = this.options.ignored;
      const ignored = (ign || []).map(normalizeIgnored(cwd));
      const ignoredPaths = [...this._ignoredPaths];
      const list = [...ignoredPaths.map(normalizeIgnored(cwd)), ...ignored];
      this._userIgnored = anymatch(list);
    }
    return this._userIgnored(path2, stats);
  }
  _isntIgnored(path2, stat2) {
    return !this._isIgnored(path2, stat2);
  }
  /**
   * Provides a set of common helpers and properties relating to symlink handling.
   * @param path file or directory pattern being watched
   */
  _getWatchHelpers(path2) {
    return new WatchHelper(path2, this.options.followSymlinks, this);
  }
  // Directory helpers
  // -----------------
  /**
   * Provides directory tracking objects
   * @param directory path of the directory
   */
  _getWatchedDir(directory) {
    const dir = sp__namespace.resolve(directory);
    if (!this._watched.has(dir))
      this._watched.set(dir, new DirEntry(dir, this._boundRemove));
    return this._watched.get(dir);
  }
  // File helpers
  // ------------
  /**
   * Check for read permissions: https://stackoverflow.com/a/11781404/1358405
   */
  _hasReadPermissions(stats) {
    if (this.options.ignorePermissionErrors)
      return true;
    return Boolean(Number(stats.mode) & 256);
  }
  /**
   * Handles emitting unlink events for
   * files and directories, and via recursion, for
   * files and directories within directories that are unlinked
   * @param directory within which the following item is located
   * @param item      base path of item/directory
   */
  _remove(directory, item, isDirectory) {
    const path2 = sp__namespace.join(directory, item);
    const fullPath = sp__namespace.resolve(path2);
    isDirectory = isDirectory != null ? isDirectory : this._watched.has(path2) || this._watched.has(fullPath);
    if (!this._throttle("remove", path2, 100))
      return;
    if (!isDirectory && this._watched.size === 1) {
      this.add(directory, item, true);
    }
    const wp = this._getWatchedDir(path2);
    const nestedDirectoryChildren = wp.getChildren();
    nestedDirectoryChildren.forEach((nested) => this._remove(path2, nested));
    const parent = this._getWatchedDir(directory);
    const wasTracked = parent.has(item);
    parent.remove(item);
    if (this._symlinkPaths.has(fullPath)) {
      this._symlinkPaths.delete(fullPath);
    }
    let relPath = path2;
    if (this.options.cwd)
      relPath = sp__namespace.relative(this.options.cwd, path2);
    if (this.options.awaitWriteFinish && this._pendingWrites.has(relPath)) {
      const event = this._pendingWrites.get(relPath).cancelWait();
      if (event === EVENTS.ADD)
        return;
    }
    this._watched.delete(path2);
    this._watched.delete(fullPath);
    const eventName = isDirectory ? EVENTS.UNLINK_DIR : EVENTS.UNLINK;
    if (wasTracked && !this._isIgnored(path2))
      this._emit(eventName, path2);
    this._closePath(path2);
  }
  /**
   * Closes all watchers for a path
   */
  _closePath(path2) {
    this._closeFile(path2);
    const dir = sp__namespace.dirname(path2);
    this._getWatchedDir(dir).remove(sp__namespace.basename(path2));
  }
  /**
   * Closes only file-specific watchers
   */
  _closeFile(path2) {
    const closers = this._closers.get(path2);
    if (!closers)
      return;
    closers.forEach((closer) => closer());
    this._closers.delete(path2);
  }
  _addPathCloser(path2, closer) {
    if (!closer)
      return;
    let list = this._closers.get(path2);
    if (!list) {
      list = [];
      this._closers.set(path2, list);
    }
    list.push(closer);
  }
  _readdirp(root, opts) {
    if (this.closed)
      return;
    const options = { type: EVENTS.ALL, alwaysStat: true, lstat: true, ...opts, depth: 0 };
    let stream = readdirp(root, options);
    this._streams.add(stream);
    stream.once(STR_CLOSE, () => {
      stream = void 0;
    });
    stream.once(STR_END, () => {
      if (stream) {
        this._streams.delete(stream);
        stream = void 0;
      }
    });
    return stream;
  }
}
function watch(paths, options = {}) {
  const watcher = new FSWatcher(options);
  watcher.add(paths);
  return watcher;
}
const chokidar = { watch, FSWatcher };
const IpcChannel = {
  OpenFolder: "workspace:open-folder",
  // 指定パス（最近開いた一覧・前回フォルダ）を直接開く。
  OpenFolderByPath: "workspace:open-folder-by-path",
  // 最近開いたフォルダの絶対パス一覧を取得する。
  GetRecentFolders: "workspace:get-recent-folders",
  // 最近開いたファイル（現在の project root 内）。relPath 一覧の取得・追加・削除。
  GetRecentFiles: "workspace:get-recent-files",
  AddRecentFile: "workspace:add-recent-file",
  RemoveRecentFile: "workspace:remove-recent-file",
  ReadDir: "workspace:read-dir",
  ReadFile: "workspace:read-file",
  WriteFile: "workspace:write-file",
  // バイナリ/巨大ファイルを OS の既定アプリ（関連付け）で開く。
  OpenPath: "workspace:open-path",
  // ファイル/フォルダをリネームする。
  RenamePath: "workspace:rename-path",
  // ファイル/フォルダをゴミ箱へ移動する（main 側で確認ダイアログを出す）。
  DeletePath: "workspace:delete-path",
  // Finder で項目を表示する（shell.showItemInFolder）。
  RevealPath: "workspace:reveal-path",
  // 項目の絶対パスをクリップボードにコピーする。
  CopyPath: "workspace:copy-path",
  // main → renderer への push。file watcher が検知した変更を通知する。
  FsEvent: "workspace:fs-event",
  // R→M invoke: 現在の project root の Git status（追加/変更/削除）を取得する。
  GitStatus: "workspace:git-status",
  // M→R push: .git（index/HEAD/refs）の変化を検知した。renderer は GitStatus を取り直す。
  GitStatusChanged: "workspace:git-status-changed",
  // 表示メニュー（ネイティブアプリメニュー）と renderer の連携。
  // M→R push: メニューの「表示」でレイアウト切り替えが選ばれた。
  SetWorkLayout: "view:set-work-layout",
  // R→M send: renderer の現在レイアウトを通知し、メニューのチェック状態を同期する。
  WorkLayoutChanged: "view:work-layout-changed",
  // M→R push: 「ファイル」メニューの「フォルダを開く」が選ばれた。
  RequestOpenFolder: "view:request-open-folder",
  // M→R push: 「最近使ったフォルダ」メニューの項目が選ばれた。renderer はそのパスを開く。
  RequestOpenFolderByPath: "view:request-open-folder-by-path",
  // M→R push: アプリメニューの「設定…」が選ばれた。renderer は設定モーダルを開く。
  OpenSettings: "view:open-settings",
  // アプリ設定（設定画面）。userData の app-settings.json に永続化する。
  SettingsGet: "settings:get",
  // R→M invoke: 現在のアプリ設定を取得する
  SettingsSet: "settings:set",
  // R→M invoke: アプリ設定を保存し、正規化後の値を返す
  // タブ（複数プロジェクトの同時オープン）。クロームシェル（タブバー）と main の連携。
  // M→shell push: タブ一覧とアクティブタブの最新状態。
  TabsState: "tabs:state",
  // shell→M send: 現在のタブ状態を要求する（マウント直後の初期同期用）。
  TabsRequestState: "tabs:request-state",
  // shell→M send: 新しいタブ（空）を作成する。
  TabNew: "tabs:new",
  // shell→M send: 指定タブをアクティブにする。
  TabActivate: "tabs:activate",
  // shell→M send: 指定タブを閉じる。
  TabClose: "tabs:close",
  // 統合ターミナル（spec 2.2.4）。1 タブ（webContents）内に複数のターミナルをタブで持てる。
  // PTY は (webContents.id, terminalId) の組で一意に保持する。terminalId は各メッセージに含める。
  TerminalStart: "terminal:start",
  // R→M invoke: cwd(project root) で PTY 起動
  TerminalInput: "terminal:input",
  // R→M send: キー入力を PTY に書き込む
  TerminalResize: "terminal:resize",
  // R→M send: cols/rows 変更
  TerminalDispose: "terminal:dispose",
  // R→M send: PTY 破棄
  TerminalData: "terminal:data",
  // M→R push: PTY 出力
  TerminalExit: "terminal:exit",
  // M→R push: プロセス終了通知
  // R→M send: ターミナルでベル（\x07）が鳴った。main は非アクティブ時に OS 通知を出す。
  // claude CLI が操作待ち（入力・許可待ち）になると鳴らすベルを拾う用途。どのターミナルが
  // 鳴らしたかを id で示し、通知クリック時にそのターミナルへ復帰できるようにする。
  TerminalBell: "terminal:bell",
  // M→R push: ベル通知のクリックで、該当ターミナル（サブタブ）をアクティブにするよう促す。
  TerminalActivate: "terminal:activate",
  // R→M send: そのアプリタブで現在アクティブなターミナル（サブタブ）の id を報告する。
  // main は「今まさに見ているターミナルが鳴ったときだけ」通知を抑制するために使う。
  TerminalActiveChanged: "terminal:active-changed"
};
const MEDIA_SCHEME = "noetelier-img";
const DEFAULT_QUICK_PROMPTS = [
  {
    id: "commit",
    label: "コミット",
    prompt: "変更内容を確認して、適切な粒度でコミットして"
  },
  {
    id: "push",
    label: "プッシュ",
    prompt: "リモート（origin）と同期して。必要なら pull してから push して"
  },
  {
    id: "commit-push",
    label: "コミット&プッシュ",
    prompt: "変更内容を確認して適切な粒度でコミットし、その後 origin と同期（必要なら pull してから push）して"
  }
];
const MAX_RECENT = 10;
let cache$2 = null;
function recentFile$1() {
  return path.join(electron.app.getPath("userData"), "recent-workspaces.json");
}
async function loadRecentFolders() {
  if (cache$2) return cache$2;
  try {
    const raw = await fs.promises.readFile(recentFile$1(), "utf8");
    const parsed = JSON.parse(raw);
    cache$2 = Array.isArray(parsed.recent) ? parsed.recent.filter((p) => typeof p === "string") : [];
  } catch {
    cache$2 = [];
  }
  return cache$2;
}
async function addRecentFolder(root) {
  const list = await loadRecentFolders();
  const next = [root, ...list.filter((p) => p !== root)].slice(0, MAX_RECENT);
  cache$2 = next;
  await persist$1(next);
}
async function removeRecentFolder(root) {
  const list = await loadRecentFolders();
  if (!list.includes(root)) return;
  const next = list.filter((p) => p !== root);
  cache$2 = next;
  await persist$1(next);
}
async function persist$1(recent) {
  try {
    await fs.promises.writeFile(recentFile$1(), JSON.stringify({ recent }, null, 2), "utf8");
  } catch {
  }
}
const MAX_RECENT_FILES = 15;
let cache$1 = null;
function recentFile() {
  return path.join(electron.app.getPath("userData"), "recent-files.json");
}
async function loadAll() {
  if (cache$1) return cache$1;
  try {
    const raw = await fs.promises.readFile(recentFile(), "utf8");
    const parsed = JSON.parse(raw);
    const result = {};
    if (parsed.files && typeof parsed.files === "object") {
      for (const [root, list] of Object.entries(parsed.files)) {
        if (Array.isArray(list)) {
          result[root] = list.filter((p) => typeof p === "string");
        }
      }
    }
    cache$1 = result;
  } catch {
    cache$1 = {};
  }
  return cache$1;
}
async function getRecentFiles(root) {
  const all = await loadAll();
  return all[root] ?? [];
}
async function addRecentFile(root, relPath) {
  const all = await loadAll();
  const list = all[root] ?? [];
  const next = [relPath, ...list.filter((p) => p !== relPath)].slice(0, MAX_RECENT_FILES);
  all[root] = next;
  cache$1 = all;
  await persist(all);
  return next;
}
async function removeRecentFile(root, relPath) {
  const all = await loadAll();
  const list = all[root] ?? [];
  if (!list.includes(relPath)) return list;
  const next = list.filter((p) => p !== relPath);
  all[root] = next;
  cache$1 = all;
  await persist(all);
  return next;
}
async function setRecentFiles(root, relPaths) {
  const all = await loadAll();
  all[root] = relPaths.slice(0, MAX_RECENT_FILES);
  cache$1 = all;
  await persist(all);
  return all[root];
}
async function persist(files) {
  try {
    await fs.promises.writeFile(recentFile(), JSON.stringify({ files }, null, 2), "utf8");
  } catch {
  }
}
const execFileAsync = util.promisify(child_process.execFile);
const stateByWcId = /* @__PURE__ */ new Map();
const GIT_EVENT_DEBOUNCE_MS = 300;
async function runGit(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    // 大規模リポジトリの porcelain 出力に備えてバッファを広めに取る。
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}
function mapStatus(code) {
  if (code === "??") return "added";
  const x = code[0];
  const y = code[1];
  if (x === "D" || y === "D") return "deleted";
  if (x === "A") return "added";
  return "modified";
}
async function computeGitStatus(root) {
  if (root === null) return { isRepo: false, statuses: {} };
  let prefix;
  try {
    prefix = (await runGit(root, ["rev-parse", "--show-prefix"])).trim();
  } catch {
    return { isRepo: false, statuses: {} };
  }
  let out;
  try {
    out = await runGit(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--ignored=no"
    ]);
  } catch {
    return { isRepo: true, statuses: {} };
  }
  const statuses = {};
  for (const entry of out.split("\0")) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const repoRelPath = entry.slice(3);
    let relPath = repoRelPath;
    if (prefix) {
      if (!repoRelPath.startsWith(prefix)) continue;
      relPath = repoRelPath.slice(prefix.length);
    }
    if (!relPath) continue;
    statuses[relPath] = mapStatus(code);
  }
  return { isRepo: true, statuses };
}
function pingGitChanged(wcId) {
  const state = stateByWcId.get(wcId);
  if (!state || state.gitDebounce !== null) return;
  state.gitDebounce = setTimeout(() => {
    const s = stateByWcId.get(wcId);
    if (!s) return;
    s.gitDebounce = null;
    if (!s.gitTarget.isDestroyed()) {
      s.gitTarget.send(IpcChannel.GitStatusChanged);
    }
  }, GIT_EVENT_DEBOUNCE_MS);
}
async function startGitWatching(root, target) {
  const wcId = target.id;
  await stopGitWatching(wcId);
  const state = { gitRoot: root, gitTarget: target, gitWatcher: null, gitDebounce: null };
  stateByWcId.set(wcId, state);
  let gitDir;
  try {
    gitDir = (await runGit(root, ["rev-parse", "--absolute-git-dir"])).trim();
  } catch {
    return;
  }
  if (!gitDir) return;
  if (stateByWcId.get(wcId) !== state) return;
  state.gitWatcher = chokidar.watch(
    [path.join(gitDir, "index"), path.join(gitDir, "HEAD"), path.join(gitDir, "refs")],
    { ignoreInitial: true }
  );
  state.gitWatcher.on("all", () => pingGitChanged(wcId));
}
async function stopGitWatching(wcId) {
  const state = stateByWcId.get(wcId);
  if (!state) return;
  stateByWcId.delete(wcId);
  if (state.gitDebounce !== null) {
    clearTimeout(state.gitDebounce);
    state.gitDebounce = null;
  }
  if (state.gitWatcher) {
    const w = state.gitWatcher;
    state.gitWatcher = null;
    await w.close();
  }
}
function registerGitHandlers() {
  electron.ipcMain.handle(
    IpcChannel.GitStatus,
    (e) => computeGitStatus(stateByWcId.get(e.sender.id)?.gitRoot ?? null)
  );
}
const IGNORED_DIRS = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage"
]);
const MAX_TEXT_FILE_SIZE = 5 * 1024 * 1024;
const FS_EVENT_DEBOUNCE_MS = 150;
const rootByWcId = /* @__PURE__ */ new Map();
const watchByWcId = /* @__PURE__ */ new Map();
const cleanupBound$1 = /* @__PURE__ */ new Set();
let rootChangedCb = null;
function setRootChangedListener(cb) {
  rootChangedCb = cb;
}
let activeRootResolver = null;
function setActiveRootResolver(fn) {
  activeRootResolver = fn;
}
function toRelPath(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join("/");
}
function flushChanges(wcId) {
  const state = watchByWcId.get(wcId);
  if (!state) return;
  state.flushTimer = null;
  if (state.pending.length === 0) return;
  const batch = { changes: state.pending };
  state.pending = [];
  if (!state.target.isDestroyed()) {
    state.target.send(IpcChannel.FsEvent, batch);
  }
}
function enqueueChange(wcId, kind, absPath) {
  const state = watchByWcId.get(wcId);
  if (!state) return;
  state.pending.push({ kind, relPath: toRelPath(state.root, absPath) });
  if (state.flushTimer === null) {
    state.flushTimer = setTimeout(() => flushChanges(wcId), FS_EVENT_DEBOUNCE_MS);
  }
}
async function startWatching(root, target) {
  const wcId = target.id;
  await stopWatching(wcId);
  const state = { root, target, watcher: null, pending: [], flushTimer: null };
  watchByWcId.set(wcId, state);
  state.watcher = chokidar.watch(root, {
    // 初期スキャンの add イベントは不要（ツリーは readDir で取得済み）。
    ignoreInitial: true,
    // ignore 対象ディレクトリはパスセグメント単位で除外する。
    ignored: (p) => p.split(path.sep).some((seg) => IGNORED_DIRS.has(seg)),
    // 保存途中の中間状態を読まないよう、書き込み完了を待ってから通知する。
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  });
  state.watcher.on("add", (p) => enqueueChange(wcId, "add", p)).on("change", (p) => enqueueChange(wcId, "change", p)).on("unlink", (p) => enqueueChange(wcId, "unlink", p)).on("addDir", (p) => enqueueChange(wcId, "addDir", p)).on("unlinkDir", (p) => enqueueChange(wcId, "unlinkDir", p));
  await startGitWatching(root, target);
}
async function stopWatching(wcId) {
  const state = watchByWcId.get(wcId);
  await stopGitWatching(wcId);
  if (!state) return;
  watchByWcId.delete(wcId);
  if (state.flushTimer !== null) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (state.watcher) {
    const w = state.watcher;
    state.watcher = null;
    await w.close();
  }
}
async function cleanupWebContents(wcId) {
  cleanupBound$1.delete(wcId);
  rootByWcId.delete(wcId);
  await stopWatching(wcId);
}
function resolveWithin(root, relPath) {
  const cleaned = path.normalize(relPath).replace(/^[/\\]+/, "");
  const abs = path.normalize(path.join(root, cleaned));
  const rel = path.relative(root, abs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) {
    throw new Error(`project root 外へのアクセスは許可されていません: ${relPath}`);
  }
  return abs;
}
function resolveWithinRoot(wcId, relPath) {
  const root = rootByWcId.get(wcId);
  if (root === void 0) {
    throw new Error("フォルダが開かれていません");
  }
  return resolveWithin(root, relPath);
}
async function openRoot(root, target) {
  try {
    const stat = await fs.promises.stat(root);
    if (!stat.isDirectory()) {
      await removeRecentFolder(root);
      return null;
    }
  } catch {
    await removeRecentFolder(root);
    return null;
  }
  rootByWcId.set(target.id, root);
  await startWatching(root, target);
  await addRecentFolder(root);
  rootChangedCb?.(target.id, root);
  if (!cleanupBound$1.has(target.id)) {
    cleanupBound$1.add(target.id);
    target.once("destroyed", () => {
      void cleanupWebContents(target.id);
    });
  }
  return { root, name: path.basename(root) };
}
async function handleOpenFolder(e) {
  const win2 = electron.BrowserWindow.getFocusedWindow() ?? electron.BrowserWindow.getAllWindows()[0];
  const result = win2 ? await electron.dialog.showOpenDialog(win2, { properties: ["openDirectory"] }) : await electron.dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return openRoot(result.filePaths[0], e.sender);
}
async function handleOpenFolderByPath(e, req) {
  return openRoot(req.path, e.sender);
}
async function handleGetRecentFolders() {
  return loadRecentFolders();
}
async function handleGetRecentFiles(e) {
  const root = getProjectRoot(e.sender.id);
  if (!root) return [];
  const list = await getRecentFiles(root);
  const surviving = [];
  for (const relPath of list) {
    try {
      await fs.promises.stat(path.join(root, relPath));
      surviving.push(relPath);
    } catch {
    }
  }
  if (surviving.length !== list.length) {
    return setRecentFiles(root, surviving);
  }
  return list;
}
async function handleAddRecentFile(e, req) {
  const root = getProjectRoot(e.sender.id);
  if (!root) return [];
  return addRecentFile(root, req.relPath);
}
async function handleRemoveRecentFile(e, req) {
  const root = getProjectRoot(e.sender.id);
  if (!root) return [];
  return removeRecentFile(root, req.relPath);
}
async function handleReadDir(e, req) {
  const absDir = resolveWithinRoot(e.sender.id, req.relPath);
  const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
  const nodes = [];
  for (const entry of entries) {
    const isDirectory = entry.isDirectory();
    if (isDirectory && IGNORED_DIRS.has(entry.name)) continue;
    const childRel = req.relPath ? `${req.relPath}/${entry.name}` : entry.name;
    nodes.push({ relPath: childRel, name: entry.name, isDirectory });
  }
  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}
async function handleReadFile(e, req) {
  const abs = resolveWithinRoot(e.sender.id, req.relPath);
  const stat = await fs.promises.stat(abs);
  if (!stat.isFile()) {
    throw new Error(`ファイルではありません: ${req.relPath}`);
  }
  if (stat.size > MAX_TEXT_FILE_SIZE) {
    return { relPath: req.relPath, content: "", isBinary: true };
  }
  const buf = await fs.promises.readFile(abs);
  if (buf.includes(0)) {
    return { relPath: req.relPath, content: "", isBinary: true };
  }
  return { relPath: req.relPath, content: buf.toString("utf8"), isBinary: false };
}
async function handleWriteFile(e, req) {
  const abs = resolveWithinRoot(e.sender.id, req.relPath);
  try {
    const stat = await fs.promises.stat(abs);
    if (stat.isDirectory()) {
      throw new Error(`ディレクトリには書き込めません: ${req.relPath}`);
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  await fs.promises.writeFile(abs, req.content, "utf8");
  return { relPath: req.relPath };
}
const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ico": "image/x-icon"
};
function getRootForMedia() {
  if (activeRootResolver) return activeRootResolver();
  if (rootByWcId.size === 1) return [...rootByWcId.values()][0];
  return null;
}
async function handleMediaRequest(request) {
  try {
    const url = new URL(request.url);
    const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!relPath) return new Response(null, { status: 404 });
    const root = getRootForMedia();
    if (root === null) return new Response(null, { status: 404 });
    const abs = resolveWithin(root, relPath);
    const mime = IMAGE_MIME[path.extname(abs).toLowerCase()];
    if (!mime) return new Response(null, { status: 415 });
    const stat = await fs.promises.stat(abs);
    if (!stat.isFile()) return new Response(null, { status: 404 });
    const buf = await fs.promises.readFile(abs);
    return new Response(buf, {
      headers: { "content-type": mime, "cache-control": "no-store" }
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
function registerMediaProtocol() {
  electron.protocol.handle(MEDIA_SCHEME, handleMediaRequest);
}
async function handleOpenPath(e, req) {
  const abs = resolveWithinRoot(e.sender.id, req.relPath);
  const stat = await fs.promises.stat(abs);
  if (!stat.isFile()) {
    return `ファイルではありません: ${req.relPath}`;
  }
  return electron.shell.openPath(abs);
}
function parentRelDir(relPath) {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}
async function handleRenamePath(e, req) {
  const newName = req.newName.trim();
  if (!newName || newName.includes("/") || newName.includes("\\")) {
    throw new Error(`不正な名前です: ${req.newName}`);
  }
  const abs = resolveWithinRoot(e.sender.id, req.relPath);
  const parent = parentRelDir(req.relPath);
  const newRel = parent ? `${parent}/${newName}` : newName;
  const newAbs = resolveWithinRoot(e.sender.id, newRel);
  let exists = true;
  try {
    await fs.promises.access(newAbs);
  } catch {
    exists = false;
  }
  if (exists) {
    throw new Error(`同名の項目が既に存在します: ${newName}`);
  }
  await fs.promises.rename(abs, newAbs);
  return { relPath: newRel };
}
async function handleDeletePath(e, req) {
  const abs = resolveWithinRoot(e.sender.id, req.relPath);
  const name = path.basename(abs);
  const win2 = electron.BrowserWindow.fromWebContents(e.sender);
  const options = {
    type: "warning",
    buttons: ["ゴミ箱に移動", "キャンセル"],
    defaultId: 0,
    cancelId: 1,
    message: `「${name}」をゴミ箱に移動しますか？`,
    detail: "ゴミ箱から元に戻せます。"
  };
  const { response } = win2 ? await electron.dialog.showMessageBox(win2, options) : await electron.dialog.showMessageBox(options);
  if (response !== 0) {
    return { deleted: false };
  }
  await electron.shell.trashItem(abs);
  return { deleted: true };
}
async function handleRevealPath(e, req) {
  const abs = resolveWithinRoot(e.sender.id, req.relPath);
  electron.shell.showItemInFolder(abs);
}
async function handleCopyPath(e, req) {
  const abs = resolveWithinRoot(e.sender.id, req.relPath);
  electron.clipboard.writeText(abs);
  return abs;
}
function registerWorkspaceHandlers() {
  electron.ipcMain.handle(IpcChannel.OpenFolder, handleOpenFolder);
  electron.ipcMain.handle(IpcChannel.OpenFolderByPath, handleOpenFolderByPath);
  electron.ipcMain.handle(IpcChannel.GetRecentFolders, handleGetRecentFolders);
  electron.ipcMain.handle(IpcChannel.GetRecentFiles, handleGetRecentFiles);
  electron.ipcMain.handle(IpcChannel.AddRecentFile, handleAddRecentFile);
  electron.ipcMain.handle(IpcChannel.RemoveRecentFile, handleRemoveRecentFile);
  electron.ipcMain.handle(IpcChannel.ReadDir, handleReadDir);
  electron.ipcMain.handle(IpcChannel.ReadFile, handleReadFile);
  electron.ipcMain.handle(IpcChannel.WriteFile, handleWriteFile);
  electron.ipcMain.handle(IpcChannel.OpenPath, handleOpenPath);
  electron.ipcMain.handle(IpcChannel.RenamePath, handleRenamePath);
  electron.ipcMain.handle(IpcChannel.DeletePath, handleDeletePath);
  electron.ipcMain.handle(IpcChannel.RevealPath, handleRevealPath);
  electron.ipcMain.handle(IpcChannel.CopyPath, handleCopyPath);
}
async function disposeWorkspace() {
  await Promise.all([...watchByWcId.keys()].map((wcId) => stopWatching(wcId)));
}
function getProjectRoot(wcId) {
  return rootByWcId.get(wcId) ?? null;
}
const stateByKey = /* @__PURE__ */ new Map();
const cleanupBound = /* @__PURE__ */ new Set();
function keyOf(wcId, id) {
  return `${wcId}:${id}`;
}
function resolveShell() {
  return process.env.SHELL ?? "/bin/zsh";
}
function buildEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== void 0) env[k] = v;
  }
  env.TERM = "xterm-256color";
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
function killTerm(key) {
  const state = stateByKey.get(key);
  if (!state) return;
  stateByKey.delete(key);
  try {
    state.term.kill();
  } catch {
  }
}
function killAllForWc(wcId) {
  const prefix = `${wcId}:`;
  for (const key of [...stateByKey.keys()]) {
    if (key.startsWith(prefix)) killTerm(key);
  }
}
function handleStart(e, req) {
  const sender = e.sender;
  const wcId = sender.id;
  const root = getProjectRoot(wcId);
  if (root === null) {
    return { error: "フォルダが開かれていません" };
  }
  const key = keyOf(wcId, req.id);
  killTerm(key);
  const term = pty__namespace.spawn(resolveShell(), ["-l", "-i"], {
    name: "xterm-256color",
    cols: req.cols,
    rows: req.rows,
    cwd: root,
    env: buildEnv()
  });
  stateByKey.set(key, { term, target: sender });
  term.onData((data) => {
    if (!sender.isDestroyed()) {
      const payload = { id: req.id, data };
      sender.send(IpcChannel.TerminalData, payload);
    }
  });
  term.onExit(({ exitCode }) => {
    if (stateByKey.get(key)?.term !== term) {
      return;
    }
    stateByKey.delete(key);
    const payload = { id: req.id, exitCode };
    if (!sender.isDestroyed()) {
      sender.send(IpcChannel.TerminalExit, payload);
    }
  });
  if (!cleanupBound.has(wcId)) {
    cleanupBound.add(wcId);
    sender.once("destroyed", () => {
      cleanupBound.delete(wcId);
      killAllForWc(wcId);
    });
  }
  return {};
}
function handleInput(e, msg) {
  stateByKey.get(keyOf(e.sender.id, msg.id))?.term.write(msg.data);
}
function handleResize(e, req) {
  const term = stateByKey.get(keyOf(e.sender.id, req.id))?.term;
  if (term && req.cols > 0 && req.rows > 0) {
    term.resize(req.cols, req.rows);
  }
}
function handleDispose(e, req) {
  killTerm(keyOf(e.sender.id, req.id));
}
function registerTerminalHandlers() {
  electron.ipcMain.handle(IpcChannel.TerminalStart, handleStart);
  electron.ipcMain.on(IpcChannel.TerminalInput, handleInput);
  electron.ipcMain.on(IpcChannel.TerminalResize, handleResize);
  electron.ipcMain.on(IpcChannel.TerminalDispose, handleDispose);
}
function disposeTerminal() {
  for (const key of [...stateByKey.keys()]) {
    killTerm(key);
  }
}
let cache = null;
function settingsFile() {
  return path.join(electron.app.getPath("userData"), "app-settings.json");
}
function normalize(parsed) {
  const obj = parsed && typeof parsed === "object" ? parsed : {};
  return {
    quickPrompts: normalizeQuickPrompts(obj.quickPrompts)
  };
}
function normalizeQuickPrompts(value) {
  if (!Array.isArray(value)) return DEFAULT_QUICK_PROMPTS.map((q) => ({ ...q }));
  const result = [];
  value.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") return;
    const e = entry;
    const label = typeof e.label === "string" ? e.label : "";
    const prompt = typeof e.prompt === "string" ? e.prompt : "";
    if (!label.trim() && !prompt.trim()) return;
    const id = typeof e.id === "string" && e.id ? e.id : `qp-${i}`;
    result.push({ id, label, prompt });
  });
  return result;
}
async function loadAppSettings() {
  if (cache) return cache;
  try {
    const raw = await fs.promises.readFile(settingsFile(), "utf8");
    cache = normalize(JSON.parse(raw));
  } catch {
    cache = normalize(null);
  }
  return cache;
}
async function saveAppSettings(settings) {
  const normalized = normalize(settings);
  cache = normalized;
  try {
    await fs.promises.writeFile(settingsFile(), JSON.stringify(normalized, null, 2), "utf8");
  } catch {
  }
  return normalized;
}
function registerAppSettingsHandlers() {
  electron.ipcMain.handle(IpcChannel.SettingsGet, () => loadAppSettings());
  electron.ipcMain.handle(IpcChannel.SettingsSet, (_e, settings) => saveAppSettings(settings));
}
function sessionFile() {
  return path.join(electron.app.getPath("userData"), "tab-session.json");
}
function loadSession() {
  try {
    const raw = fs.readFileSync(sessionFile(), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.roots)) return null;
    const roots = parsed.roots.map((r) => typeof r === "string" ? r : null);
    if (roots.length === 0) return null;
    const activeIndex = typeof parsed.activeIndex === "number" && parsed.activeIndex >= 0 && parsed.activeIndex < roots.length ? parsed.activeIndex : 0;
    return { roots, activeIndex };
  } catch {
    return null;
  }
}
function saveSession(session) {
  fs.writeFile(sessionFile(), JSON.stringify(session, null, 2), "utf8", () => {
  });
}
const STRIP_H = 38;
let win = null;
let tabs = [];
let activeId = null;
let restoring = false;
function persistSession() {
  if (restoring) return;
  const roots = tabs.map((t) => getProjectRoot(t.id));
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === activeId)
  );
  saveSession({ roots, activeIndex });
}
function preloadPath() {
  return path.join(__dirname, "../preload/index.js");
}
function loadRenderer(view, entry, query = {}) {
  const wc = view.webContents;
  const search = new URLSearchParams(query).toString();
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    const base = process.env["ELECTRON_RENDERER_URL"];
    void wc.loadURL(`${base}/${entry}.html${search ? `?${search}` : ""}`);
  } else {
    void wc.loadFile(path.join(__dirname, `../renderer/${entry}.html`), search ? { search } : void 0);
  }
}
function notifyShell() {
  if (!win || win.isDestroyed()) return;
  const state = {
    tabs: tabs.map((t) => ({ id: t.id, title: t.title })),
    activeId
  };
  win.webContents.send(IpcChannel.TabsState, state);
}
function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  for (const tab of tabs) {
    const isActive = tab.id === activeId;
    tab.view.setVisible(isActive);
    if (isActive) {
      tab.view.setBounds({ x: 0, y: STRIP_H, width: w, height: Math.max(0, h - STRIP_H) });
    }
  }
}
function activateTab(id) {
  if (activeId === id) return;
  if (!tabs.some((t) => t.id === id)) return;
  activeId = id;
  layout();
  const tab = tabs.find((t) => t.id === id);
  if (tab && !tab.view.webContents.isDestroyed()) {
    tab.view.webContents.focus();
  }
  syncMenuChecks(id);
  notifyShell();
  persistSession();
}
function createTab(opts = {}) {
  if (!win) throw new Error("メインウィンドウが未作成です");
  const view = new electron.WebContentsView({
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  view.webContents.setWindowOpenHandler((details) => {
    void electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, url) => {
    if (/^https?:\/\//i.test(url)) {
      event.preventDefault();
      void electron.shell.openExternal(url);
    }
  });
  const tab = { id: view.webContents.id, view, title: "新規タブ" };
  tabs.push(tab);
  win.contentView.addChildView(view);
  const query = {};
  if (opts.root) query.root = opts.root;
  else if (opts.restore) query.restore = "1";
  loadRenderer(view, "index", query);
  activateTab(tab.id);
  notifyShell();
  return tab;
}
function closeTab(id) {
  if (tabs.length <= 1) return;
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1 || !win) return;
  const [tab] = tabs.splice(idx, 1);
  if (activeId === id) {
    const next = tabs[idx] ?? tabs[idx - 1];
    activeId = next ? next.id : null;
  }
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  forgetTabMenuState(id);
  activeTerminalByWc.delete(id);
  for (const key of [...lastBellAt.keys()]) {
    if (key.startsWith(`${id}:`)) lastBellAt.delete(key);
  }
  if (activeId !== null) syncMenuChecks(activeId);
  layout();
  notifyShell();
  persistSession();
}
const BELL_THROTTLE_MS = 2e3;
const lastBellAt = /* @__PURE__ */ new Map();
const activeTerminalByWc = /* @__PURE__ */ new Map();
function handleTerminalBell(wcId, terminalId, num) {
  if (!win || win.isDestroyed()) return;
  const tab = tabs.find((t) => t.id === wcId);
  if (!tab) return;
  const viewingThisTerminal = win.isFocused() && activeId === wcId && activeTerminalByWc.get(wcId) === terminalId;
  if (viewingThisTerminal) return;
  const key = `${wcId}:${terminalId}`;
  const now = Date.now();
  const prev = lastBellAt.get(key) ?? 0;
  if (now - prev < BELL_THROTTLE_MS) return;
  lastBellAt.set(key, now);
  if (!electron.Notification.isSupported()) return;
  const notification = new electron.Notification({
    title: tab.title,
    body: `ターミナル ${num} が操作待ちです`,
    silent: false
  });
  notification.on("click", () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (process.platform === "darwin") electron.app.focus({ steal: true });
    activateTab(wcId);
    const target = tabs.find((t) => t.id === wcId);
    if (target && !target.view.webContents.isDestroyed()) {
      const payload = { id: terminalId };
      target.view.webContents.send(IpcChannel.TerminalActivate, payload);
    }
  });
  notification.show();
}
function getActiveTabRoot() {
  if (activeId === null) return null;
  return getProjectRoot(activeId);
}
function getActiveTabWebContents() {
  const tab = tabs.find((t) => t.id === activeId);
  return tab && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
}
function newTab() {
  if (win) createTab();
}
function closeActiveTabOrWindow() {
  if (tabs.length > 1) {
    if (activeId !== null) closeTab(activeId);
  } else {
    win?.close();
  }
}
function activateTabByIndex(index) {
  const tab = tabs[index];
  if (tab) activateTab(tab.id);
}
function activateLastTab() {
  const tab = tabs[tabs.length - 1];
  if (tab) activateTab(tab.id);
}
function activateRelativeTab(delta) {
  if (tabs.length === 0 || activeId === null) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  if (i === -1) return;
  const n = ((i + delta) % tabs.length + tabs.length) % tabs.length;
  activateTab(tabs[n].id);
}
function createMainWindow() {
  win = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    // 信号機ボタンを、クロームシェルのタブストリップ（高さ STRIP_H）の中に収める。
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.on("ready-to-show", () => win?.show());
  win.on("resize", layout);
  loadRenderer(win, "shell");
  setRootChangedListener((wcId, root) => {
    const tab = tabs.find((t) => t.id === wcId);
    if (!tab) return;
    tab.title = root ? path.basename(root) : "新規タブ";
    notifyShell();
    persistSession();
    if (root) void refreshRecentMenu();
  });
  win.webContents.once("did-finish-load", () => {
    if (tabs.length === 0) restoreSession();
  });
}
function restoreSession() {
  const saved = loadSession();
  restoring = true;
  if (saved && saved.roots.length > 0) {
    for (const root of saved.roots) createTab(root ? { root } : {});
  } else {
    createTab({ restore: true });
  }
  const target = saved && tabs[saved.activeIndex] || tabs[tabs.length - 1];
  if (target && target.id !== activeId) activateTab(target.id);
  restoring = false;
}
function registerTabHandlers() {
  electron.ipcMain.on(IpcChannel.TabsRequestState, () => notifyShell());
  electron.ipcMain.on(IpcChannel.TabNew, () => createTab());
  electron.ipcMain.on(IpcChannel.TabActivate, (_e, id) => activateTab(id));
  electron.ipcMain.on(IpcChannel.TabClose, (_e, id) => closeTab(id));
  electron.ipcMain.on(
    IpcChannel.TerminalBell,
    (e, msg) => handleTerminalBell(e.sender.id, msg.id, msg.num)
  );
  electron.ipcMain.on(
    IpcChannel.TerminalActiveChanged,
    (e, msg) => activeTerminalByWc.set(e.sender.id, msg.id)
  );
}
const RECENT_MENU_LIMIT = 5;
let recentFolders = [];
let currentLayout = "horizontal";
const layoutByWc = /* @__PURE__ */ new Map();
function applyLayoutCheck(layout2) {
  currentLayout = layout2;
  const item = electron.Menu.getApplicationMenu()?.getMenuItemById(
    layout2 === "vertical" ? "layout-vertical" : "layout-horizontal"
  );
  if (item) item.checked = true;
}
function syncMenuChecks(wcId) {
  applyLayoutCheck(layoutByWc.get(wcId) ?? "horizontal");
}
function forgetTabMenuState(wcId) {
  layoutByWc.delete(wcId);
}
function requestLayout(layout2) {
  currentLayout = layout2;
  getActiveTabWebContents()?.send(IpcChannel.SetWorkLayout, layout2);
}
function requestOpenFolder() {
  getActiveTabWebContents()?.send(IpcChannel.RequestOpenFolder);
}
function requestOpenFolderByPath(path2) {
  getActiveTabWebContents()?.send(IpcChannel.RequestOpenFolderByPath, path2);
}
function abbreviatePath(p) {
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}
function buildRecentSubmenu() {
  const items = recentFolders.slice(0, RECENT_MENU_LIMIT);
  if (items.length === 0) {
    return [{ label: "（履歴なし）", enabled: false }];
  }
  return items.map((path2) => ({
    label: abbreviatePath(path2),
    click: () => requestOpenFolderByPath(path2)
  }));
}
function openSettings() {
  getActiveTabWebContents()?.send(IpcChannel.OpenSettings);
}
async function refreshRecentMenu() {
  recentFolders = await loadRecentFolders();
  buildAppMenu();
}
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    // macOS のアプリメニュー（Noetelier について / 設定… / 終了 など）。
    // 「設定…」（⌘,）を挟むため role:'appMenu' を使わず手組みする。
    ...isMac ? [
      {
        label: electron.app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "設定…",
            accelerator: "CmdOrCtrl+,",
            click: () => openSettings()
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" }
        ]
      }
    ] : [],
    {
      label: "ファイル",
      submenu: [
        {
          label: "新しいタブ",
          accelerator: "CmdOrCtrl+T",
          click: () => newTab()
        },
        {
          label: "フォルダを開く",
          accelerator: "CmdOrCtrl+O",
          click: () => requestOpenFolder()
        },
        {
          label: "最近使ったフォルダ",
          submenu: buildRecentSubmenu()
        },
        { type: "separator" },
        {
          // 最後の 1 枚のときはウィンドウを閉じる（= アプリ終了相当）。
          label: "タブを閉じる",
          accelerator: "CmdOrCtrl+W",
          click: () => closeActiveTabOrWindow()
        },
        // 非 Mac ではアプリメニューが無いため、設定と終了をファイルメニューに置く。
        ...!isMac ? [
          { type: "separator" },
          { label: "設定…", accelerator: "CmdOrCtrl+,", click: () => openSettings() },
          { type: "separator" },
          { role: "quit" }
        ] : []
      ]
    },
    { role: "editMenu" },
    {
      label: "表示",
      submenu: [
        {
          id: "layout-horizontal",
          label: "エディタとターミナルを左右に並べる",
          type: "radio",
          checked: currentLayout === "horizontal",
          click: () => requestLayout("horizontal")
        },
        {
          id: "layout-vertical",
          label: "エディタとターミナルを上下に並べる",
          type: "radio",
          checked: currentLayout === "vertical",
          click: () => requestLayout("vertical")
        },
        { type: "separator" },
        { role: "reload" },
        {
          // 各タブは WebContentsView でメインウィンドウ内に置かれるため、既定の
          // toggleDevTools（ドッキング表示）だと UI に重なって見えない。
          // アクティブタブの DevTools を必ず別ウィンドウ（detach）で開閉する。
          label: "デベロッパーツール",
          accelerator: process.platform === "darwin" ? "Alt+Cmd+I" : "Ctrl+Shift+I",
          click: () => {
            const wc = getActiveTabWebContents();
            if (!wc) return;
            if (wc.isDevToolsOpened()) wc.closeDevTools();
            else wc.openDevTools({ mode: "detach" });
          }
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "タブ",
      submenu: [
        {
          label: "次のタブ",
          accelerator: "Control+Tab",
          click: () => activateRelativeTab(1)
        },
        {
          label: "前のタブ",
          accelerator: "Control+Shift+Tab",
          click: () => activateRelativeTab(-1)
        },
        { type: "separator" },
        // ⌘1..⌘8 で位置指定、⌘9 で最後のタブ（ブラウザ慣習）。
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `タブ ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => i === 8 ? activateLastTab() : activateTabByIndex(i)
        }))
      ]
    },
    { role: "windowMenu" }
  ];
  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
function registerMenuHandlers() {
  electron.ipcMain.on(IpcChannel.WorkLayoutChanged, (e, layout2) => {
    layoutByWc.set(e.sender.id, layout2);
    if (getActiveTabWebContents()?.id === e.sender.id) applyLayoutCheck(layout2);
  });
}
const APP_GIT_HASH = "14b46cf";
const APP_BUILD_DATE = "2026-07-03T20:54:08.614Z";
function formatBuildDate(iso = APP_BUILD_DATE) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function buildDetail() {
  return `${APP_GIT_HASH} · ${formatBuildDate()}`;
}
if (process.env["ELECTRON_RENDERER_URL"]) {
  electron.app.setPath("userData", `${electron.app.getPath("userData")}-dev`);
}
electron.protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
]);
electron.app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.nomura.noetelier");
  electron.app.setAboutPanelOptions({
    applicationName: "Noetelier",
    applicationVersion: electron.app.getVersion(),
    version: buildDetail(),
    copyright: `git ${APP_GIT_HASH}`
  });
  if (process.env["ELECTRON_RENDERER_URL"] && process.platform === "darwin" && electron.app.dock) {
    const devIconPath = path.join(electron.app.getAppPath(), "design/app-icon/master-1024.png");
    if (fs.existsSync(devIconPath)) {
      electron.app.dock.setIcon(devIconPath);
    }
  }
  electron.app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });
  registerWorkspaceHandlers();
  setActiveRootResolver(getActiveTabRoot);
  registerMediaProtocol();
  registerTerminalHandlers();
  registerGitHandlers();
  registerAppSettingsHandlers();
  registerTabHandlers();
  registerMenuHandlers();
  buildAppMenu();
  void refreshRecentMenu();
  createMainWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
electron.app.on("will-quit", () => {
  void disposeWorkspace();
  disposeTerminal();
});
