var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// scripts/lib/pm2-codec-builtins.mjs
var pm2_codec_builtins_exports = {};
__export(pm2_codec_builtins_exports, {
  Writable: () => Writable,
  format: () => format
});
import { format } from "node:util";
import { Writable } from "node:stream";
var init_pm2_codec_builtins = __esm({
  "scripts/lib/pm2-codec-builtins.mjs"() {
    "use strict";
  }
});

// scripts/vendor/pm2-codec/amp/lib/encode.js
var require_encode = __commonJS({
  "scripts/vendor/pm2-codec/amp/lib/encode.js"(exports, module) {
    "use strict";
    var version = 1;
    module.exports = function(args) {
      var argc = args.length;
      var len = 1;
      var off = 0;
      for (var i = 0; i < argc; i++) {
        len += 4 + args[i].length;
      }
      var buf = new Buffer(len);
      buf[off++] = version << 4 | argc;
      for (var i = 0; i < argc; i++) {
        var arg = args[i];
        buf.writeUInt32BE(arg.length, off);
        off += 4;
        arg.copy(buf, off);
        off += arg.length;
      }
      return buf;
    };
  }
});

// scripts/vendor/pm2-codec/amp/lib/stream.js
var require_stream = __commonJS({
  "scripts/vendor/pm2-codec/amp/lib/stream.js"(exports, module) {
    "use strict";
    var Stream = (init_pm2_codec_builtins(), __toCommonJS(pm2_codec_builtins_exports)).Writable;
    var encode = require_encode();
    module.exports = Parser;
    function Parser(opts) {
      Stream.call(this, opts);
      this.state = "message";
      this._lenbuf = new Buffer(4);
    }
    Parser.prototype.__proto__ = Stream.prototype;
    Parser.prototype._write = function(chunk, encoding, fn) {
      for (var i = 0; i < chunk.length; i++) {
        switch (this.state) {
          case "message":
            var meta = chunk[i];
            this.version = meta >> 4;
            this.argv = meta & 15;
            this.state = "arglen";
            this._bufs = [new Buffer([meta])];
            this._nargs = 0;
            this._leni = 0;
            break;
          case "arglen":
            this._lenbuf[this._leni++] = chunk[i];
            if (4 == this._leni) {
              this._arglen = this._lenbuf.readUInt32BE(0);
              var buf = new Buffer(4);
              buf[0] = this._lenbuf[0];
              buf[1] = this._lenbuf[1];
              buf[2] = this._lenbuf[2];
              buf[3] = this._lenbuf[3];
              this._bufs.push(buf);
              this._argcur = 0;
              this.state = "arg";
            }
            break;
          case "arg":
            var rem = this._arglen - this._argcur;
            var pos = Math.min(rem + i, chunk.length);
            var part = chunk.slice(i, pos);
            this._bufs.push(part);
            this._argcur += pos - i;
            var done = this._argcur == this._arglen;
            i = pos - 1;
            if (done) this._nargs++;
            if (this._nargs == this.argv) {
              this.state = "message";
              this.emit("data", Buffer.concat(this._bufs));
              break;
            }
            if (done) {
              this.state = "arglen";
              this._leni = 0;
            }
            break;
        }
      }
      fn();
    };
  }
});

// scripts/vendor/pm2-codec/amp/lib/decode.js
var require_decode = __commonJS({
  "scripts/vendor/pm2-codec/amp/lib/decode.js"(exports, module) {
    "use strict";
    module.exports = function(buf) {
      var off = 0;
      var meta = buf[off++];
      var version = meta >> 4;
      var argv = meta & 15;
      var args = new Array(argv);
      for (var i = 0; i < argv; i++) {
        var len = buf.readUInt32BE(off);
        off += 4;
        var arg = buf.slice(off, off += len);
        args[i] = arg;
      }
      return args;
    };
  }
});

// scripts/vendor/pm2-codec/amp/index.js
var require_amp = __commonJS({
  "scripts/vendor/pm2-codec/amp/index.js"(exports) {
    "use strict";
    exports.Stream = require_stream();
    exports.encode = require_encode();
    exports.decode = require_decode();
  }
});

// scripts/vendor/pm2-codec/amp-message/index.js
var require_amp_message = __commonJS({
  "scripts/vendor/pm2-codec/amp-message/index.js"(exports, module) {
    "use strict";
    var fmt = (init_pm2_codec_builtins(), __toCommonJS(pm2_codec_builtins_exports)).format;
    var amp = require_amp();
    var methods = [
      "push",
      "pop",
      "shift",
      "unshift"
    ];
    module.exports = Message2;
    function Message2(args) {
      if (Buffer.isBuffer(args)) args = decode(args);
      this.args = args || [];
    }
    methods.forEach(function(method) {
      Message2.prototype[method] = function() {
        return this.args[method].apply(this.args, arguments);
      };
    });
    Message2.prototype.inspect = function() {
      return fmt(
        "<Message args=%d size=%d>",
        this.args.length,
        this.toBuffer().length
      );
    };
    Message2.prototype.toBuffer = function() {
      return encode(this.args);
    };
    function decode(msg) {
      var args = amp.decode(msg);
      for (var i = 0; i < args.length; i++) {
        args[i] = unpack(args[i]);
      }
      return args;
    }
    function encode(args) {
      var tmp = new Array(args.length);
      for (var i = 0; i < args.length; i++) {
        tmp[i] = pack(args[i]);
      }
      return amp.encode(tmp);
    }
    function pack(arg) {
      if (Buffer.isBuffer(arg)) return arg;
      if ("string" == typeof arg) return new Buffer("s:" + arg);
      if (arg === void 0) arg = null;
      return new Buffer("j:" + JSON.stringify(arg));
    }
    function unpack(arg) {
      if (isJSON(arg)) return JSON.parse(arg.slice(2));
      if (isString(arg)) return arg.slice(2).toString();
      return arg;
    }
    function isString(arg) {
      return 115 == arg[0] && 58 == arg[1];
    }
    function isJSON(arg) {
      return 106 == arg[0] && 58 == arg[1];
    }
  }
});

// scripts/oid-control-capsule.source.mjs
import { createHash as createHash9, randomBytes as randomBytes4 } from "node:crypto";
import { spawn as spawn2, spawnSync as spawnSync4 } from "node:child_process";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync as lstatSync2,
  openSync,
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  realpathSync as realpathSync3,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path12 from "node:path";
import * as fs13 from "node:fs";
import { hostname } from "node:os";
import { getBuiltinModule } from "node:process";

// scripts/lib/local-update-policy.mjs
import fs2 from "node:fs";
import { createHash as createHash2, randomUUID } from "node:crypto";

// scripts/git-control-root.mjs
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
var SAFE_CONTROL_NAME = /^nassaj-[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
function commonGitDir(root) {
  const repository = realpathSync(path.resolve(root));
  const gitEntry = path.join(repository, ".git");
  const entry = lstatSync(gitEntry);
  if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) {
    throw new Error("git_control_entry_unsafe");
  }
  const result = spawnSync("git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ], { cwd: repository, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error("git_control_common_dir_unresolved");
  const reported = String(result.stdout || "").trim();
  if (!path.isAbsolute(reported)) throw new Error("git_control_common_dir_not_absolute");
  const metadata2 = lstatSync(reported);
  if (!metadata2.isDirectory() || metadata2.isSymbolicLink()) throw new Error("git_control_common_dir_unsafe");
  const resolved = realpathSync(reported);
  if (resolved !== path.resolve(reported)) throw new Error("git_control_common_dir_redirected");
  return resolved;
}
function gitControlPath(root, name) {
  if (!SAFE_CONTROL_NAME.test(name) || name.includes("..")) throw new Error("git_control_filename_unsafe");
  const directory = commonGitDir(root);
  const file = path.join(directory, name);
  if (path.dirname(file) !== directory) throw new Error("git_control_path_escapes_common_dir");
  return file;
}

// scripts/lib/client-publication-policy.mjs
import fs from "node:fs";
import path2 from "node:path";
var CLIENT_PUBLICATION_POLICY = "nassaj-client-publication-policy-v1.json";
var fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
function readPublicationControlJson(file, uid = process.getuid()) {
  if (!path2.isAbsolute(file) || path2.resolve(file) !== file) fail("client_publication_control_path");
  fs.lstatSync(file);
  const descriptors = [];
  let directory = "/";
  let privateAncestor = false;
  try {
    const parts = file.slice(1).split("/");
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      const fd = fs.openSync(path2.join(directory, part), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (last ? 0 : fs.constants.O_DIRECTORY));
      descriptors.push(fd);
      const stat = fs.fstatSync(fd);
      if (!privateAncestor && (stat.mode & 18) !== 0 || ![0, uid].includes(stat.uid)) fail("client_publication_control_permissions");
      if (!last && stat.uid === uid && (stat.mode & 63) === 0) privateAncestor = true;
      if (last) {
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 511) !== 384 || stat.size > 1024 * 1024) fail("client_publication_control_file");
        return JSON.parse(fs.readFileSync(fd, "utf8"));
      }
      directory = `/proc/self/fd/${fd}`;
    }
  } finally {
    for (const fd of descriptors.reverse()) fs.closeSync(fd);
  }
}
function clientPublicationPolicyEnabled(root) {
  let value;
  try {
    value = readPublicationControlJson(gitControlPath(root, CLIENT_PUBLICATION_POLICY));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (value.schema !== "nassaj-client-publication-policy/v1" || !["button-only", "dev-client-auto"].includes(value.mode)) fail("client_publication_policy_invalid");
  return value.mode === "dev-client-auto";
}

// scripts/lib/oid-triple-target.mjs
import { createHash } from "node:crypto";
var HASH = /^[a-f0-9]{64}$/;
var OID = /^[a-f0-9]{40}$/;
var SCHEMA = "nassaj-oid-triple-target/v2";
var HASH_FIELDS = [
  "clientBuildId",
  "serverBuildId",
  "clientTreeSha256",
  "serverTreeSha256",
  "nodeModulesTreeSha256",
  "dependencyContractSha256",
  "packageJsonSha256",
  "packageLockSha256",
  "installPolicySha256",
  "controlManifestSha256"
];
var RUNTIME_FIELDS = ["nodeBinarySha256", "nodeVersion", "nodeModuleAbi", "napi", "platform", "arch", "npmVersion", "npmCliSha256"];
var fail2 = () => {
  throw Object.assign(new Error("local_update_invalid_triple_target"), { code: "local_update_invalid_triple_target" });
};
var exactKeys = (value, keys2) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys2].sort().join(",");
function canonicalTripleJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalTripleJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalTripleJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function validateOidTripleTargetDescriptor(target) {
  if (!exactKeys(target, ["schema", "generationNames", ...HASH_FIELDS, "installRuntime"]) || target.schema !== SCHEMA || JSON.stringify(target.generationNames) !== '["nodeModules","server","client"]' || HASH_FIELDS.some((key) => !HASH.test(target[key] || "")) || !exactKeys(target.installRuntime, RUNTIME_FIELDS)) fail2();
  const runtime = target.installRuntime;
  if (!HASH.test(runtime.nodeBinarySha256 || "") || !HASH.test(runtime.npmCliSha256 || "") || !/^v\d+\.\d+\.\d+$/.test(runtime.nodeVersion || "") || !/^\d+\.\d+\.\d+$/.test(runtime.npmVersion || "") || !/^\d+$/.test(runtime.nodeModuleAbi || "") || typeof runtime.nodeModuleAbi !== "string" || !/^\d+$/.test(runtime.napi || "") || typeof runtime.napi !== "string" || !/^[a-z0-9_]{1,32}$/.test(runtime.platform || "") || !/^[a-z0-9_]{1,32}$/.test(runtime.arch || "")) fail2();
  return target;
}
function computeOidTripleTargetDigest({ sequence, group, sourceOid, target }) {
  validateOidTripleTargetDescriptor(target);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !OID.test(sourceOid || "") || group !== `event-${String(sequence).padStart(16, "0")}`) fail2();
  return createHash("sha256").update(canonicalTripleJson({
    schema: "nassaj-oid-triple-consent/v2",
    sequence,
    group,
    sourceOid,
    target
  })).digest("hex");
}

// scripts/lib/local-update-policy.mjs
var LOCAL_UPDATE_POLICY_FILE = "nassaj-local-update-policy-v1.json";
var HASH2 = /^[a-f0-9]{64}$/;
var fail3 = (code) => {
  throw Object.assign(new Error(code), { code });
};
var digest = (value) => createHash2("sha256").update(canonicalTripleJson(value)).digest("hex");
function localUpdatePolicyInstallation(root) {
  const scope = {
    canonicalProjectRoot: fs2.realpathSync(root),
    canonicalGitCommonDir: commonGitDir(root),
    serviceUid: process.getuid(),
    serviceIdentity: "nassaj-local-main"
  };
  return { ...scope, installationId: digest(scope) };
}
function receiptName(key) {
  return `nassaj-local-update-policy-receipt-${key}.json`;
}
function readControl(root, name) {
  try {
    return readPublicationControlJson(gitControlPath(root, name));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function checkScope(root, record) {
  const expected = localUpdatePolicyInstallation(root);
  for (const [key, value] of Object.entries(expected)) {
    if (record?.[key] !== value) fail3("local_update_policy_installation_mismatch");
  }
}
function readLocalUpdatePolicy(root) {
  const policy = readControl(root, LOCAL_UPDATE_POLICY_FILE);
  if (!policy) return {
    schema: "nassaj-local-update-policy/v1",
    mode: "disabled",
    revision: 0,
    ...localUpdatePolicyInstallation(root)
  };
  if (policy.schema !== "nassaj-local-update-policy/v1" || !["disabled", "dev-full-auto"].includes(policy.mode) || !Number.isSafeInteger(policy.revision) || policy.revision < 1 || !Number.isSafeInteger(policy.ownerId) || policy.ownerId < 1 || !HASH2.test(policy.receiptKey || "") || !HASH2.test(policy.receiptDigest || "")) fail3("local_update_policy_invalid");
  checkScope(root, policy);
  const receipt = readControl(root, receiptName(policy.receiptKey));
  const { receiptKey: _key, receiptDigest: _digest, ...policyBody } = policy;
  if (!receipt || receipt.schema !== "nassaj-local-update-policy-receipt/v1" || digest(receipt) !== policy.receiptDigest || canonicalTripleJson(receipt.policy) !== canonicalTripleJson(policyBody)) {
    fail3("local_update_policy_receipt_invalid");
  }
  return policy;
}
function assertLocalUpdatePolicy(root, expected = {}) {
  const policy = readLocalUpdatePolicy(root);
  if (policy.mode !== "dev-full-auto") fail3("local_update_policy_disabled");
  if (clientPublicationPolicyEnabled(root)) fail3("local_update_policy_client_conflict");
  for (const [key, value] of Object.entries(expected)) {
    if (policy[key] !== value) fail3("local_update_policy_changed");
  }
  return policy;
}
function inspectLocalUpdatePolicyGrant(root, state, now = Date.now()) {
  const grant = state?.policyAuthorization;
  if (state?.consent || grant?.schema !== "nassaj-local-update-policy-authorization/v1") fail3("local_update_policy_grant_invalid");
  const { grantDigest, ...body } = grant;
  if (!HASH2.test(grantDigest || "") || digest(body) !== grantDigest || grant.sequence !== state.sequence || grant.targetDigest !== state.targetDigest || !Number.isSafeInteger(grant.issuedAt) || !Number.isSafeInteger(grant.expiresAt) || grant.issuedAt > now || grant.expiresAt <= now || grant.expiresAt - grant.issuedAt !== 864e5) fail3("local_update_policy_grant_invalid");
  const policy = assertLocalUpdatePolicy(root, {
    revision: grant.policyRevision,
    receiptDigest: grant.receiptDigest,
    ownerId: Number(grant.ownerId),
    installationId: grant.installationId
  });
  if (digest(policy) !== grant.policyDigest || state.prepare?.origin?.kind !== "policy" || state.prepare.origin.policyRevision !== policy.revision || state.prepare.origin.receiptDigest !== policy.receiptDigest || state.prepare.ownerId !== grant.ownerId) fail3("local_update_policy_grant_invalid");
  return {
    kind: "policy",
    ownerId: grant.ownerId,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    targetDigest: grant.targetDigest,
    grantId: grant.grantId,
    grantDigest,
    policyRevision: grant.policyRevision,
    receiptDigest: grant.receiptDigest,
    policyDigest: grant.policyDigest
  };
}

// scripts/lib/dependency-tree-identity-v2.mjs
import fs3 from "node:fs";
import path3 from "node:path";
import { createHash as createHash3 } from "node:crypto";
var sha256 = (bytes) => createHash3("sha256").update(bytes).digest("hex");
var reject = (code) => {
  throw Object.assign(new Error(code), { code });
};
var inside = (root, target) => target === root || target.startsWith(`${root}${path3.sep}`);
var relative = (root, target) => path3.relative(root, target).split(path3.sep).join("/") || ".";
function metadata(file, sealed, generationRoot = null, expectedOwnerUid = process.getuid?.()) {
  const stat = fs3.lstatSync(file);
  if (stat.mode & 3072) reject("dependency_tree_privileged_mode");
  if (sealed && file === generationRoot) {
    if ((stat.mode & 511) !== 448 || stat.uid !== expectedOwnerUid) reject("dependency_tree_root_owner_mode");
  } else if (!stat.isSymbolicLink() && sealed && stat.mode & 146) reject("dependency_tree_writable");
  return stat;
}
var stableFields = ["dev", "ino", "nlink", "size", "mode", "ctimeMs", "mtimeMs"];
var sameMetadata = (left, right) => stableFields.every((key) => left[key] === right[key]);
var inodeKey = (stat) => `${stat.dev}:${stat.ino}`;
function verifyInventory(entries) {
  const groups = /* @__PURE__ */ new Map();
  for (const { file, stat } of entries) {
    if (!sameMetadata(stat, fs3.lstatSync(file))) reject("dependency_tree_changed");
    if (!stat.isFile()) continue;
    const key = inodeKey(stat), group = groups.get(key) || [];
    group.push({ file, stat });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const { stat } = group[0];
    if (!Number.isSafeInteger(stat.nlink) || stat.nlink < 1 || group.length !== stat.nlink || new Set(group.map((entry) => entry.file)).size !== stat.nlink || group.some((entry) => !sameMetadata(stat, entry.stat))) reject("dependency_tree_shared_hardlink");
  }
}
function fileRecord(file, stat, name) {
  const fd = fs3.openSync(file, fs3.constants.O_RDONLY | fs3.constants.O_NOFOLLOW | fs3.constants.O_NONBLOCK);
  try {
    const before = fs3.fstatSync(fd);
    if (!before.isFile() || !sameMetadata(before, stat)) reject("dependency_tree_changed");
    const hash3 = sha256(fs3.readFileSync(fd)), after = fs3.fstatSync(fd);
    if (!sameMetadata(before, after) || !sameMetadata(after, fs3.lstatSync(file))) reject("dependency_tree_changed");
    return [name, "file", after.mode & 511, after.size, hash3];
  } finally {
    fs3.closeSync(fd);
  }
}
function linkRecord(root, file, stat, name) {
  const text = fs3.readlinkSync(file);
  if (path3.isAbsolute(text)) reject("dependency_tree_absolute_link");
  if (!inside(root, path3.resolve(path3.dirname(file), text))) reject("dependency_tree_link_escape");
  let target;
  try {
    target = fs3.realpathSync(file);
  } catch {
    reject("dependency_tree_unresolved_link");
  }
  if (!inside(root, target)) reject("dependency_tree_link_escape");
  return [name, "link", stat.mode & 511, text, relative(root, target)];
}
function inventoryTree(directory, { requireSealed = false, expectedOwnerUid = process.getuid?.() } = {}) {
  const root = path3.resolve(directory), rootStat = metadata(root, requireSealed, root, expectedOwnerUid);
  if (!rootStat.isDirectory() || fs3.realpathSync(root) !== root) reject("dependency_tree_invalid_root");
  const records = [], entries = [], counts = { files: 0, directories: 0, links: 0, nativeFiles: 0 };
  function walk(file) {
    const stat = metadata(file, requireSealed, root, expectedOwnerUid), name = relative(root, file);
    entries.push({ file, stat });
    if (stat.isDirectory()) {
      counts.directories += 1;
      records.push([name, "directory", stat.mode & 511]);
      for (const child of fs3.readdirSync(file).sort()) walk(path3.join(file, child));
    } else if (stat.isFile()) {
      counts.files += 1;
      if (name.endsWith(".node")) counts.nativeFiles += 1;
      records.push(fileRecord(file, stat, name));
    } else if (stat.isSymbolicLink()) {
      counts.links += 1;
      records.push(linkRecord(root, file, stat, name));
    } else reject("dependency_tree_special_file");
  }
  walk(root);
  verifyInventory(entries);
  return { entries, identity: { schema: "nassaj-dependency-tree/v2", sha256: sha256(JSON.stringify(records)), ...counts } };
}
function hashDependencyTreeV2(directory, options = {}) {
  return inventoryTree(directory, options).identity;
}

// scripts/lib/pm2-service-owner.mjs
var import_amp_message = __toESM(require_amp_message(), 1);
import fs6 from "node:fs";
import path5 from "node:path";
import { createHash as createHash5, randomBytes as randomBytes2 } from "node:crypto";

// scripts/lib/pm2-existing-transport.mjs
import fs5 from "node:fs";
import path4 from "node:path";
import net from "node:net";
import { createHash as createHash4, randomBytes } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

// scripts/lib/release-runtime-forward-child-protocol.mjs
import fs4 from "node:fs";
var canonicalForwardValue = (value) => Array.isArray(value) ? `[${value.map(canonicalForwardValue).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalForwardValue(value[key])}`).join(",")}}` : JSON.stringify(value);
function inspectForwardChildIdentity(pid, read = (file) => fs4.readFileSync(file, "utf8")) {
  const bootId = read("/proc/sys/kernel/random/boot_id").trim();
  const before = read(`/proc/${pid}/stat`);
  const status = read(`/proc/${pid}/status`);
  const fields = before.slice(before.lastIndexOf(")") + 2).trim().split(" ");
  const after = read(`/proc/${pid}/stat`);
  const second = after.slice(after.lastIndexOf(")") + 2).trim().split(" ");
  if (fields[19] !== second[19] || fields[1] !== second[1] || bootId !== read("/proc/sys/kernel/random/boot_id").trim() || ["Z", "X"].includes(second[0])) throw Error("forward_child_process_changed");
  const numeric = (name) => {
    const match = new RegExp(`^${name}:[ 	]*(.*)$`, "m").exec(status);
    if (!match) throw Error("forward_child_credentials_missing");
    return match[1].trim() ? match[1].trim().split(/\s+/).map(Number) : [];
  };
  const caps = ["CapEff", "CapPrm", "CapAmb"].map((name) => {
    const value = new RegExp(`^${name}:\\s+([a-f0-9]+)$`, "mi").exec(status)?.[1];
    if (!value) throw Error("forward_child_capabilities_missing");
    return value;
  });
  return {
    pid,
    parentPid: Number(fields[1]),
    startTicks: fields[19],
    bootId,
    uids: numeric("Uid"),
    gids: numeric("Gid"),
    supplementaryGids: numeric("Groups").sort((a, b) => a - b),
    capabilities: caps
  };
}

// scripts/lib/pm2-existing-transport.mjs
var CAP = 1024 * 1024;
var HEX = /^[a-f0-9]{64}$/;
var DECIMAL = /^(0|[1-9][0-9]*)$/;
var hash = (value) => createHash4("sha256").update(value).digest("hex");
function unknown(reason) {
  return Error(`pm2_observation_unknown:${reason}`);
}
function check(ok, reason) {
  if (!ok) throw unknown(reason);
}
function remaining(deadline) {
  const value = Math.floor(deadline - performance.now());
  check(value > 0, "deadline");
  return value;
}
function pinPm2RuntimeFile(file, expected, ownerUid, deadline, cap = CAP, allowEmpty = false) {
  remaining(deadline);
  check(path4.isAbsolute(file) && fs5.realpathSync(file) === file, "pin_path");
  for (let parent = path4.dirname(file); ; parent = path4.dirname(parent)) {
    const stat = fs5.lstatSync(parent);
    check(stat.isDirectory() && !stat.isSymbolicLink() && [0, ownerUid].includes(stat.uid) && !(stat.mode & 18), "pin_ancestor");
    if (parent === path4.dirname(parent)) break;
  }
  const before = fs5.lstatSync(file);
  check(before.isFile() && before.uid === ownerUid && !(before.mode & 18) && (before.size > 0 || allowEmpty) && before.size <= cap && HEX.test(expected || ""), "pin_metadata");
  const fd = fs5.openSync(file, fs5.constants.O_RDONLY | fs5.constants.O_NOFOLLOW);
  try {
    const opened = fs5.fstatSync(fd);
    check(["dev", "ino", "mode", "uid", "size"].every((key) => before[key] === opened[key]), "pin_race");
    const bytes = fs5.readFileSync(fd);
    check(hash(bytes) === expected, "pin_digest");
    remaining(deadline);
    return bytes;
  } finally {
    fs5.closeSync(fd);
  }
}
function validatedPm2FrameLength(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length <= CAP, "frame_limit");
  if (!bytes.length) return null;
  check(bytes[0] === 18, "frame_header");
  let offset = 1;
  for (let argument = 0; argument < 2; argument++) {
    if (bytes.length < offset + 4) return null;
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    check(length > 0 && length <= CAP - offset, "frame_length");
    offset += length;
    if (bytes.length < offset) return null;
  }
  check(bytes.length === offset, "extra_frame");
  return offset;
}
function socketInode(pid, fd) {
  const value = fs5.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[([0-9]+)\]$/);
  check(value, "socket_fd");
  return value[1];
}
function processSockets(pid) {
  return fs5.readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
    try {
      const value = fs5.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[([0-9]+)\]$/);
      return value ? [value[1]] : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  });
}
function kernelSnapshot(settings, deadline) {
  remaining(deadline);
  const expected = settings.daemon;
  const identity2 = settings.socketIdentity;
  const daemon = inspectForwardChildIdentity(expected.pid);
  check(daemon.startTicks === expected.startTicks && daemon.bootId === expected.bootId && daemon.uids.every((uid) => uid === expected.uid), "daemon_identity");
  check(hash(fs5.readFileSync(`/proc/${daemon.pid}/exe`)) === expected.exeSha256, "daemon_executable");
  const info = fs5.lstatSync(settings.socketPath, { bigint: true });
  check(info.isSocket() && !info.isSymbolicLink() && fs5.realpathSync(settings.socketPath) === settings.socketPath && String(info.dev) === identity2.device && String(info.ino) === identity2.inode && Number(info.uid) === identity2.uid, "socket_identity");
  const namespace = fs5.readlinkSync(`/proc/${daemon.pid}/ns/net`);
  check(namespace === identity2.networkNamespace && fs5.readlinkSync("/proc/self/ns/net") === namespace, "socket_namespace");
  const listeners = fs5.readFileSync(`/proc/${daemon.pid}/net/unix`, "utf8").split("\n").slice(1).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length === 8 && parts[7] === settings.socketPath && parts[3] === "00010000" && parts[4] === "0001");
  check(listeners.length === 1 && listeners[0][6] === identity2.listenerInode && processSockets(daemon.pid).includes(identity2.listenerInode), "listener_owner");
  const again = inspectForwardChildIdentity(expected.pid);
  check(again.startTicks === daemon.startTicks && again.bootId === daemon.bootId && again.uids.every((uid) => uid === expected.uid), "daemon_changed");
  remaining(deadline);
  return { daemon: expected, socket: identity2 };
}
function verifyPm2ConnectedPeer(output, clientInode, daemonSockets) {
  check(typeof output === "string" && Buffer.byteLength(output) <= CAP && DECIMAL.test(clientInode), "peer_output");
  const rows = output.split("\n").flatMap((line) => {
    const match = line.match(/^u_str\s+ESTAB\s+\d+\s+\d+\s+\S+\s+(\d+)\s+\S+\s+(\d+)(?:\s+.*)?$/);
    return match ? [{ local: match[1], peer: match[2] }] : [];
  });
  const local = rows.filter((row) => row.local === clientInode);
  check(local.length === 1 && local[0].peer !== "0" && daemonSockets.includes(local[0].peer), "peer_unproven");
  const peer = rows.filter((row) => row.local === local[0].peer);
  check(peer.length === 1 && peer[0].peer === clientInode, "peer_ambiguous");
  return local[0].peer;
}
var PYTHON_PATH = "/usr/bin/python3.13";
var PYTHON_STDLIB = "/usr/lib/python3.13";
var PYTHON_ENV = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
var PYTHON_IMPORTS = "import json,socket,struct,os,sys\n";
var PYTHON_MAPS = 'sorted({line.split(maxsplit=5)[5].strip() for line in open("/proc/self/maps") if len(line.split(maxsplit=5))==6 and line.split(maxsplit=5)[5].startswith("/")})';
var PEER_CREDENTIAL_PROBE = PYTHON_IMPORTS + `s=socket.socket(fileno=3)
try:
 if s.family != socket.AF_UNIX or s.getsockopt(socket.SOL_SOCKET,socket.SO_TYPE) != socket.SOCK_STREAM: raise ValueError("socket_type")
 pid,uid,gid=struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
 print(json.dumps({"pid":pid,"uid":uid,"gid":gid,"inode":os.readlink("/proc/self/fd/3"),"maps":${PYTHON_MAPS},"searchPath":sys.path}))
finally:
 s.close()
`;
function rootRuntimeFile(file, deadline) {
  remaining(deadline);
  const real = fs5.realpathSync(file), before = fs5.lstatSync(real);
  check(before.isFile() && before.uid === 0 && !(before.mode & 18) && before.size <= 128 * CAP, "python_runtime_file");
  const bytes = fs5.readFileSync(real);
  const sha2562 = hash(bytes);
  pinPm2RuntimeFile(real, sha2562, 0, deadline, 128 * CAP, true);
  return { path: file, realpath: real, sha256: sha2562 };
}
function pythonStandardLibraryDigest(deadline) {
  const entries = [];
  function visit(directory) {
    remaining(deadline);
    const st = fs5.lstatSync(directory);
    check(st.isDirectory() && st.uid === 0 && !(st.mode & 18), "python_runtime_directory");
    for (const name of fs5.readdirSync(directory).sort()) {
      const file = path4.join(directory, name), stat = fs5.lstatSync(file);
      check(stat.uid === 0 && (stat.isSymbolicLink() || !(stat.mode & 18)), "python_runtime_metadata");
      if (stat.isDirectory()) {
        entries.push({ path: file, type: "directory" });
        visit(file);
      } else if (stat.isSymbolicLink()) entries.push({
        path: file,
        type: "link",
        target: fs5.readlinkSync(file),
        resolved: fs5.existsSync(file) ? rootRuntimeFile(file, deadline) : null
      });
      else entries.push(rootRuntimeFile(file, deadline));
    }
  }
  visit(PYTHON_STDLIB);
  return hash(canonicalForwardValue(entries));
}
function pythonRuntimeInventory(maps, searchPath, deadline) {
  check(canonicalForwardValue(searchPath) === canonicalForwardValue([
    "/usr/lib/python313.zip",
    PYTHON_STDLIB,
    path4.join(PYTHON_STDLIB, "lib-dynload")
  ]), "python_search_path");
  check(Array.isArray(maps) && maps.length > 1 && maps.length <= 64 && maps.includes(PYTHON_PATH) && maps.some((file) => /\/ld-linux[^/]*\.so(?:\.[0-9]+)*$/.test(file)), "python_runtime_maps");
  for (const file of ["/usr/lib/python313.zip", "/etc/ld.so.preload"]) {
    try {
      fs5.lstatSync(file);
      throw unknown("python_runtime_unexpected_search");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const files2 = [.../* @__PURE__ */ new Set([...maps, "/etc/ld.so.cache"])].sort().map((file) => {
    check(typeof file === "string" && path4.isAbsolute(file) && !file.includes(".."), "python_runtime_path");
    return rootRuntimeFile(file, deadline);
  });
  return {
    schema: "nassaj-pm2-python-runtime/v1",
    maps,
    searchPath,
    files: files2,
    stdlibSha256: pythonStandardLibraryDigest(deadline),
    probeSha256: hash(PEER_CREDENTIAL_PROBE)
  };
}
function capturePm2PeerCredentialReader() {
  const deadline = performance.now() + 5e3;
  const interpreter = rootRuntimeFile(PYTHON_PATH, deadline);
  const source = PYTHON_IMPORTS + `print(json.dumps({"maps":${PYTHON_MAPS},"searchPath":sys.path}))`;
  const value = JSON.parse(execFileSync(PYTHON_PATH, ["-I", "-S", "-B", "-c", source], {
    env: PYTHON_ENV,
    encoding: "utf8",
    timeout: remaining(deadline),
    maxBuffer: 4096
  }));
  return {
    path: PYTHON_PATH,
    sha256: interpreter.sha256,
    runtime: pythonRuntimeInventory(value.maps, value.searchPath, deadline)
  };
}
function verifyPythonRuntime(reader, deadline) {
  check(reader?.path === PYTHON_PATH && reader.runtime?.schema === "nassaj-pm2-python-runtime/v1", "peer_credentials_reader");
  pinPm2RuntimeFile(reader.path, reader.sha256, 0, deadline, 32 * CAP);
  const current = pythonRuntimeInventory(reader.runtime.maps, reader.runtime.searchPath, deadline);
  check(canonicalForwardValue(current) === canonicalForwardValue(reader.runtime), "python_runtime_changed");
}
function credentialProbe(reader, fd, deadline) {
  return new Promise((resolve, reject2) => {
    const timeout = remaining(deadline);
    const child = spawn(reader.path, ["-I", "-S", "-B", "-c", PEER_CREDENTIAL_PROBE], {
      stdio: ["ignore", "pipe", "ignore", fd],
      env: PYTHON_ENV
    });
    let output = Buffer.alloc(0), failure = null;
    const fail7 = (reason) => {
      failure ||= unknown(reason);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail7("peer_credentials_deadline"), timeout);
    child.once("error", () => {
      failure ||= unknown("peer_credentials_unavailable");
    });
    child.stdout.on("data", (bytes) => {
      if (failure) return;
      if (output.length + bytes.length > 1024) return fail7("peer_credentials_output");
      output = Buffer.concat([output, bytes]);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) return reject2(failure || unknown("peer_credentials_failed"));
      try {
        resolve(JSON.parse(output.toString("utf8")));
      } catch {
        reject2(unknown("peer_credentials_output"));
      }
    });
  });
}
async function verifyPinnedPm2PeerCredentials(settings, socket, deadline) {
  const reader = settings.peerCredentialReader;
  verifyPythonRuntime(reader, deadline);
  const fd = socket._handle?.fd;
  check(Number.isInteger(fd) && fd >= 0 && !socket.destroyed, "connection_closed");
  const inode = socketInode(process.pid, fd);
  const before = inspectForwardChildIdentity(settings.daemon.pid);
  check(before.startTicks === settings.daemon.startTicks && before.bootId === settings.daemon.bootId && before.uids.every((uid) => uid === settings.daemon.uid), "peer_credentials_identity");
  const value = await credentialProbe(reader, fd, deadline);
  check(!socket.destroyed && socket._handle?.fd === fd && socketInode(process.pid, fd) === inode, "connection_changed");
  check(value.pid === settings.daemon.pid && value.uid === settings.daemon.uid && before.gids.every((gid) => gid === value.gid) && value.inode === `socket:[${inode}]`, "peer_credentials_mismatch");
  const after = inspectForwardChildIdentity(settings.daemon.pid);
  check(canonicalForwardValue(after) === canonicalForwardValue(before), "peer_credentials_changed");
  check(canonicalForwardValue(value.maps) === canonicalForwardValue(reader.runtime.maps) && canonicalForwardValue(value.searchPath) === canonicalForwardValue(reader.runtime.searchPath), "python_runtime_changed");
  verifyPythonRuntime(reader, deadline);
  remaining(deadline);
  return Object.freeze({ pid: value.pid, uid: value.uid, gid: value.gid, inode });
}
async function peerProof(settings, socket, deadline) {
  const binary = settings.ss;
  check(binary?.path === "/usr/bin/ss", "peer_reader");
  pinPm2RuntimeFile(binary.path, binary.sha256, 0, deadline, 16 * CAP);
  const fd = socket._handle?.fd;
  check(Number.isInteger(fd) && fd >= 0 && !socket.destroyed, "connection_closed");
  const inode = socketInode(process.pid, fd);
  const output = await new Promise((resolve, reject2) => execFile(binary.path, ["-xnpH"], {
    encoding: "utf8",
    timeout: remaining(deadline),
    maxBuffer: CAP,
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LC_ALL: "C" }
  }, (error, stdout) => error ? reject2(unknown("peer_reader_failed")) : resolve(stdout)));
  check(!socket.destroyed && socketInode(process.pid, fd) === inode, "connection_changed");
  verifyPm2ConnectedPeer(output, inode, processSockets(settings.daemon.pid));
  remaining(deadline);
}
function boundedText(value, key, max = 4096) {
  check(typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value), key);
  return value;
}
function projection(entries) {
  check(Array.isArray(entries), "reply_array");
  const identifiers = /* @__PURE__ */ new Set();
  return entries.map((entry) => {
    const env = entry?.pm2_env;
    check(env && Number.isSafeInteger(entry.pm_id) && entry.pm_id >= 0 && !identifiers.has(entry.pm_id) && Number.isSafeInteger(entry.pid) && entry.pid >= 0 && typeof env.autorestart === "boolean" && typeof env.watch === "boolean", "entry_invalid");
    identifiers.add(entry.pm_id);
    const value = {
      pmId: entry.pm_id,
      name: boundedText(entry.name ?? env.name, "entry_name", 256),
      namespace: boundedText(env.namespace, "entry_namespace", 256),
      pid: entry.pid,
      status: boundedText(env.status, "entry_status", 64),
      execPath: boundedText(env.pm_exec_path, "entry_path"),
      cwd: boundedText(env.pm_cwd, "entry_cwd"),
      interpreter: boundedText(env.exec_interpreter, "entry_interpreter"),
      execMode: boundedText(env.exec_mode, "entry_mode", 64),
      autorestart: env.autorestart,
      watch: env.watch
    };
    return Object.freeze({ ...value, entrySha256: hash(canonicalForwardValue(value)) });
  }).sort((a, b) => a.pmId - b.pmId);
}
async function runExistingPm2Observation(settings, deps = {}, mutation = null) {
  const deadline = deps.deadline ?? performance.now() + 5e3;
  let socket;
  let timer;
  try {
    check(path4.isAbsolute(settings.socketPath || "") && settings.socketPath.length < 104 && !/\s/.test(settings.socketPath), "socket_path");
    const Message2 = deps.Message;
    check(typeof Message2 === "function", "codec_missing");
    const inspect = deps.kernelSnapshot || kernelSnapshot;
    const peer = deps.peerProof || peerProof;
    const credentials = deps.peerCredentials || verifyPinnedPm2PeerCredentials;
    const before = inspect(settings, deadline);
    const requestId = randomBytes(16).toString("hex");
    return await new Promise((resolve, reject2) => {
      let bytes = Buffer.alloc(0);
      let processing = false;
      let failed = false;
      const fail7 = (error) => {
        failed = true;
        socket?.destroy();
        reject2(error);
      };
      timer = setTimeout(() => fail7(unknown("deadline")), remaining(deadline));
      socket = net.createConnection({ path: settings.socketPath });
      socket.on("error", () => fail7(unknown("connection_error")));
      socket.on("end", () => fail7(unknown("connection_closed")));
      socket.on("connect", async () => {
        try {
          await credentials(settings, socket, deadline);
          check(!failed && !socket.destroyed, "connection_closed");
          check(canonicalForwardValue(inspect(settings, deadline)) === canonicalForwardValue(before), "kernel_changed");
          remaining(deadline);
          socket.write(new Message2([{ type: "call", method: "getMonitorData", args: [{}] }, requestId]).toBuffer());
        } catch (error) {
          fail7(error);
        }
      });
      socket.on("data", async (chunk) => {
        try {
          check(bytes.length + chunk.length <= CAP, "frame_limit");
          bytes = Buffer.concat([bytes, chunk]);
          if (validatedPm2FrameLength(bytes) === null || processing) return;
          processing = true;
          const decoded = new Message2(bytes).args;
          check(Array.isArray(decoded) && decoded.length === 2 && decoded[1] === requestId, "reply_id");
          check(decoded[0] && Object.keys(decoded[0]).join(",") === "args" && Array.isArray(decoded[0].args) && decoded[0].args.length === 1, "rpc_error");
          const entries = projection(decoded[0].args[0]);
          await credentials(settings, socket, deadline);
          await peer(settings, socket, deadline, deps.ownerUid ?? 0);
          check(canonicalForwardValue(inspect(settings, deadline)) === canonicalForwardValue(before), "kernel_changed");
          await new Promise((resolve2) => setImmediate(resolve2));
          check(!failed && !socket.destroyed, "connection_closed");
          remaining(deadline);
          validatedPm2FrameLength(bytes);
          const observed = Object.freeze({
            state: "observed",
            ...before,
            entries: Object.freeze(entries),
            observationSha256: hash(canonicalForwardValue({ ...before, entries }))
          });
          if (!mutation) return resolve(observed);
          socket.removeAllListeners("data");
          const unexpectedData = () => fail7(unknown("unexpected_frame"));
          socket.on("data", unexpectedData);
          const result = await mutation({ unexpectedData, raw: decoded[0].args[0], observed, socket, Message: Message2, deadline, inspect, peer: async (...args) => {
            await credentials(args[0], args[1], args[2]);
            return peer(...args);
          } });
          check(!failed, "connection_closed");
          resolve(result);
        } catch (error) {
          fail7(error);
        }
      });
    });
  } catch (error) {
    if (/^pm2_observation_unknown:[a-z_]+$/.test(error?.message || "")) throw error;
    throw unknown("unavailable");
  } finally {
    clearTimeout(timer);
    socket?.destroy();
  }
}
function sendPinnedPm2TypedFrame(socket, Message2, plan, deadline) {
  return new Promise((resolve, reject2) => {
    let bytes = Buffer.alloc(0);
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", read);
      socket.off("error", failed);
      socket.off("end", failed);
      error ? reject2(error) : resolve(value);
    };
    const failed = () => finish(unknown("mutation_effect_unknown"));
    const timer = setTimeout(failed, remaining(deadline));
    const read = (chunk) => {
      try {
        check(bytes.length + chunk.length <= CAP, "frame_limit");
        bytes = Buffer.concat([bytes, chunk]);
        if (validatedPm2FrameLength(bytes) === null) return;
        const decoded = new Message2(bytes).args;
        check(Array.isArray(decoded) && decoded.length === 2 && decoded[1] === plan.intent.requestId, "reply_id");
        check(decoded[0] && Object.keys(decoded[0]).join(",") === "args" && Array.isArray(decoded[0].args) && decoded[0].args.length === 1, "rpc_error");
        const result = decoded[0].args[0];
        check(result && typeof result === "object" && !result.error, "mutation_result");
        setImmediate(() => {
          try {
            validatedPm2FrameLength(bytes);
            finish(null, result);
          } catch {
            failed();
          }
        });
      } catch {
        failed();
      }
    };
    socket.on("data", read);
    socket.once("error", failed);
    socket.once("end", failed);
    try {
      socket.write(new Message2([{ type: "call", method: plan.method, args: [plan.payload] }, plan.intent.requestId]).toBuffer());
    } catch {
      failed();
    }
  });
}

// scripts/lib/pm2-service-owner.mjs
var hash2 = (value) => createHash5("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalForwardValue(value)).digest("hex");
var fail4 = (reason) => {
  throw new Error(`pm2_service_owner_${reason}`);
};
var check2 = (value, reason) => {
  if (!value) fail4(reason);
};
var TELEMETRY = /* @__PURE__ */ new Set([
  "pm_id",
  "status",
  "pm_uptime",
  "restart_time",
  "unstable_restarts",
  "created_at",
  "exit_code",
  "node_version",
  "axm_actions",
  "axm_monitor",
  "versioning",
  "vizion_running"
]);
var CHANGING_ENV = /* @__PURE__ */ new Set(["NASSAJ_UPDATE_MODE", "NASSAJ_PREVIEW_TRANSACTION_NONCE", "NASSAJ_PREVIEW_BOOT_NONCE"]);
function captureServiceOwnerObserver(pm2Home, runtime) {
  check2(path5.isAbsolute(pm2Home) && fs6.realpathSync(pm2Home) === pm2Home, "home");
  const pid = Number(fs6.readFileSync(path5.join(pm2Home, "pm2.pid"), "utf8").trim());
  const daemon = inspectForwardChildIdentity(pid);
  check2(daemon.uids.every((uid) => uid === process.getuid()) && process.getuid() > 0, "uid");
  const command = fs6.readFileSync(`/proc/${pid}/cmdline`).toString().replaceAll("\0", " ").trim();
  check2(/^PM2 v[0-9.]+: God Daemon /.test(command) && command.endsWith(`(${pm2Home})`), "daemon");
  if (runtime) {
    const app = inspectForwardChildIdentity(runtime.pid);
    check2(app.parentPid === pid && app.startTicks === runtime.startTicks && app.bootId === daemon.bootId, "parent");
  }
  const socketPath = path5.join(pm2Home, "rpc.sock"), stat = fs6.lstatSync(socketPath, { bigint: true });
  check2(stat.isSocket() && Number(stat.uid) === process.getuid() && fs6.realpathSync(socketPath) === socketPath, "socket");
  const rows = fs6.readFileSync(`/proc/${pid}/net/unix`, "utf8").split("\n").map((line) => line.trim().split(/\s+/)).filter((row) => row.length === 8 && row[7] === socketPath && row[3] === "00010000" && row[4] === "0001");
  check2(rows.length === 1, "socket_ambiguous");
  return {
    socketPath,
    daemon: {
      pid,
      startTicks: daemon.startTicks,
      bootId: daemon.bootId,
      uid: process.getuid(),
      exeSha256: hash2(fs6.readFileSync(`/proc/${pid}/exe`))
    },
    socketIdentity: {
      device: String(stat.dev),
      inode: String(stat.ino),
      uid: Number(stat.uid),
      listenerInode: rows[0][6],
      networkNamespace: fs6.readlinkSync(`/proc/${pid}/ns/net`)
    },
    ss: { path: "/usr/bin/ss", sha256: hash2(fs6.readFileSync("/usr/bin/ss")) },
    peerCredentialReader: capturePm2PeerCredentialReader()
  };
}
function observeServiceOwnerPm2(settings) {
  check2(settings.daemon.uid === process.getuid() && process.getuid() > 0, "uid");
  return runExistingPm2Observation(settings, { Message: import_amp_message.default, ownerUid: process.getuid() }, async (session) => session.raw);
}
function serviceOwnerSlotControls(slot) {
  check2(Number.isSafeInteger(slot.pm_id) && slot.pm_id >= 0 && slot.pm2_env, "slot");
  return { pmId: slot.pm_id, values: Object.fromEntries(Object.entries(slot.pm2_env).filter(([key]) => key !== "env" && !TELEMETRY.has(key) && !CHANGING_ENV.has(key))) };
}
function assertServiceOwnerEnvironmentCopies(slot) {
  const effective = slot.pm2_env, nested = effective.env || {};
  for (const key of CHANGING_ENV) check2(Object.hasOwn(effective, key) === Object.hasOwn(nested, key), "environment_shadow");
  for (const [key, value] of Object.entries(nested)) {
    if (Object.hasOwn(effective, key)) check2(canonicalForwardValue(effective[key]) === canonicalForwardValue(value), "environment_shadow");
  }
  return nested;
}
function exactSlot(rows, authority) {
  const matches = rows.filter((row) => row.pm_id === authority.pmId || row.pm2_env?.name === authority.name);
  check2(matches.length === 1, "slot_ambiguous");
  const slot = matches[0];
  check2(slot.pm_id === authority.pmId && slot.pm2_env?.name === authority.name && slot.pm2_env.namespace === authority.namespace && hash2(serviceOwnerSlotControls(slot)) === authority.controlsSha256, "slot_changed");
  check2(hash2(assertServiceOwnerEnvironmentCopies(slot)) === authority.environmentSha256, "environment_changed");
  return slot;
}
function validatedEnvironment(before, after) {
  check2(before && after && Object.getPrototypeOf(after) === Object.prototype, "environment");
  check2(Object.keys(before).every((key) => Object.hasOwn(after, key)) && Object.keys(after).every((key) => Object.hasOwn(before, key) || CHANGING_ENV.has(key)), "environment_keys");
  for (const key of Object.keys(after)) {
    check2(typeof after[key] === "string" || canonicalForwardValue(after[key]) === canonicalForwardValue(before[key]), "environment_value");
    if (!CHANGING_ENV.has(key)) check2(canonicalForwardValue(before[key]) === canonicalForwardValue(after[key]), "environment_delta");
  }
  if (Object.hasOwn(after, "NASSAJ_UPDATE_MODE")) check2(["release", "local-main"].includes(after.NASSAJ_UPDATE_MODE), "mode");
  for (const key of ["NASSAJ_PREVIEW_TRANSACTION_NONCE", "NASSAJ_PREVIEW_BOOT_NONCE"]) {
    check2(/^[a-f0-9]{64}$/.test(after[key] || ""), "nonce");
  }
  return Object.fromEntries([...CHANGING_ENV].filter((key) => Object.hasOwn(after, key)).map((key) => [key, after[key]]));
}
function deriveStep(session, authority, step) {
  const slot = exactSlot(session.raw, authority);
  check2(["stop-old", "start-stopped"].includes(step), "step");
  if (step === "stop-old") {
    check2(slot.pid === authority.previous.pid && slot.pm2_env.status === "online", "old_slot");
    const app = inspectForwardChildIdentity(slot.pid);
    check2(app.parentPid === authority.observer.daemon.pid && app.startTicks === authority.previous.startTicks && app.bootId === authority.observer.daemon.bootId && app.uids.every((uid) => uid === process.getuid()), "old_identity");
    return { method: "stopProcessId", payload: slot.pm_id };
  }
  check2(slot.pid === 0 && slot.pm2_env.status === "stopped", "not_stopped");
  try {
    const prior = inspectForwardChildIdentity(authority.previous.pid);
    check2(prior.startTicks !== authority.previous.startTicks || prior.bootId !== authority.observer.daemon.bootId, "old_alive");
  } catch (error) {
    if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
  }
  return { method: "restartProcessId", payload: {
    id: slot.pm_id,
    env: validatedEnvironment(slot.pm2_env.env || {}, authority.nextEnvironment)
  } };
}
async function executeServiceOwnerPm2Step(authority, step, hooks) {
  check2(authority?.schema === "nassaj-pm2-service-owner/v1" && authority.observer?.daemon.uid === process.getuid() && process.getuid() > 0 && typeof hooks?.authorize === "function" && typeof hooks?.unknown === "function", "authority");
  let dispatched = false;
  try {
    return await runExistingPm2Observation(authority.observer, { Message: import_amp_message.default, ownerUid: process.getuid() }, async (session) => {
      const plan = deriveStep(session, authority, step);
      plan.intent = {
        requestId: randomBytes2(16).toString("hex"),
        step,
        payloadSha256: hash2(plan.payload),
        daemonSha256: hash2(session.observed.daemon),
        slotSha256: hash2(exactSlot(session.raw, authority))
      };
      await hooks.authorize(plan.intent);
      await session.peer(authority.observer, session.socket, session.deadline);
      session.inspect(authority.observer, session.deadline);
      deriveStep(session, authority, step);
      session.socket.off("data", session.unexpectedData);
      dispatched = true;
      const reply = await sendPinnedPm2TypedFrame(session.socket, session.Message, plan, session.deadline);
      session.socket.on("data", session.unexpectedData);
      await session.peer(authority.observer, session.socket, session.deadline);
      check2(canonicalForwardValue(session.inspect(authority.observer, session.deadline).daemon) === canonicalForwardValue(session.observed.daemon), "daemon_changed");
      return reply;
    });
  } catch (error) {
    if (dispatched) await hooks.unknown({ step, reason: "effect_unproven" });
    throw error;
  }
}

// scripts/lib/update-generation-reconciliation.mjs
var UPDATE_GENERATION_NAMES = Object.freeze(["nodeModules", "server", "client"]);
function classifyGenerationExchange({ previous, target, live, candidate }) {
  const valid = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (![previous, target, live, candidate].every(valid)) return "manual";
  if (previous === target) return live === previous && candidate === target ? "identical" : "manual";
  if (live === previous && candidate === target) return "pending";
  if (live === target && candidate === previous) return "exchanged";
  return "manual";
}
function reconcileUpdateGenerations({ generationNames, generations, direction, databaseState }) {
  if (JSON.stringify(generationNames) !== JSON.stringify(UPDATE_GENERATION_NAMES) || !generations || Object.keys(generations).sort().join(",") !== "client,nodeModules,server" || !["forward", "rollback"].includes(direction) || !["PRE_CANDIDATE", "UNKNOWN", "TARGET_VERIFIED"].includes(databaseState)) {
    return Object.freeze({ state: "manual", reason: "generation_contract_invalid", steps: [] });
  }
  if (direction === "rollback" && databaseState !== "PRE_CANDIDATE") {
    return Object.freeze({ state: "manual", reason: "database_downgrade_forbidden", steps: [] });
  }
  const names = direction === "forward" ? UPDATE_GENERATION_NAMES : [...UPDATE_GENERATION_NAMES].reverse();
  const steps = names.map((name) => {
    const position = classifyGenerationExchange(generations[name] || {});
    const exchange2 = direction === "forward" ? position === "pending" : position === "exchanged";
    return Object.freeze({ name, position, operation: exchange2 ? "exchange" : "attest" });
  });
  if (steps.some((step) => step.position === "manual")) {
    return Object.freeze({ state: "manual", reason: "generation_identity_unknown", steps: [] });
  }
  if (databaseState !== "PRE_CANDIDATE" && steps.some((step) => step.operation === "exchange")) {
    return Object.freeze({ state: "manual", reason: "database_unknown_partial_generation", steps: [] });
  }
  return Object.freeze({ state: "verified", direction, steps: Object.freeze(steps) });
}

// scripts/lib/oid-dependency-candidate.mjs
import fs7 from "node:fs";
import path6 from "node:path";
import { createHash as createHash6 } from "node:crypto";
var HASH3 = /^[a-f0-9]{64}$/;
var digest2 = (bytes) => createHash6("sha256").update(bytes).digest("hex");
var fail5 = (code) => {
  throw Object.assign(new Error(code), { code });
};
function computeDependencyContractV2(fields) {
  return digest2(canonicalTripleJson({
    schema: "nassaj-dependency-contract/v2",
    packageJsonSha256: fields.packageJsonSha256,
    packageLockSha256: fields.packageLockSha256,
    installRuntime: fields.installRuntime,
    installPolicySha256: fields.installPolicySha256,
    nodeModulesTreeSha256: fields.nodeModulesTreeSha256
  }));
}
function verifyOidDependencyCandidate(root, target) {
  if (!HASH3.test(target.nodeModulesTreeSha256 || "") || !HASH3.test(target.dependencyContractSha256 || "")) fail5("local_update_invalid_dependency_identity");
  const parent = path6.join(root, ".nassaj-local-preview", "dependency-candidates");
  const evidenceParent = path6.join(root, ".nassaj-local-preview", "dependency-evidence");
  for (const directory of [root, path6.dirname(parent), parent, evidenceParent]) {
    const stat = fs7.lstatSync(directory);
    if (!stat.isDirectory() || fs7.realpathSync(directory) !== path6.resolve(directory) || stat.uid !== process.getuid?.() || stat.mode & 18) fail5("local_update_unsafe_dependency_store");
  }
  const tree = hashDependencyTreeV2(path6.join(parent, target.nodeModulesTreeSha256), { requireSealed: true });
  const fd = fs7.openSync(path6.join(evidenceParent, `${target.dependencyContractSha256}.json`), fs7.constants.O_RDONLY | fs7.constants.O_NOFOLLOW | fs7.constants.O_NONBLOCK);
  let evidence;
  try {
    const stat = fs7.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 511) !== 384) fail5("local_update_unsafe_dependency_evidence");
    evidence = JSON.parse(fs7.readFileSync(fd));
  } finally {
    fs7.closeSync(fd);
  }
  if (evidence.schema !== "nassaj-oid-dependency-candidate/v2" || tree.sha256 !== target.nodeModulesTreeSha256 || canonicalTripleJson(evidence.tree) !== canonicalTripleJson(tree) || digest2(canonicalTripleJson(evidence.installPolicy)) !== target.installPolicySha256 || computeDependencyContractV2(evidence) !== target.dependencyContractSha256) fail5("local_update_dependency_candidate_changed");
  const proof = evidence.nativeProbe;
  if (proof?.schema !== "nassaj-oid-native-probe/v2" || proof.processExited !== true || proof.nodeModulesTreeSha256 !== tree.sha256 || proof.nodeVersion !== target.installRuntime.nodeVersion || proof.nodeModuleAbi !== target.installRuntime.nodeModuleAbi) fail5("local_update_native_probe_unverified");
  for (const key of ["nodeModulesTreeSha256", "packageJsonSha256", "packageLockSha256", "installPolicySha256", "dependencyContractSha256", "installRuntime"]) {
    if (canonicalTripleJson(target[key]) !== canonicalTripleJson(evidence[key])) fail5("local_update_dependency_candidate_changed");
  }
  return evidence;
}

// scripts/lib/local-source-bootstrap-ticket.mjs
import fs8 from "node:fs";
import path7 from "node:path";
import { createHash as createHash7, randomBytes as randomBytes3 } from "node:crypto";
var HASH4 = /^[a-f0-9]{64}$/;
var OID2 = /^[a-f0-9]{40}$/;
var MATERIAL = ["installation", "event", "approval", "previous", "supervisor", "database", "mode", "baseline", "executor"];
var sha = (value) => createHash7("sha256").update(value).digest("hex");
var fail6 = (reason) => {
  throw new Error(`bootstrap_ticket_${reason}`);
};
function check3(value, reason) {
  if (!value) fail6(reason);
}
function keys(value, expected) {
  check3(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(",") === [...expected].sort().join(","), "schema");
}
function hashes(value, names) {
  for (const name of names) check3(HASH4.test(value[name] || ""), "digest");
}
function bootstrapClock() {
  const uptime = fs8.readFileSync("/proc/uptime", "utf8").match(/^([0-9]+)\.([0-9]{2}) /);
  check3(uptime, "clock_unknown");
  const milliseconds = Number(uptime[1]) * 1e3 + Number(uptime[2]) * 10;
  check3(Number.isSafeInteger(milliseconds), "clock_unknown");
  return { bootId: fs8.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), milliseconds };
}
function validateMaterial(material) {
  keys(material, MATERIAL);
  const { installation: install, event, approval, previous, supervisor, database, mode, baseline, executor } = material;
  keys(install, ["root", "commonGit", "hostname", "serviceUid"]);
  check3([install.root, install.commonGit].every((value) => typeof value === "string" && path7.isAbsolute(value) && path7.resolve(value) === value) && typeof install.hostname === "string" && install.hostname.length > 0 && Number.isSafeInteger(install.serviceUid) && install.serviceUid >= 0, "installation");
  keys(event, ["sequence", "group", "oid", "targetDigest", "manifestSha256"]);
  check3(Number.isSafeInteger(event.sequence) && event.sequence > 0 && event.group === `event-${String(event.sequence).padStart(16, "0")}` && OID2.test(event.oid || ""), "event");
  hashes(event, ["targetDigest", "manifestSha256"]);
  keys(approval, ["ownerId", "receiptSha256"]);
  check3(typeof approval.ownerId === "string" && /^[1-9][0-9]*$/.test(approval.ownerId), "owner");
  hashes(approval, ["receiptSha256"]);
  keys(previous, [
    "pid",
    "ppid",
    "startTicks",
    "clientBuildId",
    "serverBuildId",
    "controlManifestSha256",
    "clientTreeSha256",
    "serverTreeSha256",
    "nodeModulesTreeSha256"
  ]);
  check3([previous.pid, previous.ppid].every((pid) => Number.isSafeInteger(pid) && pid > 1) && /^[1-9][0-9]*$/.test(previous.startTicks || ""), "process");
  hashes(previous, ["clientBuildId", "serverBuildId", "controlManifestSha256", "clientTreeSha256", "serverTreeSha256", "nodeModulesTreeSha256"]);
  keys(supervisor, ["pid", "startTicks", "observerSha256", "slotSha256", "environmentSha256", "dumpSha256"]);
  check3(supervisor.pid === previous.ppid && /^[1-9][0-9]*$/.test(supervisor.startTicks || ""), "supervisor");
  hashes(supervisor, ["observerSha256", "slotSha256", "environmentSha256", "dumpSha256"]);
  keys(database, ["path", "dev", "ino"]);
  check3(typeof database.path === "string" && path7.isAbsolute(database.path) && path7.resolve(database.path) === database.path && ["dev", "ino"].every((key) => typeof database[key] === "string" && /^[0-9]+$/.test(database[key])), "database");
  keys(mode, ["original", "proposed", "originalEnvSha256", "proposalEnvSha256"]);
  check3(mode.original === "release" && mode.proposed === "local-main", "mode");
  hashes(mode, ["originalEnvSha256", "proposalEnvSha256"]);
  keys(baseline, ["attestationSha256", "rehearsalSha256"]);
  hashes(baseline, ["attestationSha256", "rehearsalSha256"]);
  keys(executor, ["codeClosureSha256", "transactionNonce"]);
  hashes(executor, ["codeClosureSha256", "transactionNonce"]);
}
function verifyBootstrapTicket(ticket, expected, clock = bootstrapClock()) {
  keys(ticket, ["schema", "nonce", "bootId", "issuedBootMs", "expiresBootMs", "material"]);
  check3(ticket.schema === "nassaj-local-main-bootstrap-ticket/v2" && HASH4.test(ticket.nonce || "") && /^[a-f0-9-]{36}$/.test(ticket.bootId || ""), "schema");
  validateMaterial(ticket.material);
  validateMaterial(expected);
  check3(canonicalTripleJson(ticket.material) === canonicalTripleJson(expected), "material_changed");
  check3(ticket.bootId === clock.bootId && Number.isSafeInteger(clock.milliseconds) && Number.isSafeInteger(ticket.issuedBootMs) && Number.isSafeInteger(ticket.expiresBootMs) && ticket.issuedBootMs >= 0 && ticket.expiresBootMs > ticket.issuedBootMs && ticket.expiresBootMs - ticket.issuedBootMs <= 3e5 && clock.milliseconds >= ticket.issuedBootMs && clock.milliseconds < ticket.expiresBootMs, "expired_or_rebooted");
  return sha(canonicalTripleJson(ticket));
}
function checkedClaimDirectory(ticket) {
  const root = ticket.material.installation.commonGit;
  const directory = path7.join(root, "nassaj-oid-recovery", ticket.material.executor.transactionNonce);
  for (const file of [root, path7.dirname(directory), directory]) {
    const stat = fs8.lstatSync(file);
    check3(stat.isDirectory() && !stat.isSymbolicLink() && fs8.realpathSync(file) === file && stat.uid === process.getuid() && !(stat.mode & 18), "claim_directory");
  }
  return directory;
}
function consumeBootstrapTicket(ticket, expected, executorOwner, clock = bootstrapClock()) {
  const ticketSha256 = verifyBootstrapTicket(ticket, expected, clock);
  check3(executorOwner?.pid === process.pid && executorOwner.bootId === clock.bootId && /^[1-9][0-9]*$/.test(executorOwner.startTime || ""), "claim_owner");
  const processStat = fs8.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  check3(processStat.slice(processStat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] === executorOwner.startTime && expected.installation.serviceUid === process.getuid(), "claim_owner");
  const directory = checkedClaimDirectory(ticket), basename = `bootstrap-claim-${ticket.nonce}.json`, file = path7.join(directory, basename);
  const claim = {
    schema: "nassaj-local-main-bootstrap-claim/v1",
    state: "claimed_pre_effect",
    ticketSha256,
    nonce: ticket.nonce,
    transactionNonce: expected.executor.transactionNonce,
    owner: executorOwner,
    targetDigest: expected.event.targetDigest,
    approvalSha256: expected.approval.receiptSha256,
    executorCodeClosureSha256: expected.executor.codeClosureSha256
  };
  const bytes = Buffer.from(`${canonicalTripleJson(claim)}
`);
  const parent = fs8.openSync(directory, fs8.constants.O_RDONLY | fs8.constants.O_DIRECTORY | fs8.constants.O_NOFOLLOW);
  try {
    const held = fs8.fstatSync(parent), named = fs8.lstatSync(checkedClaimDirectory(ticket));
    check3(held.dev === named.dev && held.ino === named.ino, "claim_directory");
    const fd = fs8.openSync(
      `/proc/self/fd/${parent}/${basename}`,
      fs8.constants.O_WRONLY | fs8.constants.O_CREAT | fs8.constants.O_EXCL | fs8.constants.O_NOFOLLOW,
      384
    );
    try {
      fs8.writeFileSync(fd, bytes);
      fs8.fsyncSync(fd);
    } finally {
      fs8.closeSync(fd);
    }
    fs8.fsyncSync(parent);
    const after = fs8.lstatSync(checkedClaimDirectory(ticket));
    check3(held.dev === after.dev && held.ino === after.ino, "claim_directory");
  } finally {
    fs8.closeSync(parent);
  }
  return { file, sha256: sha(bytes), claim };
}
var PREVIOUS_KEYS = [
  "oid",
  "clientOid",
  "serverBuildId",
  "clientBuildId",
  "controlManifestSha256",
  "serverInputManifestSha256",
  "serverProvenanceSha256",
  "clientProvenanceSha256",
  "clientTreeSha256",
  "serverTreeSha256",
  "nodeModulesTreeSha256",
  "dependencyLegacyActualSha256",
  "nodeBinarySha256",
  "nodeVersion",
  "nodeModuleAbi",
  "pm2PackageTreeSha256",
  "safeRestartSha256",
  "admissionImplementationSha256",
  "mode"
];
var REHEARSAL_KEYS = [
  "schema",
  "reportSha256",
  "evidenceIndexSha256",
  "harnessClosureSha256",
  "verifierClosureSha256",
  "previousMaterialSha256",
  "executorClosureSha256"
];
function validateBootstrapQualificationMaterial(qualification, actual, manifest) {
  keys(qualification, ["schema", "installation", "previous", "exceptions", "rehearsal", "review"]);
  check3(qualification.schema === "nassaj-bootstrap-previous-qualification/v1", "qualification_schema");
  keys(qualification.installation, ["root", "commonGit", "hostname", "serviceUid"]);
  keys(qualification.previous, PREVIOUS_KEYS);
  const previous = qualification.previous;
  for (const key of PREVIOUS_KEYS.filter((key2) => key2.endsWith("Sha256") || key2.endsWith("BuildId"))) hashes(previous, [key]);
  check3(OID2.test(previous.oid || "") && OID2.test(previous.clientOid || "") && previous.mode === "release" && /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(previous.nodeVersion || "") && /^[0-9]+$/.test(previous.nodeModuleAbi || ""), "qualification_previous");
  check3(canonicalTripleJson(qualification.installation) === canonicalTripleJson(actual.installation) && canonicalTripleJson(previous) === canonicalTripleJson(actual.previous), "qualification_material_changed");
  check3(Array.isArray(qualification.exceptions) && qualification.exceptions.length <= 1 && HASH4.test(manifest.runtimeDependenciesSha256 || ""), "qualification_exception");
  const mismatch = manifest.runtimeDependenciesSha256 !== previous.dependencyLegacyActualSha256;
  check3(qualification.exceptions.length === Number(mismatch), "qualification_exception");
  if (mismatch) {
    const exception = qualification.exceptions[0];
    keys(exception, ["kind", "manifestSha256", "expectedLegacySha256", "actualLegacySha256"]);
    check3(exception.kind === "dependency-seal-mismatch" && exception.manifestSha256 === previous.controlManifestSha256 && exception.expectedLegacySha256 === manifest.runtimeDependenciesSha256 && exception.actualLegacySha256 === previous.dependencyLegacyActualSha256, "qualification_exception");
  }
  keys(qualification.rehearsal, REHEARSAL_KEYS);
  check3(qualification.rehearsal.schema === "nassaj-bootstrap-previous-rehearsal/v1", "qualification_rehearsal");
  hashes(qualification.rehearsal, REHEARSAL_KEYS.filter((key) => key !== "schema"));
  keys(qualification.review, ["receiptSha256"]);
  hashes(qualification.review, ["receiptSha256"]);
  const material = { installation: qualification.installation, previous, exceptions: qualification.exceptions };
  check3(qualification.rehearsal.previousMaterialSha256 === sha(canonicalTripleJson(material)), "qualification_material_digest");
  return {
    previous: structuredClone(previous),
    exceptions: structuredClone(qualification.exceptions),
    previousMaterialSha256: sha(canonicalTripleJson(material)),
    qualificationSha256: sha(canonicalTripleJson(qualification))
  };
}
function validateBootstrapApprovalChain(ticket, review, receipt, principal, clock = bootstrapClock()) {
  verifyBootstrapTicket(ticket, ticket.material, clock);
  keys(review, [
    "schema",
    "installation",
    "operation",
    "transactionNonce",
    "event",
    "baseline",
    "executorCodeClosureSha256",
    "qaReceiptSha256",
    "mode",
    "validity"
  ]);
  keys(receipt, ["schema", "reviewPacketSha256", "transactionNonce", "ownerId", "source", "scope", "decision", "recordedAt"]);
  const material = ticket.material;
  check3(review.schema === "nassaj-bootstrap-owner-review/v1" && review.operation === "bootstrap-release-to-local-main" && canonicalTripleJson(review.installation) === canonicalTripleJson(material.installation) && canonicalTripleJson(review.event) === canonicalTripleJson(material.event) && canonicalTripleJson(review.baseline) === canonicalTripleJson(material.baseline) && canonicalTripleJson(review.mode) === canonicalTripleJson(material.mode) && review.executorCodeClosureSha256 === material.executor.codeClosureSha256 && review.transactionNonce === material.executor.transactionNonce, "review_scope");
  keys(review.validity, ["bootId", "notBeforeBootMs", "notAfterBootMs", "attempts"]);
  check3(review.validity.bootId === ticket.bootId && review.validity.attempts === 1 && Number.isSafeInteger(review.validity.notBeforeBootMs) && review.validity.notBeforeBootMs >= 0 && Number.isSafeInteger(review.validity.notAfterBootMs) && review.validity.notBeforeBootMs <= ticket.issuedBootMs && review.validity.notAfterBootMs >= ticket.expiresBootMs, "review_validity");
  hashes(review, ["qaReceiptSha256"]);
  check3(receipt.schema === "nassaj-bootstrap-owner-conversation-approval/v1" && receipt.reviewPacketSha256 === sha(canonicalTripleJson(review)) && receipt.transactionNonce === review.transactionNonce && receipt.ownerId === material.approval.ownerId && receipt.decision === "approve" && Number.isSafeInteger(receipt.recordedAt) && receipt.recordedAt > 0 && canonicalTripleJson(receipt.scope) === canonicalTripleJson({ operation: review.operation, installation: review.installation }) && sha(canonicalTripleJson(receipt)) === material.approval.receiptSha256, "approval_scope");
  keys(receipt.source, ["harness", "conversationId", "messageId", "transcriptRef", "messageText", "messageSha256", "timestamp"]);
  const source = receipt.source;
  check3(["harness", "conversationId", "transcriptRef", "messageText", "timestamp"].every((key) => typeof source[key] === "string" && source[key].trim().length > 0 && source[key].length <= 16384) && (source.messageId === null || typeof source.messageId === "string" && source.messageId.length > 0) && source.messageSha256 === sha(source.messageText), "approval_source");
  check3(principal?.id === receipt.ownerId && principal.mappedOwnerId === receipt.ownerId && principal.role === "owner" && principal.is_active === 1 && principal.status === "active", "owner_ineligible");
  return {
    ownerId: receipt.ownerId,
    receiptSha256: material.approval.receiptSha256,
    reviewPacketSha256: receipt.reviewPacketSha256,
    qaReceiptSha256: review.qaReceiptSha256
  };
}
function readBootstrapPrivateFile(file) {
  check3(typeof file === "string" && path7.isAbsolute(file) && fs8.realpathSync(file) === file, "file_path");
  const named = fs8.lstatSync(file);
  const fd = fs8.openSync(file, fs8.constants.O_RDONLY | fs8.constants.O_NOFOLLOW | fs8.constants.O_NONBLOCK);
  try {
    const before = fs8.fstatSync(fd);
    check3(before.isFile() && before.nlink === 1 && before.uid === process.getuid() && (before.mode & 511) === 384 && before.size <= 4 * 1024 * 1024 && before.dev === named.dev && before.ino === named.ino, "file_metadata");
    const bytes = fs8.readFileSync(fd), after = fs8.fstatSync(fd), current = fs8.lstatSync(file);
    check3(before.size === after.size && before.ctimeMs === after.ctimeMs && current.dev === before.dev && current.ino === before.ino && current.ctimeMs === before.ctimeMs, "file_changed");
    return bytes;
  } finally {
    fs8.closeSync(fd);
  }
}
function readBootstrapPinnedFile(file, expectedSha256) {
  const bytes = readBootstrapPrivateFile(file);
  check3(HASH4.test(expectedSha256 || "") && sha(bytes) === expectedSha256, "file_changed");
  return bytes;
}
function bootstrapJournalBinding(ticket, consumed) {
  verifyBootstrapTicket(ticket, ticket.material, { bootId: ticket.bootId, milliseconds: ticket.issuedBootMs });
  const material = ticket.material, claim = consumed?.claim;
  keys(claim, ["schema", "state", "ticketSha256", "nonce", "transactionNonce", "owner", "targetDigest", "approvalSha256", "executorCodeClosureSha256"]);
  keys(claim.owner, ["pid", "bootId", "startTime"]);
  check3(Number.isSafeInteger(claim.owner.pid) && claim.owner.pid > 1 && claim.owner.bootId === ticket.bootId && /^[1-9][0-9]*$/.test(claim.owner.startTime || ""), "claim_owner");
  check3(claim.schema === "nassaj-local-main-bootstrap-claim/v1" && claim.state === "claimed_pre_effect" && claim.ticketSha256 === sha(canonicalTripleJson(ticket)) && claim.nonce === ticket.nonce && claim.transactionNonce === material.executor.transactionNonce && claim.targetDigest === material.event.targetDigest && claim.approvalSha256 === material.approval.receiptSha256 && claim.executorCodeClosureSha256 === material.executor.codeClosureSha256 && consumed.sha256 === sha(`${canonicalTripleJson(claim)}
`), "claim_binding");
  return {
    schema: "nassaj-local-main-bootstrap-transaction/v1",
    ticketSha256: claim.ticketSha256,
    claimSha256: consumed.sha256,
    qualificationSha256: material.baseline.attestationSha256,
    executorCodeClosureSha256: material.executor.codeClosureSha256,
    manifestSha256: material.event.manifestSha256
  };
}
function verifyBootstrapJournalBinding(transaction, record, claimBytes, codeClosureSha256) {
  const ticket = record?.bootstrap?.ticket;
  check3(ticket && transaction?.schema === "nassaj-oid-control-transaction/v2", "journal_missing");
  const claim = JSON.parse(claimBytes), binding = bootstrapJournalBinding(ticket, { claim, sha256: sha(claimBytes) });
  check3(canonicalTripleJson(transaction.bootstrap) === canonicalTripleJson(binding) && binding.executorCodeClosureSha256 === codeClosureSha256 && transaction.transactionNonce === ticket.material.executor.transactionNonce && record.transactionNonce === transaction.transactionNonce && record.actionId === transaction.actionId && transaction.sequence === ticket.material.event.sequence && transaction.oid === ticket.material.event.oid && transaction.pair?.targetDigest === ticket.material.event.targetDigest && record.pair?.targetDigest === transaction.pair.targetDigest && record.repoRoot === ticket.material.installation.root, "journal_binding");
  return { binding, ticket, claim };
}
var REHEARSAL_CHECKS = [
  "loaded_identity",
  "admission_exclusion",
  "old_stop",
  "old_restart_under_gate",
  "pid_and_peer_races",
  "crash_after_stop",
  "crash_after_mode",
  "crash_after_exchange",
  "candidate_start_unknown",
  "evidence_negative"
];
function rehearsalIdentity(value, previous) {
  keys(value, [
    "pid",
    "startTicks",
    "oid",
    "serverBuildId",
    "clientBuildId",
    "nodeBinarySha256",
    "clientTreeSha256",
    "serverTreeSha256",
    "nodeModulesTreeSha256",
    "mode"
  ]);
  check3(Number.isSafeInteger(value.pid) && value.pid > 0 && /^[1-9][0-9]*$/.test(value.startTicks || ""), "rehearsal_process");
  for (const key of Object.keys(value).filter((key2) => !["pid", "startTicks"].includes(key2))) {
    check3(value[key] === previous[key], "rehearsal_loaded_identity");
  }
}
function noActivationEffects(value) {
  keys(value, ["stopRequests", "exchangeRequests", "startRequests", "databaseRestores"]);
  check3(Object.values(value).every((count) => count === 0), "rehearsal_unexpected_effect");
}
function previousReturnObserved(value, initial, final, databaseIdentity) {
  keys(value, [
    "gateClosed",
    "newWriterStatus",
    "databaseBefore",
    "databaseAfter",
    "usersBeforeSha256",
    "usersAfterSha256",
    "targetStartRequests",
    "databaseRestores",
    "childReceipt"
  ]);
  for (const database of [value.databaseBefore, value.databaseAfter]) {
    keys(database, ["path", "dev", "ino"]);
    check3(path7.isAbsolute(database.path) && ["dev", "ino"].every((key) => /^[0-9]+$/.test(database[key])), "rehearsal_database");
  }
  check3(value.gateClosed === true && value.newWriterStatus === 503 && value.targetStartRequests === 0 && value.databaseRestores === 0 && canonicalTripleJson(value.databaseBefore) === canonicalTripleJson(value.databaseAfter) && canonicalTripleJson(value.databaseBefore) === canonicalTripleJson(databaseIdentity) && HASH4.test(value.usersBeforeSha256 || "") && value.usersBeforeSha256 === value.usersAfterSha256 && (initial.pid !== final.pid || initial.startTicks !== final.startTicks), "rehearsal_previous_return");
  const child = value.childReceipt;
  check3(child?.schema === "nassaj-oid-triple-bootstrap/v2" && child.rollback === true && child.pid === final.pid && child.startTime === final.startTicks && child.serverBuildId === final.serverBuildId && child.clientBuildId === final.clientBuildId && child.nodeModulesTreeSha256 === final.nodeModulesTreeSha256, "rehearsal_previous_receipt");
}
function checkRehearsalCase(entry, previous, bindings, databaseIdentity) {
  keys(entry, [
    "schema",
    "name",
    "previousMaterialSha256",
    "executorClosureSha256",
    "initial",
    "final",
    "observations",
    "injectedPhase",
    "attempt",
    "journalEvidence",
    "receiptEvidence",
    "executionEvidence"
  ]);
  check3(entry.schema === "nassaj-bootstrap-observed-case/v1" && REHEARSAL_CHECKS.includes(entry.name) && entry.previousMaterialSha256 === bindings.previousMaterialSha256 && entry.executorClosureSha256 === bindings.executorClosureSha256, "rehearsal_case_binding");
  rehearsalIdentity(entry.initial, previous);
  if (entry.name !== "candidate_start_unknown") rehearsalIdentity(entry.final, previous);
  const observed = entry.observations;
  if (entry.name === "loaded_identity") {
    keys(observed, ["loadedArtifactLinkageSha256", "healthServerBuildId", "healthClientBuildId", "processExecutableSha256"]);
    check3(observed.loadedArtifactLinkageSha256 === previous.serverInputManifestSha256 && observed.healthServerBuildId === previous.serverBuildId && observed.healthClientBuildId === previous.clientBuildId && observed.processExecutableSha256 === previous.nodeBinarySha256, "rehearsal_loaded_linkage");
  } else if (entry.name === "admission_exclusion") {
    keys(observed, ["existingWriterCount", "outcome", "newWriterStatus", "gateClosed", "effects"]);
    check3(Number.isSafeInteger(observed.existingWriterCount) && observed.existingWriterCount > 0 && observed.outcome === "deferred" && observed.newWriterStatus === 503 && observed.gateClosed === true, "rehearsal_admission");
    noActivationEffects(observed.effects);
  } else if (entry.name === "old_stop") {
    keys(observed, ["method", "sameFdPeerPid", "expectedDaemonPid", "oldProcessDead", "remainingWriterPids", "firstExchangeAfterDeath"]);
    check3(observed.method === "stopProcessId" && Number.isSafeInteger(observed.expectedDaemonPid) && observed.expectedDaemonPid > 0 && observed.sameFdPeerPid === observed.expectedDaemonPid && observed.oldProcessDead === true && canonicalTripleJson(observed.remainingWriterPids) === "[]" && observed.firstExchangeAfterDeath === true, "rehearsal_stop");
  } else if (entry.name === "old_restart_under_gate" || entry.name.startsWith("crash_after_")) {
    if (entry.name.startsWith("crash_after_")) {
      keys(observed, ["crashBoundary", "journalState", "recovery"]);
      const phases = { crash_after_stop: "triple_old_stopped", crash_after_mode: "bootstrap_mode_verified", crash_after_exchange: "triple_exchanged" };
      check3(observed.crashBoundary === entry.name && observed.journalState === phases[entry.name], "rehearsal_crash");
      previousReturnObserved(observed.recovery, entry.initial, entry.final, databaseIdentity);
    } else previousReturnObserved(observed, entry.initial, entry.final, databaseIdentity);
  } else if (entry.name === "candidate_start_unknown") {
    keys(observed, ["journalState", "databaseState", "gateClosed", "replayedRequests", "rollbackRequests", "databaseRestores"]);
    check3(entry.final === null && observed.journalState === "manual_recovery_required" && observed.databaseState === "UNKNOWN" && observed.gateClosed === true && observed.replayedRequests === 0 && observed.rollbackRequests === 0 && observed.databaseRestores === 0, "rehearsal_unknown");
  } else checkRehearsalRefusals(entry.name, observed);
}
function verifyRehearsalTrace(entry, evidence, used, previous) {
  const read = (reference) => {
    keys(reference, ["path", "sha256"]);
    check3(typeof reference.path === "string" && evidence.has(reference.path) && !used.has(reference.path) && reference.sha256 === sha(evidence.get(reference.path)), "rehearsal_trace");
    used.add(reference.path);
    return JSON.parse(evidence.get(reference.path));
  };
  const journal = read(entry.journalEvidence), receipt = read(entry.receiptEvidence), execution = read(entry.executionEvidence);
  verifyRehearsalExecution(entry, execution);
  check3(canonicalTripleJson(receipt) === canonicalTripleJson(entry.observations), "rehearsal_receipt");
  check3(entry.injectedPhase === entry.name, "rehearsal_injection");
  const states = {
    old_stop: "triple_old_stopped",
    old_restart_under_gate: "pair_rolled_back",
    crash_after_stop: "triple_old_stopped",
    crash_after_mode: "bootstrap_mode_verified",
    crash_after_exchange: "triple_exchanged",
    candidate_start_unknown: "manual_recovery_required"
  };
  if (states[entry.name]) {
    keys(entry.attempt, ["transactionNonce", "actionId"]);
    check3(HASH4.test(entry.attempt.transactionNonce || "") && /^[a-f0-9-]{36}$/.test(entry.attempt.actionId || "") && journal.transactionNonce === entry.attempt.transactionNonce && journal.actionId === entry.attempt.actionId, "rehearsal_attempt");
    check3(journal?.schema === "nassaj-oid-control-transaction/v2" && journal.state === states[entry.name] && journal.pair?.databaseState === (entry.name === "candidate_start_unknown" ? "UNKNOWN" : "PRE_CANDIDATE"), "rehearsal_journal");
    for (const key of ["clientBuildId", "serverBuildId", "clientTreeSha256", "serverTreeSha256", "nodeModulesTreeSha256", "controlManifestSha256"]) {
      check3(journal.pair.previous?.[key] === previous[key], "rehearsal_journal_previous");
    }
    const runtime = journal.pair.previous?.runtime;
    check3(runtime?.pid === entry.initial.pid && runtime.startTime === entry.initial.startTicks && runtime.oid === entry.initial.oid && runtime.serverBuildId === entry.initial.serverBuildId && runtime.clientBuildId === entry.initial.clientBuildId, "rehearsal_journal_runtime");
  } else {
    check3(entry.attempt === null, "rehearsal_pre_effect_attempt");
    keys(journal, ["schema", "operation", "errorCode"]);
    check3(journal.schema === "nassaj-bootstrap-file-observation/v1" && journal.operation === "lstat" && journal.errorCode === "ENOENT", "rehearsal_pre_effect_journal");
  }
}
function verifyRehearsalExecution(entry, execution) {
  keys(execution, ["schema", "case", "command", "exitCode", "signal", "injectedPhase"]);
  check3(execution.schema === "nassaj-bootstrap-execution-observation/v1" && execution.case === entry.name && execution.injectedPhase === entry.injectedPhase && Array.isArray(execution.command) && execution.command.length >= 2 && execution.command.length <= 32 && execution.command.every((value) => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value)) && path7.isAbsolute(execution.command[0]), "rehearsal_command");
  if (entry.name.startsWith("crash_after_")) {
    check3(execution.exitCode === null && execution.signal === "SIGKILL", "rehearsal_crash_exit");
  } else check3(execution.exitCode === 0 && execution.signal === null, "rehearsal_command_exit");
}
function checkRehearsalRefusals(name, observed) {
  const required = name === "pid_and_peer_races" ? ["stale-pid", "wrong-peer"] : ["mutated-tree", "wrong-report", "wrong-approval", "wrong-closure", "unlisted-exception", "missing-evidence", "false-loaded-identity"];
  keys(observed, ["refusals"]);
  check3(Array.isArray(observed.refusals) && canonicalTripleJson(observed.refusals.map((value) => value.reason).sort()) === canonicalTripleJson(required.sort()), "rehearsal_refusals");
  for (const refusal of observed.refusals) {
    keys(refusal, ["reason", "observedMismatch", "effects"]);
    check3(typeof refusal.observedMismatch === "string" && refusal.observedMismatch.length > 0, "rehearsal_mismatch");
    noActivationEffects(refusal.effects);
  }
}
function verifyBootstrapRehearsalObservations(report, qualification, evidence) {
  keys(report, [
    "schema",
    "checkSet",
    "previousMaterialSha256",
    "executorClosureSha256",
    "harnessClosureSha256",
    "verifierClosureSha256",
    "evidenceIndexSha256",
    "cases",
    "appDataGuard"
  ]);
  check3(report.schema === "nassaj-bootstrap-rehearsal-report/v1" && report.checkSet === "actual-old-bootstrap-checks/v1", "report_schema");
  for (const key of ["previousMaterialSha256", "executorClosureSha256", "harnessClosureSha256", "verifierClosureSha256", "evidenceIndexSha256"]) {
    check3(report[key] === qualification.rehearsal[key], "report_binding");
  }
  check3(Array.isArray(report.cases) && canonicalTripleJson(report.cases.map((value) => value.name).sort()) === canonicalTripleJson([...REHEARSAL_CHECKS].sort()), "report_checks");
  keys(report.appDataGuard, ["evidencePath"]);
  check3(evidence.has(report.appDataGuard.evidencePath), "appdata_evidence");
  const boundary = JSON.parse(evidence.get(report.appDataGuard.evidencePath));
  const appDataGuard = verifyBootstrapAppDataBoundary(boundary, qualification);
  const metadata2 = fs8.lstatSync(boundary.databasePath);
  const databaseIdentity = { path: boundary.databasePath, dev: String(metadata2.dev), ino: String(metadata2.ino) };
  const used = /* @__PURE__ */ new Set([report.appDataGuard.evidencePath]);
  for (const item of report.cases) {
    keys(item, ["name", "evidencePath"]);
    check3(typeof item.evidencePath === "string" && evidence.has(item.evidencePath) && !used.has(item.evidencePath), "report_evidence");
    const observed = JSON.parse(evidence.get(item.evidencePath));
    check3(observed.name === item.name, "report_evidence");
    checkRehearsalCase(observed, qualification.previous, report, databaseIdentity);
    used.add(item.evidencePath);
    verifyRehearsalTrace(observed, evidence, used, qualification.previous);
  }
  verifyBootstrapHarnessClosure(evidence, qualification.rehearsal.harnessClosureSha256, used);
  check3(used.size === evidence.size, "evidence_unused");
  return { used, appDataGuard, databasePath: boundary.databasePath };
}
function verifyBootstrapHarnessClosure(evidence, expected, used) {
  const name = "harness-closure.json";
  check3(evidence.has(name) && !used.has(name), "harness_closure_missing");
  const bytes = evidence.get(name), closure = JSON.parse(bytes);
  check3(sha(bytes) === expected, "harness_closure_digest");
  used.add(name);
  keys(closure, ["schema", "entrypoint", "files"]);
  check3(closure.schema === "nassaj-bootstrap-rehearsal-harness/v1" && Array.isArray(closure.files) && closure.files.length > 0 && closure.files.length <= 64, "harness_closure_schema");
  const files2 = /* @__PURE__ */ new Set();
  for (const item of closure.files) {
    keys(item, ["path", "mode", "size", "sha256"]);
    check3(typeof item.path === "string" && /\.(?:mjs|py|sh|json)$/.test(item.path) && !files2.has(item.path) && !used.has(item.path) && evidence.has(item.path) && item.mode === 384 && item.size === evidence.get(item.path).length && item.sha256 === sha(evidence.get(item.path)), "harness_closure_file");
    files2.add(item.path);
    used.add(item.path);
  }
  check3(files2.has(closure.entrypoint) && /\.(?:mjs|py|sh)$/.test(closure.entrypoint), "harness_entrypoint");
}
function verifyBootstrapAppDataBoundary(boundary, qualification) {
  keys(boundary, ["schema", "directory", "dev", "ino", "databasePath", "purpose"]);
  check3(boundary.schema === "nassaj-bootstrap-appdata-boundary/v1" && boundary.purpose === "exclusive-application-data" && path7.isAbsolute(boundary.directory) && path7.isAbsolute(boundary.databasePath) && path7.dirname(boundary.databasePath) === boundary.directory && boundary.directory !== "/" && !["/home", "/var", "/var/lib", "/tmp", "/var/tmp"].includes(boundary.directory), "appdata_boundary");
  for (const protectedPath of [qualification.installation.root, qualification.installation.commonGit]) {
    check3(protectedPath !== boundary.directory && !protectedPath.startsWith(`${boundary.directory}/`), "appdata_shared_directory");
  }
  const metadata2 = fs8.lstatSync(boundary.directory), database = fs8.lstatSync(boundary.databasePath);
  check3(metadata2.isDirectory() && !metadata2.isSymbolicLink() && fs8.realpathSync(boundary.directory) === boundary.directory && metadata2.uid === qualification.installation.serviceUid && (metadata2.mode & 511) === 448 && String(metadata2.dev) === boundary.dev && String(metadata2.ino) === boundary.ino && database.isFile() && !database.isSymbolicLink() && fs8.realpathSync(boundary.databasePath) === boundary.databasePath && database.uid === metadata2.uid && database.nlink === 1 && (database.mode & 511) === 384, "appdata_identity");
  return {
    directory: boundary.directory,
    dev: boundary.dev,
    ino: boundary.ino,
    dedicated: true,
    attestationSha256: sha(canonicalTripleJson(qualification))
  };
}
function readQualificationEvidenceIndex(directory, index) {
  keys(index, ["schema", "files"]);
  check3(index.schema === "nassaj-bootstrap-evidence-index/v1" && Array.isArray(index.files) && index.files.length > 0 && index.files.length <= 128, "evidence_index");
  const files2 = /* @__PURE__ */ new Map();
  let total = 0;
  for (const item of index.files) {
    keys(item, ["path", "size", "sha256"]);
    check3(typeof item.path === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(item.path) && !files2.has(item.path) && !["qualification.json", "report.json", "evidence-index.json", "qa-review.json"].includes(item.path) && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 4 * 1024 * 1024, "evidence_entry");
    total += item.size;
    check3(total <= 16 * 1024 * 1024, "evidence_limit");
    const bytes = readBootstrapPinnedFile(path7.join(directory, item.path), item.sha256);
    check3(bytes.length === item.size, "evidence_size");
    files2.set(item.path, bytes);
  }
  const expected = [...files2.keys(), "qualification.json", "report.json", "evidence-index.json", "qa-review.json"].sort();
  check3(canonicalTripleJson(fs8.readdirSync(directory).sort()) === canonicalTripleJson(expected), "evidence_unlisted");
  return files2;
}
function inspectBootstrapQualification({
  installation,
  actualPrevious,
  liveManifest,
  executorCodeClosureSha256,
  verifierClosureSha256,
  qualificationReference
}) {
  keys(qualificationReference, ["directory", "sha256"]);
  const directory = qualificationReference.directory, metadata2 = fs8.lstatSync(directory);
  check3(path7.isAbsolute(directory) && fs8.realpathSync(directory) === directory && metadata2.isDirectory() && !metadata2.isSymbolicLink() && metadata2.uid === process.getuid() && (metadata2.mode & 511) === 448, "evidence_directory");
  const qualificationBytes = readBootstrapPinnedFile(path7.join(directory, "qualification.json"), qualificationReference.sha256);
  const qualification = JSON.parse(qualificationBytes);
  const material = validateBootstrapQualificationMaterial(qualification, { installation, previous: actualPrevious }, liveManifest);
  check3(material.qualificationSha256 === qualificationReference.sha256 && qualification.rehearsal.executorClosureSha256 === executorCodeClosureSha256 && qualification.rehearsal.verifierClosureSha256 === verifierClosureSha256, "qualification_closure");
  const read = (name, digest3) => JSON.parse(readBootstrapPinnedFile(path7.join(directory, name), digest3));
  const report = read("report.json", qualification.rehearsal.reportSha256);
  const index = read("evidence-index.json", qualification.rehearsal.evidenceIndexSha256);
  const evidence = readQualificationEvidenceIndex(directory, index);
  const result = verifyBootstrapRehearsalObservations(report, qualification, evidence);
  verifyBootstrapIndependentReview(read("qa-review.json", qualification.review.receiptSha256), qualification);
  return {
    ...material,
    reportSha256: qualification.rehearsal.reportSha256,
    reviewReceiptSha256: qualification.review.receiptSha256,
    executorCodeClosureSha256,
    appDataGuard: result.appDataGuard,
    databasePath: result.databasePath,
    evidence
  };
}
function verifyBootstrapIndependentReview(review, qualification) {
  keys(review, [
    "schema",
    "decision",
    "checkSet",
    "previousMaterialSha256",
    "reportSha256",
    "evidenceIndexSha256",
    "harnessClosureSha256",
    "verifierClosureSha256",
    "executorClosureSha256",
    "reviewer",
    "source"
  ]);
  check3(review.schema === "nassaj-bootstrap-independent-review/v1" && review.decision === "accept" && review.checkSet === "actual-old-bootstrap-checks/v1", "qualification_review");
  for (const key of REHEARSAL_KEYS.filter((key2) => key2 !== "schema")) {
    check3(review[key] === qualification.rehearsal[key], "qualification_review_binding");
  }
  keys(review.reviewer, ["identity", "role"]);
  check3(typeof review.reviewer.identity === "string" && review.reviewer.identity.length > 0 && review.reviewer.role === "independent-qa", "qualification_reviewer");
  keys(review.source, ["harness", "conversationId", "transcriptRef", "messageSha256"]);
  check3(["harness", "conversationId", "transcriptRef"].every((key) => typeof review.source[key] === "string" && review.source[key].length > 0) && HASH4.test(review.source.messageSha256 || ""), "qualification_review_source");
}

// scripts/lib/client-publication-journal.mjs
import fs10 from "node:fs";
import path9 from "node:path";
import { spawnSync as spawnSync2 } from "node:child_process";

// scripts/lib/client-publication-artifacts.mjs
import fs9, { existsSync, readFileSync, readdirSync, realpathSync as realpathSync2 } from "node:fs";
import path8 from "node:path";
import { createHash as createHash8 } from "node:crypto";
var CLIENT_ASSET_MANIFEST = "CLIENT_ASSET_MANIFEST.json";
var CLIENT_ASSET_SCHEMA = "nassaj-client-assets/v1";
var HEX40 = /^[a-f0-9]{40}$/;
var HEX64 = /^[a-f0-9]{64}$/;
var MAX_BYTES = 1024 ** 3;
function clientPublicationCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(clientPublicationCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${clientPublicationCanonical(value[key])}`).join(",")}}`;
  if (value === void 0 || typeof value === "number" && !Number.isFinite(value)) throw new Error("client_publication_noncanonical_value");
  return JSON.stringify(value);
}
function clientPublicationDigest(value) {
  return createHash8("sha256").update(Buffer.isBuffer(value) || typeof value === "string" ? value : clientPublicationCanonical(value)).digest("hex");
}
function readClientPublicationFile(file, maximum = MAX_BYTES) {
  const before = fs9.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw new Error("client_publication_file_unsafe");
  const fd = fs9.openSync(file, fs9.constants.O_RDONLY | fs9.constants.O_NOFOLLOW | fs9.constants.O_NONBLOCK);
  try {
    const opened = fs9.fstatSync(fd), bytes = fs9.readFileSync(fd), after = fs9.fstatSync(fd);
    if (before.dev !== opened.dev || before.ino !== opened.ino || opened.ctimeMs !== after.ctimeMs || opened.size !== after.size || bytes.length !== after.size) throw new Error("client_publication_file_changed");
    return bytes;
  } finally {
    fs9.closeSync(fd);
  }
}
function assertClientAssetPath(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || value.startsWith("/") || /[\\%?#\x00-\x1f]/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("client_asset_path_invalid");
  return value;
}
function inspectClientPublicationTree(directory, options = {}) {
  const root = path8.resolve(directory), base = fs9.lstatSync(root);
  if (!base.isDirectory() || fs9.realpathSync(root) !== root) throw new Error("client_publication_directory_unsafe");
  const maximumBytes = options.maximumBytes ?? MAX_BYTES, maximumFiles = options.maximumFiles ?? 5e4;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !Number.isSafeInteger(maximumFiles) || maximumFiles < 1) throw new Error("client_publication_budget_invalid");
  const entries = [], pending = [""];
  let totalBytes = 0, visited = 0;
  while (pending.length) {
    const relative2 = pending.pop(), current = path8.join(root, relative2);
    const stream = fs9.opendirSync(current);
    try {
      for (let entry; (entry = stream.readSync()) !== null; ) {
        if (++visited > maximumFiles) throw new Error("client_publication_capacity_exceeded");
        const name = entry.name;
        const next = relative2 ? `${relative2}/${name}` : name, file = path8.join(root, next), stat = fs9.lstatSync(file);
        assertClientAssetPath(next);
        if (stat.dev !== base.dev || stat.isSymbolicLink()) throw new Error("client_publication_tree_alias");
        if (stat.isDirectory()) {
          pending.push(next);
          continue;
        }
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("client_publication_tree_special");
        if (next === CLIENT_ASSET_MANIFEST && !options.includeManifest) continue;
        totalBytes += stat.size;
        if (totalBytes > maximumBytes || entries.length >= maximumFiles) throw new Error("client_publication_capacity_exceeded");
        entries.push({ path: next, sha256: clientPublicationDigest(readClientPublicationFile(file, maximumBytes)), size: stat.size });
      }
    } finally {
      stream.closeSync();
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { entries, totalBytes, treeDigest: clientPublicationDigest(entries) };
}
var MANIFEST_DRIFT_SAMPLE_LIMIT = 20;
function summarizeManifestDrift(paths) {
  const sorted = [...paths].sort();
  return { total: sorted.length, sample: sorted.slice(0, MANIFEST_DRIFT_SAMPLE_LIMIT) };
}
function diffManifestEntries(manifestEntries, inventoryEntries) {
  const sealed = new Map(manifestEntries.map((entry) => [entry.path, entry]));
  const actual = new Map(inventoryEntries.map((entry) => [entry.path, entry]));
  const unexpected = [], changed = [];
  for (const [relativePath, entry] of actual) {
    const before = sealed.get(relativePath);
    if (!before) {
      unexpected.push(relativePath);
      continue;
    }
    if (before.sha256 !== entry.sha256 || before.size !== entry.size) changed.push(relativePath);
  }
  const missing = [...sealed.keys()].filter((relativePath) => !actual.has(relativePath));
  return {
    unexpected: summarizeManifestDrift(unexpected),
    missing: summarizeManifestDrift(missing),
    changed: summarizeManifestDrift(changed)
  };
}
function manifestChangedError(manifestEntries, inventoryEntries) {
  const details = diffManifestEntries(manifestEntries, inventoryEntries);
  const parts = [];
  if (details.unexpected.total) parts.push(`${details.unexpected.total} unexpected file(s) on disk`);
  if (details.missing.total) parts.push(`${details.missing.total} manifest file(s) missing`);
  if (details.changed.total) parts.push(`${details.changed.total} file(s) changed since sealing`);
  const summary = parts.length ? parts.join("; ") : "the sealed manifest digest no longer matches, though every entry is identical";
  const error = new Error(`client_asset_manifest_changed: ${summary}. See the listed files in the update details.`);
  error.code = "client_asset_manifest_changed";
  error.details = details;
  return error;
}
function validateClientAssetManifest(directory, expected = {}, verifyClosure) {
  const bytes = readClientPublicationFile(path8.join(directory, CLIENT_ASSET_MANIFEST), 16 * 1024 ** 2), manifest = JSON.parse(bytes);
  if (manifest.schema !== CLIENT_ASSET_SCHEMA || !HEX64.test(manifest.generationId || "") || !HEX64.test(manifest.buildId || "") || !HEX40.test(manifest.sourceOid || "") || !Array.isArray(manifest.entries)) throw new Error("client_asset_manifest_invalid");
  for (const key of ["generationId", "sourceOid", "buildId"]) if (expected[key] !== void 0 && manifest[key] !== expected[key]) throw new Error("client_asset_manifest_identity_mismatch");
  const inventory = inspectClientPublicationTree(directory);
  if (clientPublicationCanonical(manifest.entries) !== clientPublicationCanonical(inventory.entries) || expected.manifestDigest && clientPublicationDigest(bytes) !== expected.manifestDigest) {
    throw manifestChangedError(manifest.entries, inventory.entries);
  }
  if (typeof verifyClosure !== "function") throw new Error("client_asset_closure_verifier_required");
  verifyClosure(directory);
  return { manifest, ...inventory, manifestDigest: clientPublicationDigest(bytes) };
}

// scripts/lib/client-publication-journal.mjs
var CLIENT_PUBLICATION_JOURNAL_SCHEMA = "nassaj-oid-client-publication/v1";
var CLIENT_PUBLICATION_RECEIPT_SCHEMA = "nassaj-client-publication-receipt/v1";
var HEX642 = /^[a-f0-9]{64}$/;
var HEX402 = /^[a-f0-9]{40}$/;
var STATES = ["prepared", "publishing", "verifying", "recovery_required", "served", "rolled_back", "cancelled"];
var FIELDS = [
  "schema",
  "kind",
  "transactionNonce",
  "sequence",
  "sourceOid",
  "policyRevision",
  "reservationId",
  "baseReceiptDigest",
  "parentServingReceiptDigest",
  "serverIdentity",
  "dependencyIdentity",
  "previousClientIdentity",
  "targetClientIdentity",
  "candidateManifestDigest",
  "compatibilityProofDigest",
  "assetManifestDigest"
];
function controlDirectory(root) {
  const run = spawnSync2("/usr/bin/git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error("client_publication_git_control_unavailable");
  const directory = run.stdout.trim(), stat = fs10.lstatSync(directory);
  if (!path9.isAbsolute(directory) || !stat.isDirectory() || fs10.realpathSync(directory) !== directory) throw new Error("client_publication_git_control_unsafe");
  return directory;
}
function files(root, value) {
  const directory = controlDirectory(root);
  return {
    directory,
    journal: path9.join(directory, `nassaj-oid-control-transaction-${value.sequence}-${value.transactionNonce}.json`),
    intent: path9.join(directory, `nassaj-oid-client-intent-${value.transactionNonce}.json`),
    receipt: path9.join(directory, `nassaj-oid-client-receipt-${value.transactionNonce}.json`)
  };
}
function identity(value) {
  return value && HEX402.test(value.sourceOid || "") && HEX642.test(value.buildId || "") && HEX642.test(value.treeDigest || "") && HEX642.test(value.assetManifestDigest || "");
}
function assertClientPublicationServerIdentity(value) {
  if (!value || !HEX402.test(value.sourceOid || "") || !HEX642.test(value.buildId || "") || !HEX642.test(value.controlManifestDigest || "") || !Number.isSafeInteger(value.pid) || value.pid < 1 || !/^\d+$/.test(value.startTime || "") || !HEX642.test(value.baseReceiptDigest || "")) throw new Error("client_publication_server_identity_invalid");
  return value;
}
function intentFields(value) {
  if (!value || value.schema !== CLIENT_PUBLICATION_JOURNAL_SCHEMA || value.kind !== "client-publication" || !HEX642.test(value.transactionNonce || "") || !HEX402.test(value.sourceOid || "") || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Number.isSafeInteger(value.policyRevision) || value.policyRevision < 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.reservationId || "") || !identity(value.previousClientIdentity) || !identity(value.targetClientIdentity) || value.targetClientIdentity.sourceOid !== value.sourceOid) throw new Error("client_publication_intent_invalid");
  for (const key of ["baseReceiptDigest", "parentServingReceiptDigest", "dependencyIdentity", "candidateManifestDigest", "compatibilityProofDigest", "assetManifestDigest"]) {
    if (!HEX642.test(value[key] || "")) throw new Error("client_publication_intent_digest_invalid");
  }
  assertClientPublicationServerIdentity(value.serverIdentity);
  if (value.targetClientIdentity.assetManifestDigest !== value.assetManifestDigest) throw new Error("client_publication_asset_binding_mismatch");
  if (value.serverIdentity.baseReceiptDigest !== value.baseReceiptDigest) throw new Error("client_publication_baseline_mismatch");
  return Object.fromEntries(FIELDS.map((key) => [key, value[key]]));
}
function checkedRecord(file) {
  const stat = fs10.lstatSync(file);
  if (stat.uid !== process.getuid() || (stat.mode & 511) !== 384) throw new Error("client_publication_record_permissions");
  return JSON.parse(readClientPublicationFile(file, 256 * 1024));
}
function validateClientPublicationJournal(root, entry) {
  const value = entry?.value ?? entry, intent = intentFields(value), paths = files(root, value);
  if (!STATES.includes(value.state) || value.intentDigest !== clientPublicationDigest(intent) || entry?.file && path9.resolve(entry.file) !== paths.journal) throw new Error("client_publication_journal_invalid");
  const pinnedIntent = checkedRecord(paths.intent);
  if (clientPublicationCanonical(pinnedIntent) !== clientPublicationCanonical(intent)) throw new Error("client_publication_intent_changed");
  if (!["served", "rolled_back", "cancelled"].includes(value.state)) {
    if (value.receiptDigest !== void 0) throw new Error("client_publication_premature_receipt");
    return { terminal: false, intent, intentDigest: value.intentDigest };
  }
  const receiptBytes = readClientPublicationFile(paths.receipt, 256 * 1024), receipt = checkedRecord(paths.receipt);
  if (receipt.schema !== CLIENT_PUBLICATION_RECEIPT_SCHEMA || receipt.intentDigest !== value.intentDigest || receipt.outcome !== value.state || receipt.transactionNonce !== value.transactionNonce || clientPublicationDigest(receiptBytes) !== value.receiptDigest || clientPublicationCanonical(receipt.intent) !== clientPublicationCanonical(intent) || !HEX642.test(receipt.servingProofDigest || "") || clientPublicationDigest(receipt.servingProof) !== receipt.servingProofDigest) throw new Error("client_publication_receipt_invalid");
  const selected = receipt.outcome === "served" ? intent.targetClientIdentity : intent.previousClientIdentity;
  if (clientPublicationCanonical(receipt.servingProof.clientIdentity) !== clientPublicationCanonical(selected) || clientPublicationCanonical(receipt.servingProof.serverIdentity) !== clientPublicationCanonical(intent.serverIdentity) || receipt.servingProof.parentServingReceiptDigest !== intent.parentServingReceiptDigest || receipt.outcome !== "cancelled" && (!receipt.servingProof.http || receipt.servingProof.http.schema !== "nassaj-client-http-serving/v1" || !Array.isArray(receipt.servingProof.http.files) || receipt.servingProof.http.files.length !== 2) || !Number.isSafeInteger(receipt.servingProof.observedAt) || receipt.servingProof.observedAt < 1) throw new Error("client_publication_serving_proof_invalid");
  return { terminal: true, intent, receipt, receiptDigest: value.receiptDigest };
}

// scripts/lib/client-publication-lineage.mjs
function advanceClientServingLineageRecord(ledger, input) {
  const current = ledger.clientPublicationServing ?? null;
  const hash3 = (value) => /^[a-f0-9]{64}$/.test(value || "");
  if (!hash3(input.receiptDigest) || !hash3(input.generationId) || !hash3(input.baseReceiptDigest) || !hash3(input.assetManifestDigest) || !hash3(input.buildId)) throw new Error("client_serving_identity_invalid");
  if ((current?.receiptDigest ?? null) !== input.expectedReceiptDigest) throw new Error("client_serving_lineage_conflict");
  const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
  const generations = { ...ledger.clientPublicationGenerations || {} };
  if (current && current.generationId !== input.generationId) {
    const previous = generations[current.generationId];
    if (!previous?.serving) throw new Error("client_serving_epoch_invalid");
    generations[current.generationId] = { ...previous, serving: false, retiredAt: now };
  }
  const prior = generations[input.generationId];
  const renewed = !prior?.serving;
  generations[input.generationId] = {
    ...prior,
    assetManifestDigest: input.assetManifestDigest,
    serving: true,
    epoch: (prior?.epoch || 0) + (renewed ? 1 : 0),
    servedAt: renewed ? now : prior.servedAt,
    retiredAt: null,
    protectionOwners: [.../* @__PURE__ */ new Set([...prior?.protectionOwners || [], input.receiptDigest])]
  };
  return {
    ...ledger,
    clientPublicationServing: {
      receiptDigest: input.receiptDigest,
      baseReceiptDigest: input.baseReceiptDigest,
      generationId: input.generationId,
      buildId: input.buildId,
      assetManifestDigest: input.assetManifestDigest
    },
    clientPublicationGenerations: generations,
    updatedAt: now
  };
}

// scripts/lib/client-publication-archive.mjs
import fs11 from "node:fs";
import path10 from "node:path";
var MAX_ASSETS = 1024 ** 3;
var CLIENT_PUBLICATION_RESERVE_BYTES = 16 * 1024 ** 3;
function mkdirReal(directory) {
  fs11.mkdirSync(directory, { recursive: true, mode: 448 });
  if (fs11.realpathSync(directory) !== directory || !fs11.lstatSync(directory).isDirectory()) throw new Error("client_publication_parent_unsafe");
}
function syncDirectory(directory) {
  const fd = fs11.openSync(directory, "r");
  try {
    fs11.fsyncSync(fd);
  } finally {
    fs11.closeSync(fd);
  }
}
function assertClientPublicationCapacity(root, incomingBytes = 0, options = {}) {
  const reserveBytes = options.reserveBytes ?? CLIENT_PUBLICATION_RESERVE_BYTES;
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 2 * 1024 ** 3) throw new Error("client_publication_reserve_invalid");
  if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0 || incomingBytes > MAX_ASSETS) throw new Error("client_publication_capacity_exceeded");
  const archive = path10.join(root, ".nassaj-local-preview/client-assets/generations"), unique = /* @__PURE__ */ new Map();
  if (fs11.existsSync(archive)) {
    for (const entry of fs11.readdirSync(archive)) {
      const tree = inspectClientPublicationTree(path10.join(archive, entry));
      for (const asset of tree.entries) unique.set(asset.sha256, asset.size);
    }
  }
  const bytes = [...unique.values()].reduce((sum, value) => sum + value, 0);
  const disk = fs11.statfsSync(root);
  if (bytes + incomingBytes > MAX_ASSETS || disk.bavail * disk.bsize < reserveBytes + 3 * incomingBytes) throw new Error("client_publication_capacity_exceeded");
  return { uniqueAssetBytes: bytes, incomingBytes, reserveBytes };
}
function prepareClientPublicationAssets(root, candidate, expected, verifyClosure, options = {}) {
  const verified = validateClientAssetManifest(candidate, expected, verifyClosure);
  const parent = path10.join(root, ".nassaj-local-preview/client-assets/generations"), destination = path10.join(parent, verified.manifest.generationId);
  mkdirReal(parent);
  if (fs11.existsSync(destination)) {
    validateClientAssetManifest(destination, expected, verifyClosure);
    return destination;
  }
  assertClientPublicationCapacity(root, verified.totalBytes, options);
  const staging = path10.join(parent, `.${verified.manifest.generationId}-${process.pid}`);
  if (fs11.existsSync(staging)) throw new Error("client_publication_asset_preparation_unresolved");
  fs11.cpSync(candidate, staging, { recursive: true, dereference: false, errorOnExist: true, force: false });
  validateClientAssetManifest(staging, expected, verifyClosure);
  for (const entry of [...verified.entries, { path: "CLIENT_ASSET_MANIFEST.json" }]) {
    const fd = fs11.openSync(path10.join(staging, entry.path), "r");
    try {
      fs11.fsyncSync(fd);
    } finally {
      fs11.closeSync(fd);
    }
  }
  syncDirectory(staging);
  fs11.renameSync(staging, destination);
  syncDirectory(parent);
  return destination;
}

// scripts/lib/client-publication-baseline.mjs
import fs12 from "node:fs";
import path11 from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
import { spawnSync as spawnSync3 } from "node:child_process";
var CLIENT_PUBLICATION_CAPABILITY = "nassaj-dev-client-publication/v1";
var CLIENT_PUBLICATION_RUNTIME_FILE = "nassaj-client-publication-runtime-v1.json";
function write(file, value, replace = false) {
  const target = replace ? `${file}.${randomUUID2()}.tmp` : file, fd = fs12.openSync(target, "wx", 384);
  try {
    fs12.writeFileSync(fd, `${clientPublicationCanonical(value)}
`);
    fs12.fsyncSync(fd);
  } finally {
    fs12.closeSync(fd);
  }
  if (replace) fs12.renameSync(target, file);
  const parent = fs12.openSync(path11.dirname(file), "r");
  try {
    fs12.fsyncSync(parent);
  } finally {
    fs12.closeSync(parent);
  }
}
function commonDirectory(root) {
  const result = spawnSync3("/usr/bin/git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("client_baseline_git_unavailable");
  const directory = result.stdout.trim();
  if (fs12.realpathSync(directory) !== directory || fs12.realpathSync(root) !== root) throw new Error("client_baseline_root_unsafe");
  return directory;
}
function readJson(file) {
  return JSON.parse(readClientPublicationFile(file, 16 * 1024 ** 2));
}
function qualifyClientPublicationRollback(directories) {
  if (!Array.isArray(directories) || !directories.length) return false;
  return directories.every((directory) => {
    try {
      const manifest = readJson(path11.join(directory, "OID_CONTROL_MANIFEST.json"));
      return manifest.capabilities?.clientPublicationV1 === CLIENT_PUBLICATION_CAPABILITY;
    } catch {
      return false;
    }
  });
}
function recordFullClientPublicationBaseline(root, fullReceipt, options) {
  const git2 = commonDirectory(root), manifestFile = path11.join(root, "dist-server/OID_CONTROL_MANIFEST.json");
  const manifestBytes = readClientPublicationFile(manifestFile), manifest = JSON.parse(manifestBytes);
  if (manifest.capabilities?.clientPublicationV1 !== CLIENT_PUBLICATION_CAPABILITY) return null;
  const proofFile = path11.join(git2, `nassaj-oid-pair-serving-${fullReceipt.transactionNonce}.json`);
  const proofBytes = readClientPublicationFile(proofFile), stored = JSON.parse(proofBytes);
  if (clientPublicationCanonical(stored) !== clientPublicationCanonical(fullReceipt) || stored.outcome !== "served" || stored.serverBuildId !== manifest.serverBuildId || !/^[a-f0-9]{40}$/.test(manifest.oid || "") || !/^[a-f0-9]{64}$/.test(stored.nodeModulesTreeSha256 || "") || !/^[a-f0-9]{64}$/.test(manifest.updateRuntimeBuildId || "")) throw new Error("client_baseline_full_receipt_invalid");
  const processStat = fs12.readFileSync(`/proc/${stored.pid}/stat`, "utf8");
  if (processStat.slice(processStat.lastIndexOf(")") + 2).split(/\s+/)[19] !== stored.startTime) throw new Error("client_baseline_loaded_process_changed");
  const baseReceiptDigest = clientPublicationDigest(proofBytes), serverIdentity = {
    sourceOid: manifest.oid,
    buildId: stored.serverBuildId,
    pid: stored.pid,
    startTime: stored.startTime,
    controlManifestDigest: clientPublicationDigest(manifestBytes),
    baseReceiptDigest
  };
  const runtimeFile = path11.join(git2, CLIENT_PUBLICATION_RUNTIME_FILE);
  let prior = null;
  try {
    prior = readJson(runtimeFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const lineageFile = path11.join(git2, "nassaj-client-publication-serving-v1.json");
  let previousServing = null;
  try {
    previousServing = readJson(lineageFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const baselineFile = path11.join(git2, `nassaj-client-publication-baseline-${baseReceiptDigest}.json`);
  let saved = null;
  try {
    saved = readJson(baselineFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (saved) {
    if (saved.binding?.baseReceiptDigest !== baseReceiptDigest || clientPublicationCanonical(saved.binding.serverIdentity) !== clientPublicationCanonical(serverIdentity)) throw new Error("client_baseline_replay_identity_changed");
    if (prior?.baseReceiptDigest === baseReceiptDigest && previousServing?.baseReceiptDigest === baseReceiptDigest) return prior;
    const repaired = { ...saved.lineage, receiptDigest: clientPublicationDigest(readClientPublicationFile(baselineFile)) };
    write(runtimeFile, saved.binding, true);
    options.afterWrite?.("runtime");
    write(lineageFile, repaired, true);
    options.afterWrite?.("lineage");
    return saved.binding;
  }
  const sealed = validateClientAssetManifest(path11.join(root, "dist"), { sourceOid: manifest.oid, buildId: stored.clientBuildId }, options.verifyClosure);
  const capabilities = Object.fromEntries(["executor", "state", "static"].map((key) => [key, CLIENT_PUBLICATION_CAPABILITY]));
  if (qualifyClientPublicationRollback(options.rollbackDirectories)) capabilities.rollback = CLIENT_PUBLICATION_CAPABILITY;
  const binding = {
    schema: "nassaj-client-publication-runtime/v1",
    installationId: clientPublicationDigest({ root, git: git2, uid: process.getuid() }),
    canonicalProjectRoot: root,
    canonicalGitCommonDir: git2,
    serviceIdentity: `nassaj:${process.getuid()}`,
    serviceUid: process.getuid(),
    capabilities,
    updateRuntimeBuildId: manifest.updateRuntimeBuildId,
    clientIdentity: {
      sourceOid: sealed.manifest.sourceOid,
      buildId: sealed.manifest.buildId,
      generationId: sealed.manifest.generationId,
      assetManifestDigest: sealed.manifestDigest,
      treeDigest: sealed.treeDigest
    },
    baseReceiptDigest,
    baselineOid: manifest.oid,
    dependencyIdentity: stored.nodeModulesTreeSha256,
    installedControlDigest: clientPublicationDigest(manifestBytes),
    serverIdentity,
    fullReceipt: { sequence: stored.sequence, transactionNonce: stored.transactionNonce },
    previousServingReceiptDigest: previousServing?.receiptDigest ?? null
  };
  const lineage = {
    schema: "nassaj-client-publication-serving/v1",
    baseReceiptDigest,
    sourceOid: manifest.oid,
    buildId: stored.clientBuildId,
    assetManifestDigest: sealed.manifestDigest,
    generationId: sealed.manifest.generationId,
    kind: "full",
    transactionNonce: stored.transactionNonce,
    sequence: stored.sequence
  };
  write(baselineFile, { schema: "nassaj-client-publication-baseline/v1", binding, lineage });
  options.afterWrite?.("baseline");
  lineage.receiptDigest = clientPublicationDigest(readClientPublicationFile(baselineFile));
  write(runtimeFile, binding, true);
  options.afterWrite?.("runtime");
  write(lineageFile, lineage, true);
  options.afterWrite?.("lineage");
  return binding;
}
function captureClientPublicationBaseline(root, previous) {
  const git2 = commonDirectory(root);
  let binding;
  try {
    binding = readJson(path11.join(git2, CLIENT_PUBLICATION_RUNTIME_FILE));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const serving = readJson(path11.join(git2, "nassaj-client-publication-serving-v1.json"));
  const proof = readClientPublicationFile(path11.join(git2, `nassaj-oid-pair-serving-${binding.fullReceipt?.transactionNonce}.json`));
  if (clientPublicationDigest(proof) !== binding.baseReceiptDigest || serving.baseReceiptDigest !== binding.baseReceiptDigest || binding.serverIdentity.buildId !== previous.serverBuildId || binding.installedControlDigest !== previous.controlManifestSha256 || serving.buildId !== previous.clientBuildId || serving.sourceOid !== previous.clientOid || binding.dependencyIdentity !== previous.nodeModulesTreeSha256) throw new Error("client_rollback_capture_changed");
  if (binding.serverIdentity.pid !== previous.runtime.pid || binding.serverIdentity.startTime !== previous.runtime.startTime) throw new Error("client_rollback_capture_process_changed");
  validateCapturedServing(root, serving);
  const snapshot = { schema: "nassaj-client-publication-previous/v1", binding, serving };
  return { ...snapshot, snapshotDigest: clientPublicationDigest(snapshot) };
}
function validateCapturedServing(root, serving) {
  const git2 = commonDirectory(root);
  if (serving.kind === "full") {
    const bytes = readClientPublicationFile(path11.join(git2, `nassaj-client-publication-baseline-${serving.baseReceiptDigest}.json`));
    if (clientPublicationDigest(bytes) !== serving.receiptDigest || Object.entries(JSON.parse(bytes).lineage).some(([key, value]) => serving[key] !== value)) throw new Error("client_rollback_capture_lineage_changed");
  } else if (serving.kind === "client") {
    const file = path11.join(git2, `nassaj-oid-control-transaction-${serving.sequence}-${serving.transactionNonce}.json`);
    const checked = validateClientPublicationJournal(root, { file, value: readJson(file) });
    const selected = checked.receipt?.outcome === "served" ? checked.intent.targetClientIdentity : checked.intent.previousClientIdentity;
    if (!checked.terminal || checked.receiptDigest !== serving.receiptDigest || ["sourceOid", "buildId", "assetManifestDigest"].some((key) => serving[key] !== selected[key])) throw new Error("client_rollback_capture_lineage_changed");
  } else throw new Error("client_rollback_capture_lineage_changed");
}
function recordClientPublicationRollbackBaseline(root, transaction, options) {
  const previous = transaction.pair?.previous, snapshot = previous?.clientPublication;
  if (!snapshot) return null;
  const { snapshotDigest, ...captured } = snapshot;
  validateCapturedServing(root, snapshot.serving);
  if (clientPublicationDigest(captured) !== snapshotDigest) throw new Error("client_rollback_snapshot_changed");
  if (transaction.state !== "pair_rolled_back" || transaction.pair.databaseState !== "PRE_CANDIDATE" || !options.validateTerminal(root, transaction)) throw new Error("client_rollback_terminal_unverified");
  const git2 = commonDirectory(root), receiptFile = path11.join(git2, `nassaj-oid-pair-receipt-${transaction.transactionNonce}.json`);
  const receiptBytes = readClientPublicationFile(receiptFile), receipt = JSON.parse(receiptBytes);
  if (clientPublicationDigest(receiptBytes) !== transaction.pair.receiptSha256 || receipt.outcome !== "rolled_back" || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1 || !/^\d+$/.test(receipt.startTime || "") || receipt.serverBuildId !== previous.serverBuildId || receipt.clientBuildId !== previous.clientBuildId || receipt.nodeModulesTreeSha256 !== previous.nodeModulesTreeSha256) throw new Error("client_rollback_receipt_changed");
  const stat = fs12.readFileSync(`/proc/${receipt.pid}/stat`, "utf8");
  if (stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19] !== receipt.startTime) throw new Error("client_rollback_process_changed");
  const manifestBytes = readClientPublicationFile(path11.join(root, "dist-server/OID_CONTROL_MANIFEST.json"));
  if (clientPublicationDigest(manifestBytes) !== snapshot.binding.installedControlDigest || clientPublicationDigest(manifestBytes) !== previous.controlManifestSha256) throw new Error("client_rollback_control_changed");
  const original = readClientPublicationFile(path11.join(git2, `nassaj-oid-pair-serving-${snapshot.binding.fullReceipt.transactionNonce}.json`));
  if (clientPublicationDigest(original) !== snapshot.binding.baseReceiptDigest || snapshot.serving.baseReceiptDigest !== snapshot.binding.baseReceiptDigest) throw new Error("client_rollback_original_baseline_changed");
  const immutable = readJson(path11.join(git2, `nassaj-client-publication-baseline-${snapshot.binding.baseReceiptDigest}.json`));
  const originalBinding = { ...snapshot.binding };
  delete originalBinding.processReceipt;
  originalBinding.serverIdentity = { ...originalBinding.serverIdentity, pid: immutable.binding.serverIdentity.pid, startTime: immutable.binding.serverIdentity.startTime };
  if (clientPublicationCanonical(originalBinding) !== clientPublicationCanonical(immutable.binding)) throw new Error("client_rollback_snapshot_binding_changed");
  const journalFile = path11.join(git2, `nassaj-oid-control-transaction-${transaction.sequence}-${transaction.transactionNonce}.json`);
  const journalBytes = readClientPublicationFile(journalFile);
  if (clientPublicationCanonical(JSON.parse(journalBytes)) !== clientPublicationCanonical(transaction)) throw new Error("client_rollback_journal_changed");
  if (receipt.serverOid !== snapshot.binding.baselineOid || receipt.clientBuildIdServed !== previous.clientBuildId || receipt.oidNodeModulesTreeSha256 !== previous.nodeModulesTreeSha256 || receipt.oidPairTargetDigest !== transaction.pair.targetDigest) throw new Error("client_rollback_http_proof_missing");
  const processReceipt = {
    schema: "nassaj-client-publication-process-receipt/v1",
    sequence: transaction.sequence,
    transactionNonce: transaction.transactionNonce,
    receiptDigest: clientPublicationDigest(receiptBytes),
    journalDigest: clientPublicationDigest(journalBytes)
  };
  const binding = { ...snapshot.binding, serverIdentity: { ...snapshot.binding.serverIdentity, pid: receipt.pid, startTime: receipt.startTime }, processReceipt };
  const current = readJson(path11.join(git2, CLIENT_PUBLICATION_RUNTIME_FILE));
  const serving = readJson(path11.join(git2, "nassaj-client-publication-serving-v1.json"));
  if (clientPublicationCanonical(current) === clientPublicationCanonical(binding) && serving.baseReceiptDigest === binding.baseReceiptDigest) {
    const prior = readJson(path11.join(git2, `nassaj-client-publication-rollback-baseline-${transaction.transactionNonce}.json`));
    if (clientPublicationCanonical(prior.binding) !== clientPublicationCanonical(binding) || clientPublicationCanonical(prior.serving) !== clientPublicationCanonical(snapshot.serving)) throw new Error("client_rollback_qualification_changed");
    validateCapturedServing(root, serving);
    return current;
  }
  if (receipt.http?.schema !== "nassaj-client-http-serving/v1" || receipt.http.files?.length !== 2 || ["index.html", "version.json"].some((name) => {
    const entry = receipt.http.files.find((item) => item.path === name);
    return entry?.status !== 200 || entry.sha256 !== clientPublicationDigest(readClientPublicationFile(path11.join(root, "dist", name)));
  })) throw new Error("client_rollback_http_bytes_changed");
  const sealed = validateClientAssetManifest(path11.join(root, "dist"), { sourceOid: previous.clientOid, buildId: previous.clientBuildId }, options.verifyClosure);
  if (sealed.manifestDigest !== snapshot.serving.assetManifestDigest) throw new Error("client_rollback_client_changed");
  const qualification = { schema: "nassaj-client-publication-rollback-baseline/v1", binding, serving: snapshot.serving };
  const file = path11.join(git2, `nassaj-client-publication-rollback-baseline-${transaction.transactionNonce}.json`);
  try {
    write(file, qualification);
  } catch (error) {
    if (error.code !== "EEXIST" || clientPublicationCanonical(readJson(file)) !== clientPublicationCanonical(qualification)) throw error;
  }
  options.afterWrite?.("rollback");
  if (clientPublicationCanonical(current) !== clientPublicationCanonical(snapshot.binding) && clientPublicationCanonical(current) !== clientPublicationCanonical(binding)) throw new Error("client_rollback_runtime_cas_conflict");
  if (serving.receiptDigest !== snapshot.serving.receiptDigest) throw new Error("client_rollback_lineage_cas_conflict");
  write(path11.join(git2, CLIENT_PUBLICATION_RUNTIME_FILE), binding, true);
  options.afterWrite?.("runtime");
  write(path11.join(git2, "nassaj-client-publication-serving-v1.json"), snapshot.serving, true);
  options.afterWrite?.("lineage");
  return binding;
}

// scripts/oid-control-capsule.source.mjs
var { DatabaseSync } = getBuiltinModule("node:sqlite");
var HEX403 = /^[a-f0-9]{40}$/;
var HEX643 = /^[a-f0-9]{64}$/;
var TERMINAL = /* @__PURE__ */ new Set(["pair_rolled_back", "pair_served", "loaded", "served", "rolled_back", "restart_deferred_restored", "reconciled_adopted_live", "aborted_pre_effect"]);
var sha2 = (bytes) => createHash9("sha256").update(bytes).digest("hex");
function readFd(fd, max = 4 * 1024 * 1024) {
  const bytes = readFileSync2(fd);
  if (!bytes.length || bytes.length > max) throw new Error(`capsule_fd_${fd}_size_invalid`);
  return bytes;
}
function canonicalRoot(value, label) {
  if (typeof value !== "string" || !path12.isAbsolute(value)) throw new Error(`${label}_not_absolute`);
  const metadata2 = lstatSync2(value);
  if (!metadata2.isDirectory() || metadata2.isSymbolicLink()) throw new Error(`${label}_unsafe`);
  const resolved = path12.resolve(value);
  if (resolved !== value) throw new Error(`${label}_not_canonical`);
  return resolved;
}
function durable(file, value) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(temp, "wx", 384);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}
`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  const directory = openSync(path12.dirname(file), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function durableCreate(file, value) {
  const temp = `${file}.create-${process.pid}-${Date.now()}`;
  const fd = openSync(temp, "wx", 384);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}
`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, file);
  } finally {
    unlinkSync(temp);
  }
  fsyncDir(path12.dirname(file));
}
function bootstrapAbortReceipt(claimSha256, transactionNonce, recordedAt = Date.now()) {
  return {
    schema: "nassaj-local-main-bootstrap-abort/v1",
    state: "aborted_pre_effect",
    claimSha256,
    transactionNonce,
    recordedAt,
    reason: "claim_without_transaction_journal"
  };
}
function validateBootstrapAbortReceipt(file, claimSha256, transactionNonce) {
  const bytes = readBootstrapPrivateFile(file), receipt = JSON.parse(bytes);
  const expected = bootstrapAbortReceipt(claimSha256, transactionNonce, receipt.recordedAt);
  if (!Number.isSafeInteger(receipt.recordedAt) || receipt.recordedAt <= 0 || pairCanonical(receipt) !== pairCanonical(expected) || !bytes.equals(Buffer.from(`${JSON.stringify(expected, null, 2)}
`))) {
    throw new Error("oid_bootstrap_abort_receipt_invalid");
  }
  return receipt;
}
function injectFailure(point) {
  if (process.env.NODE_ENV === "test" && process.env.NASSAJ_OID_CAPSULE_CRASH_AT === point) process.kill(process.pid, "SIGKILL");
  if (process.env.NODE_ENV === "test" && process.env.NASSAJ_OID_CAPSULE_FAIL_AT === point) {
    throw new Error(`injected_failure:${point}`);
  }
}
function pinnedFile(file, label, expected = {}) {
  const requested = lstatSync2(file);
  if (!requested.isFile() || requested.isSymbolicLink()) throw new Error(`${label}_unsafe`);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > (expected.maxSize || 16 * 1024 * 1024)) throw new Error(`${label}_size_invalid`);
    const bytes = readFileSync2(fd);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.ctimeMs !== after.ctimeMs || expected.sha256 && sha2(bytes) !== expected.sha256 || expected.mode && (before.mode & 511) !== expected.mode) throw new Error(`${label}_changed`);
    return { bytes, identity: { dev: String(before.dev), ino: String(before.ino) } };
  } finally {
    closeSync(fd);
  }
}
function pinnedJson(file, label, expected = {}) {
  return JSON.parse(pinnedFile(file, label, expected).bytes.toString("utf8"));
}
var DISPOSITION_SCHEMA = "nassaj-oid-control-disposition/v1";
var SUCCESSOR_FIELDS = ["sequence", "group", "oid", "buildId", "controlManifestSha256", "transactionNonce", "actionId"];
function dispositionArtifactHash(root) {
  canonicalRoot(root, "disposition_artifact");
  const rows = [];
  function visit(directory) {
    for (const name of readdirSync2(directory).sort((a, b) => a.localeCompare(b))) {
      const file = path12.join(directory, name);
      const metadata2 = lstatSync2(file);
      if (metadata2.isSymbolicLink()) throw new Error("disposition_artifact_symlink");
      if (metadata2.isDirectory()) visit(file);
      else {
        const bytes = pinnedFile(file, "disposition_artifact").bytes;
        rows.push([path12.relative(root, file), `file:${metadata2.mode & 511}:${bytes.length}`, sha2(bytes)]);
      }
    }
  }
  visit(root);
  const hash3 = createHash9("sha256");
  for (const row of rows) for (const value of row) hash3.update(String(value)).update("\0");
  return hash3.digest("hex");
}
function assertDispositionLock(root) {
  const file = path12.join(gitControlRoot(root), "nassaj-preview-event-mutation.lock");
  const metadata2 = lstatSync2(file);
  if (!metadata2.isFile() || metadata2.isSymbolicLink()) throw new Error("disposition_lock_unsafe");
  const locks = readFileSync2("/proc/locks", "utf8").split("\n");
  const held = locks.some((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== "FLOCK" || fields[3] !== "WRITE" || fields[5]?.split(":").at(-1) !== String(metadata2.ino)) return false;
    let pid = Number(fields[4]);
    for (let depth = 0; depth < 12 && pid > 1; depth += 1) {
      if (pid === process.pid) return true;
      try {
        const raw = readFileSync2(`/proc/${pid}/stat`, "utf8");
        pid = Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[1]);
      } catch {
        return false;
      }
    }
    return false;
  });
  if (!held) throw new Error("disposition_event_lock_required");
}
function sameSuccessor(left, right) {
  return SUCCESSOR_FIELDS.every((key) => left?.[key] === right?.[key]);
}
function validateSuccessor(value) {
  if (!Number.isSafeInteger(value?.sequence) || value.sequence < 1 || value.group !== `event-${String(value.sequence).padStart(16, "0")}` || !HEX403.test(value.oid || "") || !HEX643.test(value.buildId || "") || !HEX643.test(value.controlManifestSha256 || "") || !HEX643.test(value.transactionNonce || "") || !(value.actionId === null || /^[a-f0-9-]{36}$/.test(value.actionId || ""))) {
    throw new Error("disposition_successor_invalid");
  }
}
function readDispositionPacket(root, context) {
  if (!context || !HEX643.test(context.packetSha256 || "")) throw new Error("disposition_context_required");
  const packet = pinnedJson(context.packetPath, "disposition_packet", { sha256: context.packetSha256, maxSize: 128 * 1024 });
  if (packet.schema !== "nassaj-oid-control-operator/v1" || packet.repoRoot !== canonicalRoot(root, "repo_root") || !packet.ownerOperation || !HEX643.test(packet.original?.sha256 || "") || !HEX643.test(packet.original?.transactionNonce || "")) throw new Error("disposition_packet_invalid");
  validateSuccessor(packet.successor);
  if (packet.successor.transactionNonce === packet.original.transactionNonce) throw new Error("disposition_cycle");
  return packet;
}
function assertIntendedSuccessor(packet, context) {
  const intended = context.intended;
  if (!intended || intended.sequence !== packet.successor.sequence || intended.group !== packet.successor.group || intended.oid !== packet.successor.oid) throw new Error("disposition_intent_mismatch");
  for (const key of SUCCESSOR_FIELDS) {
    if (Object.hasOwn(intended, key) && intended[key] !== packet.successor[key]) throw new Error("disposition_intent_mismatch");
  }
}
function originalDispositionJournal(root, packet) {
  const file = path12.join(gitControlRoot(root), `nassaj-oid-control-transaction-${packet.original.sequence}-${packet.original.transactionNonce}.json`);
  const bytes = pinnedFile(file, "disposition_original", { sha256: packet.original.sha256, mode: 384, maxSize: 128 * 1024 }).bytes;
  const value = JSON.parse(bytes);
  if (value.schema !== "nassaj-oid-control-transaction/v1" || value.state !== "manual_recovery_required" || value.reason !== "previous_attestation_failed" || value.transactionNonce !== packet.original.transactionNonce || value.sequence !== packet.original.sequence || value.group !== packet.original.group || value.actionId !== packet.original.actionId || value.previousOid !== packet.previous.oid || value.previousBuildId !== packet.previous.buildId || value.livePath !== path12.join(root, "dist-server") || packet.successor.sequence <= value.sequence) throw new Error("disposition_original_invalid");
  return { file, value };
}
function dispositionProcess(previous) {
  if (!Number.isSafeInteger(previous.pid) || previous.pid < 2) throw new Error("disposition_pid_invalid");
  const stat = readFileSync2(`/proc/${previous.pid}/stat`, "utf8");
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  const bootId = readFileSync2("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const cmd = readFileSync2(`/proc/${previous.pid}/cmdline`, "utf8").split("\0");
  const environment = readFileSync2(`/proc/${previous.pid}/environ`, "utf8").split("\0");
  if (ticks !== previous.startTicks || bootId !== previous.bootId || !cmd.includes(previous.entry) && !environment.includes(`pm_exec_path=${previous.entry}`)) {
    throw new Error("disposition_process_changed");
  }
  return { pid: previous.pid, startTicks: ticks, bootId, entry: previous.entry };
}
var HEALTH_OBSERVER = `
const urls = JSON.parse(process.argv[1]);
for (const url of urls) {
 const response = await fetch(url, {signal:AbortSignal.timeout(4000),redirect:'error'});
 if (!response.ok) throw Error('health_status');
 let size=0; const chunks=[];
 for await (const chunk of response.body) {size+=chunk.length;if(size>65536)throw Error('health_size');chunks.push(chunk);}
 process.stdout.write(JSON.stringify(JSON.parse(Buffer.concat(chunks)))+'\\n');
}`;
function observeDispositionHealth(packet) {
  const urls = [packet.previous.privateHealthUrl, packet.previous.publicHealthUrl];
  const privateUrl = new URL(urls[0]);
  const publicUrl = new URL(urls[1]);
  if (!["127.0.0.1", "[::1]"].includes(privateUrl.hostname) || privateUrl.protocol !== "http:" || publicUrl.protocol !== "https:" || urls.some((url) => {
    const parsed = new URL(url);
    return parsed.username || parsed.password;
  })) {
    throw new Error("disposition_health_url_invalid");
  }
  const result = spawnSync4(process.execPath, ["--input-type=module", "-e", HEALTH_OBSERVER, JSON.stringify(urls)], {
    encoding: "utf8",
    timeout: 1e4,
    maxBuffer: 14e4,
    env: { PATH: "/usr/bin:/bin" }
  });
  if (result.status !== 0 || result.error) throw new Error("disposition_health_unavailable");
  const observations = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  if (observations.length !== 2 || observations.some((value) => value.status !== "ok" || value.pid !== packet.previous.pid || value.serverLoadedBuildId !== packet.previous.buildId || value.serverBuildIdOnDisk !== packet.previous.buildId || value.clientBuildIdServed !== packet.previous.clientBuildId)) {
    throw new Error("disposition_health_identity_mismatch");
  }
  return observations.map((value) => ({ pid: value.pid, serverLoadedBuildId: value.serverLoadedBuildId, clientBuildIdServed: value.clientBuildIdServed }));
}
function verifyDispositionRestoration(root, packet) {
  const original = originalDispositionJournal(root, packet);
  const previous = packet.previous;
  if (previous.entry !== path12.join(root, "dist-server", previous.entryRelative || "server/index.js")) throw new Error("disposition_entry_invalid");
  const before = dispositionProcess(previous);
  if (dispositionArtifactHash(path12.join(root, "dist-server")) !== previous.serverTreeSha256 || dispositionArtifactHash(path12.join(root, "dist")) !== previous.clientTreeSha256) throw new Error("disposition_artifact_changed");
  const restored = provenance(path12.join(root, "dist-server"));
  if (restored.commit !== previous.oid || restored.buildId !== previous.buildId) throw new Error("disposition_provenance_changed");
  const healthProof = observeDispositionHealth(packet);
  dispositionProcess(previous);
  const candidateRoot = path12.join(root, ".nassaj-local-preview/server-candidates", packet.successor.buildId);
  const manifest = pinnedJson(path12.join(candidateRoot, "OID_CONTROL_MANIFEST.json"), "disposition_candidate", { sha256: packet.successor.controlManifestSha256 });
  const candidate = provenance(candidateRoot);
  if (candidate.commit !== packet.successor.oid || candidate.buildId !== packet.successor.buildId || manifest.oid !== packet.successor.oid || manifest.serverBuildId !== packet.successor.buildId) throw new Error("disposition_candidate_changed");
  return { original, process: before, health: healthProof };
}
function createOidManualDisposition(root, context) {
  assertDispositionLock(root);
  const packet = readDispositionPacket(root, context);
  assertIntendedSuccessor(packet, context);
  const proof = verifyDispositionRestoration(root, packet);
  const file = path12.join(gitControlRoot(root), `nassaj-oid-control-disposition-${packet.original.transactionNonce}.json`);
  const value = {
    schema: DISPOSITION_SCHEMA,
    packetSha256: context.packetSha256,
    original: packet.original,
    successor: packet.successor,
    ownerOperation: packet.ownerOperation,
    previous: packet.previous,
    process: proof.process,
    health: proof.health
  };
  try {
    durableCreate(file, value);
  } catch (error) {
    if (error.code !== "EEXIST" || JSON.stringify(pinnedJson(file, "disposition_receipt", { mode: 384 })) !== JSON.stringify(value)) throw error;
  }
  return { file, sha256: sha2(pinnedFile(file, "disposition_receipt", { mode: 384 }).bytes) };
}
function validateOidManualDisposition(root, transaction, context, journals) {
  if (transaction.value.state !== "manual_recovery_required") return null;
  if (!context) return validateCompletedDisposition(root, transaction, journals);
  assertDispositionLock(root);
  const packet = readDispositionPacket(root, context);
  assertIntendedSuccessor(packet, context);
  const original = originalDispositionJournal(root, packet);
  if (original.file !== transaction.file) return null;
  const receiptFile = path12.join(gitControlRoot(root), `nassaj-oid-control-disposition-${packet.original.transactionNonce}.json`);
  const bytes = pinnedFile(receiptFile, "disposition_receipt", { mode: 384, maxSize: 128 * 1024 }).bytes;
  const receipt = JSON.parse(bytes);
  if (receipt.schema !== DISPOSITION_SCHEMA || receipt.packetSha256 !== context.packetSha256 || JSON.stringify(receipt.original) !== JSON.stringify(packet.original) || !sameSuccessor(receipt.successor, packet.successor) || JSON.stringify(receipt.previous) !== JSON.stringify(packet.previous)) throw new Error("disposition_receipt_mismatch");
  const link = { originalJournalSha256: packet.original.sha256, dispositionSha256: sha2(bytes), originalTransactionNonce: packet.original.transactionNonce };
  const children = journals.filter(({ value }) => value.disposition?.originalTransactionNonce === packet.original.transactionNonce);
  if (children.length > 1) throw new Error("disposition_multiple_children");
  if (children.length === 1) {
    const child = children[0].value;
    if (!sameSuccessor(child, packet.successor) || JSON.stringify(child.disposition) !== JSON.stringify(link)) throw new Error("disposition_child_mismatch");
  } else verifyDispositionRestoration(root, packet);
  return link;
}
function validateCompletedDisposition(root, transaction, journals) {
  const old = transaction.value;
  if (old.reason !== "previous_attestation_failed" || !HEX643.test(old.transactionNonce || "")) return null;
  const children = journals.filter(({ value }) => value.disposition?.originalTransactionNonce === old.transactionNonce);
  if (children.length !== 1 || !TERMINAL.has(children[0].value.state)) return null;
  const bytes = pinnedFile(path12.join(gitControlRoot(root), `nassaj-oid-control-disposition-${old.transactionNonce}.json`), "disposition_receipt", { mode: 384, maxSize: 128 * 1024 }).bytes;
  const receipt = JSON.parse(bytes);
  const child = children[0].value;
  const oldSha = sha2(pinnedFile(transaction.file, "disposition_original", { mode: 384 }).bytes);
  if (receipt.schema !== DISPOSITION_SCHEMA || receipt.original?.sha256 !== oldSha || receipt.original.transactionNonce !== old.transactionNonce || receipt.original.sequence !== old.sequence || receipt.original.group !== old.group || receipt.original.actionId !== old.actionId || child.disposition.originalJournalSha256 !== oldSha || child.disposition.dispositionSha256 !== sha2(bytes) || !sameSuccessor(child, receipt.successor) || child.sequence <= old.sequence) throw new Error("disposition_completed_chain_invalid");
  validateSuccessor(receipt.successor);
  return child.disposition;
}
function resolveDispositionLink(root, context, request) {
  const packet = readDispositionPacket(root, context);
  assertIntendedSuccessor(packet, context);
  if (request.sequence !== packet.successor.sequence || request.group !== packet.successor.group || request.oid !== packet.successor.oid || request.buildId !== packet.successor.buildId || request.controlManifestSha256 !== packet.successor.controlManifestSha256) {
    throw new Error("disposition_request_plan_mismatch");
  }
  originalDispositionJournal(root, packet);
  const receiptFile = path12.join(gitControlRoot(root), `nassaj-oid-control-disposition-${packet.original.transactionNonce}.json`);
  const bytes = pinnedFile(receiptFile, "disposition_receipt", { mode: 384, maxSize: 128 * 1024 }).bytes;
  const receipt = JSON.parse(bytes);
  if (receipt.schema !== DISPOSITION_SCHEMA || receipt.packetSha256 !== context.packetSha256 || JSON.stringify(receipt.original) !== JSON.stringify(packet.original) || !sameSuccessor(receipt.successor, packet.successor)) throw new Error("disposition_receipt_mismatch");
  return {
    originalJournalSha256: packet.original.sha256,
    dispositionSha256: sha2(bytes),
    originalTransactionNonce: packet.original.transactionNonce
  };
}
function git(repoRoot, args) {
  const result = spawnSync4("/usr/bin/git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git_${args[0]}_failed`);
  return String(result.stdout || "").trim();
}
function gitControlRoot(repoRoot) {
  const entry = lstatSync2(path12.join(repoRoot, ".git"));
  if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error("git_control_entry_unsafe");
  const result = spawnSync4("/usr/bin/git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0 || !path12.isAbsolute(String(result.stdout || "").trim())) throw new Error("git_control_common_dir_unresolved");
  const reported = String(result.stdout).trim();
  const metadata2 = lstatSync2(reported);
  if (!metadata2.isDirectory() || metadata2.isSymbolicLink()) throw new Error("git_control_common_dir_unsafe");
  const resolved = realpathSync3(reported);
  if (resolved !== path12.resolve(reported)) throw new Error("git_control_common_dir_redirected");
  return resolved;
}
function directDirectory(parent, requested, label) {
  const parentBefore = statSync(parent);
  const requestedMetadata = lstatSync2(requested);
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink() || path12.dirname(requested) !== parent) throw new Error(`${label}_unsafe`);
  const resolved = realpathSync3(requested);
  const after = lstatSync2(requested);
  const parentAfter = statSync(parent);
  if (resolved !== requested || requestedMetadata.dev !== after.dev || requestedMetadata.ino !== after.ino || parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino) {
    throw new Error(`${label}_changed`);
  }
  return resolved;
}
function exactControlState(repoRoot, options = {}) {
  const gitRoot = gitControlRoot(repoRoot);
  const request = pinnedJson(path12.join(gitRoot, "nassaj-preview-oid-control-request-v1.json"), "control_request");
  if (request.schemaVersion !== 1 || request.action !== "promote-and-safe-restart" || !Number.isSafeInteger(request.sequence) || request.sequence < 1 || !HEX403.test(request.oid || "") || !HEX643.test(request.buildId || "") || !HEX643.test(request.controlManifestSha256 || "") || request.snapshotOid !== request.oid || request.group !== `event-${String(request.sequence).padStart(16, "0")}`) {
    throw new Error("control_request_identity_invalid");
  }
  const sequence = String(request.sequence).padStart(16, "0");
  const event = pinnedJson(path12.join(gitRoot, `nassaj-preview-oid-event-control-${sequence}.json`), "event_control");
  const consumer = pinnedJson(path12.join(gitRoot, "nassaj-preview-oid-consumer-v1.json"), "consumer_state");
  if (event.schema !== "nassaj-oid-control-event/v1" || event.sequence !== request.sequence || event.oid !== request.oid || event.snapshotOid !== request.oid || event.buildId !== request.buildId || event.controlManifestSha256 !== request.controlManifestSha256 || consumer.server?.sequence !== request.sequence || consumer.server?.oid !== request.oid || consumer.server?.buildId !== request.buildId || consumer.server?.phase !== "awaiting_owner" || consumer.server?.controlManifestSha256 !== request.controlManifestSha256) {
    throw new Error("control_state_mismatch");
  }
  const refs = git(repoRoot, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/nassaj/previews/v1/events/"]).split("\n").filter(Boolean);
  const serverEvents = refs.map((line) => line.match(/^refs\/nassaj\/previews\/v1\/events\/(\d{16})\/server ([a-f0-9]{40})$/)).filter(Boolean);
  const newest = serverEvents.at(-1);
  const general = refs.map((line) => line.match(/^refs\/nassaj\/previews\/v1\/events\/(\d{16})\/event ([a-f0-9]{40})$/)).filter(Boolean).find((match) => Number(match[1]) === request.sequence);
  if (!newest || Number(newest[1]) !== request.sequence || newest[2] !== request.oid || !general || general[2] !== request.oid || git(repoRoot, ["rev-parse", `refs/nassaj/previews/v1/groups/${request.group}/desired`]) !== request.oid || git(repoRoot, ["rev-parse", `refs/nassaj/previews/v1/groups/${request.group}/server/desired`]) !== request.oid || git(repoRoot, ["rev-parse", `refs/nassaj/previews/v1/groups/${request.group}/server/candidate`]) !== request.oid) {
    throw new Error("control_refs_superseded");
  }
  const snapshotParent = path12.join(repoRoot, ".nassaj-local-preview", "oid-snapshots");
  const snapshot = directDirectory(snapshotParent, path12.join(snapshotParent, request.oid), "snapshot");
  const candidateParent = path12.join(repoRoot, ".nassaj-local-preview", "server-candidates");
  const requestedArtifact = options.artifactRoot || path12.join(candidateParent, request.buildId);
  const artifactRoot = requestedArtifact === path12.join(repoRoot, "dist-server") ? canonicalRoot(requestedArtifact, "promoted_candidate") : directDirectory(candidateParent, requestedArtifact, "candidate");
  const manifest = pinnedJson(path12.join(artifactRoot, "OID_CONTROL_MANIFEST.json"), "candidate_manifest", {
    sha256: request.controlManifestSha256,
    mode: 292
  });
  if (manifest.schema !== "nassaj-oid-control-runtime/v1" || manifest.protocol !== 1 || manifest.oid !== request.oid || manifest.serverBuildId !== request.buildId) {
    throw new Error("candidate_manifest_identity_mismatch");
  }
  const candidate = provenance(artifactRoot);
  if (candidate.commit !== request.oid || candidate.baseCommit !== request.oid || candidate.buildId !== request.buildId || candidate.dirty !== false) {
    throw new Error("candidate_identity_mismatch");
  }
  const inputs = pinnedJson(path12.join(artifactRoot, "SERVER_INPUT_MANIFEST.json"), "server_input_manifest");
  if (inputs.schemaVersion !== 2 || inputs.buildId !== request.buildId || !Array.isArray(inputs.inputs)) {
    throw new Error("server_input_manifest_identity_mismatch");
  }
  for (const input of inputs.inputs) {
    if (typeof input.path !== "string" || path12.isAbsolute(input.path) || input.path.includes("..") || !HEX643.test(input.sha256 || "") || !Number.isInteger(input.mode)) {
      throw new Error("server_input_manifest_entry_invalid");
    }
    pinnedFile(path12.join(snapshot, input.path), "snapshot_input", {
      sha256: input.sha256,
      mode: input.mode & 511
    });
  }
  return { request, artifactRoot, manifest };
}
function fsyncDir(directory) {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function provenance(directory) {
  const file = path12.join(directory, "BUILD_PROVENANCE.json");
  const metadata2 = lstatSync2(file);
  if (!metadata2.isFile() || metadata2.isSymbolicLink()) throw new Error("provenance_unsafe");
  return JSON.parse(readFileSync2(file, "utf8"));
}
function exchange(left, right) {
  return new Promise((resolve, reject2) => {
    const child = spawn2("/usr/bin/mv", ["--exchange", "--no-copy", "-T", left, right], { stdio: ["ignore", "pipe", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.on("error", reject2);
    child.on("close", (code) => code === 0 ? resolve() : reject2(new Error(`exchange_failed:${error.trim()}`)));
  });
}
var SAFE_STOP_DIAGNOSTIC_CODES = /* @__PURE__ */ new Set([
  "oid_triple_safe_context_invalid",
  "oid_triple_safe_file_unsafe",
  "oid_triple_safe_journal_invalid",
  "oid_triple_safe_executor_unsafe",
  "oid_triple_safe_executor_changed",
  "oid_triple_safe_executor_mismatch",
  "oid_triple_safe_closure_invalid",
  "oid_triple_safe_closure_changed",
  "oid_triple_safe_phase_not_owned",
  "oid_triple_safe_ancestry_unknown",
  "oid_triple_safe_phase_foreign_process",
  "oid_triple_safe_phase_invalid",
  "oid_triple_supervisor_missing",
  "oid_triple_stop_not_intended",
  "oid_triple_pm2_slot_ambiguous",
  "oid_triple_pm2_slot_changed",
  "oid_triple_pm2_environment_changed",
  "oid_triple_writer_descendant_present",
  "oid_triple_process_inventory_unknown",
  "oid_triple_pm2_operation_unverified",
  "oid_triple_old_process_still_alive",
  "oid_triple_pm2_authority_changed",
  "oid_triple_pm2_daemon_changed",
  "oid_triple_pm2_unavailable",
  "oid_triple_child_mode_changed",
  "EACCES",
  "EPERM",
  "ENOENT",
  "EIO",
  "ENOSPC",
  "EMFILE",
  "oid_triple_safe_control_unavailable",
  "oid_pair_maintenance_invalid",
  "oid_pair_link_invalid",
  "oid_pair_counterpart_mismatch",
  "oid_pair_receipt_invalid",
  "oid_pair_open_unverified",
  "oid_pair_live_generation_mismatch",
  "oid_triple_live_dependencies_mismatch",
  "git_control_entry_unsafe",
  "git_control_common_dir_unresolved",
  "git_control_common_dir_unsafe",
  "oid_triple_pm2_response_invalid",
  "oid_triple_pm2_authority_invalid",
  "oid_triple_pm2_authority_exposed_write",
  "oid_triple_pm2_home_owner_invalid",
  "pair_maintenance_journal_unsafe",
  "pair_maintenance_journal_size_invalid",
  "pair_maintenance_journal_changed",
  "pair_journal_unsafe",
  "pair_journal_size_invalid",
  "pair_journal_changed",
  "triple_pm2_dump_unsafe",
  "triple_pm2_dump_size_invalid",
  "triple_pm2_dump_changed",
  "triple_pm2_dump_after_sync_unsafe",
  "triple_pm2_dump_after_sync_size_invalid",
  "triple_pm2_dump_after_sync_changed",
  "provenance_unsafe",
  "provenance_size_invalid",
  "provenance_changed",
  "oid_pair_artifact_entry_unsafe",
  "pair_maintenance_root_not_absolute",
  "pair_maintenance_root_unsafe",
  "pair_maintenance_root_not_canonical",
  "ELOOP",
  "ENOTDIR",
  "ESRCH",
  "triple_node_unsafe",
  "triple_node_size_invalid",
  "triple_node_changed",
  "triple_pm2_unsafe",
  "triple_pm2_size_invalid",
  "triple_pm2_changed",
  "triple_mode_file_unsafe",
  "triple_mode_file_size_invalid",
  "triple_mode_file_changed",
  "oid_triple_pm2_dump_invalid",
  "oid_triple_pm2_dump_slot_ambiguous",
  "oid_triple_pm2_dump_slot_changed",
  "oid_triple_pm2_dump_environment_changed",
  "oid_triple_persistence_child_changed",
  "oid_triple_persistence_stop_changed",
  "oid_triple_pm2_dump_unsafe",
  "oid_triple_pm2_persistence_changed",
  "oid_triple_pm2_dump_changed",
  "oid_triple_pm2_home_invalid",
  "oid_triple_pm2_authority_not_canonical",
  "oid_triple_supervisor_changed",
  "dependency_tree_privileged_mode",
  "dependency_tree_root_owner_mode",
  "dependency_tree_writable",
  "dependency_tree_changed",
  "dependency_tree_shared_hardlink",
  "dependency_tree_absolute_link",
  "dependency_tree_link_escape",
  "dependency_tree_unresolved_link",
  "dependency_tree_invalid_root",
  "dependency_tree_special_file",
  "oid_triple_start_not_intended",
  "oid_triple_start_generations_unverified",
  "oid_triple_stopped_slot_changed",
  "oid_triple_saved_environment_drift",
  "oid_triple_boot_environment_not_applied",
  "EPIPE",
  "ERR_STREAM_DESTROYED"
]);
var SAFE_STOP_DIAGNOSTIC_STAGES = /* @__PURE__ */ new Set([
  "options_invalid",
  "validate_stop_failed",
  "native_runtime_invalid",
  "native_interpreter_mismatch",
  "native_open_failed"
]);
function oidTripleSafeDiagnosticReason(error) {
  for (const value of [error?.code, error?.message]) if (SAFE_STOP_DIAGNOSTIC_CODES.has(value)) return value;
  return "unknown";
}
function createOidTripleSafeDiagnostic() {
  const prefixes = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, truncated = { stdout: false, stderr: false };
  return {
    capture(channel, chunk) {
      if (!Object.hasOwn(prefixes, channel)) throw new Error("oid_triple_diagnostic_channel_invalid");
      const remaining2 = 8192 - prefixes[channel].length;
      if (Buffer.byteLength(chunk) > remaining2) truncated[channel] = true;
      if (remaining2 > 0) prefixes[channel] = Buffer.concat([prefixes[channel], Buffer.from(chunk).subarray(0, remaining2)]);
    },
    summarize(status, signal) {
      let reason = "unknown", stage = null;
      for (const channel of ["stderr", "stdout"]) {
        let text = prefixes[channel].toString("utf8");
        if (truncated[channel]) text = text.slice(0, text.lastIndexOf("\n") + 1);
        for (const line of text.split(/\r?\n/)) {
          const code = line.startsWith("Error: ") ? line.slice(7) : line;
          if (reason === "unknown" && SAFE_STOP_DIAGNOSTIC_CODES.has(code)) reason = code;
          if (line.startsWith("OID_TRIPLE_STOP_STAGE:") && SAFE_STOP_DIAGNOSTIC_STAGES.has(line.slice(22))) stage = line.slice(22);
        }
      }
      return {
        schema: "nassaj-oid-safe-stop-diagnostic/v1",
        exitCode: Number.isInteger(status) && status >= 0 && status <= 255 ? status : null,
        signal: ["SIGKILL", "SIGTERM", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGINT", "SIGPIPE"].includes(signal) ? signal : null,
        reason,
        ...stage ? { stage } : {}
      };
    }
  };
}
function runSafe(bytes, args, record) {
  return new Promise((resolve, reject2) => {
    const child = spawn2("/usr/bin/bash", ["-c", [
      "set -o pipefail",
      'script="$(/usr/bin/cat <&3)" || exit 97',
      // V2's writer guard must not see a sibling printf still feeding an unread script tail.
      args[0] === "--oid-triple-phase" && record.pair ? 'exec /usr/bin/bash -s -- "$@" <<< "$script"' : '/usr/bin/printf "%s\\n" "$script" | /usr/bin/bash -s -- "$@"'
    ].join("; "), "capsule-safe-restart", ...args], {
      cwd: record.repoRoot,
      env: {
        ...process.env,
        NASSAJ_CAPSULE_MODE_ABI: record.capsuleModeAbi,
        ...record.pair ? {
          NASSAJ_OID_PAIR_SEQUENCE: String(record.pair.sequence),
          NASSAJ_OID_PAIR_TARGET_DIGEST: record.pair.targetDigest,
          NASSAJ_OID_PAIR_OWNER_ID: String(record.pair.ownerId),
          NASSAJ_OID_ACTION_ID: record.actionId,
          NASSAJ_OID_ATTEMPT_NONCE: record.transactionNonce
        } : {},
        NASSAJ_CAPSULE_REPO_ROOT: record.repoRoot,
        NASSAJ_CAPSULE_ARTIFACT_ROOT: record.artifactRoot
      },
      stdio: ["ignore", "pipe", "pipe", "pipe"]
    });
    const diagnostic = args[0] === "--oid-triple-phase" && ["stop", "start-target", "start-previous"].includes(args[1]) ? createOidTripleSafeDiagnostic() : null;
    let stdout = "";
    let stderr = "";
    let pipeError = null;
    child.stdout.on("data", (chunk) => {
      if (diagnostic) diagnostic.capture("stdout", chunk);
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (diagnostic) diagnostic.capture("stderr", chunk);
      else stderr += chunk;
    });
    child.stdio[3].on("error", (error) => {
      pipeError = error;
    });
    child.stdio[3].end(bytes);
    child.on("error", reject2);
    child.on("close", (code, signal) => resolve({ status: code, signal, stdout, stderr, pipeError, ...diagnostic ? { diagnostic: diagnostic.summarize(code, signal) } : {} }));
  });
}
function parseProcessStartTicks(raw) {
  if (typeof raw !== "string") return null;
  const commandEnd = raw.lastIndexOf(")");
  if (commandEnd < 2) return null;
  const fields = raw.slice(commandEnd + 2).trim().split(/\s+/);
  const startTicks = fields[19];
  return /^\d+$/.test(startTicks || "") ? startTicks : null;
}
function processStartTicks(pid) {
  try {
    return parseProcessStartTicks(readFileSync2(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}
async function health(expected, attempts = 90) {
  attempts = Number(process.env.NASSAJ_OID_HEALTH_ATTEMPTS || attempts);
  const interval = Number(process.env.NASSAJ_OID_HEALTH_INTERVAL_MS || 500);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(process.env.NASSAJ_PREVIEW_HEALTH_URL || "http://127.0.0.1:3004/health", {
        signal: AbortSignal.timeout(3e3)
      });
      const body = response.ok ? await response.json() : null;
      if (body?.status === "ok" && body.serverLoadedOid === expected.oid && body.serverLoadedBuildId === expected.buildId && body.serverTransactionNonce === expected.transactionNonce && body.serverBootNonce === expected.bootNonce && String(body.serverProcessStartTicks || "") !== String(expected.oldStartTicks || "")) return body;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return null;
}
function activeTransactions(repoRoot) {
  const gitRoot = gitControlRoot(repoRoot);
  return readdirSync2(gitRoot).filter((name) => name.startsWith("nassaj-oid-control-transaction-") && name.endsWith(".json")).map((name) => ({
    file: path12.join(gitRoot, name),
    value: pinnedJson(path12.join(gitRoot, name), "transaction_journal")
  })).filter((entry) => {
    if (entry.value.kind === "client-publication" || entry.value.schema === CLIENT_PUBLICATION_JOURNAL_SCHEMA) return !validateClientPublicationJournal(repoRoot, entry).terminal;
    return ["pair_served", "pair_rolled_back"].includes(entry.value.state) ? !validateOidPairTerminal(repoRoot, entry) : !TERMINAL.has(entry.value.state);
  });
}
async function rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes, alreadyRestored = false }) {
  durable(journalFile, { ...base, state: "rollback_prepared", rollbackPreparedAt: (/* @__PURE__ */ new Date()).toISOString() });
  if (!alreadyRestored) {
    await exchange(artifactRoot, liveRoot);
    fsyncDir(path12.dirname(liveRoot));
  }
  const restored = provenance(liveRoot);
  if (restored.commit !== base.previousOid || restored.buildId !== base.previousBuildId) {
    durable(journalFile, { ...base, state: "manual_recovery_required", reason: "rollback_layout_ambiguous" });
    return false;
  }
  const rollbackBootNonce = randomBytes4(32).toString("hex");
  durable(journalFile, { ...base, state: "rollback_prepared", rollbackBootNonce, layoutRestored: true });
  const restart = await runSafe(safeBytes, [
    "--set",
    "TMPDIR=/var/tmp",
    "--set",
    `NASSAJ_PREVIEW_TRANSACTION_NONCE=${base.transactionNonce}`,
    "--set",
    `NASSAJ_PREVIEW_BOOT_NONCE=${rollbackBootNonce}`,
    "--exec"
  ], { ...record, artifactRoot: liveRoot });
  if (restart.pipeError) {
    durable(journalFile, { ...base, state: "manual_recovery_required", reason: "rollback_fd3_incomplete" });
    return false;
  }
  if ([3, 6].includes(restart.status)) {
    durable(journalFile, { ...base, state: "rollback_prepared", rollbackBootNonce, restartDeferred: restart.status });
    return false;
  }
  const attested = await health({
    oid: base.previousOid,
    buildId: base.previousBuildId,
    transactionNonce: base.transactionNonce,
    bootNonce: rollbackBootNonce,
    oldStartTicks: base.oldStartTicks
  });
  if (!attested) {
    durable(journalFile, { ...base, state: "manual_recovery_required", reason: "previous_attestation_failed" });
    return false;
  }
  durable(journalFile, {
    ...base,
    state: "rolled_back",
    rollbackBootNonce,
    newPid: attested.pid,
    newStartTicks: attested.serverProcessStartTicks
  });
  return true;
}
async function resumeActiveTransaction(repoRoot, liveRoot, record, safeBytes, active) {
  const { file: journalFile, value: base } = active;
  const artifactRoot = directDirectory(
    path12.join(repoRoot, ".nassaj-local-preview", "server-candidates"),
    base.candidatePath,
    "resume_candidate"
  );
  if (base.livePath !== liveRoot || !HEX403.test(base.oid || "") || !HEX643.test(base.buildId || "") || !HEX403.test(base.previousOid || "") || !HEX643.test(base.previousBuildId || "") || !HEX643.test(base.transactionNonce || "")) throw new Error("resume_transaction_identity_invalid");
  const live = provenance(liveRoot);
  let state = null;
  if (["launch_prepared", "executor_ready", "prepared"].includes(base.state) && live.commit === base.previousOid && live.buildId === base.previousBuildId) {
    state = "restart_deferred_restored";
    durable(journalFile, { ...base, state, resumedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } else if (["prepared", "exchanged", "smoke_passed"].includes(base.state) && live.commit === base.oid && live.buildId === base.buildId) {
    await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
    state = pinnedJson(journalFile, "resumed_journal").state;
  } else if (["recovery_prepared", "recovered"].includes(base.state) && live.commit === base.oid && live.buildId === base.buildId) {
    const attested = base.bootNonce ? await health({
      oid: base.oid,
      buildId: base.buildId,
      transactionNonce: base.transactionNonce,
      bootNonce: base.bootNonce,
      oldStartTicks: base.oldStartTicks
    }) : null;
    if (attested) {
      if (base.state === "recovery_prepared") {
        durable(journalFile, {
          ...base,
          state: "recovered",
          bootNonce: base.bootNonce,
          newPid: attested.pid,
          newStartTicks: attested.serverProcessStartTicks,
          resumedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
      state = "served";
      durable(journalFile, {
        ...base,
        state,
        bootNonce: base.bootNonce,
        newPid: attested.pid,
        newStartTicks: attested.serverProcessStartTicks,
        resumedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    } else {
      await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
      state = pinnedJson(journalFile, "resumed_journal").state;
    }
  } else if (base.state === "rollback_prepared" && live.commit === base.previousOid && live.buildId === base.previousBuildId) {
    await rollbackAndAttest({
      artifactRoot,
      liveRoot,
      journalFile,
      base,
      record,
      safeBytes,
      alreadyRestored: true
    });
    state = pinnedJson(journalFile, "resumed_journal").state;
  } else if (base.state === "rollback_prepared" && live.commit === base.oid && live.buildId === base.buildId) {
    await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
    state = pinnedJson(journalFile, "resumed_journal").state;
  } else {
    state = "manual_recovery_required";
    durable(journalFile, { ...base, state, reason: "resume_layout_ambiguous" });
  }
  durable(record.handshakePath, {
    schema: 1,
    state: "executor_ready",
    launcherNonce: record.transactionNonce,
    transactionNonce: base.transactionNonce,
    sequence: base.sequence,
    oid: base.oid,
    buildId: base.buildId,
    journalFile
  });
  return state;
}
async function main() {
  const record = JSON.parse(readFd(4, 64 * 1024).toString("utf8"));
  const safeBytes = readFd(3);
  const repoRoot = canonicalRoot(record.repoRoot, "repo_root");
  const liveRoot = canonicalRoot(record.liveRoot, "live_root");
  if (liveRoot !== path12.join(repoRoot, "dist-server") || !HEX643.test(record.transactionNonce || "") || !HEX643.test(record.safeRestartSha256 || "") || sha2(safeBytes) !== record.safeRestartSha256 || record.capsuleModeAbi !== "nassaj-capsule-roots/v1") {
    throw new Error("capsule_record_identity_invalid");
  }
  if (record.actionId && !HEX643.test(record.expectedBuildId || "")) {
    throw new Error("action_expected_build_required");
  }
  if (record.pair) {
    await runOidPairTransaction(record, safeBytes);
    return;
  }
  const gitRoot = gitControlRoot(repoRoot);
  const lock = lstatSync2(path12.join(gitRoot, "nassaj-preview-event-mutation.lock"));
  if (!lock.isFile() || lock.isSymbolicLink() || String(lock.dev) !== record.lockIdentity?.dev || String(lock.ino) !== record.lockIdentity?.ino) throw new Error("event_lock_identity_mismatch");
  const active = activeTransactions(repoRoot);
  if (active.length > 1) throw new Error("multiple_oid_control_transactions_in_progress");
  if (active.length === 1) {
    if (record.actionId && record.expectedBuildId !== active[0].value.buildId) {
      throw new Error("action_candidate_superseded");
    }
    const activeLive = provenance(liveRoot);
    const control2 = exactControlState(repoRoot, {
      artifactRoot: activeLive.commit === active[0].value.oid && activeLive.buildId === active[0].value.buildId ? liveRoot : active[0].value.candidatePath
    });
    if (control2.request.sequence !== active[0].value.sequence || control2.request.oid !== active[0].value.oid || control2.request.buildId !== active[0].value.buildId || control2.request.controlManifestSha256 !== active[0].value.controlManifestSha256) {
      throw new Error("resume_control_identity_mismatch");
    }
    await resumeActiveTransaction(repoRoot, liveRoot, record, safeBytes, active[0]);
    return;
  }
  const control = exactControlState(repoRoot);
  const { request, artifactRoot } = control;
  if (record.actionId && record.expectedBuildId !== request.buildId) {
    throw new Error("action_candidate_superseded");
  }
  if (statSync(artifactRoot).dev !== statSync(liveRoot).dev) throw new Error("candidate_cross_device");
  const candidate = provenance(artifactRoot);
  const previous = provenance(liveRoot);
  const nonce = record.transactionNonce;
  const disposition = record.disposition ? resolveDispositionLink(repoRoot, record.disposition, request) : null;
  const journalFile = path12.join(gitRoot, `nassaj-oid-control-transaction-${request.sequence}-${nonce}.json`);
  const base = {
    schema: "nassaj-oid-control-transaction/v1",
    sequence: request.sequence,
    group: request.group,
    eventGroup: request.group,
    oid: request.oid,
    buildId: request.buildId,
    previousOid: previous.commit,
    previousBuildId: previous.buildId,
    candidatePath: artifactRoot,
    livePath: liveRoot,
    transactionNonce: nonce,
    controlManifestSha256: request.controlManifestSha256,
    lockIdentity: record.lockIdentity,
    oldPid: record.oldPid,
    oldStartTicks: record.oldStartTicks,
    actionId: /^[a-f0-9-]{36}$/.test(record.actionId || "") ? record.actionId : null,
    ...disposition ? { disposition } : {}
  };
  durableCreate(journalFile, { ...base, state: "launch_prepared", at: (/* @__PURE__ */ new Date()).toISOString() });
  durable(journalFile, { ...base, state: "executor_ready", at: (/* @__PURE__ */ new Date()).toISOString() });
  durable(record.handshakePath, {
    schema: 1,
    state: "executor_ready",
    launcherNonce: nonce,
    transactionNonce: nonce,
    sequence: request.sequence,
    oid: request.oid,
    buildId: request.buildId,
    journalFile
  });
  const gate1 = await runSafe(safeBytes, ["--json"], { ...record, artifactRoot });
  if (gate1.pipeError) throw new Error("pre_exchange_fd3_incomplete");
  if ([3, 6].includes(gate1.status)) {
    durable(journalFile, { ...base, state: "restart_deferred_restored", gate: gate1.status });
    return;
  }
  if (gate1.status !== 0) throw new Error(`pre_exchange_gate_failed:${gate1.status}`);
  const rechecked = exactControlState(repoRoot);
  if (rechecked.request.sequence !== request.sequence || rechecked.request.oid !== request.oid || rechecked.request.buildId !== request.buildId || rechecked.request.controlManifestSha256 !== request.controlManifestSha256 || rechecked.artifactRoot !== artifactRoot) throw new Error("control_changed_before_exchange");
  durable(journalFile, { ...base, state: "prepared" });
  await exchange(artifactRoot, liveRoot);
  fsyncDir(path12.dirname(liveRoot));
  const promoted = provenance(liveRoot);
  if (promoted.commit !== request.oid || promoted.buildId !== request.buildId) throw new Error("post_exchange_identity_mismatch");
  durable(journalFile, { ...base, state: "exchanged" });
  injectFailure("after_exchange");
  const gate2 = await runSafe(safeBytes, ["--json"], { ...record, artifactRoot: liveRoot });
  if (gate2.pipeError) {
    await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
    throw new Error("post_exchange_fd3_incomplete");
  }
  if ([3, 6].includes(gate2.status)) {
    durable(journalFile, { ...base, state: "rollback_prepared", gate: gate2.status });
    await exchange(artifactRoot, liveRoot);
    fsyncDir(path12.dirname(liveRoot));
    durable(journalFile, { ...base, state: "restart_deferred_restored", gate: gate2.status });
    return;
  }
  if (gate2.status !== 0) {
    await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
    throw new Error(`post_exchange_gate_failed:${gate2.status}`);
  }
  durable(journalFile, { ...base, state: "smoke_passed" });
  injectFailure("after_smoke");
  const bootNonce = randomBytes4(32).toString("hex");
  durable(journalFile, { ...base, state: "recovery_prepared", bootNonce });
  const restart = await runSafe(safeBytes, [
    "--set",
    "TMPDIR=/var/tmp",
    "--set",
    `NASSAJ_PREVIEW_TRANSACTION_NONCE=${nonce}`,
    "--set",
    `NASSAJ_PREVIEW_BOOT_NONCE=${bootNonce}`,
    "--exec"
  ], { ...record, artifactRoot: liveRoot });
  if (restart.pipeError) {
    await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
    return;
  }
  if ([3, 6].includes(restart.status)) {
    durable(journalFile, { ...base, state: "rollback_prepared", gate: restart.status, bootNonce });
    await exchange(artifactRoot, liveRoot);
    fsyncDir(path12.dirname(liveRoot));
    durable(journalFile, { ...base, state: "restart_deferred_restored", gate: restart.status, bootNonce });
    return;
  }
  const attested = await health({
    oid: request.oid,
    buildId: request.buildId,
    transactionNonce: nonce,
    bootNonce,
    oldStartTicks: record.oldStartTicks
  });
  if (attested) {
    durable(journalFile, {
      ...base,
      state: "recovered",
      bootNonce,
      newPid: attested.pid,
      newStartTicks: attested.serverProcessStartTicks
    });
    injectFailure("after_recovered");
    durable(journalFile, {
      ...base,
      state: "served",
      bootNonce,
      newPid: attested.pid,
      newStartTicks: attested.serverProcessStartTicks
    });
    injectFailure("after_served");
    return;
  }
  await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
}
var PAIR_PHASES = /* @__PURE__ */ new Set([
  "OID_DRAINING",
  "OID_QUIESCENT",
  "OID_EXCHANGING",
  "OID_BOOTSTRAP_VERIFYING",
  "OID_PAIR_VERIFIED",
  "OID_RECOVERING"
]);
function pairCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(pairCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${pairCanonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function pairChecksum(value) {
  const { checksum: ignored, ...fields } = value;
  return sha2(pairCanonical(fields));
}
function pairPaths(root) {
  const gitRoot = gitControlRoot(root);
  const controlRoot = path12.join(gitRoot, "nassaj-source-update");
  canonicalRoot(controlRoot, "pair_maintenance_root");
  return {
    root,
    gitRoot,
    controlRoot,
    journal: path12.join(controlRoot, "journal.json"),
    admission: path12.join(controlRoot, "admission.lock"),
    activity: path12.join(controlRoot, "activity.lock")
  };
}
function pairReadMaintenance(paths) {
  const value = pinnedJson(paths.journal, "pair_maintenance_journal", { mode: 384 });
  if (value.schema !== "nassaj-source-update-maintenance/v1" || value.checksum !== pairChecksum(value) || !Number.isSafeInteger(value.sequence)) throw new Error("oid_pair_maintenance_invalid");
  return value;
}
function pairWriteMaintenance(paths, before, patch) {
  const current = pairReadMaintenance(paths);
  if (current.sequence !== before.sequence || current.checksum !== before.checksum) throw new Error("oid_pair_maintenance_cas");
  const next = { ...current, ...patch, sequence: current.sequence + 1, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  next.checksum = pairChecksum(next);
  durable(paths.journal, next);
  return next;
}
function pairProcessIdentity(pid = process.pid) {
  return {
    pid,
    startTime: processStartTicks(pid),
    bootId: readFileSync2("/proc/sys/kernel/random/boot_id", "utf8").trim()
  };
}
function pairOwnerAlive(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || typeof owner.startTime !== "string" || !/^\d+$/.test(owner.startTime)) return false;
  try {
    return owner?.bootId === readFileSync2("/proc/sys/kernel/random/boot_id", "utf8").trim() && owner.startTime === processStartTicks(owner.pid);
  } catch {
    return false;
  }
}
function pairJournal(paths, identity2) {
  if (!Number.isSafeInteger(identity2?.sequence) || identity2.sequence < 1 || !HEX643.test(identity2.transactionNonce || "") || identity2.journalBasename !== `nassaj-oid-control-transaction-${identity2.sequence}-${identity2.transactionNonce}.json`) {
    throw new Error("oid_pair_link_invalid");
  }
  const file = path12.join(paths.gitRoot, identity2.journalBasename);
  const bytes = pinnedFile(file, "pair_journal").bytes;
  const value = JSON.parse(bytes);
  const triple = value.pair?.target?.schema === "nassaj-oid-triple-target/v2";
  if (value.schema !== (triple ? "nassaj-oid-control-transaction/v2" : "nassaj-oid-control-transaction/v1") || triple && JSON.stringify(value.generationNames) !== JSON.stringify(UPDATE_GENERATION_NAMES) || value.sequence !== identity2.sequence || value.transactionNonce !== identity2.transactionNonce || value.pair?.targetDigest !== identity2.targetDigest || value.oid !== identity2.oid || value.pair?.target?.clientBuildId !== identity2.targetClientBuildId || value.pair?.target?.serverBuildId !== identity2.targetServerBuildId) throw new Error("oid_pair_counterpart_mismatch");
  return { file, bytes, value };
}
function validateOidPairMaintenance(root, maintenance) {
  if (maintenance.identity?.kind !== "oid-pair") return null;
  const paths = pairPaths(root), identity2 = maintenance.identity.oid;
  if (maintenance.checksum !== pairChecksum(maintenance) || !PAIR_PHASES.has(maintenance.phase)) throw new Error("oid_pair_maintenance_invalid");
  const journal = pairJournal(paths, identity2);
  if (["pair_served", "pair_rolled_back"].includes(journal.value.state) && !validateOidPairTerminal(root, journal)) throw new Error("oid_pair_receipt_invalid");
  if (!maintenance.gateClosed || maintenance.state === "OPEN") {
    const completion = maintenance.oidCompletion, receipt = journal.value.pair?.receipt;
    const rollback = journal.value.state === "pair_rolled_back";
    const verified = rollback ? journal.value.pair.previous : journal.value.pair.target;
    if (maintenance.gateClosed || maintenance.state !== "OPEN" || !["pair_served", "pair_rolled_back"].includes(journal.value.state) || !completion || !receipt || completion.terminalJournalSha256 !== sha2(journal.bytes) || completion.receiptSha256 !== sha2(pairCanonical(receipt)) || receipt.targetDigest !== identity2.targetDigest || receipt.transactionNonce !== identity2.transactionNonce || completion.transactionNonce !== identity2.transactionNonce || receipt.clientBuildId !== verified.clientBuildId || receipt.serverBuildId !== verified.serverBuildId || receipt.outcome !== (rollback ? "rolled_back" : "activated") || maintenance.databaseState !== (rollback ? "PRE_CANDIDATE" : "TARGET_VERIFIED")) throw new Error("oid_pair_open_unverified");
  }
  return journal.value;
}
async function pairLock(file, waitMs = 3e4) {
  const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 384);
  const st = fstatSync(fd);
  if (!st.isFile() || st.uid !== process.getuid() || st.mode & 18) {
    closeSync(fd);
    throw new Error("oid_pair_lock_unsafe");
  }
  const child = spawn2("/usr/bin/flock", ["-x", "-w", String(waitMs / 1e3), "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
  try {
    await new Promise((resolve, reject2) => {
      child.once("error", reject2);
      child.once("exit", (code) => code === 0 ? resolve() : reject2(new Error("oid_pair_lock_contended")));
    });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let released = false;
  return { release() {
    if (released) return;
    released = true;
    closeSync(fd);
  } };
}
async function beginOidPairAdmission(root, identity2, { waitMs = 3e4, intent = null } = {}) {
  const paths = pairPaths(root);
  if (process.env.NASSAJ_UPDATE_MODE !== "local-main" || !HEX403.test(identity2?.oid || "") || !HEX643.test(identity2?.targetDigest || "") || !HEX643.test(identity2?.transactionNonce || "") || !Number.isSafeInteger(identity2.sequence) || identity2.sequence < 1 || identity2.group !== `event-${String(identity2.sequence).padStart(16, "0")}` || !HEX643.test(identity2.targetClientBuildId || "") || !HEX643.test(identity2.targetServerBuildId || "") || identity2.journalBasename !== `nassaj-oid-control-transaction-${identity2.sequence}-${identity2.transactionNonce}.json`) throw new Error("oid_pair_identity_invalid");
  if (process.env.NASSAJ_STARTUP_ADMISSION_FD || process.env.NASSAJ_UPDATE_CAPABILITY_FILE) throw new Error("oid_pair_root_runtime_refused");
  const admission = await pairLock(paths.admission, waitMs);
  const held = [admission];
  let current;
  let original;
  try {
    current = pairReadMaintenance(paths);
    original = current;
    if (current.state !== "OPEN" || current.gateClosed || current.degraded) throw new Error("oid_pair_maintenance_busy");
    validateOidPairMaintenance(root, current);
    if (current.oidAdmissionIntent) throw new Error("oid_pair_admission_intent_pending");
    if (intent) {
      current = pairWriteMaintenance(paths, current, { oidAdmissionIntent: {
        schema: "nassaj-oid-admission-intent/v1",
        identity: identity2,
        owner: pairProcessIdentity(),
        previousMaintenance: original,
        transaction: intent
      } });
      injectFailure("pair_after_admission_intent");
    }
    current = pairWriteMaintenance(paths, current, {
      state: "DRAINING",
      gateClosed: true,
      phase: "OID_DRAINING",
      transactionId: identity2.transactionNonce,
      identity: { kind: "oid-pair", oid: identity2 },
      owner: { ...pairProcessIdentity(), epoch: identity2.transactionNonce, tokenDigest: current.tokenDigest },
      databaseState: "PRE_CANDIDATE",
      oidCompletion: null
    });
    injectFailure("pair_after_draining");
    held.push(await pairLock(paths.activity, waitMs));
    current = pairWriteMaintenance(paths, current, { state: "UPDATING", phase: "OID_QUIESCENT" });
    injectFailure("pair_after_quiescent");
    let released = false;
    return {
      paths,
      original,
      get journal() {
        return current;
      },
      transition(patch) {
        if (released) throw new Error("oid_pair_ownership_released");
        current = pairWriteMaintenance(paths, current, patch);
        return current;
      },
      async lockPublishers() {
        for (const name of ["nassaj-local-preview-build.lock", "nassaj-client-build.lock", "nassaj-preview-event-mutation.lock"]) held.push(await pairLock(path12.join(paths.gitRoot, name), waitMs));
      },
      release() {
        if (released) return;
        released = true;
        for (const lock of held.reverse()) lock.release();
      }
    };
  } catch (error) {
    if (!intent && current?.phase === "OID_DRAINING" && current.transactionId === identity2.transactionNonce) {
      try {
        const { checksum: oldChecksum, sequence: oldSequence, ...previous } = original;
        pairWriteMaintenance(paths, current, previous);
      } catch {
      }
    }
    for (const lock of held.reverse()) lock.release();
    throw error;
  }
}
async function beginBootstrapOidAdmission(root, identity2, intent, claimOperation, waitMs = 3e4) {
  if (process.env.NASSAJ_UPDATE_MODE !== "release" || typeof claimOperation !== "function") throw new Error("oid_bootstrap_admission_context_invalid");
  const paths = pairPaths(root), held = [], publisherNames = ["nassaj-local-preview-build.lock", "nassaj-client-build.lock", "nassaj-preview-event-mutation.lock"];
  let current, original, consumed, claimedTransaction, maintenanceWritten = false, released = false;
  try {
    held.push(await pairLock(paths.admission, waitMs));
    held.push(await pairLock(paths.activity, waitMs));
    for (const name of publisherNames) held.push(await pairLock(path12.join(paths.gitRoot, name), waitMs));
    current = pairReadMaintenance(paths);
    original = current;
    if (current.state !== "OPEN" || current.gateClosed || current.degraded || current.oidAdmissionIntent) throw new Error("oid_pair_maintenance_busy");
    validateOidPairMaintenance(root, current);
    consumed = await claimOperation();
    if (!consumed?.claim || !consumed.ticket || !HEX643.test(consumed.sha256 || "")) throw new Error("oid_bootstrap_claim_invalid");
    claimedTransaction = { ...intent, bootstrapPending: false, bootstrap: bootstrapJournalBinding(consumed.ticket, consumed) };
    durableCreate(path12.join(paths.gitRoot, identity2.journalBasename), claimedTransaction);
    current = pairWriteMaintenance(paths, current, { oidAdmissionIntent: {
      schema: "nassaj-oid-admission-intent/v1",
      identity: identity2,
      owner: pairProcessIdentity(),
      previousMaintenance: original,
      transaction: claimedTransaction
    } });
    maintenanceWritten = true;
    injectFailure("bootstrap_after_admission_intent");
    current = pairWriteMaintenance(paths, current, {
      state: "DRAINING",
      gateClosed: true,
      phase: "OID_DRAINING",
      transactionId: identity2.transactionNonce,
      identity: { kind: "oid-pair", oid: identity2 },
      owner: { ...pairProcessIdentity(), epoch: identity2.transactionNonce, tokenDigest: current.tokenDigest },
      databaseState: "PRE_CANDIDATE",
      oidCompletion: null
    });
    injectFailure("bootstrap_after_draining");
    current = pairWriteMaintenance(paths, current, { state: "UPDATING", phase: "OID_QUIESCENT" });
    return {
      paths,
      original,
      consumed,
      claimedTransaction,
      get journal() {
        return current;
      },
      transition(patch) {
        if (released) throw new Error("oid_pair_ownership_released");
        current = pairWriteMaintenance(paths, current, patch);
        return current;
      },
      async lockPublishers() {
      },
      release() {
        if (released) return;
        released = true;
        for (const lock of held.reverse()) lock.release();
      }
    };
  } catch (error) {
    if (consumed && !maintenanceWritten) {
      const file = path12.join(path12.dirname(consumed.file), "bootstrap-aborted-pre-effect.json");
      durableCreate(file, bootstrapAbortReceipt(consumed.sha256, identity2.transactionNonce));
      const journal = path12.join(paths.gitRoot, identity2.journalBasename);
      if (fs13.existsSync(journal)) durable(journal, { ...claimedTransaction, state: "aborted_pre_effect" });
    }
    for (const lock of held.reverse()) lock.release();
    throw error;
  }
}
function completeOidPairAdmission(root, handle) {
  const current = pairReadMaintenance(handle.paths);
  if (current.identity?.oid?.transactionNonce !== handle.journal.identity?.oid?.transactionNonce) throw new Error("oid_pair_completion_superseded");
  if (current.state === "OPEN") {
    validateOidPairMaintenance(root, current);
    return current;
  }
  const identity2 = current.identity?.oid;
  if (!identity2 || !pairOwnerAlive(current.owner) || current.owner.pid !== process.pid) throw new Error("oid_pair_owner_mismatch");
  const terminal = pairJournal(handle.paths, identity2), receipt = terminal.value.pair?.receipt;
  const rollback = terminal.value.state === "pair_rolled_back";
  const verified = rollback ? terminal.value.pair.previous : terminal.value.pair.target;
  pairVerifyLive(root, { ...identity2, targetClientBuildId: verified.clientBuildId, targetServerBuildId: verified.serverBuildId }, verified);
  if (!["pair_served", "pair_rolled_back"].includes(terminal.value.state) || receipt?.outcome !== (rollback ? "rolled_back" : "activated")) throw new Error("oid_pair_terminal_required");
  const patch = {
    state: "OPEN",
    gateClosed: false,
    phase: "OID_PAIR_VERIFIED",
    databaseState: rollback ? "PRE_CANDIDATE" : "TARGET_VERIFIED",
    owner: null,
    oidAdmissionIntent: null,
    oidCompletion: {
      transactionNonce: identity2.transactionNonce,
      targetDigest: identity2.targetDigest,
      terminalJournalSha256: sha2(terminal.bytes),
      receiptSha256: sha2(pairCanonical(receipt))
    }
  };
  const proposed = { ...current, ...patch };
  proposed.checksum = pairChecksum(proposed);
  validateOidPairMaintenance(root, proposed);
  const result = handle.transition(patch);
  handle.release();
  return result;
}
function inspectOidBootstrapAdmission(root, applicationPath, runtimeNonce = process.env.NASSAJ_PREVIEW_TRANSACTION_NONCE, { databasePath } = {}) {
  const paths = pairPaths(root), maintenance = pairReadMaintenance(paths);
  if (maintenance.identity?.kind !== "oid-pair") return null;
  const journal = validateOidPairMaintenance(root, maintenance), identity2 = maintenance.identity.oid;
  if (maintenance.state === "OPEN") return null;
  const rollback = journal.schema === "nassaj-oid-control-transaction/v2" && journal.bootDirection === "previous" && journal.pair.databaseState === "PRE_CANDIDATE";
  const databaseState = rollback ? "PRE_CANDIDATE" : "UNKNOWN";
  if (maintenance.phase !== "OID_BOOTSTRAP_VERIFYING" || maintenance.databaseState !== databaseState || identity2.transactionNonce !== runtimeNonce || !pairOwnerAlive(maintenance.owner) || maintenance.owner.pid === process.pid || journal.pair?.databaseState !== databaseState) throw new Error("oid_pair_bootstrap_not_granted");
  if (applicationPath !== path12.join(root, "dist-server/server/application.js") || realpathSync3(applicationPath) !== applicationPath) throw new Error("oid_pair_bootstrap_application_invalid");
  const snapshot = journal.pair.snapshot;
  if (!databasePath || snapshot?.databasePath !== path12.resolve(databasePath) || snapshot.transactionId !== runtimeNonce || snapshot.targetCommit !== identity2.oid || snapshot.phase !== "CAPTURED" || sha2(pinnedFile(snapshot.snapshotFile, "pair_bootstrap_snapshot", { mode: 384, maxSize: Number.MAX_SAFE_INTEGER }).bytes) !== snapshot.snapshotFingerprint?.sha256) throw new Error("oid_pair_bootstrap_database_unverified");
  const database = lstatSync2(databasePath);
  if (!database.isFile() || database.isSymbolicLink() || String(database.dev) !== snapshot.sourceIdentity?.dev || String(database.ino) !== snapshot.sourceIdentity?.ino) throw new Error("oid_pair_bootstrap_database_changed");
  const selected = rollback ? journal.pair.previous : journal.pair.target;
  pairVerifyLive(root, { ...identity2, targetServerBuildId: selected.serverBuildId, targetClientBuildId: selected.clientBuildId }, selected);
  const manifest = pinnedJson(path12.join(root, "dist-server/OID_CONTROL_MANIFEST.json"), "pair_bootstrap_manifest", { sha256: selected.controlManifestSha256 });
  const triple = journal.pair.target.schema === "nassaj-oid-triple-target/v2";
  if (triple) {
    if (rollback) {
      if (manifest.capabilities?.oidTripleAdmissionV2 !== true) throw new Error("oid_triple_previous_bootstrap_unavailable");
    } else verifyOidTripleManifest(manifest, selected);
    assertOidTripleRuntime(selected.installRuntime);
  } else if (manifest.capabilities?.oidPairAdmissionV1 !== true) throw new Error("oid_pair_bootstrap_capability_missing");
  if (!triple && (!HEX643.test(manifest.runtimeDependenciesSha256 || "") || hashOidPairDependencyTree(path12.join(root, "node_modules")) !== manifest.runtimeDependenciesSha256)) throw new Error("oid_pair_dependency_baseline_unverified");
  const loaded = provenance(path12.join(root, "dist-server"));
  const client = provenance(path12.join(root, "dist"));
  if (loaded.commit !== (rollback ? selected.runtime.oid : identity2.oid) || loaded.buildId !== selected.serverBuildId || client.commit !== (rollback ? selected.clientOid : identity2.oid) || client.buildId !== selected.clientBuildId) throw new Error("oid_pair_bootstrap_generation_mismatch");
  const tripleFields = triple ? { rollback, generationNames: UPDATE_GENERATION_NAMES, nodeModulesTreeSha256: selected.nodeModulesTreeSha256 } : {};
  const grant = {
    schema: triple ? "nassaj-oid-triple-bootstrap/v2" : "nassaj-oid-pair-bootstrap/v1",
    ...tripleFields,
    ...pairProcessIdentity(),
    transactionNonce: runtimeNonce,
    targetDigest: identity2.targetDigest,
    serverBuildId: loaded.buildId,
    clientBuildId: client.buildId
  };
  const grantFile = path12.join(paths.controlRoot, `oid-child-${runtimeNonce}.json`);
  try {
    durableCreate(grantFile, grant);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (pairCanonical(pinnedJson(grantFile, "pair_child_grant")) !== pairCanonical(grant)) throw new Error("oid_pair_child_already_claimed");
  }
  const isOpen = () => {
    const next = pairReadMaintenance(paths);
    validateOidPairMaintenance(root, next);
    return next.state === "OPEN" && next.identity?.oid?.transactionNonce === runtimeNonce;
  };
  return Object.freeze({
    kind: "oid-pair",
    schema: grant.schema,
    ...tripleFields,
    sequence: identity2.sequence,
    targetDigest: identity2.targetDigest,
    transactionNonce: runtimeNonce,
    serverBuildId: loaded.buildId,
    clientBuildId: client.buildId,
    normalAdmissionReady: false,
    isOpen,
    async waitForOpen({ signal, timeoutMs = 12e4 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (!signal?.aborted && Date.now() < deadline) {
        if (isOpen()) return pairReadMaintenance(paths).oidCompletion;
        const current = pairReadMaintenance(paths);
        if (pairOwnerProvablyDead(current.owner)) await recoverOidPairAdmission(root);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("oid_pair_open_wait_expired");
    }
  });
}
function hashOidPairTree(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const entries = [];
  function walk(parent, prefix = "") {
    for (const name of readdirSync2(parent).sort()) {
      const file = path12.join(parent, name), relative2 = `${prefix}${name}`;
      const child = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const st = fstatSync(child);
        if (st.isDirectory()) walk(`/proc/self/fd/${child}`, `${relative2}/`);
        else if (st.isFile()) entries.push([relative2, sha2(readFileSync2(child))]);
        else throw new Error("oid_pair_artifact_entry_unsafe");
      } finally {
        closeSync(child);
      }
    }
  }
  try {
    walk(`/proc/self/fd/${fd}`);
  } finally {
    closeSync(fd);
  }
  return sha2(JSON.stringify(entries));
}
function pairVerifyLive(root, identity2, target) {
  const server = path12.join(root, "dist-server"), client = path12.join(root, "dist");
  if (hashOidPairTree(client) !== target.clientTreeSha256 || hashOidPairTree(server) !== target.serverTreeSha256 || provenance(server).buildId !== identity2.targetServerBuildId || provenance(client).buildId !== identity2.targetClientBuildId) {
    throw new Error("oid_pair_live_generation_mismatch");
  }
  if (["nassaj-oid-triple-target/v2", "nassaj-oid-triple-previous/v2"].includes(target.schema) && hashDependencyTreeV2(path12.join(root, "node_modules"), { requireSealed: target.schema === "nassaj-oid-triple-target/v2" }).sha256 !== target.nodeModulesTreeSha256) throw new Error("oid_triple_live_dependencies_mismatch");
}
function verifyOidTripleManifest(manifest, target) {
  validateOidTripleTargetDescriptor(target);
  const dependency = manifest.dependencyGenerationV2;
  if (manifest.capabilities?.oidTripleAdmissionV2 !== true || dependency?.schema !== "nassaj-oid-dependency-generation/v2") throw new Error("triple_activation_unavailable");
  for (const key of ["nodeModulesTreeSha256", "dependencyContractSha256", "packageJsonSha256", "packageLockSha256", "installPolicySha256", "installRuntime"]) {
    if (pairCanonical(dependency[key]) !== pairCanonical(target[key])) throw new Error("oid_triple_manifest_dependencies_mismatch");
  }
  if (computeDependencyContractV2(dependency) !== target.dependencyContractSha256) throw new Error("oid_triple_dependency_contract_invalid");
}
function assertOidTripleRuntime(runtime) {
  if (!runtime || runtime.nodeVersion !== process.version || runtime.nodeModuleAbi !== process.versions.modules || runtime.napi !== process.versions.napi || runtime.platform !== process.platform || runtime.arch !== process.arch || sha2(pinnedFile(realpathSync3(process.execPath), "triple_node_binary", { maxSize: Number.MAX_SAFE_INTEGER }).bytes) !== runtime.nodeBinarySha256) {
    throw new Error("oid_triple_runtime_mismatch");
  }
  return true;
}
var OID_NATIVE_PROBE_PROGRAM = `
const assert = require('node:assert/strict');
const loaded = [];
for (const name of ['bcrypt','argon2','better-sqlite3','esbuild','sharp','@vscode/ripgrep','node-pty','unrs-resolver']) {
  const module = require('/deps/node_modules/' + name);
  if (name === 'better-sqlite3') { const db = new module(':memory:'); try { assert.equal(db.prepare('SELECT 1 AS ok').get().ok, 1); } finally { db.close(); } }
  if (name === 'bcrypt') { const digest = module.hashSync('isolated-native-probe', 4); assert.equal(module.compareSync('isolated-native-probe', digest), true); }
  loaded.push(name);
}
process.stdout.write(JSON.stringify({schema:'nassaj-oid-native-probe/v2',loaded,nodeVersion:process.version,nodeModuleAbi:process.versions.modules}));
`;
var OID_NATIVE_PROBE_NAMESPACE = `
set -euo pipefail
probe_root="$1"; dependencies="$2"; native_program="$3"; original_home="$4"; node_binary="$5"
mount --make-rprivate /
mount --bind "$probe_root" "$probe_root"
mount --rbind -o ro=recursive /usr "$probe_root/usr"
mount --rbind -o ro=recursive "$dependencies" "$probe_root/deps/node_modules"
LIBMOUNT_FORCE_MOUNT2=always mount -t proc -o ro,nosuid,nodev,noexec proc "$probe_root/proc"
for device in null zero random urandom; do
  mount --bind "/dev/$device" "$probe_root/dev/$device"
  mount -o remount,bind,ro "$probe_root/dev/$device"
done
mount --bind "$probe_root/tmp" "$probe_root/tmp"
mount --bind "$probe_root$original_home" "$probe_root$original_home"
mount -o remount,bind,ro "$probe_root"
exec /usr/sbin/chroot "$probe_root" /usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs "$node_binary" --input-type=commonjs -e "$native_program"
`;
function prepareOidNativeProbeRoot(root, nonce) {
  if (!HEX643.test(nonce || "") || !path12.isAbsolute(process.env.HOME || "") || process.env.HOME === "/") throw new Error("oid_native_probe_context_invalid");
  const parent = path12.join(gitControlRoot(root), "nassaj-oid-native-probes");
  fs13.mkdirSync(parent, { recursive: true, mode: 448 });
  if (realpathSync3(parent) !== parent || lstatSync2(parent).uid !== process.getuid() || (lstatSync2(parent).mode & 511) !== 448 || Number(fs13.statfsSync(parent).type) === 16914836) throw new Error("oid_native_probe_storage_unsafe");
  const directory = fs13.mkdtempSync(path12.join(parent, `${nonce}-`));
  for (const name of ["usr", "deps/node_modules", "proc", "dev", "tmp", process.env.HOME.slice(1)]) fs13.mkdirSync(path12.join(directory, name), { recursive: true, mode: 448 });
  for (const name of ["lib", "lib64", "bin", "sbin"]) {
    const host = path12.join("/", name);
    if (lstatSync2(host).isSymbolicLink() && !path12.isAbsolute(readlinkSync(host))) fs13.symlinkSync(readlinkSync(host), path12.join(directory, name));
    else throw new Error("oid_native_probe_platform_unsupported");
  }
  for (const name of ["null", "zero", "random", "urandom"]) writeFileSync(path12.join(directory, "dev", name), "", { mode: 384 });
  return directory;
}
function runOidTripleNativeProbe(root, dependencies, expected, { timeoutMs = 3e4 } = {}) {
  assertOidTripleRuntime(expected.installRuntime);
  const nodeBinary = realpathSync3(process.execPath);
  if (!nodeBinary.startsWith("/usr/") || realpathSync3(dependencies) !== dependencies || hashDependencyTreeV2(dependencies, { requireSealed: true }).sha256 !== expected.nodeModulesTreeSha256) throw new Error("oid_native_probe_identity_invalid");
  const directory = prepareOidNativeProbeRoot(root, expected.transactionNonce);
  try {
    const result = spawnSync4("/usr/bin/setpriv", [
      "--pdeathsig=SIGKILL",
      "/usr/bin/bash",
      "-c",
      '[ "$PPID" -eq "$1" ] || exit 97; shift; exec /usr/bin/unshare "$@"',
      "oid-native-parent",
      String(process.pid),
      "--user",
      "--map-root-user",
      "--mount",
      "--net",
      "--pid",
      "--fork",
      "--kill-child=SIGKILL",
      "/usr/bin/bash",
      "-c",
      OID_NATIVE_PROBE_NAMESPACE,
      "oid-native-probe",
      directory,
      dependencies,
      OID_NATIVE_PROBE_PROGRAM,
      process.env.HOME,
      nodeBinary
    ], {
      cwd: directory,
      env: { PATH: "/usr/bin:/usr/sbin", HOME: process.env.HOME, TMPDIR: "/tmp", LANG: "C.UTF-8" },
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 128 * 1024
    });
    if (result.status !== 0 || result.error || result.signal) throw new Error("oid_native_probe_isolation_or_abi_failed");
    if (hashDependencyTreeV2(dependencies, { requireSealed: true }).sha256 !== expected.nodeModulesTreeSha256) throw new Error("oid_native_probe_dependencies_changed");
    const proof = JSON.parse(result.stdout);
    if (proof.schema !== "nassaj-oid-native-probe/v2" || proof.nodeVersion !== process.version || proof.nodeModuleAbi !== process.versions.modules || proof.loaded?.length !== 8) throw new Error("oid_native_probe_proof_invalid");
    return { ...proof, nodeModulesTreeSha256: expected.nodeModulesTreeSha256, processExited: true };
  } finally {
    fs13.rmSync(directory, { recursive: true, force: true });
  }
}
function inspectOidTripleGenerationPlan(root, transaction, direction) {
  const target = validateOidTripleTargetDescriptor(transaction.pair?.target);
  const previous = transaction.pair?.previous, generations = {};
  if (transaction.schema !== "nassaj-oid-control-transaction/v2" || JSON.stringify(transaction.generationNames) !== JSON.stringify(UPDATE_GENERATION_NAMES)) throw new Error("oid_triple_transaction_invalid");
  for (const name of UPDATE_GENERATION_NAMES) {
    const hash3 = name === "nodeModules" ? (directory) => hashDependencyTreeV2(directory).sha256 : hashOidPairTree;
    const { live, candidate } = tripleLocation(root, transaction, name);
    try {
      generations[name] = { previous: previous?.[`${name}TreeSha256`], target: target[`${name}TreeSha256`], live: hash3(live), candidate: hash3(candidate) };
    } catch {
      generations[name] = {};
    }
  }
  return reconcileUpdateGenerations({
    generationNames: transaction.generationNames,
    generations,
    direction,
    databaseState: transaction.pair.databaseState
  });
}
function validateOidTriplePm2Slot(rows, expected, status = "online") {
  if (!Array.isArray(rows) || !["online", "stopped"].includes(status)) throw new Error("oid_triple_pm2_response_invalid");
  const matches = rows.filter((row) => row?.name === expected.name || row?.pm_id === expected.pmId);
  if (matches.length !== 1) throw new Error("oid_triple_pm2_slot_ambiguous");
  const slot = matches[0], env = slot.pm2_env;
  if (!env || slot.name !== expected.name || !Number.isSafeInteger(slot.pm_id) || slot.pm_id < 0 || expected.pmId !== void 0 && slot.pm_id !== expected.pmId || env.pm_exec_path !== path12.join(expected.root, "dist-server/server/index.js") || env.pm_cwd !== expected.root || env.status !== status || env.treekill !== false || env.kill_timeout !== 864e5 && env.kill_timeout !== "86400000" || status === "online" && slot.pid !== expected.pid || status === "stopped" && slot.pid !== 0) throw new Error("oid_triple_pm2_slot_changed");
  return slot;
}
function tripleStableEnvironment(environment, { allowMode = false } = {}) {
  const result = { ...environment };
  if (allowMode) delete result.NASSAJ_UPDATE_MODE;
  delete result.NASSAJ_PREVIEW_TRANSACTION_NONCE;
  delete result.NASSAJ_PREVIEW_BOOT_NONCE;
  return sha2(pairCanonical(result));
}
function validateBootstrapModeProposal(original, proposal) {
  if (!Buffer.isBuffer(original) || !Buffer.isBuffer(proposal) || original.length > 4 * 1024 * 1024 || proposal.length > 4 * 1024 * 1024) throw new Error("oid_bootstrap_mode_bytes_invalid");
  const line = /^\s*(?:export\s+)?NASSAJ_UPDATE_MODE\s*=.*$/gm;
  const before = original.toString("utf8"), after = proposal.toString("utf8");
  const oldLines = before.match(line) || [], newLines = after.match(line) || [];
  if (oldLines.length > 1 || oldLines.length === 1 && !/^\s*(?:export\s+)?NASSAJ_UPDATE_MODE\s*=\s*(?:release|"release"|'release')\s*$/.test(oldLines[0]) || newLines.length !== 1 || newLines[0] !== "NASSAJ_UPDATE_MODE=local-main" || before.replace(line, "").trimEnd() !== after.replace(line, "").trimEnd()) {
    throw new Error("oid_bootstrap_mode_scope_invalid");
  }
  return { originalSha256: sha2(original), proposalSha256: sha2(proposal) };
}
function bootstrapProposalBytes(record) {
  const encoded = record.bootstrap?.proposalEnvBase64;
  if (typeof encoded !== "string" || Buffer.from(encoded, "base64").toString("base64") !== encoded) throw new Error("oid_bootstrap_mode_proposal_invalid");
  return Buffer.from(encoded, "base64");
}
function bootstrapModeBackupFile(root, transaction) {
  return path12.join(gitControlRoot(root), "nassaj-oid-recovery", transaction.transactionNonce, "bootstrap-mode-original.env");
}
function exchangeBootstrapModeFile(envFile, bytes, beforeSha256, afterSha256, staged) {
  const read = (file, label) => pinnedFile(file, label, { mode: 384 }).bytes;
  const current = read(envFile, "bootstrap_mode_exchange_current");
  if (sha2(current) === afterSha256) return;
  if (sha2(current) !== beforeSha256) throw new Error("oid_bootstrap_mode_cas_changed");
  if (!fs13.existsSync(staged)) {
    const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDir(path12.dirname(staged));
  }
  if (sha2(read(staged, "bootstrap_mode_exchange_proposal")) !== afterSha256) throw new Error("oid_bootstrap_mode_cas_changed");
  const result = spawnSync4(
    "/usr/bin/mv",
    ["--exchange", "--no-copy", "-T", staged, envFile],
    { env: { PATH: "/usr/bin:/bin", LANG: "C" }, encoding: "utf8", timeout: 5e3 }
  );
  fsyncDir(path12.dirname(envFile));
  if (result.status !== 0 || result.error || sha2(read(envFile, "bootstrap_mode_exchange_after")) !== afterSha256 || sha2(read(staged, "bootstrap_mode_exchange_previous")) !== beforeSha256) throw new Error("oid_bootstrap_mode_cas_unknown");
}
function applyBootstrapModeCAS(root, file, transaction, record) {
  if (!transaction.bootstrap || !["triple_old_stopped", "bootstrap_mode_intent", "bootstrap_mode_verified"].includes(transaction.state) || !transaction.oldStoppedAt || transaction.pair.databaseState !== "PRE_CANDIDATE") throw new Error("oid_bootstrap_mode_boundary_invalid");
  const mode = record.bootstrap.ticket.material.mode, envFile = path12.join(root, ".env"), proposal = bootstrapProposalBytes(record);
  const current = pinnedFile(envFile, "bootstrap_mode_current", { mode: 384 }).bytes;
  const identities = validateBootstrapModeProposal(
    transaction.bootstrapMode?.originalBytesBase64 ? Buffer.from(transaction.bootstrapMode.originalBytesBase64, "base64") : current,
    proposal
  );
  if (identities.originalSha256 !== mode.originalEnvSha256 || identities.proposalSha256 !== mode.proposalEnvSha256 || ![mode.originalEnvSha256, mode.proposalEnvSha256].includes(sha2(current))) throw new Error("oid_bootstrap_mode_binding_changed");
  const backupFile = bootstrapModeBackupFile(root, transaction);
  let next = transaction;
  if (!next.bootstrapMode) {
    const intent = {
      state: "intent",
      originalSha256: mode.originalEnvSha256,
      proposalSha256: mode.proposalEnvSha256,
      originalBytesBase64: current.toString("base64"),
      backupBasename: path12.basename(backupFile),
      proposalStageBasename: `bootstrap-mode-proposal-${transaction.transactionNonce}.env`
    };
    next = { ...next, state: "bootstrap_mode_intent", bootstrapMode: intent };
    durable(file, next);
  }
  if (!fs13.existsSync(backupFile)) {
    const original = Buffer.from(next.bootstrapMode.originalBytesBase64, "base64");
    if (sha2(original) !== mode.originalEnvSha256) throw new Error("oid_bootstrap_mode_original_changed");
    const fd = openSync(backupFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
    try {
      writeFileSync(fd, original);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDir(path12.dirname(backupFile));
  }
  const backup = pinnedFile(backupFile, "bootstrap_mode_backup", { sha256: mode.originalEnvSha256, mode: 384 }).bytes;
  validateBootstrapModeProposal(backup, proposal);
  const proposalStage = path12.join(path12.dirname(backupFile), next.bootstrapMode.proposalStageBasename);
  exchangeBootstrapModeFile(envFile, proposal, mode.originalEnvSha256, mode.proposalEnvSha256, proposalStage);
  if (sha2(pinnedFile(envFile, "bootstrap_mode_after_apply", { mode: 384 }).bytes) !== mode.proposalEnvSha256) throw new Error("oid_bootstrap_mode_cas_unknown");
  next = { ...next, state: "bootstrap_mode_verified", bootstrapMode: { ...next.bootstrapMode, state: "verified", verifiedAt: Date.now() } };
  durable(file, next);
  return next;
}
function restoreBootstrapModeCAS(root, file, transaction, record) {
  if (!transaction.bootstrap || transaction.pair.databaseState !== "PRE_CANDIDATE" || transaction.bootDirection || transaction.pm2Operations && Object.keys(transaction.pm2Operations).some((key) => key.startsWith("start-"))) {
    throw new Error("oid_bootstrap_mode_restore_forbidden");
  }
  const mode = record.bootstrap.ticket.material.mode, envFile = path12.join(root, ".env");
  const backupFile = bootstrapModeBackupFile(root, transaction), proposal = bootstrapProposalBytes(record);
  let backup;
  try {
    backup = pinnedFile(backupFile, "bootstrap_mode_restore_backup", { sha256: mode.originalEnvSha256, mode: 384 }).bytes;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const encoded = transaction.bootstrapMode?.originalBytesBase64;
    if (typeof encoded !== "string" || Buffer.from(encoded, "base64").toString("base64") !== encoded) throw new Error("oid_bootstrap_mode_original_changed");
    const original = Buffer.from(encoded, "base64"), current2 = pinnedFile(envFile, "bootstrap_mode_restore_current", { mode: 384 }).bytes;
    const identities = validateBootstrapModeProposal(original, proposal);
    if (identities.originalSha256 !== mode.originalEnvSha256 || identities.proposalSha256 !== mode.proposalEnvSha256 || ![mode.originalEnvSha256, mode.proposalEnvSha256].includes(sha2(current2))) throw new Error("oid_bootstrap_mode_cas_unknown");
    const fd = openSync(backupFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
    try {
      writeFileSync(fd, original);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDir(path12.dirname(backupFile));
    backup = pinnedFile(backupFile, "bootstrap_mode_recreated_backup", { sha256: mode.originalEnvSha256, mode: 384 }).bytes;
  }
  validateBootstrapModeProposal(backup, proposal);
  const proposalStage = path12.join(path12.dirname(bootstrapModeBackupFile(root, transaction)), transaction.bootstrapMode.proposalStageBasename);
  const current = pinnedFile(envFile, "bootstrap_mode_restore_current", { mode: 384 }).bytes;
  const currentSha256 = sha2(current);
  let proposalStagePresent;
  try {
    lstatSync2(proposalStage);
    proposalStagePresent = true;
  } catch (error) {
    if (error.code === "ENOENT") proposalStagePresent = false;
    else throw error;
  }
  if (proposalStagePresent) {
    const stagedSha256 = sha2(pinnedFile(proposalStage, "bootstrap_mode_restore_stage", { mode: 384 }).bytes);
    if (currentSha256 === mode.originalEnvSha256 && stagedSha256 === mode.proposalEnvSha256) {
      unlinkSync(proposalStage);
      fsyncDir(path12.dirname(proposalStage));
      try {
        lstatSync2(proposalStage);
        throw new Error("oid_bootstrap_mode_cas_unknown");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    } else if (currentSha256 === mode.proposalEnvSha256 && stagedSha256 === mode.originalEnvSha256) {
      exchangeBootstrapModeFile(envFile, backup, mode.proposalEnvSha256, mode.originalEnvSha256, proposalStage);
      if (sha2(pinnedFile(proposalStage, "bootstrap_mode_restore_proposal", { mode: 384 }).bytes) !== mode.proposalEnvSha256) {
        throw new Error("oid_bootstrap_mode_cas_unknown");
      }
      unlinkSync(proposalStage);
      fsyncDir(path12.dirname(proposalStage));
      try {
        lstatSync2(proposalStage);
        throw new Error("oid_bootstrap_mode_cas_unknown");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    } else throw new Error("oid_bootstrap_mode_cas_unknown");
  } else if (currentSha256 !== mode.originalEnvSha256) throw new Error("oid_bootstrap_mode_cas_unknown");
  if (sha2(pinnedFile(envFile, "bootstrap_mode_restored", { mode: 384 }).bytes) !== mode.originalEnvSha256) throw new Error("oid_bootstrap_mode_restore_unknown");
  const next = { ...transaction, bootstrapMode: { ...transaction.bootstrapMode, state: "restored", restoredAt: Date.now() } };
  durable(file, next);
  return next;
}
function validateOidTriplePm2Dump(rows, slot) {
  if (!Array.isArray(rows)) throw new Error("oid_triple_pm2_dump_invalid");
  const matches = rows.filter((row) => row?.name === slot.name);
  if (matches.length !== 1) throw new Error("oid_triple_pm2_dump_slot_ambiguous");
  const saved = matches[0], current = slot.pm2_env;
  assertServiceOwnerEnvironmentCopies(slot);
  assertServiceOwnerEnvironmentCopies({ pm2_env: saved });
  for (const key of ["name", "pm_cwd", "pm_exec_path", "status", "treekill", "kill_timeout"]) {
    if (pairCanonical(saved[key]) !== pairCanonical(key === "name" ? slot.name : current[key])) throw new Error("oid_triple_pm2_dump_slot_changed");
  }
  if (saved.pm_id !== void 0 || pairCanonical(saved.env || {}) !== pairCanonical(current.env || {})) throw new Error("oid_triple_pm2_dump_environment_changed");
  return true;
}
function tripleDumpEnvironment(row, slot, status) {
  const environment = assertServiceOwnerEnvironmentCopies(slot), next = { ...row, status, env: environment };
  for (const key of ["NASSAJ_UPDATE_MODE", "NASSAJ_PREVIEW_TRANSACTION_NONCE", "NASSAJ_PREVIEW_BOOT_NONCE"]) {
    if (Object.hasOwn(environment, key)) next[key] = environment[key];
    else if (Object.hasOwn(row, key)) throw new Error("oid_triple_dump_environment_shadow");
  }
  return next;
}
function prepareTripleDumpCAS(transaction, slot, status) {
  const supervisor = transaction.supervisor, file = path12.join(supervisor.pm2Home, "dump.pm2");
  const bytes = pinnedFile(file, "triple_dump_cas_before", { maxSize: 16 * 1024 * 1024 }).bytes, stat = lstatSync2(file);
  if (stat.uid !== process.getuid() || stat.nlink !== 1 || stat.mode & 18) throw new Error("oid_triple_pm2_dump_unsafe");
  const priorIntent = transaction.persistence?.[status]?.dumpCAS;
  if (priorIntent) {
    if (![priorIntent.beforeSha256, priorIntent.afterSha256].includes(sha2(bytes))) throw new Error("oid_triple_dump_cas_changed");
    return priorIntent;
  }
  const expected = status === "online" ? transaction.persistence?.stopped?.dumpSha256 : transaction.persistence?.online?.dumpSha256 || supervisor.dumpSha256;
  if (sha2(bytes) !== expected) throw new Error("oid_triple_dump_cas_changed");
  const rows = JSON.parse(bytes), matches = rows.filter((row) => row.name === supervisor.name);
  if (matches.length !== 1 || matches[0].pm_id !== void 0) throw new Error("oid_triple_dump_cas_slot");
  const saved = matches[0];
  if (sha2(pairCanonical(serviceOwnerSlotControls({ pm_id: supervisor.pmId, pm2_env: saved }))) !== supervisor.controlsSha256) throw new Error("oid_triple_dump_cas_controls");
  const after = rows.map((row) => row === saved ? tripleDumpEnvironment(row, slot, status) : row);
  const next = Buffer.from(JSON.stringify(after, null, 2));
  return {
    beforeSha256: sha2(bytes),
    afterSha256: sha2(next),
    status,
    state: "intent",
    stagedBasename: `dump.pm2.nassaj-${transaction.transactionNonce}-${sha2(next)}`
  };
}
function applyTripleDumpCAS(supervisor, slot, intent) {
  if (!/^dump\.pm2\.nassaj-[a-f0-9]{64}-[a-f0-9]{64}$/.test(intent.stagedBasename || "") || !intent.stagedBasename.endsWith(intent.afterSha256)) throw new Error("oid_triple_dump_cas_paths");
  const file = path12.join(supervisor.pm2Home, "dump.pm2"), staged = path12.join(supervisor.pm2Home, intent.stagedBasename);
  const read = (name) => pinnedFile(name, "triple_dump_cas", { maxSize: 16 * 1024 * 1024 }).bytes;
  const before = read(file), currentHash = sha2(before);
  if (currentHash === intent.afterSha256 && fs13.existsSync(staged) && sha2(read(staged)) === intent.beforeSha256) return;
  if (currentHash !== intent.beforeSha256) throw new Error("oid_triple_dump_cas_changed");
  const rows = JSON.parse(before), matches = rows.filter((row) => row.name === supervisor.name);
  if (matches.length !== 1) throw new Error("oid_triple_dump_cas_slot");
  const next = Buffer.from(JSON.stringify(rows.map((row) => row === matches[0] ? tripleDumpEnvironment(row, slot, intent.status) : row), null, 2));
  if (sha2(next) !== intent.afterSha256) throw new Error("oid_triple_dump_cas_proposal_changed");
  if (!fs13.existsSync(staged)) {
    const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
    try {
      writeFileSync(fd, next);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDir(supervisor.pm2Home);
  }
  if (sha2(pinnedFile(staged, "triple_dump_proposal", { mode: 384, maxSize: 16 * 1024 * 1024 }).bytes) !== intent.afterSha256 || sha2(read(file)) !== intent.beforeSha256) throw new Error("oid_triple_dump_cas_changed");
  assertOidTriplePm2Authority(supervisor);
  injectFailure("triple_before_dump_cas");
  if (process.env.NODE_ENV === "test" && process.env.NASSAJ_OID_CAPSULE_FAIL_AT === "triple_dump_competing_writer") {
    writeFileSync(file, read(path12.join(supervisor.pm2Home, "competing-dump-fixture.json")));
  }
  const result = spawnSync4(
    "/usr/bin/mv",
    ["--exchange", "--no-copy", "-T", staged, file],
    { env: { PATH: "/usr/bin:/bin", LANG: "C" }, encoding: "utf8", timeout: 5e3 }
  );
  fsyncDir(supervisor.pm2Home);
  injectFailure("triple_after_dump_cas");
  if (result.status !== 0 || result.error || sha2(read(file)) !== intent.afterSha256 || sha2(read(staged)) !== intent.beforeSha256) {
    throw new Error("oid_triple_dump_cas_unknown");
  }
}
async function persistOidTriplePm2Slot(root, file, transaction, status, child = null) {
  transaction = assertOidTripleFailureBinding(pinnedJson(file, "triple_persistence_latest"), transaction);
  const supervisor = transaction.supervisor;
  const slot = validateOidTriplePm2Slot(await triplePm2Read(supervisor), { ...supervisor, pid: child?.pid ?? supervisor.pid }, status);
  const environment = slot.pm2_env.env || {};
  if (status === "online") {
    if (!child || !pairOwnerAlive(child) || processStartTicks(slot.pid) !== child.startTime || environment.NASSAJ_PREVIEW_TRANSACTION_NONCE !== transaction.transactionNonce || environment.NASSAJ_PREVIEW_BOOT_NONCE !== transaction.bootNonce || tripleStableEnvironment(environment, { allowMode: Boolean(transaction.bootstrap) }) !== (transaction.bootstrap ? supervisor.bootstrapStableEnvironmentSha256 : supervisor.stableEnvironmentSha256)) throw new Error("oid_triple_persistence_child_changed");
  } else if (sha2(pairCanonical(environment)) !== supervisor.environmentSha256 || !pairOwnerProvablyDead(transaction.pair.previous.runtime)) throw new Error("oid_triple_persistence_stop_changed");
  const expectedMode = transaction.bootstrap && (status === "stopped" || transaction.bootDirection === "previous") ? "release" : "local-main";
  assertOidTripleEffectiveMode(root, environment, expectedMode);
  const intent = {
    state: "intent",
    status,
    pmId: supervisor.pmId,
    name: supervisor.name,
    environmentSha256: sha2(pairCanonical(environment)),
    dumpCAS: prepareTripleDumpCAS(transaction, slot, status),
    ...child ? { pid: child.pid, startTime: child.startTime, bootNonce: transaction.bootNonce } : {}
  };
  let current = { ...transaction, persistence: { ...transaction.persistence, [status]: intent } };
  durable(file, current);
  const dumpFile = path12.join(supervisor.pm2Home, "dump.pm2");
  const verify = async () => {
    assertOidTriplePm2Authority(supervisor);
    const pinned = pinnedFile(dumpFile, "triple_pm2_dump", { maxSize: 16 * 1024 * 1024 });
    const metadata2 = lstatSync2(dumpFile);
    if (metadata2.uid !== process.getuid() || metadata2.nlink !== 1 || metadata2.mode & 18) throw new Error("oid_triple_pm2_dump_unsafe");
    validateOidTriplePm2Dump(JSON.parse(pinned.bytes), slot);
    const live = validateOidTriplePm2Slot(await triplePm2Read(supervisor), { ...supervisor, pid: child?.pid ?? supervisor.pid }, status);
    if (sha2(pairCanonical(live.pm2_env.env || {})) !== intent.environmentSha256 || child && !pairOwnerAlive(child)) throw new Error("oid_triple_pm2_persistence_changed");
    const fd = openSync(dumpFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const held = fstatSync(fd);
      if (held.dev !== metadata2.dev || held.ino !== metadata2.ino || held.nlink !== 1 || sha2(readFileSync2(fd)) !== sha2(pinned.bytes)) throw new Error("oid_triple_pm2_dump_changed");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDir(supervisor.pm2Home);
    if (sha2(pinnedFile(dumpFile, "triple_pm2_dump_after_sync").bytes) !== sha2(pinned.bytes)) throw new Error("oid_triple_pm2_dump_changed");
    assertOidTriplePm2Authority(supervisor);
    return sha2(pinned.bytes);
  };
  try {
    applyTripleDumpCAS(supervisor, slot, intent.dumpCAS);
  } catch (error) {
    durable(file, { ...current, persistence: { ...current.persistence, [status]: { ...intent, state: "unknown" } } });
    throw error;
  }
  const digest3 = await verify();
  injectFailure("triple_after_pm2_save_before_receipt");
  current = { ...current, persistence: { ...current.persistence, [status]: { ...intent, state: "verified", dumpSha256: digest3, verifiedAt: Date.now() } } };
  durable(file, current);
  return current;
}
function tripleStableExecutable(file, root, label) {
  const resolved = realpathSync3(file);
  if (resolved === root || resolved.startsWith(`${root}${path12.sep}`)) throw new Error(`oid_triple_${label}_not_external`);
  const metadata2 = lstatSync2(resolved), bytes = pinnedFile(resolved, `triple_${label}`, { maxSize: Number.MAX_SAFE_INTEGER }).bytes;
  if (metadata2.mode & 18 || metadata2.nlink !== 1) throw new Error(`oid_triple_${label}_unsafe`);
  return { path: resolved, sha256: sha2(bytes), size: bytes.length, mode: metadata2.mode & 511 };
}
function validateOidTriplePm2AuthorityChain(chain, serviceUid = process.getuid()) {
  if (!Array.isArray(chain) || !chain.length || chain[0].path !== "/") throw new Error("oid_triple_pm2_authority_invalid");
  let privateBoundary = false;
  for (const [index, entry] of chain.entries()) {
    if (!Number.isSafeInteger(entry.uid) || !Number.isSafeInteger(entry.gid) || !Number.isSafeInteger(entry.mode) || ![0, serviceUid].includes(entry.uid) || typeof entry.dev !== "string" || typeof entry.ino !== "string" || index && path12.dirname(entry.path) !== chain[index - 1].path) throw new Error("oid_triple_pm2_authority_invalid");
    if (!privateBoundary && entry.mode & 18) throw new Error("oid_triple_pm2_authority_exposed_write");
    if (entry.uid === serviceUid && entry.mode === 448) privateBoundary = true;
  }
  if (chain.at(-1).uid !== serviceUid) throw new Error("oid_triple_pm2_home_owner_invalid");
  return true;
}
function captureOidTriplePm2Authority(pm2Home) {
  if (!path12.isAbsolute(pm2Home || "") || path12.resolve(pm2Home) !== pm2Home || realpathSync3(pm2Home) !== pm2Home) throw new Error("oid_triple_pm2_home_invalid");
  const names = ["/"];
  let current = "/";
  for (const name of pm2Home.split("/").filter(Boolean)) {
    current = path12.join(current, name);
    names.push(current);
  }
  const chain = names.map((directory) => {
    const metadata2 = lstatSync2(directory);
    if (!metadata2.isDirectory() || realpathSync3(directory) !== directory) throw new Error("oid_triple_pm2_authority_not_canonical");
    return { path: directory, dev: String(metadata2.dev), ino: String(metadata2.ino), uid: metadata2.uid, gid: metadata2.gid, mode: metadata2.mode & 4095 };
  });
  validateOidTriplePm2AuthorityChain(chain);
  return chain;
}
function assertOidTriplePm2Authority(supervisor) {
  if (!supervisor.authority || pairCanonical(captureOidTriplePm2Authority(supervisor.pm2Home)) !== pairCanonical(supervisor.authority)) throw new Error("oid_triple_pm2_authority_changed");
  return true;
}
async function triplePm2Read(supervisor) {
  assertOidTriplePm2Authority(supervisor);
  for (const [label, identity2] of [["node", supervisor.node], ["pm2", supervisor.pm2]]) {
    if (sha2(pinnedFile(identity2.path, `triple_${label}`, { maxSize: Number.MAX_SAFE_INTEGER, mode: identity2.mode }).bytes) !== identity2.sha256) throw new Error("oid_triple_supervisor_changed");
  }
  if (!pairOwnerAlive(supervisor.daemon) || sha2(readFileSync2(`/proc/${supervisor.daemon.pid}/exe`)) !== supervisor.daemonExecutableSha256 || hashDependencyTreeV2(supervisor.pm2PackageRoot).sha256 !== supervisor.pm2TreeSha256) throw new Error("oid_triple_pm2_daemon_changed");
  if (!supervisor.observer) throw new Error("oid_triple_pm2_observer_missing");
  const rows = await observeServiceOwnerPm2(supervisor.observer);
  assertOidTriplePm2Authority(supervisor);
  return rows;
}
function assertOidTripleEffectiveMode(root, environment, expected = "local-main") {
  if (!["release", "local-main"].includes(expected)) throw new Error("oid_triple_child_mode_changed");
  let mode = environment?.NASSAJ_UPDATE_MODE;
  if (mode === void 0) {
    const text = pinnedFile(path12.join(root, ".env"), "triple_mode_file").bytes.toString("utf8");
    const lines = text.split("\n").filter((line) => /^\s*(?:export\s+)?NASSAJ_UPDATE_MODE(?:\s|=|$)/.test(line));
    if (lines.length !== 1 || !/^\s*(?:export\s+)?NASSAJ_UPDATE_MODE\s*=/.test(lines[0])) throw new Error("oid_triple_child_mode_changed");
    mode = lines[0].slice(lines[0].indexOf("=") + 1).trim();
    if (mode && ['"', "'"].includes(mode[0]) && mode.at(-1) === mode[0]) mode = mode.slice(1, -1);
  }
  if (mode !== expected) throw new Error("oid_triple_child_mode_changed");
  return true;
}
async function captureOidTripleSupervisor(root, record) {
  const pm2Home = process.env.PM2_HOME || process.env.HOME && path12.join(process.env.HOME, ".pm2");
  const authority = captureOidTriplePm2Authority(pm2Home);
  const found = spawnSync4("/usr/bin/which", ["pm2"], { encoding: "utf8", timeout: 5e3 });
  if (found.status !== 0) throw new Error("oid_triple_pm2_executable_missing");
  const daemonPid = Number(pinnedFile(path12.join(pm2Home, "pm2.pid"), "triple_pm2_pid").bytes.toString().trim());
  if (!Number.isSafeInteger(daemonPid) || daemonPid < 1) throw new Error("oid_triple_pm2_daemon_invalid");
  const supervisor = {
    node: tripleStableExecutable(process.execPath, root, "node"),
    pm2: tripleStableExecutable(found.stdout.trim(), root, "pm2"),
    pm2Home,
    authority,
    daemon: pairProcessIdentity(daemonPid)
  };
  supervisor.pm2PackageRoot = path12.dirname(path12.dirname(supervisor.pm2.path));
  const pm2Package = pinnedJson(path12.join(supervisor.pm2PackageRoot, "package.json"), "triple_pm2_package");
  const daemonCommand = readFileSync2(`/proc/${daemonPid}/cmdline`).toString().replace(/\0/g, " ").trim();
  if (pm2Package.name !== "pm2" || !daemonCommand.startsWith(`PM2 v${pm2Package.version}: God Daemon (`) || !daemonCommand.endsWith(`(${pm2Home})`)) throw new Error("oid_triple_pm2_daemon_identity_invalid");
  supervisor.pm2TreeSha256 = hashDependencyTreeV2(supervisor.pm2PackageRoot).sha256;
  supervisor.daemonExecutableSha256 = sha2(readFileSync2(`/proc/${daemonPid}/exe`));
  supervisor.observer = captureServiceOwnerObserver(pm2Home, { pid: record.oldPid, startTicks: record.oldStartTicks });
  const name = process.env.PROC_NAME || process.env.NASSAJ_PROCESS_NAME;
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new Error("oid_triple_pm2_name_invalid");
  const slot = validateOidTriplePm2Slot(await triplePm2Read(supervisor), { root, name, pid: record.oldPid });
  if (processStartTicks(slot.pid) !== record.oldStartTicks) throw new Error("oid_triple_previous_process_changed");
  return {
    ...supervisor,
    name,
    pmId: slot.pm_id,
    root,
    pid: slot.pid,
    startTime: record.oldStartTicks,
    controlsSha256: sha2(pairCanonical(serviceOwnerSlotControls(slot))),
    dumpSha256: sha2(pinnedFile(path12.join(pm2Home, "dump.pm2"), "triple_initial_dump").bytes),
    environmentSha256: sha2(pairCanonical(slot.pm2_env.env || {})),
    stableEnvironmentSha256: tripleStableEnvironment(slot.pm2_env.env || {}),
    bootstrapStableEnvironmentSha256: tripleStableEnvironment(slot.pm2_env.env || {}, { allowMode: true })
  };
}
function tripleOwnedTransaction(root, expected) {
  const paths = pairPaths(root), maintenance = pairReadMaintenance(paths);
  const transaction = validateOidPairMaintenance(root, maintenance);
  if (transaction?.schema !== "nassaj-oid-control-transaction/v2" || !pairOwnerAlive(maintenance.owner) || transaction.sequence !== expected.sequence || transaction.transactionNonce !== expected.transactionNonce || transaction.actionId !== expected.actionId || transaction.pair.targetDigest !== expected.targetDigest) throw new Error("oid_triple_safe_phase_not_owned");
  const ancestry = /* @__PURE__ */ new Set();
  let pid = process.pid;
  while (pid > 1 && !ancestry.has(pid)) {
    ancestry.add(pid);
    const match = readFileSync2(`/proc/${pid}/status`, "utf8").match(/^PPid:\s+(\d+)/m);
    if (!match) throw new Error("oid_triple_safe_ancestry_unknown");
    pid = Number(match[1]);
  }
  if (!ancestry.has(maintenance.owner.pid) || maintenance.owner.pid === process.pid) throw new Error("oid_triple_safe_phase_foreign_process");
  return { paths, maintenance, transaction, ancestry, file: path12.join(paths.gitRoot, maintenance.identity.oid.journalBasename) };
}
function tripleRefuseWriterDescendants(oldPid, allowed) {
  const parents = /* @__PURE__ */ new Map();
  for (const entry of readdirSync2("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync2(`/proc/${entry}/status`, "utf8");
      const parent = status.match(/^PPid:\s+(\d+)/m);
      if (parent) parents.set(Number(entry), Number(parent[1]));
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw new Error("oid_triple_process_inventory_unknown");
    }
  }
  for (const pid of parents.keys()) {
    if (pid === oldPid || allowed.has(pid)) continue;
    const seen = /* @__PURE__ */ new Set();
    let ancestor = parents.get(pid);
    while (ancestor && !seen.has(ancestor)) {
      if (ancestor === oldPid) throw new Error("oid_triple_writer_descendant_present");
      seen.add(ancestor);
      ancestor = parents.get(ancestor);
    }
  }
}
async function triplePm2Command(supervisor, step, owned, environment = null) {
  const { file, transaction, paths } = owned;
  const slot = validateOidTriplePm2Slot(await triplePm2Read(supervisor), supervisor, step === "stop-old" ? "online" : "stopped");
  const operationKey = step === "stop-old" ? "stop-old" : `start-${transaction.bootNonce}`;
  const authority = {
    schema: "nassaj-pm2-service-owner/v1",
    observer: supervisor.observer,
    pmId: supervisor.pmId,
    name: supervisor.name,
    namespace: slot.pm2_env.namespace,
    controlsSha256: supervisor.controlsSha256,
    environmentSha256: sha2(pairCanonical(slot.pm2_env.env || {})),
    previous: { pid: supervisor.pid, startTicks: supervisor.startTime },
    nextEnvironment: environment
  };
  const bound = () => {
    const latest2 = pinnedJson(file, "triple_pm2_authority");
    assertOidTripleFailureBinding(latest2, transaction);
    const maintenance = pairReadMaintenance(paths);
    if (!maintenance.gateClosed || maintenance.transactionId !== transaction.transactionNonce || !pairOwnerAlive(maintenance.owner) || !owned.ancestry.has(maintenance.owner.pid)) throw new Error("oid_triple_pm2_lease_changed");
    if (latest2.pm2Operations?.[operationKey]) throw new Error("oid_triple_pm2_operation_already_intended");
    if (step === "stop-old" ? latest2.state !== "triple_old_stop_intent" || latest2.pair.databaseState !== "PRE_CANDIDATE" : !["triple_candidate_start_intent", "triple_previous_start_intent"].includes(latest2.state)) throw new Error("oid_triple_pm2_phase_changed");
    return latest2;
  };
  await executeServiceOwnerPm2Step(authority, step, {
    authorize(intent) {
      const latest2 = bound();
      durable(file, { ...latest2, pm2Operations: { ...latest2.pm2Operations, [operationKey]: { ...intent, state: "intent" } } });
    },
    unknown() {
      const latest2 = pinnedJson(file, "triple_pm2_unknown");
      assertOidTripleFailureBinding(latest2, transaction);
      durable(file, { ...latest2, pm2Operations: {
        ...latest2.pm2Operations,
        [operationKey]: { ...latest2.pm2Operations?.[operationKey], state: "unknown" }
      } });
    }
  });
  const latest = pinnedJson(file, "triple_pm2_reply");
  assertOidTripleFailureBinding(latest, transaction);
  durable(file, { ...latest, pm2Operations: {
    ...latest.pm2Operations,
    [operationKey]: { ...latest.pm2Operations?.[operationKey], state: "reply_observed" }
  } });
}
async function runOidTripleSafePhase(root, expected, phase) {
  if (!["inspect-stop", "validate-stop", "stop", "start-target", "start-previous"].includes(phase)) throw new Error("oid_triple_safe_phase_invalid");
  const owned = tripleOwnedTransaction(root, expected), transaction = owned.transaction, supervisor = transaction.supervisor;
  if (!supervisor || supervisor.root !== root) throw new Error("oid_triple_supervisor_missing");
  if (phase === "inspect-stop") {
    if (transaction.state !== "triple_old_stop_intent" || transaction.pair.databaseState !== "PRE_CANDIDATE") throw new Error("oid_triple_stop_not_intended");
    const slot = validateOidTriplePm2Slot(await triplePm2Read(supervisor), supervisor);
    assertServiceOwnerEnvironmentCopies(slot);
    if (processStartTicks(slot.pid) !== supervisor.startTime || sha2(pairCanonical(serviceOwnerSlotControls(slot))) !== supervisor.controlsSha256 || sha2(pairCanonical(slot.pm2_env.env || {})) !== supervisor.environmentSha256) throw new Error("oid_triple_pm2_environment_changed");
    return [slot];
  }
  if (phase === "stop" || phase === "validate-stop") {
    if (transaction.state !== "triple_old_stop_intent" || transaction.pair.databaseState !== "PRE_CANDIDATE") throw new Error("oid_triple_stop_not_intended");
    pairVerifyLive(root, { targetClientBuildId: transaction.pair.previous.clientBuildId, targetServerBuildId: transaction.pair.previous.serverBuildId }, transaction.pair.previous);
    const slot = validateOidTriplePm2Slot(await triplePm2Read(supervisor), supervisor);
    assertOidTripleEffectiveMode(root, slot.pm2_env.env || {}, transaction.bootstrap ? "release" : "local-main");
    if (processStartTicks(slot.pid) !== supervisor.startTime || sha2(pairCanonical(slot.pm2_env.env || {})) !== supervisor.environmentSha256) throw new Error("oid_triple_pm2_environment_changed");
    tripleRefuseWriterDescendants(supervisor.pid, owned.ancestry);
    if (phase === "validate-stop") return { state: "stop_ready", transactionNonce: transaction.transactionNonce };
    await triplePm2Command(supervisor, "stop-old", owned);
    validateOidTriplePm2Slot(await triplePm2Read(supervisor), supervisor, "stopped");
    if (!pairOwnerProvablyDead(transaction.pair.previous.runtime)) throw new Error("oid_triple_old_process_still_alive");
    const persisted = await persistOidTriplePm2Slot(root, owned.file, transaction, "stopped");
    durable(owned.file, { ...persisted, state: "triple_old_stopped", oldStoppedAt: Date.now() });
    return { state: "old_stopped", transactionNonce: transaction.transactionNonce };
  }
  return startOidTripleStoppedSlot(root, owned, phase);
}
async function startOidTripleStoppedSlot(root, owned, phase) {
  const transaction = owned.transaction, supervisor = transaction.supervisor;
  const rollback = phase === "start-previous";
  if (transaction.state !== (rollback ? "triple_previous_start_intent" : "triple_candidate_start_intent") || transaction.pair.databaseState !== (rollback ? "PRE_CANDIDATE" : "UNKNOWN") || !transaction.oldStoppedAt || !HEX643.test(transaction.bootNonce || "")) throw new Error("oid_triple_start_not_intended");
  const plan = inspectOidTripleGenerationPlan(root, transaction, rollback ? "rollback" : "forward");
  if (plan.state !== "verified" || plan.steps.some((step) => step.operation !== "attest")) throw new Error("oid_triple_start_generations_unverified");
  const slot = validateOidTriplePm2Slot(await triplePm2Read(supervisor), supervisor, "stopped");
  const stoppedEnvironment = slot.pm2_env.env || {};
  const stoppedMode = transaction.bootstrap && (rollback || Object.hasOwn(stoppedEnvironment, "NASSAJ_UPDATE_MODE")) ? "release" : "local-main";
  assertOidTripleEffectiveMode(root, stoppedEnvironment, stoppedMode);
  if (!pairOwnerProvablyDead(transaction.pair.previous.runtime) || sha2(pairCanonical(slot.pm2_env.env || {})) !== supervisor.environmentSha256) throw new Error("oid_triple_stopped_slot_changed");
  const saved = slot.pm2_env.env || {};
  const environment = buildOidTripleStartEnvironment(saved, transaction, rollback);
  await triplePm2Command(supervisor, "start-stopped", owned, environment);
  const rows = await triplePm2Read(supervisor), candidate = rows.find((row) => row.pm_id === supervisor.pmId);
  const started = validateOidTriplePm2Slot(rows, { ...supervisor, pid: candidate?.pid });
  const actual = started.pm2_env.env || {};
  for (const key of /* @__PURE__ */ new Set([...Object.keys(saved), ...Object.keys(actual)])) {
    if (["NASSAJ_UPDATE_MODE", "NASSAJ_PREVIEW_TRANSACTION_NONCE", "NASSAJ_PREVIEW_BOOT_NONCE"].includes(key)) continue;
    if (pairCanonical(saved[key]) !== pairCanonical(actual[key])) throw new Error("oid_triple_saved_environment_drift");
  }
  if (actual.NASSAJ_PREVIEW_TRANSACTION_NONCE !== transaction.transactionNonce || actual.NASSAJ_PREVIEW_BOOT_NONCE !== transaction.bootNonce) throw new Error("oid_triple_boot_environment_not_applied");
  return { state: rollback ? "previous_start_requested" : "candidate_start_requested", transactionNonce: transaction.transactionNonce };
}
function buildOidTripleStartEnvironment(saved, transaction, rollback = false) {
  if (!saved || Object.getPrototypeOf(saved) !== Object.prototype || !HEX643.test(transaction?.transactionNonce || "") || !HEX643.test(transaction?.bootNonce || "")) throw new Error("oid_triple_start_environment_invalid");
  return {
    ...saved,
    ...transaction.bootstrap ? { NASSAJ_UPDATE_MODE: rollback ? "release" : "local-main" } : {},
    NASSAJ_PREVIEW_TRANSACTION_NONCE: transaction.transactionNonce,
    NASSAJ_PREVIEW_BOOT_NONCE: transaction.bootNonce
  };
}
function verifyTripleRetainedRecord(root, record) {
  const reference = record.recoveryReference;
  if (reference?.transactionNonce !== record.transactionNonce || !HEX643.test(reference.executorManifestSha256 || "")) throw new Error("oid_triple_retained_executor_missing");
  const storage = path12.join(gitControlRoot(root), "nassaj-oid-recovery");
  const directory = path12.join(storage, record.transactionNonce, "executor");
  for (const file of [storage, path12.dirname(directory), directory]) {
    const stat = lstatSync2(file);
    if (!stat.isDirectory() || realpathSync3(file) !== file || stat.uid !== process.getuid() || (stat.mode & 511) !== 448) throw new Error("oid_triple_retained_directory_unsafe");
  }
  const descriptor = pinnedJson(path12.join(directory, "executor-manifest.json"), "triple_executor_manifest", { sha256: reference.executorManifestSha256, mode: 384 });
  if (descriptor.schema !== "nassaj-oid-retained-executor/v2" || descriptor.repoRoot !== root || descriptor.transactionNonce !== record.transactionNonce || descriptor.actionId !== record.actionId || descriptor.targetDigest !== record.pair.targetDigest || JSON.stringify(descriptor.files?.map((file) => file.name)) !== '["launcher.mjs","capsule.mjs","safe-restart.sh","control-manifest.json","record.json"]') throw new Error("oid_triple_retained_binding_invalid");
  const contents = {};
  for (const expected of descriptor.files) {
    const file = path12.join(directory, expected.name), metadata2 = lstatSync2(file);
    if (metadata2.nlink !== 1 || metadata2.uid !== process.getuid() || metadata2.size !== expected.size) throw new Error("oid_triple_retained_file_unsafe");
    contents[expected.name] = pinnedFile(file, "triple_retained_file", { sha256: expected.sha256, mode: 384 }).bytes;
  }
  const { recoveryReference: ignored, resume: ignoredResume, ...original } = record;
  if (pairCanonical(JSON.parse(contents["record.json"])) !== pairCanonical(original)) throw new Error("oid_triple_retained_record_changed");
  return contents;
}
function prepareFullClientPublicationArchives(root, target, previous) {
  const candidate = path12.join(root, ".nassaj-local-preview/client-candidates", target.clientBuildId);
  if (!fs13.existsSync(path12.join(candidate, "CLIENT_ASSET_MANIFEST.json"))) return;
  const verifier = (expected) => (directory) => {
    if (hashOidPairTree(directory) !== expected) throw new Error("full_client_archive_tree_changed");
  };
  const live = path12.join(root, "dist");
  if (fs13.existsSync(path12.join(live, "CLIENT_ASSET_MANIFEST.json"))) prepareClientPublicationAssets(root, live, {}, verifier(previous.clientTreeSha256));
  prepareClientPublicationAssets(root, candidate, {}, verifier(target.clientTreeSha256));
}
function tripleCurrentRuntime() {
  return {
    nodeBinarySha256: sha2(pinnedFile(realpathSync3(process.execPath), "triple_node", { maxSize: Number.MAX_SAFE_INTEGER }).bytes),
    nodeVersion: process.version,
    nodeModuleAbi: process.versions.modules,
    napi: process.versions.napi,
    platform: process.platform,
    arch: process.arch
  };
}
async function captureOidTriplePreviousGeneration(root, liveManifest, { allowQualifiedMismatch = false } = {}) {
  if (!allowQualifiedMismatch && hashOidPairDependencyTree(path12.join(root, "node_modules")) !== liveManifest.runtimeDependenciesSha256) throw new Error("oid_triple_previous_dependencies_unverified");
  const server = provenance(path12.join(root, "dist-server")), client = provenance(path12.join(root, "dist"));
  const previous = {
    schema: "nassaj-oid-triple-previous/v2",
    clientBuildId: client.buildId,
    serverBuildId: server.buildId,
    clientOid: client.commit,
    clientTreeSha256: hashOidPairTree(path12.join(root, "dist")),
    serverTreeSha256: hashOidPairTree(path12.join(root, "dist-server")),
    nodeModulesTreeSha256: hashDependencyTreeV2(path12.join(root, "node_modules")).sha256,
    controlManifestSha256: sha2(pinnedFile(path12.join(root, "dist-server/OID_CONTROL_MANIFEST.json"), "triple_previous_manifest").bytes),
    installRuntime: tripleCurrentRuntime()
  };
  previous.runtime = await probeOidPairPreviousRuntime(root, previous);
  if (!previous.runtime || sha2(readFileSync2(`/proc/${previous.runtime.pid}/exe`)) !== previous.installRuntime.nodeBinarySha256) throw new Error("oid_triple_previous_interpreter_unverified");
  previous.clientPublication = captureClientPublicationBaseline(root, previous);
  return previous;
}
function bootstrapReferenceJson(reference, label) {
  if (!reference || Object.keys(reference).sort().join(",") !== "file,sha256" || !path12.isAbsolute(reference.file) || !HEX643.test(reference.sha256 || "")) throw new Error(`oid_bootstrap_${label}_reference_invalid`);
  return JSON.parse(readBootstrapPinnedFile(reference.file, reference.sha256));
}
function bootstrapRetainedCodeClosure(root, record) {
  verifyTripleRetainedRecord(root, record);
  const file = path12.join(gitControlRoot(root), "nassaj-oid-recovery", record.transactionNonce, "executor", "executor-manifest.json");
  const descriptor = pinnedJson(file, "bootstrap_executor_manifest", { sha256: record.recoveryReference.executorManifestSha256, mode: 384 });
  if (descriptor.codeClosure?.descriptor?.schema !== "nassaj-bootstrap-executable-closure/v1" || !HEX643.test(descriptor.codeClosure.sha256 || "")) throw new Error("oid_bootstrap_executor_closure_invalid");
  return descriptor.codeClosure.sha256;
}
function verifyBootstrapPreviousMaterialLive(root, previousMaterial, previous, supervisor, controlManifest) {
  const digest3 = (relative2) => sha2(pinnedFile(path12.join(root, relative2), `bootstrap_previous_${relative2.replaceAll("/", "_")}`, { maxSize: Number.MAX_SAFE_INTEGER }).bytes);
  const expected = {
    oid: previous.runtime.oid,
    clientOid: previous.clientOid,
    serverBuildId: previous.serverBuildId,
    clientBuildId: previous.clientBuildId,
    controlManifestSha256: previous.controlManifestSha256,
    serverInputManifestSha256: digest3("dist-server/SERVER_INPUT_MANIFEST.json"),
    serverProvenanceSha256: digest3("dist-server/BUILD_PROVENANCE.json"),
    clientProvenanceSha256: digest3("dist/BUILD_PROVENANCE.json"),
    clientTreeSha256: previous.clientTreeSha256,
    serverTreeSha256: previous.serverTreeSha256,
    nodeModulesTreeSha256: previous.nodeModulesTreeSha256,
    dependencyLegacyActualSha256: hashOidPairDependencyTree(path12.join(root, "node_modules")),
    nodeBinarySha256: sha2(pinnedFile(realpathSync3(process.execPath), "bootstrap_previous_node", { maxSize: Number.MAX_SAFE_INTEGER }).bytes),
    nodeVersion: process.version,
    nodeModuleAbi: process.versions.modules,
    pm2PackageTreeSha256: supervisor.pm2TreeSha256,
    safeRestartSha256: digest3("dist-server/scripts/safe-restart.sh"),
    admissionImplementationSha256: digest3("dist-server/OID_CONTROL_CAPSULE.mjs"),
    mode: "release"
  };
  if (controlManifest.safeRestartSha256 !== expected.safeRestartSha256 || controlManifest.capsuleSha256 !== expected.admissionImplementationSha256) throw new Error("oid_bootstrap_previous_control_changed");
  for (const [key, value] of Object.entries(expected)) {
    if (previousMaterial[key] !== value) throw new Error(`oid_bootstrap_previous_${key}_changed`);
  }
  return expected;
}
async function verifyBootstrapExecutionBindings(root, record, state, previous, supervisor, { clock = bootstrapClock() } = {}) {
  const bootstrap = record.bootstrap, ticket = bootstrap?.ticket, material = ticket?.material;
  if (!ticket || bootstrap.proposalEnvBase64 === void 0 || !bootstrap.previousMaterial || typeof bootstrap.previousControlManifestBase64 !== "string" || !bootstrap.qualificationReference) {
    throw new Error("oid_bootstrap_record_invalid");
  }
  const codeClosureSha256 = bootstrapRetainedCodeClosure(root, record);
  if (material.installation.root !== root || material.installation.commonGit !== gitControlRoot(root) || material.installation.hostname !== hostname() || material.installation.serviceUid !== process.getuid() || material.event.sequence !== state.sequence || material.event.group !== state.group || material.event.oid !== state.oid || material.event.targetDigest !== state.targetDigest || material.approval.ownerId !== String(record.pair.ownerId) || material.executor.transactionNonce !== record.transactionNonce || material.executor.codeClosureSha256 !== codeClosureSha256) {
    throw new Error("oid_bootstrap_live_binding_changed");
  }
  const candidateManifest = bootstrapReferenceJson(bootstrap.candidateManifestReference, "candidate_manifest");
  if (bootstrap.candidateManifestReference.sha256 !== material.event.manifestSha256 || candidateManifest.releaseCommit !== material.event.oid || candidateManifest.serverBuildId !== state.target.serverBuildId || candidateManifest.clientBuildId !== state.target.clientBuildId) throw new Error("oid_bootstrap_candidate_manifest_changed");
  for (const key of ["clientBuildId", "serverBuildId", "controlManifestSha256", "clientTreeSha256", "serverTreeSha256", "nodeModulesTreeSha256"]) {
    if (material.previous[key] !== previous[key] || bootstrap.previousMaterial[key] !== previous[key]) throw new Error("oid_bootstrap_previous_changed");
  }
  const previousStatus = readFileSync2(`/proc/${previous.runtime.pid}/status`, "utf8").match(/^PPid:\s+(\d+)/m);
  if (material.previous.pid !== previous.runtime.pid || !previousStatus || material.previous.ppid !== Number(previousStatus[1]) || material.previous.startTicks !== previous.runtime.startTime || material.supervisor.pid !== supervisor.daemon.pid || material.supervisor.startTicks !== supervisor.daemon.startTime || material.supervisor.observerSha256 !== sha2(pairCanonical(supervisor.observer)) || material.supervisor.slotSha256 !== supervisor.controlsSha256 || material.supervisor.environmentSha256 !== supervisor.environmentSha256 || material.supervisor.dumpSha256 !== supervisor.dumpSha256) throw new Error("oid_bootstrap_runtime_changed");
  const database = lstatSync2(material.database.path);
  if (!database.isFile() || database.isSymbolicLink() || String(database.dev) !== material.database.dev || String(database.ino) !== material.database.ino || (database.mode & 511) !== 384) throw new Error("oid_bootstrap_database_changed");
  const currentEnv = pinnedFile(path12.join(root, ".env"), "bootstrap_original_mode", { mode: 384 }).bytes;
  const proposal = bootstrapProposalBytes(record), mode = validateBootstrapModeProposal(currentEnv, proposal);
  if (mode.originalSha256 !== material.mode.originalEnvSha256 || mode.proposalSha256 !== material.mode.proposalEnvSha256) throw new Error("oid_bootstrap_mode_changed");
  const previousManifest = Buffer.from(bootstrap.previousControlManifestBase64, "base64");
  if (previousManifest.toString("base64") !== bootstrap.previousControlManifestBase64 || sha2(previousManifest) !== bootstrap.previousMaterial.controlManifestSha256) throw new Error("oid_bootstrap_previous_manifest_changed");
  const liveManifest = JSON.parse(previousManifest);
  verifyBootstrapPreviousMaterialLive(root, bootstrap.previousMaterial, previous, supervisor, liveManifest);
  const qualified = inspectBootstrapQualification({
    installation: material.installation,
    actualPrevious: bootstrap.previousMaterial,
    liveManifest,
    executorCodeClosureSha256: codeClosureSha256,
    verifierClosureSha256: sha2(verifyTripleRetainedRecord(root, record)["capsule.mjs"]),
    qualificationReference: bootstrap.qualificationReference
  });
  if (qualified.qualificationSha256 !== material.baseline.attestationSha256 || qualified.reportSha256 !== material.baseline.rehearsalSha256 || qualified.databasePath !== material.database.path) {
    throw new Error("oid_bootstrap_qualification_changed");
  }
  const review = bootstrapReferenceJson(bootstrap.reviewReference, "review");
  const receipt = bootstrapReferenceJson(bootstrap.approvalReference, "approval");
  if (bootstrap.approvalReference.sha256 !== material.approval.receiptSha256) throw new Error("oid_bootstrap_approval_changed");
  validateBootstrapApprovalChain(ticket, review, receipt, bootstrap.ownerPrincipal, clock);
  verifyBootstrapTicket(ticket, material, clock);
  return { material, codeClosureSha256, qualified };
}
function tripleReadClaim(root, transaction, record, { requireFresh = true } = {}) {
  const state = pinnedJson(path12.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${String(transaction.sequence).padStart(16, "0")}.json`), "triple_event").localUpdate;
  if (state.targetDigest !== transaction.pair.targetDigest || state.activation?.actionId !== transaction.actionId || state.activation?.transactionNonce !== transaction.transactionNonce || (transaction.pair.authority || state.consent)?.ownerId !== String(record.pair.ownerId) || transaction.pair.authoritySourceSha256 && transaction.pair.authoritySourceSha256 !== sha2(pairCanonical(state.policyAuthorization || state.consent)) || computeOidTripleTargetDigest({ sequence: state.sequence, group: state.group, sourceOid: state.oid, target: state.target }) !== transaction.pair.targetDigest || requireFresh && git(root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]) !== state.oid) throw new Error("oid_triple_claim_changed");
  if (!requireFresh) return state;
  inspectOidPairAuthority(root, state, record.pair.ownerId);
  const database = new DatabaseSync(record.pair.databasePath, { readOnly: true });
  try {
    if (!database.prepare("SELECT id FROM users WHERE id=? AND role='owner' AND is_active=1 AND status='active'").get(record.pair.ownerId)) throw new Error("oid_triple_owner_not_authorized");
  } finally {
    database.close();
  }
  return state;
}
function tripleLocation(root, transaction, name) {
  const target = transaction.pair.target;
  return {
    live: path12.join(root, name === "nodeModules" ? "node_modules" : name === "server" ? "dist-server" : "dist"),
    candidate: name === "nodeModules" ? oidTripleDependencySlot(root, transaction) : path12.join(root, ".nassaj-local-preview", `${name}-candidates`, target[`${name}BuildId`])
  };
}
function tripleCloneParents(root, nonce, { create = false } = {}) {
  if (!HEX643.test(nonce || "") || realpathSync3(root) !== root) throw new Error("oid_triple_clone_context_invalid");
  const directories = [root, path12.join(root, ".nassaj-local-preview"), path12.join(root, ".nassaj-local-preview", "dependency-exchanges")];
  directories.push(path12.join(directories[2], nonce));
  const device = lstatSync2(path12.join(root, "node_modules")).dev, identities = [];
  for (const [index, directory] of directories.entries()) {
    if (create && index >= 2 && !fs13.existsSync(directory)) {
      fs13.mkdirSync(directory, { mode: 448 });
      fsyncDir(path12.dirname(directory));
    }
    const stat = lstatSync2(directory);
    if (!stat.isDirectory() || realpathSync3(directory) !== directory || stat.uid !== process.getuid() || stat.mode & 18 || stat.dev !== device || index >= 2 && (stat.mode & 511) !== 448 || Number(fs13.statfsSync(directory).type) === 16914836) throw new Error("oid_triple_clone_parent_unsafe");
    identities.push({ path: directory, dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, mode: stat.mode & 511 });
  }
  return identities;
}
function oidTripleDependencySlot(root, transaction) {
  const descriptor = transaction.dependencyExchange;
  if (descriptor?.layout !== "transaction-copy/v1" || descriptor.phase !== "ready" || descriptor.transactionNonce !== transaction.transactionNonce || descriptor.targetDigest !== transaction.pair.targetDigest || descriptor.treeSha256 !== transaction.pair.target.nodeModulesTreeSha256 || descriptor.contractSha256 !== transaction.pair.target.dependencyContractSha256 || pairCanonical(tripleCloneParents(root, transaction.transactionNonce)) !== pairCanonical(descriptor.parents)) throw new Error("oid_triple_dependency_slot_unverified");
  return path12.join(root, ".nassaj-local-preview", "dependency-exchanges", transaction.transactionNonce, "node_modules");
}
function oidTripleCloneBudget(source, storage, remainingBudget = 0) {
  if (!Number.isSafeInteger(remainingBudget) || remainingBudget < 0) throw new Error("oid_triple_clone_budget_unknown");
  const block = Number(storage.bsize);
  let entries = 0, bytes = 0;
  if (!Number.isSafeInteger(block) || block <= 0) throw new Error("oid_triple_clone_budget_unknown");
  function walk(file) {
    const stat = lstatSync2(file);
    entries++;
    if (stat.isDirectory()) for (const name of readdirSync2(file)) walk(path12.join(file, name));
    else if (stat.isFile()) bytes += Math.ceil(stat.size / block) * block;
    else if (!stat.isSymbolicLink()) throw new Error("oid_triple_clone_special_file");
  }
  walk(source);
  const copyBytes = bytes + 4 * block * entries, reserveBytes = Math.max(64 * 1024 * 1024, Math.ceil(copyBytes / 10));
  const required = copyBytes + reserveBytes + remainingBudget;
  if (![entries, required, Number(storage.bavail) * block, Number(storage.ffree), Number(storage.favail ?? storage.ffree)].every(Number.isSafeInteger)) throw new Error("oid_triple_clone_budget_unknown");
  if (Number(storage.bavail) * block < required || Number(storage.favail ?? storage.ffree) < entries + 128) throw new Error("oid_triple_clone_storage_unavailable");
  return { copyBytes, reserveBytes, remainingBudget, entries, block };
}
function tripleCopyRegularFile(source, destination, expected) {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    const before = fstatSync(input);
    if (!before.isFile() || before.nlink !== expected.nlink || before.dev !== expected.dev || before.ino !== expected.ino) throw new Error("oid_triple_clone_source_raced");
    output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs13.readSync(input, buffer, 0, buffer.length, null)) > 0) {
      let offset = 0;
      while (offset < count) offset += fs13.writeSync(output, buffer, offset, count - offset);
    }
    const after = fstatSync(input);
    if (before.ctimeMs !== after.ctimeMs || before.size !== after.size || after.nlink !== before.nlink) throw new Error("oid_triple_clone_source_raced");
    fs13.fchmodSync(output, before.mode & 511);
    fsyncSync(output);
  } finally {
    if (output !== void 0) closeSync(output);
    closeSync(input);
  }
}
function tripleCopySealedTree(source, destination) {
  const stat = lstatSync2(source);
  if (stat.isDirectory()) {
    fs13.mkdirSync(destination, { mode: 448 });
    for (const name of readdirSync2(source).sort()) tripleCopySealedTree(path12.join(source, name), path12.join(destination, name));
    fs13.chmodSync(destination, stat.mode & 511);
    fsyncDir(destination);
  } else if (stat.isSymbolicLink()) fs13.symlinkSync(readlinkSync(source), destination);
  else if (stat.isFile()) {
    tripleCopyRegularFile(source, destination, stat);
  } else throw new Error("oid_triple_clone_special_or_shared_file");
}
function prepareOidTripleDependencyExchange(root, file, transaction, { remainingBudget = 0 } = {}) {
  if (transaction.oldStopIntentAt || transaction.oldStoppedAt || transaction.pair.databaseState !== "PRE_CANDIDATE") throw new Error("oid_triple_clone_after_stop_forbidden");
  const target = validateOidTripleTargetDescriptor(transaction.pair.target);
  const source = path12.join(root, ".nassaj-local-preview", "dependency-candidates", target.nodeModulesTreeSha256);
  for (const directory2 of [root, path12.join(root, ".nassaj-local-preview"), path12.dirname(source)]) {
    const stat = lstatSync2(directory2);
    if (!stat.isDirectory() || realpathSync3(directory2) !== directory2 || stat.uid !== process.getuid() || stat.mode & 18) throw new Error("oid_triple_clone_source_parent_unsafe");
  }
  const before = hashDependencyTreeV2(source, { requireSealed: true });
  if (before.sha256 !== target.nodeModulesTreeSha256) throw new Error("oid_triple_clone_source_changed");
  let current = transaction;
  if (!current.dependencyExchange) {
    current = { ...current, dependencyExchange: {
      layout: "transaction-copy/v1",
      phase: "intent",
      transactionNonce: current.transactionNonce,
      targetDigest: current.pair.targetDigest,
      treeSha256: target.nodeModulesTreeSha256,
      contractSha256: target.dependencyContractSha256
    } };
    durable(file, current);
    injectFailure("triple_clone_after_intent");
  }
  const descriptor = current.dependencyExchange;
  if (descriptor.layout !== "transaction-copy/v1" || descriptor.transactionNonce !== current.transactionNonce || descriptor.targetDigest !== current.pair.targetDigest || descriptor.treeSha256 !== before.sha256 || descriptor.contractSha256 !== target.dependencyContractSha256 || !["intent", "copying", "ready"].includes(descriptor.phase)) throw new Error("oid_triple_clone_intent_invalid");
  const parents = tripleCloneParents(root, current.transactionNonce, { create: descriptor.phase === "intent" });
  if (descriptor.parents && pairCanonical(descriptor.parents) !== pairCanonical(parents)) throw new Error("oid_triple_clone_parent_changed");
  const directory = parents.at(-1).path, candidate = path12.join(directory, "node_modules"), temporary = path12.join(directory, "preparing");
  if (!fs13.existsSync(candidate)) {
    if (descriptor.phase === "ready" || fs13.existsSync(temporary)) throw new Error("oid_triple_clone_partial_requires_review");
    const budget2 = oidTripleCloneBudget(source, fs13.statfsSync(directory), remainingBudget);
    current = { ...current, dependencyExchange: { ...descriptor, phase: "copying", parents, budget: budget2 } };
    durable(file, current);
    tripleCopySealedTree(source, temporary);
    injectFailure("triple_clone_after_copy");
    if (pairCanonical(hashDependencyTreeV2(temporary, { requireSealed: true })) !== pairCanonical(before) || pairCanonical(hashDependencyTreeV2(source, { requireSealed: true })) !== pairCanonical(before)) throw new Error("oid_triple_clone_changed");
    if (fs13.existsSync(candidate)) throw new Error("oid_triple_clone_destination_exists");
    renameSync(temporary, candidate);
    fsyncDir(directory);
    injectFailure("triple_clone_after_publish");
  }
  if (pairCanonical(hashDependencyTreeV2(candidate, { requireSealed: true })) !== pairCanonical(before) || pairCanonical(hashDependencyTreeV2(source, { requireSealed: true })) !== pairCanonical(before)) throw new Error("oid_triple_clone_changed");
  if (pairCanonical(tripleCloneParents(root, current.transactionNonce)) !== pairCanonical(parents)) throw new Error("oid_triple_clone_parent_changed");
  const budget = current.dependencyExchange.budget;
  const storage = fs13.statfsSync(directory);
  if (!budget || Number(storage.bavail) * Number(storage.bsize) < budget.reserveBytes + remainingBudget || Number(storage.favail ?? storage.ffree) < 128) throw new Error("oid_triple_clone_reserve_unavailable");
  current = { ...current, dependencyExchange: { ...current.dependencyExchange, phase: "ready", parents, readyAt: Date.now() } };
  durable(file, current);
  return current;
}
async function exchangeOidTripleGenerations(root, file, transaction, direction, record) {
  let current = transaction;
  for (const name of direction === "forward" ? UPDATE_GENERATION_NAMES : [...UPDATE_GENERATION_NAMES].reverse()) {
    verifyTripleRetainedRecord(root, record);
    tripleReadClaim(root, current, record, { requireFresh: false });
    if (current.persistence?.stopped?.state !== "verified") throw new Error("oid_triple_stopped_persistence_missing");
    const stoppedSlot = validateOidTriplePm2Slot(await triplePm2Read(current.supervisor), current.supervisor, "stopped");
    validateOidTriplePm2Dump(pinnedJson(path12.join(current.supervisor.pm2Home, "dump.pm2"), "triple_stopped_dump"), stoppedSlot);
    if (!pairOwnerProvablyDead(current.pair.previous.runtime)) throw new Error("oid_triple_old_process_not_dead");
    const plan = inspectOidTripleGenerationPlan(root, current, direction);
    if (plan.state !== "verified") throw new Error(plan.reason);
    const step = plan.steps.find((item) => item.name === name), locations = tripleLocation(root, current, name);
    const intent = { ...locations, previous: current.pair.previous[`${name}TreeSha256`], target: current.pair.target[`${name}TreeSha256`], direction, operation: step.operation, state: "intent" };
    current = { ...current, state: `triple_${direction}_${name}_intent`, exchanges: { ...current.exchanges, [name]: intent } };
    durable(file, current);
    injectFailure(`triple_${direction}_${name}_before_exchange`);
    if (step.operation === "exchange") await exchange(locations.candidate, locations.live);
    fsyncDir(path12.dirname(locations.live));
    fsyncDir(path12.dirname(locations.candidate));
    injectFailure(`triple_${direction}_${name}_after_exchange`);
    const verified = inspectOidTripleGenerationPlan(root, current, direction);
    if (verified.state !== "verified" || verified.steps.find((item) => item.name === name).operation !== "attest") throw new Error("oid_triple_exchange_unverified");
    current = { ...current, state: `triple_${direction}_${name}_done`, exchanges: { ...current.exchanges, [name]: { ...intent, state: "done" } } };
    durable(file, current);
  }
  return current;
}
var OID_TRIPLE_ORIGIN_FAILURE_CODES = /* @__PURE__ */ new Set([
  "oid_triple_start_unverified",
  "oid_triple_health_unverified",
  "oid_triple_child_unverified",
  "oid_triple_stop_unverified",
  "oid_triple_exchange_unverified",
  "oid_triple_previous_runtime_unverified",
  "oid_native_probe_isolation_or_abi_failed",
  "oid_native_probe_identity_invalid",
  "oid_native_probe_dependencies_changed",
  "oid_native_probe_proof_invalid"
]);
function recordOidTripleOriginFailure(file, expected, error) {
  let latest;
  try {
    latest = pinnedJson(file, "triple_origin_journal");
  } catch (readError) {
    if (readError.code === "ENOENT") return null;
    throw readError;
  }
  if (latest.schema !== "nassaj-oid-control-transaction/v2" || latest.sequence !== expected.sequence || latest.transactionNonce !== expected.transactionNonce || latest.actionId !== expected.actionId || latest.pair?.targetDigest !== expected.pair?.targetDigest) throw new Error("oid_triple_origin_binding_changed");
  if (latest.originFailureCode !== void 0) return latest;
  const reason = [error?.code, error?.message].find((value) => OID_TRIPLE_ORIGIN_FAILURE_CODES.has(value)) || "unknown";
  const updated = { ...latest, originFailureCode: reason };
  durable(file, updated);
  return updated;
}
function recordOidTripleSafeStartFailure(file, expected, phase, result) {
  if (!["start-target", "start-previous"].includes(phase)) throw new Error("oid_triple_start_diagnostic_phase_invalid");
  const latest = pinnedJson(file, "triple_start_diagnostic_journal");
  if (latest.schema !== "nassaj-oid-control-transaction/v2" || latest.sequence !== expected.sequence || latest.transactionNonce !== expected.transactionNonce || latest.actionId !== expected.actionId || latest.pair?.targetDigest !== expected.pair?.targetDigest || latest.bootNonce !== expected.bootNonce || latest.bootDirection !== expected.bootDirection || latest.bootDirection !== (phase === "start-target" ? "target" : "previous")) {
    throw new Error("oid_triple_start_diagnostic_binding_changed");
  }
  const diagnostic = createOidTripleSafeDiagnostic().summarize(result.diagnostic?.exitCode, result.diagnostic?.signal);
  diagnostic.reason = SAFE_STOP_DIAGNOSTIC_CODES.has(result.diagnostic?.reason) ? result.diagnostic.reason : "unknown";
  if (diagnostic.reason === "unknown" && result.pipeError) diagnostic.reason = oidTripleSafeDiagnosticReason(result.pipeError);
  const updated = { ...latest, safeStartFailure: { phase, ...diagnostic, pipeError: Boolean(result.pipeError) } };
  durable(file, updated);
  return updated;
}
async function startAndAttestOidTriple(root, record, safeBytes, handle, file, transaction, rollback = false) {
  const slot = validateOidTriplePm2Slot(await triplePm2Read(transaction.supervisor), transaction.supervisor, "stopped");
  const stoppedEnvironment = slot.pm2_env.env || {};
  const stoppedMode = transaction.bootstrap && (rollback || Object.hasOwn(stoppedEnvironment, "NASSAJ_UPDATE_MODE")) ? "release" : "local-main";
  assertOidTripleEffectiveMode(root, stoppedEnvironment, stoppedMode);
  let current = {
    ...transaction,
    state: rollback ? "triple_previous_start_intent" : "triple_candidate_start_intent",
    bootDirection: rollback ? "previous" : "target",
    bootNonce: randomBytes4(32).toString("hex"),
    pair: { ...transaction.pair, databaseState: rollback ? "PRE_CANDIDATE" : "UNKNOWN" }
  };
  durable(file, current);
  handle.transition({ phase: "OID_BOOTSTRAP_VERIFYING", databaseState: current.pair.databaseState });
  injectFailure(rollback ? "triple_before_previous_start" : "triple_before_candidate_start");
  const result = await runSafe(safeBytes, ["--oid-triple-phase", rollback ? "start-previous" : "start-target"], { ...record, artifactRoot: path12.join(root, "dist-server") });
  if (result.status !== 0 || result.pipeError) {
    recordOidTripleSafeStartFailure(file, current, rollback ? "start-previous" : "start-target", result);
    throw new Error("oid_triple_start_unverified");
  }
  const selected = rollback ? current.pair.previous : current.pair.target;
  const proof = await health({
    oid: rollback ? selected.runtime.oid : current.oid,
    buildId: selected.serverBuildId,
    transactionNonce: current.transactionNonce,
    bootNonce: current.bootNonce,
    oldStartTicks: record.oldStartTicks
  });
  if (!proof || proof.clientBuildIdServed !== selected.clientBuildId || proof.oidNodeModulesTreeSha256 !== selected.nodeModulesTreeSha256 || proof.oidPairTargetDigest !== current.pair.targetDigest) throw new Error("oid_triple_health_unverified");
  const child = pinnedJson(path12.join(handle.paths.controlRoot, `oid-child-${current.transactionNonce}.json`), "triple_child");
  if (child.schema !== "nassaj-oid-triple-bootstrap/v2" || child.pid !== proof.pid || child.startTime !== proof.serverProcessStartTicks || child.nodeModulesTreeSha256 !== selected.nodeModulesTreeSha256 || !pairOwnerAlive(child)) throw new Error("oid_triple_child_unverified");
  current = await persistOidTriplePm2Slot(root, file, current, "online", child);
  current = pairTerminalReceipt(
    root,
    { ...current, pair: { ...current.pair, databaseState: rollback ? "PRE_CANDIDATE" : "TARGET_VERIFIED" } },
    file,
    rollback ? "rolled_back" : "activated",
    {
      pid: proof.pid,
      startTime: proof.serverProcessStartTicks,
      serverOid: rollback ? selected.runtime.oid : current.oid,
      clientBuildIdServed: proof.clientBuildIdServed,
      oidNodeModulesTreeSha256: proof.oidNodeModulesTreeSha256,
      oidPairTargetDigest: proof.oidPairTargetDigest,
      ...rollback && selected.clientPublication ? { http: await probeOidRollbackClientHttp(root) } : {}
    }
  );
  injectFailure("triple_after_terminal");
  const state = tripleReadClaim(root, current, record, { requireFresh: false });
  pairRecordEvent(root, state, { phase: rollback ? "failed" : "awaiting_serving", receipt: current.pair.receipt, ...rollback ? { consent: null } : {} });
  completeOidPairAdmission(root, handle);
  return current.pair.receipt;
}
function prepareOidTripleClaimedDependencyExchange(root, file, transaction, record) {
  const held = pinnedJson(file, "triple_executor_claim");
  if (held.schema !== "nassaj-oid-control-transaction/v2" || held.state !== "triple_prepared" || held.transactionNonce !== record.transactionNonce || held.actionId !== record.actionId || held.pair?.targetDigest !== record.pair?.targetDigest || pairCanonical(held) !== pairCanonical(JSON.parse(JSON.stringify(transaction))) || record.repoRoot !== root || record.handshakePath !== path12.join(path12.dirname(file), `nassaj-oid-control-handshake-${record.transactionNonce}.json`) || held.oldStopIntentAt || held.pair.databaseState !== "PRE_CANDIDATE") throw new Error("oid_triple_executor_claim_invalid");
  durable(record.handshakePath, {
    schema: 1,
    state: "executor_ready",
    launcherNonce: record.transactionNonce,
    transactionNonce: record.transactionNonce,
    sequence: held.sequence,
    oid: held.oid,
    buildId: held.pair.target.serverBuildId,
    journalFile: file
  });
  return prepareOidTripleDependencyExchange(root, file, held);
}
async function runOidTripleTransaction(record, safeBytes, initial) {
  const root = record.repoRoot, expected = { ...record.pair, actionId: record.actionId, transactionNonce: record.transactionNonce };
  verifyTripleRetainedRecord(root, record);
  if (activeTransactions(root).length) throw new Error("oid_triple_recovery_required");
  const manifests = pairRequireCapabilities(root, initial), previous = await captureOidTriplePreviousGeneration(root, manifests.live);
  const supervisor = await captureOidTripleSupervisor(root, record);
  const identity2 = {
    sequence: initial.sequence,
    group: initial.group,
    oid: initial.oid,
    targetDigest: initial.targetDigest,
    transactionNonce: record.transactionNonce,
    journalBasename: `nassaj-oid-control-transaction-${initial.sequence}-${record.transactionNonce}.json`,
    previousClientBuildId: previous.clientBuildId,
    previousServerBuildId: previous.serverBuildId,
    targetClientBuildId: initial.target.clientBuildId,
    targetServerBuildId: initial.target.serverBuildId
  };
  let transaction = {
    schema: "nassaj-oid-control-transaction/v2",
    generationNames: UPDATE_GENERATION_NAMES,
    ...identity2,
    buildId: initial.target.serverBuildId,
    actionId: record.actionId,
    owner: pairProcessIdentity(),
    supervisor,
    recoveryReference: record.recoveryReference,
    state: "pair_admission_intent",
    pair: { targetDigest: initial.targetDigest, target: initial.target, previous, databaseState: "PRE_CANDIDATE", activationNotClaimed: true }
  };
  transaction.fullUpdateWaiter = await claimFullClientPublicationWaiter(root, initial.sequence, record.transactionNonce);
  const handle = await beginOidPairAdmission(root, identity2, { intent: transaction }), file = path12.join(handle.paths.gitRoot, identity2.journalBasename);
  try {
    await handle.lockPublishers();
    let state = inspectConfirmedOidPair(root, expected);
    pairRequireCapabilities(root, state);
    pairVerifyLive(root, { targetClientBuildId: previous.clientBuildId, targetServerBuildId: previous.serverBuildId }, previous);
    await assertOidPairPreviousRuntime(root, previous);
    const snapshot = await prepareOidTriplePublicationSnapshot(root, state.target, previous, record.pair.databasePath, { ...identity2, ownerId: record.pair.ownerId, actionId: record.actionId });
    state = inspectConfirmedOidPair(root, expected);
    state = pairRecordEvent(root, state, { phase: "activation_claimed", activation: { actionId: record.actionId, transactionNonce: record.transactionNonce, claimedAt: Date.now() } });
    transaction = { ...transaction, state: "triple_prepared", pair: {
      ...transaction.pair,
      snapshot,
      previousMaintenance: handle.original,
      activationNotClaimed: false,
      consent: state.consent,
      authority: inspectOidPairAuthority(root, state, record.pair.ownerId),
      authoritySourceSha256: sha2(pairCanonical(state.policyAuthorization || state.consent))
    } };
    durableCreate(file, transaction);
    transaction = prepareOidTripleClaimedDependencyExchange(root, file, transaction, record);
    tripleReadClaim(root, transaction, record);
    transaction = { ...transaction, state: "triple_old_stop_intent", oldStopIntentAt: Date.now() };
    durable(file, transaction);
    handle.transition({ phase: "OID_EXCHANGING" });
    injectFailure("triple_before_old_stop");
    const stopped = await runSafe(safeBytes, ["--oid-triple-phase", "stop", "--exec"], { ...record, artifactRoot: path12.join(root, "dist-server") });
    transaction = pinnedJson(file, "triple_stopped_journal");
    if (stopped.status !== 0 || transaction.state !== "triple_old_stopped") {
      transaction = { ...transaction, safeStopFailure: stopped.diagnostic };
      durable(file, transaction);
      throw new Error("oid_triple_stop_unverified");
    }
    injectFailure("triple_after_old_stop");
    transaction = await exchangeOidTripleGenerations(root, file, transaction, "forward", record);
    const nativeProbe = runOidTripleNativeProbe(root, path12.join(root, "node_modules"), { ...transaction.pair.target, transactionNonce: record.transactionNonce });
    transaction = { ...transaction, nativeProbe };
    durable(file, transaction);
    tripleReadClaim(root, transaction, record, { requireFresh: false });
    return await startAndAttestOidTriple(root, record, safeBytes, handle, file, transaction);
  } catch (error) {
    try {
      recordOidTripleOriginFailure(file, transaction, error);
    } finally {
      await recoverOidTripleOwnedFailure(root, record, safeBytes, handle, file, transaction, error);
    }
    throw error;
  } finally {
    handle.release();
  }
}
function assertOidTripleFailureBinding(actual, expected) {
  if (actual?.schema !== "nassaj-oid-control-transaction/v2" || actual.schema !== expected?.schema || actual.sequence !== expected.sequence || actual.actionId !== expected.actionId || actual.transactionNonce !== expected.transactionNonce || actual.targetDigest !== expected.targetDigest || !actual.pair?.targetDigest || actual.pair.targetDigest !== expected.pair?.targetDigest) {
    throw new Error("oid_triple_recovery_binding_changed");
  }
  return actual;
}
async function recoverOidTripleOwnedFailure(root, record, safeBytes, handle, file, fallback, error) {
  let journalObserved = false;
  const readBound = (label) => {
    let latest;
    try {
      latest = pinnedJson(file, label);
      journalObserved = true;
    } catch (readError) {
      if (readError.code !== "ENOENT" || journalObserved || fallback.state !== "pair_admission_intent" || fallback.pair?.activationNotClaimed !== true || fallback.oldStopIntentAt || fallback.oldStoppedAt || fallback.bootDirection || fallback.bootNonce) throw readError;
      latest = fallback;
    }
    return assertOidTripleFailureBinding(latest, fallback);
  };
  let transaction = readBound("triple_failure_journal");
  const refreshPre = () => {
    const latest = readBound("triple_failure_pre_effect");
    if (latest.pair.databaseState !== "PRE_CANDIDATE" || latest.state !== transaction.state || latest.bootDirection !== transaction.bootDirection || latest.oldStoppedAt !== transaction.oldStoppedAt || latest.oldStopIntentAt !== transaction.oldStopIntentAt) throw new Error("oid_triple_recovery_binding_changed");
    return latest;
  };
  if (transaction.pair.databaseState === "PRE_CANDIDATE") {
    let plan = { state: "manual", steps: [] };
    const beforeStop = !transaction.oldStopIntentAt && !transaction.oldStoppedAt && !transaction.bootDirection;
    if (beforeStop) {
      try {
        const grant = path12.join(handle.paths.controlRoot, `oid-child-${transaction.transactionNonce}.json`);
        try {
          lstatSync2(grant);
          throw new Error("oid_triple_pre_stop_child_observed");
        } catch (error2) {
          if (error2.code !== "ENOENT") throw error2;
        }
        pairVerifyLive(root, { targetClientBuildId: transaction.pair.previous.clientBuildId, targetServerBuildId: transaction.pair.previous.serverBuildId }, transaction.pair.previous);
        plan = { state: "verified", steps: [] };
      } catch {
      }
    } else {
      try {
        plan = inspectOidTripleGenerationPlan(root, transaction, "rollback");
      } catch {
      }
    }
    if (plan.state === "verified" && plan.steps.every((step) => step.operation === "attest") && pairOwnerAlive(transaction.pair.previous.runtime)) {
      try {
        await assertOidPairPreviousRuntime(root, transaction.pair.previous);
        transaction = refreshPre();
        const event = pinnedJson(path12.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${String(transaction.sequence).padStart(16, "0")}.json`), "triple_not_started_event").localUpdate;
        transaction = refreshPre();
        if (event.targetDigest === transaction.pair.targetDigest) pairRecordEvent(root, event, { phase: "failed", consent: null });
        durable(file, { ...transaction, state: "restart_deferred_restored", error: "oid_triple_not_started" });
        injectFailure("full_waiter_after_pre_effect_terminal");
        releaseFullWaiterBeforeEffects(root, transaction, file);
        const { checksum: ignoredChecksum, sequence: ignoredSequence, ...original } = handle.original || transaction.pair.previousMaintenance;
        handle.transition({ ...original, oidAdmissionIntent: null });
        return { restored: true };
      } catch (failure) {
        if (failure.message === "oid_triple_recovery_binding_changed") throw failure;
      }
    }
    try {
      if (beforeStop || plan.state !== "verified" || !pairOwnerProvablyDead(transaction.pair.previous.runtime)) throw new Error("oid_triple_rollback_not_proven");
      transaction = refreshPre();
      validateOidTriplePm2Slot(await triplePm2Read(transaction.supervisor), transaction.supervisor, "stopped");
      transaction = refreshPre();
      if (!transaction.oldStoppedAt) {
        if (transaction.state !== "triple_old_stop_intent") throw new Error("oid_triple_stop_intent_missing");
        transaction = await persistOidTriplePm2Slot(root, file, transaction, "stopped");
        transaction = { ...transaction, oldStoppedAt: Date.now(), stopReconciled: true };
        durable(file, transaction);
      }
      transaction = refreshPre();
      transaction = await exchangeOidTripleGenerations(root, file, transaction, "rollback", record);
      transaction = refreshPre();
      if (transaction.bootstrapMode) transaction = restoreBootstrapModeCAS(root, file, transaction, record);
      return await startAndAttestOidTriple(root, record, safeBytes, handle, file, transaction, true);
    } catch (failure) {
      if (failure.message === "oid_triple_recovery_binding_changed") throw failure;
    }
  }
  transaction = readBound("triple_failure_latest");
  if (!["pair_served", "pair_rolled_back"].includes(transaction.state)) durable(file, { ...transaction, state: "manual_recovery_required", error: "oid_triple_recovery_requires_retained_executor" });
  handle.transition({ state: "MANUAL", gateClosed: true, phase: "OID_RECOVERING", recoveryError: "oid_triple_recovery_requires_retained_executor" });
  return { restored: false, error: error.message };
}
async function attestOidTripleExistingChild(root, record, handle, file, transaction) {
  const rollback = transaction.bootDirection === "previous";
  const plan = inspectOidTripleGenerationPlan(root, transaction, rollback ? "rollback" : "forward");
  if (plan.state !== "verified" || plan.steps.some((step) => step.operation !== "attest")) throw new Error("oid_triple_resume_generations_unknown");
  const selected = rollback ? transaction.pair.previous : transaction.pair.target;
  const child = pinnedJson(path12.join(handle.paths.controlRoot, `oid-child-${transaction.transactionNonce}.json`), "triple_resume_child");
  if (child.schema !== "nassaj-oid-triple-bootstrap/v2" || child.rollback !== rollback || !pairOwnerAlive(child) || child.nodeModulesTreeSha256 !== selected.nodeModulesTreeSha256 || child.targetDigest !== transaction.pair.targetDigest) throw new Error("oid_triple_resume_child_unverified");
  const proof = await health({
    oid: rollback ? selected.runtime.oid : transaction.oid,
    buildId: selected.serverBuildId,
    transactionNonce: transaction.transactionNonce,
    bootNonce: transaction.bootNonce,
    oldStartTicks: record.oldStartTicks
  }, 3);
  if (!proof || proof.pid !== child.pid || proof.serverProcessStartTicks !== child.startTime || proof.clientBuildIdServed !== selected.clientBuildId || proof.oidNodeModulesTreeSha256 !== selected.nodeModulesTreeSha256 || proof.oidPairTargetDigest !== transaction.pair.targetDigest) throw new Error("oid_triple_resume_health_unverified");
  transaction = await persistOidTriplePm2Slot(root, file, transaction, "online", child);
  const current = ["pair_served", "pair_rolled_back"].includes(transaction.state) ? transaction : pairTerminalReceipt(
    root,
    { ...transaction, pair: { ...transaction.pair, databaseState: rollback ? "PRE_CANDIDATE" : "TARGET_VERIFIED" } },
    file,
    rollback ? "rolled_back" : "activated",
    {
      pid: proof.pid,
      startTime: proof.serverProcessStartTicks,
      serverOid: rollback ? selected.runtime.oid : transaction.oid,
      clientBuildIdServed: proof.clientBuildIdServed,
      oidNodeModulesTreeSha256: proof.oidNodeModulesTreeSha256,
      oidPairTargetDigest: proof.oidPairTargetDigest,
      ...rollback && selected.clientPublication ? { http: await probeOidRollbackClientHttp(root) } : {}
    }
  );
  if (!validateOidPairTerminal(root, current) || current.pair.receipt.pid !== proof.pid || current.pair.receipt.startTime !== child.startTime) throw new Error("oid_triple_resume_terminal_invalid");
  qualifyRestoredClientPublication(root, current);
  pairRecordTerminalEvent(root, current);
  completeOidPairAdmission(root, handle);
  return current.pair.receipt;
}
async function abortBootstrapClaimWithoutJournal(root, record, paths) {
  const ticket = record.bootstrap.ticket, nonce = record.transactionNonce;
  const claimFile = path12.join(paths.gitRoot, "nassaj-oid-recovery", nonce, `bootstrap-claim-${ticket.nonce}.json`);
  const claimBytes = readBootstrapPrivateFile(claimFile), claim = JSON.parse(claimBytes);
  const binding = bootstrapJournalBinding(ticket, { claim, sha256: sha2(claimBytes) });
  if (!pairOwnerProvablyDead(claim.owner)) throw new Error("oid_triple_resume_owner_alive_or_unknown");
  const qualified = record.bootstrap.previousMaterial;
  for (const key of ["clientBuildId", "serverBuildId", "controlManifestSha256", "clientTreeSha256", "serverTreeSha256", "nodeModulesTreeSha256"]) {
    if (qualified[key] !== ticket.material.previous[key]) throw new Error("oid_bootstrap_previous_changed");
  }
  const previous = {
    schema: "nassaj-oid-triple-previous/v2",
    clientBuildId: qualified.clientBuildId,
    serverBuildId: qualified.serverBuildId,
    clientOid: qualified.clientOid,
    clientTreeSha256: qualified.clientTreeSha256,
    serverTreeSha256: qualified.serverTreeSha256,
    nodeModulesTreeSha256: qualified.nodeModulesTreeSha256,
    controlManifestSha256: qualified.controlManifestSha256,
    runtime: {
      pid: ticket.material.previous.pid,
      startTime: ticket.material.previous.startTicks,
      bootId: ticket.bootId,
      oid: qualified.oid,
      serverBuildId: qualified.serverBuildId,
      clientBuildId: qualified.clientBuildId
    }
  };
  pairVerifyLive(root, { targetClientBuildId: previous.clientBuildId, targetServerBuildId: previous.serverBuildId }, previous);
  await assertOidPairPreviousRuntime(root, previous);
  const database = lstatSync2(ticket.material.database.path), maintenance = pairReadMaintenance(paths);
  if (maintenance.state !== "OPEN" || maintenance.gateClosed || maintenance.oidAdmissionIntent || git(root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]) !== ticket.material.event.oid || sha2(pinnedFile(path12.join(root, ".env"), "bootstrap_claim_only_mode", { mode: 384 }).bytes) !== ticket.material.mode.originalEnvSha256 || String(database.dev) !== ticket.material.database.dev || String(database.ino) !== ticket.material.database.ino) {
    throw new Error("oid_bootstrap_pre_effect_state_changed");
  }
  const abortFile = path12.join(path12.dirname(claimFile), "bootstrap-aborted-pre-effect.json");
  const receipt = bootstrapAbortReceipt(binding.claimSha256, nonce);
  if (fs13.existsSync(abortFile)) {
    validateBootstrapAbortReceipt(abortFile, binding.claimSha256, nonce);
  } else durableCreate(abortFile, receipt);
  return { state: "aborted_pre_effect", transactionNonce: nonce };
}
async function resumeOidTripleTransaction(record, safeBytes) {
  const root = record.repoRoot;
  if (record.resume.operatorUid !== process.getuid() || !/^[A-Za-z0-9:_-]{1,120}$/.test(record.resume.permissionRef || "")) throw new Error("oid_triple_resume_permission_invalid");
  verifyTripleRetainedRecord(root, record);
  const sequence = record.bootstrap?.ticket?.material?.event?.sequence ?? record.pair.sequence;
  const paths = pairPaths(root), locks = [], file = path12.join(paths.gitRoot, `nassaj-oid-control-transaction-${sequence}-${record.transactionNonce}.json`);
  const attempt = randomBytes4(16).toString("hex");
  const receiptFile = path12.join(paths.gitRoot, "nassaj-oid-recovery", record.transactionNonce, `resume-${attempt}.json`);
  let current, transaction, handle;
  try {
    for (const lock of [paths.admission, paths.activity, ...["nassaj-local-preview-build.lock", "nassaj-client-build.lock", "nassaj-preview-event-mutation.lock"].map((name) => path12.join(paths.gitRoot, name))]) locks.push(await pairLock(lock));
    current = pairReadMaintenance(paths);
    if (record.bootstrap && current.state === "OPEN" && !current.gateClosed && !current.oidAdmissionIntent) {
      const sequence2 = record.bootstrap.ticket.material.event.sequence;
      const preEffectFile = path12.join(paths.gitRoot, `nassaj-oid-control-transaction-${sequence2}-${record.transactionNonce}.json`);
      let preEffect;
      try {
        preEffect = pinnedJson(preEffectFile, "bootstrap_pre_effect_recovery");
      } catch (error) {
        if (error.code === "ENOENT") return abortBootstrapClaimWithoutJournal(root, record, paths);
        throw error;
      }
      if (preEffect.state === "pair_admission_intent" && preEffect.bootstrap && !preEffect.oldStopIntentAt && !preEffect.oldStoppedAt && !preEffect.bootDirection && preEffect.pair?.activationNotClaimed === true && preEffect.pair.databaseState === "PRE_CANDIDATE") {
        if (!pairOwnerProvablyDead(preEffect.owner)) throw new Error("oid_triple_resume_owner_alive_or_unknown");
        const codeClosureSha256 = bootstrapRetainedCodeClosure(root, record);
        verifyBootstrapJournalBinding(preEffect, record, bootstrapClaimBytes(root, record, preEffect), codeClosureSha256);
        pairVerifyLive(root, {
          targetClientBuildId: preEffect.pair.previous.clientBuildId,
          targetServerBuildId: preEffect.pair.previous.serverBuildId
        }, preEffect.pair.previous);
        await assertOidPairPreviousRuntime(root, preEffect.pair.previous);
        const ticket = record.bootstrap.ticket, database = lstatSync2(ticket.material.database.path);
        if (git(root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]) !== ticket.material.event.oid || sha2(pinnedFile(path12.join(root, ".env"), "bootstrap_abort_mode", { mode: 384 }).bytes) !== ticket.material.mode.originalEnvSha256 || String(database.dev) !== ticket.material.database.dev || String(database.ino) !== ticket.material.database.ino) {
          throw new Error("oid_bootstrap_pre_effect_state_changed");
        }
        const aborted = { ...preEffect, state: "aborted_pre_effect", abortedAt: Date.now() };
        durable(preEffectFile, aborted);
        const abortFile = path12.join(paths.gitRoot, "nassaj-oid-recovery", record.transactionNonce, "bootstrap-aborted-pre-effect.json");
        if (fs13.existsSync(abortFile)) validateBootstrapAbortReceipt(
          abortFile,
          preEffect.bootstrap.claimSha256,
          record.transactionNonce
        );
        else durableCreate(abortFile, bootstrapAbortReceipt(
          preEffect.bootstrap.claimSha256,
          record.transactionNonce,
          aborted.abortedAt
        ));
        return { state: "aborted_pre_effect", transactionNonce: record.transactionNonce };
      }
    }
    transaction = pairJournal(paths, current.identity?.oid).value;
    if (transaction.schema !== "nassaj-oid-control-transaction/v2" || transaction.transactionNonce !== record.transactionNonce || transaction.actionId !== record.actionId || transaction.pair.targetDigest !== record.pair.targetDigest || pairCanonical(transaction.recoveryReference) !== pairCanonical(record.recoveryReference)) throw new Error("oid_triple_resume_binding_changed");
    if (record.bootstrap) {
      const codeClosureSha256 = bootstrapRetainedCodeClosure(root, record);
      verifyBootstrapJournalBinding(transaction, record, bootstrapClaimBytes(root, record, transaction), codeClosureSha256);
    } else if (transaction.bootstrap) throw new Error("oid_triple_resume_binding_changed");
    if (current.state === "OPEN") {
      validateOidPairMaintenance(root, current);
      durableCreate(receiptFile, { ...record.resume, attempt, state: "already_completed", transactionNonce: record.transactionNonce });
      return transaction.pair.receipt;
    }
    if (!pairOwnerProvablyDead(current.owner) || !pairOwnerProvablyDead(transaction.owner)) throw new Error("oid_triple_resume_owner_alive_or_unknown");
    durableCreate(receiptFile, { ...record.resume, attempt, state: "intent", transactionNonce: record.transactionNonce });
    const terminal = ["pair_served", "pair_rolled_back"].includes(transaction.state);
    if (!terminal) {
      transaction = { ...transaction, owner: pairProcessIdentity(), resume: { ...record.resume, attempt } };
      durable(file, transaction);
    }
    current = pairWriteMaintenance(paths, current, { owner: { ...current.owner, ...pairProcessIdentity() }, phase: "OID_RECOVERING" });
    handle = {
      paths,
      original: transaction.pair.previousMaintenance,
      get journal() {
        return current;
      },
      transition(patch) {
        current = pairWriteMaintenance(paths, current, patch);
        return current;
      },
      release() {
        for (const lock of [...locks].reverse()) lock.release();
      }
    };
    if (transaction.pair.databaseState !== "PRE_CANDIDATE" || terminal || transaction.bootDirection === "previous") {
      if (transaction.bootDirection !== "previous") tripleReadClaim(root, transaction, record, { requireFresh: false });
      else {
        const database = new DatabaseSync(record.pair.databasePath, { readOnly: true });
        try {
          if (!database.prepare("SELECT id FROM users WHERE id=? AND role='owner' AND is_active=1 AND status='active'").get(record.pair.ownerId)) throw new Error("oid_triple_resume_owner_not_authorized");
        } finally {
          database.close();
        }
      }
      const result2 = await attestOidTripleExistingChild(root, record, handle, file, transaction);
      durable(receiptFile, { ...record.resume, attempt, state: "verified_completed", transactionNonce: record.transactionNonce });
      return result2;
    }
    const result = await recoverOidTripleOwnedFailure(root, record, safeBytes, handle, file, transaction, new Error("explicit_resume"));
    if (pairReadMaintenance(paths).state !== "OPEN") throw new Error("oid_triple_resume_manual_required");
    durable(receiptFile, { ...record.resume, attempt, state: "previous_restored", transactionNonce: record.transactionNonce });
    return result;
  } catch (error) {
    if (handle && current.state !== "OPEN") handle.transition({ state: "MANUAL", gateClosed: true, phase: "OID_RECOVERING", recoveryError: "oid_triple_resume_unverified" });
    if (fs13.existsSync(receiptFile)) durable(receiptFile, { ...record.resume, attempt, state: "manual_required", transactionNonce: record.transactionNonce });
    throw error;
  } finally {
    for (const lock of [...locks].reverse()) lock.release();
  }
}
async function prepareOidTriplePublicationSnapshot(root, target, previous, databasePath, identity2) {
  prepareFullClientPublicationArchives(root, target, previous);
  return captureOidPairSnapshot(databasePath, identity2);
}
async function captureOidPairSnapshot(databasePath, identity2) {
  if (!path12.isAbsolute(databasePath) || realpathSync3(databasePath) !== databasePath) throw new Error("oid_pair_database_path_invalid");
  pinnedFile(databasePath, "pair_database", { mode: 384, maxSize: Number.MAX_SAFE_INTEGER });
  const snapshotRoot = path12.join(path12.dirname(databasePath), "nassaj-update-db-snapshots");
  fs13.mkdirSync(snapshotRoot, { mode: 448, recursive: true });
  if (lstatSync2(snapshotRoot).isSymbolicLink() || statSync(snapshotRoot).mode & 63) throw new Error("oid_pair_snapshot_root_unsafe");
  const snapshotDir = path12.join(snapshotRoot, identity2.transactionNonce);
  const storage = fs13.statfsSync(snapshotRoot);
  if (Number(storage.type) === 16914836 || statSync(snapshotRoot).dev !== statSync(databasePath).dev || Number(storage.bavail) * Number(storage.bsize) < statSync(databasePath).size * 2 + 16 * 1024 * 1024) throw new Error("oid_pair_snapshot_storage_unavailable");
  fs13.mkdirSync(snapshotDir, { mode: 448 });
  fsyncDir(snapshotRoot);
  const snapshotFile = path12.join(snapshotDir, "pre-update.sqlite");
  const descriptor = {
    schema: "nassaj-update-database-snapshot/v1",
    transactionId: identity2.transactionNonce,
    actionId: identity2.actionId,
    targetCommit: identity2.oid,
    databasePath,
    snapshotDir,
    snapshotFile,
    basename: "pre-update.sqlite",
    phase: "CAPTURE_INTENT",
    sourceIdentity: { dev: String(statSync(databasePath).dev), ino: String(statSync(databasePath).ino) }
  };
  durable(path12.join(snapshotDir, "descriptor.json"), descriptor);
  const source = new DatabaseSync(databasePath, { readOnly: true });
  const schemaSql = "SELECT type,name,tbl_name AS tableName,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name";
  let sourceSchemaDigest;
  try {
    const owner = source.prepare("SELECT id FROM users WHERE id=? AND role='owner' AND is_active=1 AND status='active'").get(identity2.ownerId);
    if (!owner) throw new Error("oid_pair_owner_not_authorized");
    sourceSchemaDigest = sha2(JSON.stringify(source.prepare(schemaSql).all()));
    source.prepare("VACUUM INTO ?").run(snapshotFile);
  } finally {
    source.close();
  }
  fs13.chmodSync(snapshotFile, 384);
  const snapshot = new DatabaseSync(snapshotFile, { readOnly: true });
  let snapshotSchemaDigest;
  try {
    if (Object.values(snapshot.prepare("PRAGMA integrity_check").get())[0] !== "ok" || snapshot.prepare("PRAGMA foreign_key_check").all().length) throw new Error("oid_pair_snapshot_integrity_failed");
    snapshotSchemaDigest = sha2(JSON.stringify(snapshot.prepare(schemaSql).all()));
  } finally {
    snapshot.close();
  }
  if (sourceSchemaDigest !== snapshotSchemaDigest) throw new Error("oid_pair_snapshot_schema_mismatch");
  const bytes = pinnedFile(snapshotFile, "pair_snapshot", { mode: 384, maxSize: Number.MAX_SAFE_INTEGER }).bytes;
  const fd = openSync(snapshotFile, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const complete = {
    ...descriptor,
    phase: "CAPTURED",
    state: "captured",
    sourceSchemaDigest,
    snapshotSchemaDigest,
    snapshotFingerprint: { sha256: sha2(bytes), size: bytes.length }
  };
  durable(path12.join(snapshotDir, "descriptor.json"), complete);
  return complete;
}
function inspectOidPairAuthority(root, state, ownerId, now = Date.now()) {
  if (state.policyAuthorization && state.consent) throw new Error("oid_pair_authority_ambiguous");
  const authority = state.policyAuthorization ? inspectLocalUpdatePolicyGrant(root, state, now) : { ...state.consent, kind: "manual" };
  if (!authority || authority.targetDigest !== state.targetDigest || authority.expiresAt <= now || authority.ownerId !== String(ownerId) || !Number.isSafeInteger(authority.expiresAt)) throw new Error("oid_pair_consent_invalid");
  return authority;
}
function inspectConfirmedOidPair(root, expected, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(expected?.sequence) || expected.sequence < 1 || !HEX643.test(expected.targetDigest || "")) throw new Error("oid_pair_request_invalid");
  const sequence = String(expected.sequence).padStart(16, "0");
  const record = pinnedJson(path12.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${sequence}.json`), "pair_event");
  const state = record.localUpdate;
  if (state?.schema !== "nassaj-local-update/v1" || state.mode !== "local-main" || state.sequence !== expected.sequence || state.targetDigest !== expected.targetDigest || state.group !== `event-${sequence}` || record.oid !== state.oid || JSON.stringify(state.domains) !== '["client","server"]' || state.phase !== "awaiting_sessions") throw new Error("oid_pair_consent_invalid");
  inspectOidPairAuthority(root, state, expected.ownerId, now);
  const triple = state.target?.schema === "nassaj-oid-triple-target/v2";
  if (state.policyAuthorization && !triple) throw new Error("oid_policy_requires_triple");
  if (state.target?.schema && !triple) throw new Error("oid_target_schema_unknown");
  const digest3 = triple ? computeOidTripleTargetDigest({ sequence: state.sequence, group: state.group, sourceOid: state.oid, target: state.target }) : sha2(JSON.stringify({ sequence: state.sequence, group: state.group, oid: state.oid, domains: state.domains, target: state.target }));
  if (digest3 !== state.targetDigest || git(root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]) !== state.oid) throw new Error("oid_pair_target_changed");
  for (const domain of ["client", "server"]) {
    const buildId = state.target[`${domain}BuildId`];
    if (!HEX643.test(buildId || "")) throw new Error("oid_pair_build_invalid");
    const directory = path12.join(root, ".nassaj-local-preview", `${domain}-candidates`, buildId);
    const candidate = provenance(directory);
    if (candidate.commit !== state.oid || candidate.baseCommit !== state.oid || candidate.dirty !== false || candidate.buildId !== buildId || hashOidPairTree(directory) !== state.target[`${domain}TreeSha256`]) throw new Error("oid_pair_candidate_changed");
  }
  if (triple) {
    verifyOidDependencyCandidate(root, state.target);
  }
  if (state.activation && (state.activation.actionId !== expected.actionId || state.activation.transactionNonce !== expected.transactionNonce)) throw new Error("oid_pair_activation_conflict");
  return state;
}
async function claimFullClientPublicationWaiter(root, sequence, transactionNonce) {
  const lease = await pairLock(path12.join(gitControlRoot(root), "nassaj-preview-event-mutation.lock"));
  try {
    return claimFullClientPublicationWaiterHeld(root, sequence, transactionNonce);
  } finally {
    lease.release();
  }
}
function claimFullClientPublicationWaiterHeld(root, sequence, transactionNonce) {
  const file = path12.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${String(sequence).padStart(16, "0")}.json`);
  const record = pinnedJson(file, "full_waiter_event"), waiter = record.fullUpdateWaiter;
  if (!waiter) {
    const loaded = pinnedJson(path12.join(root, "dist-server/OID_CONTROL_MANIFEST.json"), "full_waiter_manifest");
    if (loaded.capabilities?.clientPublicationV1) throw new Error("full_update_waiter_required");
    return null;
  }
  if (waiter.schema !== "nassaj-full-update-waiter/v1" || waiter.requestId !== `local-update:${sequence}` || waiter.sequence !== sequence || !Number.isSafeInteger(waiter.revision) || waiter.revision < 1 || waiter.phase !== "waiting" || waiter.effect !== "none") throw new Error("full_update_waiter_conflict");
  const next = { ...waiter, revision: waiter.revision + 1, phase: "effects_started", effect: "started", transactionNonce };
  durable(file, { ...record, fullUpdateWaiter: next });
  return next;
}
function releaseFullWaiterBeforeEffects(root, transaction, journalFile, options = {}) {
  if (!transaction.fullUpdateWaiter) return null;
  const terminal = pinnedJson(journalFile, "full_waiter_pre_effect_terminal");
  if (terminal.state !== "restart_deferred_restored" || terminal.transactionNonce !== transaction.transactionNonce || terminal.pair?.databaseState !== "PRE_CANDIDATE" || terminal.oldStopIntentAt || terminal.oldStoppedAt || terminal.bootDirection || terminal.bootNonce || terminal.pair?.activationNotClaimed !== true || !pairOwnerAlive(terminal.pair.previous.runtime)) throw new Error("full_waiter_pre_effect_unproven");
  const eventFile = path12.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${String(terminal.sequence).padStart(16, "0")}.json`);
  const event = pinnedJson(eventFile, "full_waiter_pre_effect_event"), waiter = event.fullUpdateWaiter;
  const expected = transaction.fullUpdateWaiter;
  const file = path12.join(gitControlRoot(root), `nassaj-full-waiter-disposition-${terminal.transactionNonce}.json`);
  pairVerifyLive(root, { targetClientBuildId: terminal.pair.previous.clientBuildId, targetServerBuildId: terminal.pair.previous.serverBuildId }, terminal.pair.previous);
  if (event.localUpdate?.activation) throw new Error("full_waiter_pre_effect_cas_conflict");
  if (waiter?.phase === "released" && waiter.requestId === expected.requestId && waiter.revision === expected.revision + 1 && waiter.transactionNonce === terminal.transactionNonce) {
    const bytes = pinnedFile(file, "full_waiter_pre_effect_receipt").bytes, prior = JSON.parse(bytes);
    if (sha2(bytes) !== waiter.receiptDigest || prior.requestId !== expected.requestId || prior.revision !== expected.revision || prior.transactionNonce !== terminal.transactionNonce || prior.journalDigest !== sha2(pinnedFile(journalFile, "full_waiter_pre_effect_journal").bytes)) throw new Error("full_waiter_pre_effect_receipt_changed");
    return waiter;
  }
  if (waiter?.requestId !== expected.requestId || waiter.revision !== expected.revision || waiter.transactionNonce !== terminal.transactionNonce || waiter.phase !== "effects_started" || event.localUpdate?.activation) throw new Error("full_waiter_pre_effect_cas_conflict");
  const receipt = {
    schema: "nassaj-full-update-waiter-disposition/v1",
    outcome: "failed_before_effects",
    sequence: terminal.sequence,
    transactionNonce: terminal.transactionNonce,
    requestId: waiter.requestId,
    revision: waiter.revision,
    journalDigest: sha2(pinnedFile(journalFile, "full_waiter_pre_effect_journal").bytes),
    previous: terminal.pair.previous
  };
  try {
    durableCreate(file, receipt);
  } catch (error) {
    if (error.code !== "EEXIST" || pairCanonical(pinnedJson(file, "full_waiter_pre_effect_receipt")) !== pairCanonical(receipt)) throw error;
  }
  options.afterWrite?.("receipt");
  injectFailure("full_waiter_after_disposition_receipt");
  const next = {
    ...waiter,
    revision: waiter.revision + 1,
    phase: "released",
    effect: "settled",
    reason: "failed_before_effects",
    receiptDigest: sha2(pinnedFile(file, "full_waiter_pre_effect_receipt").bytes)
  };
  durable(eventFile, { ...event, fullUpdateWaiter: next });
  options.afterWrite?.("event");
  injectFailure("full_waiter_after_disposition_event");
  return next;
}
function settledFullWaiter(root, record, patch) {
  const waiter = record.fullUpdateWaiter, receipt = patch.receipt;
  if (!waiter || !receipt || !["served", "rolled_back"].includes(receipt.outcome)) return waiter;
  if (waiter.phase === "released") return waiter;
  if (waiter.transactionNonce !== receipt.transactionNonce || waiter.phase !== "effects_started") throw new Error("full_update_waiter_terminal_conflict");
  const journal = pinnedJson(path12.join(gitControlRoot(root), `nassaj-oid-control-transaction-${waiter.sequence}-${waiter.transactionNonce}.json`), "full_waiter_terminal");
  if (!validateOidPairTerminal(root, journal)) throw new Error("full_update_waiter_receipt_unverified");
  const receiptFile = path12.join(gitControlRoot(root), `nassaj-oid-pair-${receipt.outcome === "served" ? "serving-" : "receipt-"}${receipt.transactionNonce}.json`);
  return {
    ...waiter,
    revision: waiter.revision + 1,
    phase: "released",
    effect: "settled",
    reason: receipt.outcome,
    receiptDigest: sha2(pinnedFile(receiptFile, "full_waiter_receipt").bytes)
  };
}
function pairRecordEvent(root, state, patch) {
  const file = path12.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${String(state.sequence).padStart(16, "0")}.json`);
  const record = pinnedJson(file, "pair_event_write");
  if (record.localUpdate.revision !== state.revision || record.localUpdate.targetDigest !== state.targetDigest) throw new Error("oid_pair_event_cas");
  const next = { ...state, ...patch, revision: state.revision + 1 };
  const fullUpdateWaiter = settledFullWaiter(root, record, patch);
  durable(file, { ...record, localUpdate: next, ...fullUpdateWaiter ? { fullUpdateWaiter } : {} });
  return next;
}
function pairRequireCapabilities(root, state) {
  const live = pinnedJson(path12.join(root, "dist-server/OID_CONTROL_MANIFEST.json"), "pair_loaded_manifest", { mode: 292 });
  const target = pinnedJson(
    path12.join(root, ".nassaj-local-preview/server-candidates", state.target.serverBuildId, "OID_CONTROL_MANIFEST.json"),
    "pair_candidate_manifest",
    { sha256: state.target.controlManifestSha256, mode: 292 }
  );
  if (state.target?.schema === "nassaj-oid-triple-target/v2") {
    validateOidTripleTargetDescriptor(state.target);
    if (live.capabilities?.oidTripleAdmissionV2 !== true || target.capabilities?.oidTripleAdmissionV2 !== true) throw new Error("triple_activation_unavailable");
    verifyOidTripleManifest(target, state.target);
    assertOidTripleRuntime(state.target.installRuntime);
  } else {
    if (live.capabilities?.oidPairAdmissionV1 !== true || target.capabilities?.oidPairAdmissionV1 !== true) throw new Error("pair_activation_unavailable");
    verifyOidPairDependencies(root, live, target, state.oid);
  }
  return { live, target };
}
function bootstrapClaimBytes(root, record, transaction) {
  const ticket = record.bootstrap.ticket;
  const file = path12.join(gitControlRoot(root), "nassaj-oid-recovery", record.transactionNonce, `bootstrap-claim-${ticket.nonce}.json`);
  if (!HEX643.test(transaction.bootstrap?.claimSha256 || "")) throw new Error("oid_bootstrap_claim_binding_missing");
  return readBootstrapPinnedFile(file, transaction.bootstrap.claimSha256);
}
async function runBootstrapOidTripleTransaction(record, safeBytes, initial) {
  const root = record.repoRoot, ticket = record.bootstrap.ticket;
  if (initial.target?.schema !== "nassaj-oid-triple-target/v2" || record.resume) throw new Error("oid_bootstrap_record_invalid");
  verifyTripleRetainedRecord(root, record);
  if (activeTransactions(root).length) throw new Error("oid_triple_recovery_required");
  const manifests = pairRequireCapabilities(root, initial);
  const previous = await captureOidTriplePreviousGeneration(root, manifests.live, { allowQualifiedMismatch: true });
  const supervisor = await captureOidTripleSupervisor(root, record);
  const identity2 = {
    sequence: initial.sequence,
    group: initial.group,
    oid: initial.oid,
    targetDigest: initial.targetDigest,
    transactionNonce: record.transactionNonce,
    journalBasename: `nassaj-oid-control-transaction-${initial.sequence}-${record.transactionNonce}.json`,
    previousClientBuildId: previous.clientBuildId,
    previousServerBuildId: previous.serverBuildId,
    targetClientBuildId: initial.target.clientBuildId,
    targetServerBuildId: initial.target.serverBuildId
  };
  let transaction = {
    schema: "nassaj-oid-control-transaction/v2",
    generationNames: UPDATE_GENERATION_NAMES,
    ...identity2,
    buildId: initial.target.serverBuildId,
    actionId: record.actionId,
    owner: pairProcessIdentity(),
    supervisor,
    recoveryReference: record.recoveryReference,
    state: "pair_admission_intent",
    bootstrapPending: true,
    pair: { targetDigest: initial.targetDigest, target: initial.target, previous, databaseState: "PRE_CANDIDATE", activationNotClaimed: true }
  };
  let verified = await verifyBootstrapExecutionBindings(root, record, initial, previous, supervisor);
  const handle = await beginBootstrapOidAdmission(root, identity2, transaction, async () => {
    const state = inspectConfirmedOidPair(root, { ...record.pair, actionId: record.actionId, transactionNonce: record.transactionNonce });
    pairVerifyLive(root, { targetClientBuildId: previous.clientBuildId, targetServerBuildId: previous.serverBuildId }, previous);
    await assertOidPairPreviousRuntime(root, previous);
    verified = await verifyBootstrapExecutionBindings(root, record, state, previous, supervisor);
    return { ...consumeBootstrapTicket(ticket, verified.material, pairProcessIdentity(), bootstrapClock()), ticket };
  });
  const file = path12.join(handle.paths.gitRoot, identity2.journalBasename);
  transaction = handle.claimedTransaction;
  try {
    transaction.fullUpdateWaiter = claimFullClientPublicationWaiterHeld(root, initial.sequence, record.transactionNonce);
    const snapshot = await prepareOidTriplePublicationSnapshot(root, initial.target, previous, record.pair.databasePath, {
      ...identity2,
      ownerId: record.pair.ownerId,
      actionId: record.actionId
    });
    let state = inspectConfirmedOidPair(root, { ...record.pair, actionId: record.actionId, transactionNonce: record.transactionNonce });
    state = pairRecordEvent(root, state, { phase: "activation_claimed", activation: {
      actionId: record.actionId,
      transactionNonce: record.transactionNonce,
      claimedAt: Date.now()
    } });
    transaction = {
      ...transaction,
      state: "triple_prepared",
      pair: {
        ...transaction.pair,
        snapshot,
        previousMaintenance: handle.original,
        activationNotClaimed: false,
        consent: state.consent,
        authority: inspectOidPairAuthority(root, state, record.pair.ownerId),
        authoritySourceSha256: sha2(pairCanonical(state.policyAuthorization || state.consent))
      }
    };
    durable(file, transaction);
    transaction = prepareOidTripleClaimedDependencyExchange(root, file, transaction, record);
    const freshState = tripleReadClaim(root, transaction, record);
    verified = await verifyBootstrapExecutionBindings(root, record, freshState, previous, supervisor);
    verifyBootstrapTicket(ticket, verified.material, bootstrapClock());
    transaction = { ...transaction, state: "triple_old_stop_intent", oldStopIntentAt: Date.now() };
    durable(file, transaction);
    handle.transition({ phase: "OID_EXCHANGING" });
    injectFailure("bootstrap_before_old_stop");
    const stopped = await runSafe(safeBytes, ["--oid-triple-phase", "stop", "--exec"], { ...record, artifactRoot: path12.join(root, "dist-server") });
    transaction = pinnedJson(file, "bootstrap_stopped_journal");
    if (stopped.status !== 0 || transaction.state !== "triple_old_stopped") throw new Error("oid_triple_stop_unverified");
    injectFailure("bootstrap_after_old_stop");
    transaction = applyBootstrapModeCAS(root, file, transaction, record);
    injectFailure("bootstrap_after_mode");
    transaction = await exchangeOidTripleGenerations(root, file, transaction, "forward", record);
    transaction = { ...transaction, state: "triple_exchanged" };
    durable(file, transaction);
    injectFailure("bootstrap_after_exchange");
    const nativeProbe = runOidTripleNativeProbe(root, path12.join(root, "node_modules"), { ...transaction.pair.target, transactionNonce: record.transactionNonce });
    transaction = { ...transaction, nativeProbe };
    durable(file, transaction);
    verifyBootstrapJournalBinding(transaction, record, bootstrapClaimBytes(root, record, transaction), verified.codeClosureSha256);
    return await startAndAttestOidTriple(root, record, safeBytes, handle, file, transaction);
  } catch (error) {
    try {
      recordOidTripleOriginFailure(file, transaction, error);
    } finally {
      await recoverOidTripleOwnedFailure(root, record, safeBytes, handle, file, transaction, error);
    }
    throw error;
  } finally {
    handle.release();
  }
}
async function runOidPairTransaction(record, safeBytes) {
  const root = record.repoRoot, expected = { ...record.pair, actionId: record.actionId, transactionNonce: record.transactionNonce };
  if (!/^[a-f0-9-]{36}$/.test(record.actionId || "") || !HEX643.test(record.transactionNonce || "")) throw new Error("oid_pair_action_required");
  if (record.resume) return resumeOidTripleTransaction(record, safeBytes);
  let state = inspectConfirmedOidPair(root, expected);
  if (record.bootstrap !== void 0) {
    return runBootstrapOidTripleTransaction(record, safeBytes, state);
  }
  pairRequireCapabilities(root, state);
  if (state.target?.schema === "nassaj-oid-triple-target/v2") return runOidTripleTransaction(record, safeBytes, state);
  if (activeTransactions(root).length) throw new Error("oid_pair_recovery_required");
  const previous = {
    clientBuildId: provenance(path12.join(root, "dist")).buildId,
    serverBuildId: provenance(path12.join(root, "dist-server")).buildId,
    clientTreeSha256: hashOidPairTree(path12.join(root, "dist")),
    serverTreeSha256: hashOidPairTree(path12.join(root, "dist-server"))
  };
  previous.runtime = await probeOidPairPreviousRuntime(root, previous);
  if (!previous.runtime) throw new Error("oid_pair_previous_runtime_unverified");
  const identity2 = {
    sequence: state.sequence,
    group: state.group,
    oid: state.oid,
    targetDigest: state.targetDigest,
    transactionNonce: record.transactionNonce,
    journalBasename: `nassaj-oid-control-transaction-${state.sequence}-${record.transactionNonce}.json`,
    previousClientBuildId: previous.clientBuildId,
    previousServerBuildId: previous.serverBuildId,
    targetClientBuildId: state.target.clientBuildId,
    targetServerBuildId: state.target.serverBuildId
  };
  const intent = {
    schema: "nassaj-oid-control-transaction/v1",
    sequence: state.sequence,
    group: state.group,
    oid: state.oid,
    buildId: state.target.serverBuildId,
    transactionNonce: record.transactionNonce,
    actionId: record.actionId,
    state: "pair_admission_intent",
    owner: pairProcessIdentity(),
    pair: {
      targetDigest: state.targetDigest,
      target: state.target,
      previous,
      databaseState: "PRE_CANDIDATE",
      activationNotClaimed: true
    }
  };
  intent.fullUpdateWaiter = await claimFullClientPublicationWaiter(root, state.sequence, record.transactionNonce);
  const handle = await beginOidPairAdmission(root, identity2, { intent });
  const file = path12.join(handle.paths.gitRoot, identity2.journalBasename);
  let transaction = null;
  try {
    await handle.lockPublishers();
    state = inspectConfirmedOidPair(root, expected);
    pairRequireCapabilities(root, state);
    if (hashOidPairTree(path12.join(root, "dist")) !== previous.clientTreeSha256 || hashOidPairTree(path12.join(root, "dist-server")) !== previous.serverTreeSha256) throw new Error("oid_pair_previous_changed");
    const snapshot = await prepareOidTriplePublicationSnapshot(root, state.target, previous, record.pair.databasePath, { ...identity2, ownerId: expected.ownerId, actionId: record.actionId });
    state = inspectConfirmedOidPair(root, expected);
    state = pairRecordEvent(root, state, { phase: "activation_claimed", activation: {
      actionId: record.actionId,
      transactionNonce: record.transactionNonce,
      claimedAt: Date.now()
    } });
    transaction = {
      schema: "nassaj-oid-control-transaction/v1",
      sequence: state.sequence,
      group: state.group,
      oid: state.oid,
      buildId: state.target.serverBuildId,
      transactionNonce: record.transactionNonce,
      actionId: record.actionId,
      state: "pair_prepared",
      owner: pairProcessIdentity(),
      pair: {
        targetDigest: state.targetDigest,
        target: state.target,
        previous,
        snapshot,
        previousMaintenance: handle.original,
        databaseState: "PRE_CANDIDATE",
        clientExchanged: false,
        serverExchanged: false,
        receipt: null
      }
    };
    durableCreate(file, transaction);
    durable(record.handshakePath, {
      schema: 1,
      state: "executor_ready",
      launcherNonce: record.transactionNonce,
      transactionNonce: record.transactionNonce,
      sequence: state.sequence,
      oid: state.oid,
      buildId: state.target.serverBuildId,
      journalFile: file
    });
    const save = (phase, fields = {}) => {
      transaction = { ...transaction, state: phase, pair: { ...transaction.pair, ...fields } };
      durable(file, transaction);
    };
    handle.transition({ phase: "OID_EXCHANGING" });
    for (const domain of ["client", "server"]) {
      save(`pair_${domain}_exchange_intent`);
      await exchange(path12.join(root, ".nassaj-local-preview", `${domain}-candidates`, state.target[`${domain}BuildId`]), path12.join(root, domain === "client" ? "dist" : "dist-server"));
      fsyncDir(root);
      fsyncDir(path12.join(root, ".nassaj-local-preview", `${domain}-candidates`));
      save(`pair_${domain}_exchanged`, { [`${domain}Exchanged`]: true });
      injectFailure(`pair_after_${domain}_exchange`);
    }
    pairVerifyLive(root, identity2, state.target);
    save("pair_bootstrap_verifying", { databaseState: "UNKNOWN" });
    handle.transition({ phase: "OID_BOOTSTRAP_VERIFYING", databaseState: "UNKNOWN" });
    injectFailure("pair_before_bootstrap");
    const bootNonce = randomBytes4(32).toString("hex");
    const result = await runSafe(safeBytes, [
      "--set",
      "TMPDIR=/var/tmp",
      "--set",
      `NASSAJ_PREVIEW_TRANSACTION_NONCE=${record.transactionNonce}`,
      "--set",
      `NASSAJ_PREVIEW_BOOT_NONCE=${bootNonce}`,
      "--exec"
    ], { ...record, artifactRoot: path12.join(root, "dist-server") });
    if (result.status !== 0 || result.pipeError) throw new Error("oid_pair_restart_unverified");
    const proof = await health({
      oid: state.oid,
      buildId: state.target.serverBuildId,
      transactionNonce: record.transactionNonce,
      bootNonce,
      oldStartTicks: record.oldStartTicks
    });
    if (!proof || proof.clientBuildIdServed !== state.target.clientBuildId || proof.oidPairTargetDigest !== state.targetDigest) throw new Error("oid_pair_health_unverified");
    const child = pinnedJson(path12.join(handle.paths.controlRoot, `oid-child-${record.transactionNonce}.json`), "pair_child_proof");
    if (child.pid !== proof.pid || child.startTime !== proof.serverProcessStartTicks || !pairOwnerAlive(child)) throw new Error("oid_pair_child_unverified");
    pairVerifyLive(root, identity2, state.target);
    const receipt = {
      outcome: "activated",
      transactionNonce: record.transactionNonce,
      targetDigest: state.targetDigest,
      clientBuildId: state.target.clientBuildId,
      serverBuildId: state.target.serverBuildId,
      pid: proof.pid,
      startTime: proof.serverProcessStartTicks,
      completedAt: Date.now()
    };
    const receiptFile = path12.join(handle.paths.gitRoot, `nassaj-oid-pair-receipt-${record.transactionNonce}.json`);
    durableCreate(receiptFile, receipt);
    save("pair_served", { receipt, receiptSha256: sha2(pinnedFile(receiptFile, "pair_terminal_receipt").bytes), databaseState: "TARGET_VERIFIED" });
    injectFailure("pair_after_terminal");
    pairRecordEvent(root, state, { phase: "awaiting_serving", receipt, activation: state.activation });
    completeOidPairAdmission(root, handle);
    return receipt;
  } catch (error) {
    if (transaction?.state === "pair_served") throw error;
    if (transaction?.pair.databaseState === "PRE_CANDIDATE" && transaction.state !== "pair_prepared") {
      try {
        await restoreOidPairBeforeCandidate(root, handle, transaction, file);
        throw Object.assign(error, { pairRestored: true });
      } catch (recoveryError) {
        if (recoveryError.pairRestored) throw recoveryError;
      }
    }
    if (!transaction || transaction.state === "pair_prepared") {
      if (hashOidPairTree(path12.join(root, "dist")) === previous.clientTreeSha256 && hashOidPairTree(path12.join(root, "dist-server")) === previous.serverTreeSha256) {
        await assertOidPairPreviousRuntime(root, previous);
        if (transaction) {
          durable(file, { ...transaction, state: "restart_deferred_restored", error: "oid_pair_not_started" });
          pairRecordEvent(root, state, { phase: "failed", consent: null });
        }
        const { checksum: oldChecksum, sequence: oldSequence, ...original } = handle.original;
        handle.transition({ ...original, oidAdmissionIntent: null });
        throw error;
      }
    }
    if (transaction) {
      durable(file, { ...transaction, state: "manual_recovery_required", error: "oid_pair_activation_unverified" });
      try {
        pairRecordEvent(root, state, { phase: "manual_recovery_required", receipt: { outcome: "manual_recovery_required", completedAt: Date.now(), transactionNonce: record.transactionNonce } });
      } catch {
      }
    }
    try {
      handle.transition({ state: "MANUAL", gateClosed: true, phase: "OID_RECOVERING", recoveryError: "oid_pair_activation_unverified" });
    } catch {
    }
    throw error;
  } finally {
    handle.release();
  }
}
function validateOidPairTerminal(root, transaction) {
  try {
    const value = transaction.value || transaction;
    if (!["pair_served", "pair_rolled_back"].includes(value.state) || !HEX643.test(value.transactionNonce || "") || !HEX643.test(value.pair?.receiptSha256 || "")) return false;
    const bytes = pinnedFile(path12.join(gitControlRoot(root), `nassaj-oid-pair-receipt-${value.transactionNonce}.json`), "pair_receipt", { sha256: value.pair.receiptSha256 }).bytes;
    const receipt = JSON.parse(bytes);
    const rollback = value.state === "pair_rolled_back";
    const verified = rollback ? value.pair.previous : value.pair.target;
    if (value.pair.target.schema === "nassaj-oid-triple-target/v2") {
      validateOidTripleTargetDescriptor(value.pair.target);
      if (!value.pair.activationNotClaimed) {
        const persistence = value.persistence?.online;
        if (persistence?.state !== "verified" || persistence.status !== "online" || !HEX643.test(persistence.dumpSha256 || "") || persistence.pid !== receipt.pid || persistence.startTime !== receipt.startTime || persistence.bootNonce !== value.bootNonce) return false;
      }
      if (computeOidTripleTargetDigest({ sequence: value.sequence, group: value.group, sourceOid: value.oid, target: value.pair.target }) !== value.pair.targetDigest) return false;
      if (value.schema !== "nassaj-oid-control-transaction/v2" || JSON.stringify(value.generationNames) !== JSON.stringify(UPDATE_GENERATION_NAMES) || receipt.schema !== "nassaj-oid-triple-terminal/v2" || JSON.stringify(receipt.generationNames) !== JSON.stringify(UPDATE_GENERATION_NAMES) || !HEX643.test(verified.nodeModulesTreeSha256 || "") || receipt.nodeModulesTreeSha256 !== verified.nodeModulesTreeSha256) return false;
    }
    return receipt.outcome === (rollback ? "rolled_back" : "activated") && receipt.transactionNonce === value.transactionNonce && receipt.targetDigest === value.pair.targetDigest && receipt.clientBuildId === verified.clientBuildId && receipt.serverBuildId === verified.serverBuildId && pairCanonical(receipt) === pairCanonical(value.pair.receipt);
  } catch {
    return false;
  }
}
function inspectOidPairRestart(root, expected) {
  const paths = pairPaths(root), maintenance = pairReadMaintenance(paths);
  const transaction = validateOidPairMaintenance(root, maintenance), identity2 = maintenance.identity?.oid;
  if (transaction?.pair?.target?.schema === "nassaj-oid-triple-target/v2") throw new Error("oid_triple_requires_stop_start_path");
  if (!identity2 || maintenance.phase !== "OID_BOOTSTRAP_VERIFYING" || maintenance.databaseState !== "UNKNOWN" || !pairOwnerAlive(maintenance.owner) || identity2.sequence !== expected.sequence || identity2.transactionNonce !== expected.transactionNonce || identity2.targetDigest !== expected.targetDigest || transaction.actionId !== expected.actionId || transaction.pair.databaseState !== "UNKNOWN") throw new Error("oid_pair_restart_not_owned");
  pairVerifyLive(root, identity2, transaction.pair.target);
  return {
    allowed: true,
    activationKind: "oid-pair",
    sequence: identity2.sequence,
    expectedServerBuildId: identity2.targetServerBuildId,
    targetDigest: identity2.targetDigest,
    transactionNonce: identity2.transactionNonce
  };
}
function hashOidPairDependencyTree(directory) {
  const root = canonicalRoot(directory, "oid_pair_dependencies");
  const entries = [];
  const visit = (parent, prefix = "") => {
    for (const name of readdirSync2(parent).sort()) {
      const file = path12.join(parent, name), relative2 = `${prefix}${name}`, stat = lstatSync2(file);
      if (stat.isSymbolicLink()) {
        const destination = realpathSync3(file), link = readlinkSync(file), after = lstatSync2(file);
        if (!destination.startsWith(`${root}${path12.sep}`) || stat.ino !== after.ino || stat.ctimeMs !== after.ctimeMs) throw new Error("oid_pair_dependency_link_unsafe");
        entries.push([relative2, "link", link]);
        continue;
      }
      const fd2 = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd2);
        if (opened.isDirectory()) visit(`/proc/self/fd/${fd2}`, `${relative2}/`);
        else if (opened.isFile()) entries.push([relative2, "file", sha2(readFileSync2(fd2))]);
        else throw new Error("oid_pair_dependency_entry_unsafe");
      } finally {
        closeSync(fd2);
      }
    }
  };
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    visit(`/proc/self/fd/${fd}`);
  } finally {
    closeSync(fd);
  }
  return sha2(JSON.stringify(entries));
}
function verifyOidPairDependencies(root, live, target, targetOid) {
  if (!HEX403.test(live.oid || "") || !HEX643.test(live.runtimeDependenciesSha256 || "") || target.runtimeDependenciesSha256 !== live.runtimeDependenciesSha256) throw new Error("oid_pair_dependency_baseline_unavailable");
  const contractAt = (oid) => oidPairDependencyContract(git(root, ["show", `${oid}:package.json`]), git(root, ["show", `${oid}:package-lock.json`]));
  if (contractAt(live.oid) !== contractAt(targetOid)) throw new Error("oid_pair_dependency_contract_changed");
  if (hashOidPairDependencyTree(path12.join(root, "node_modules")) !== live.runtimeDependenciesSha256) throw new Error("oid_pair_dependency_baseline_unverified");
}
function pairOwnerProvablyDead(owner) {
  if (!Number.isSafeInteger(owner?.pid) || typeof owner.startTime !== "string" || typeof owner.bootId !== "string") return false;
  try {
    const bootId = readFileSync2("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (bootId !== owner.bootId) return true;
    try {
      const observed = parseProcessStartTicks(readFileSync2(`/proc/${owner.pid}/stat`, "utf8"));
      return Boolean(observed && observed !== owner.startTime);
    } catch (error) {
      return ["ENOENT", "ESRCH"].includes(error.code);
    }
  } catch {
    return false;
  }
}
function pairTerminalReceipt(root, transaction, file, outcome, proof = {}) {
  const verified = outcome === "rolled_back" ? transaction.pair.previous : transaction.pair.target;
  const receipt = {
    ...transaction.schema === "nassaj-oid-control-transaction/v2" ? {
      schema: "nassaj-oid-triple-terminal/v2",
      generationNames: UPDATE_GENERATION_NAMES,
      nodeModulesTreeSha256: verified.nodeModulesTreeSha256
    } : {},
    outcome,
    transactionNonce: transaction.transactionNonce,
    targetDigest: transaction.pair.targetDigest,
    clientBuildId: verified.clientBuildId,
    serverBuildId: verified.serverBuildId,
    completedAt: Date.now(),
    ...proof
  };
  const receiptFile = path12.join(gitControlRoot(root), `nassaj-oid-pair-receipt-${transaction.transactionNonce}.json`);
  let recorded = receipt;
  try {
    durableCreate(receiptFile, receipt);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    recorded = pinnedJson(receiptFile, "pair_terminal_receipt");
    if (recorded.outcome !== outcome || recorded.transactionNonce !== receipt.transactionNonce || recorded.targetDigest !== receipt.targetDigest || recorded.clientBuildId !== receipt.clientBuildId || recorded.serverBuildId !== receipt.serverBuildId) throw new Error("oid_pair_receipt_conflict");
  }
  const next = {
    ...transaction,
    state: outcome === "rolled_back" ? "pair_rolled_back" : "pair_served",
    pair: { ...transaction.pair, receipt: recorded, receiptSha256: sha2(pinnedFile(receiptFile, "pair_terminal_receipt").bytes) }
  };
  durable(file, next);
  qualifyRestoredClientPublication(root, next);
  return next;
}
async function probeOidRollbackClientHttp(root) {
  const origin = new URL(process.env.NASSAJ_PREVIEW_HEALTH_URL || "http://127.0.0.1:3004/health").origin;
  const files2 = [];
  for (const name of ["index.html", "version.json"]) {
    const response = await fetch(`${origin}/${name}`, { cache: "no-store", signal: AbortSignal.timeout(3e3) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const expected = pinnedFile(path12.join(root, "dist", name), "rollback_http_asset").bytes;
    if (response.status !== 200 || !bytes.equals(expected)) throw new Error("client_rollback_http_bytes_changed");
    files2.push({ path: name, status: 200, sha256: sha2(bytes) });
  }
  return { schema: "nassaj-client-http-serving/v1", files: files2 };
}
function qualifyRestoredClientPublication(root, transaction) {
  if (transaction.state !== "pair_rolled_back" || !transaction.pair.previous.clientPublication) return;
  return recordClientPublicationRollbackBaseline(root, transaction, {
    validateTerminal: validateOidPairTerminal,
    verifyClosure: (directory) => {
      hashOidPairTree(directory);
    }
  });
}
async function probeOidPairPreviousRuntime(root, previous) {
  try {
    const response = await fetch(process.env.NASSAJ_PREVIEW_HEALTH_URL || "http://127.0.0.1:3004/health", { signal: AbortSignal.timeout(3e3) });
    const body = response.ok ? await response.json() : null;
    const disk = provenance(path12.join(root, "dist-server"));
    if (body?.serverLoadedBuildId !== previous.serverBuildId || body.clientBuildIdServed !== previous.clientBuildId || body.serverLoadedOid !== disk.commit || !Number.isSafeInteger(body.pid)) return null;
    const identity2 = {
      ...pairProcessIdentity(body.pid),
      oid: body.serverLoadedOid,
      serverBuildId: body.serverLoadedBuildId,
      clientBuildId: body.clientBuildIdServed
    };
    if (String(identity2.startTime) !== String(body.serverProcessStartTicks) || !pairOwnerAlive(identity2)) return null;
    return identity2;
  } catch {
    return null;
  }
}
async function assertOidPairPreviousRuntime(root, previous) {
  const runtime = await probeOidPairPreviousRuntime(root, previous);
  if (!runtime || !previous.runtime || pairCanonical(runtime) !== pairCanonical(previous.runtime)) throw new Error("oid_pair_previous_runtime_unverified");
}
async function restoreOidPairBeforeCandidate(root, handle, transaction, file) {
  const current = pairReadMaintenance(handle.paths);
  if (current.databaseState !== "PRE_CANDIDATE" || transaction.pair.databaseState !== "PRE_CANDIDATE") throw new Error("oid_pair_unknown_recovery_refused");
  const grant = path12.join(handle.paths.controlRoot, `oid-child-${transaction.transactionNonce}.json`);
  try {
    lstatSync2(grant);
    throw new Error("oid_pair_candidate_bootstrap_observed");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const domain of ["server", "client"]) {
    const live = path12.join(root, domain === "client" ? "dist" : "dist-server");
    const candidate = path12.join(root, ".nassaj-local-preview", `${domain}-candidates`, transaction.pair.target[`${domain}BuildId`]);
    const liveHash = hashOidPairTree(live), candidateHash = hashOidPairTree(candidate);
    const previousHash = transaction.pair.previous[`${domain}TreeSha256`], targetHash = transaction.pair.target[`${domain}TreeSha256`];
    if (liveHash === previousHash && candidateHash === targetHash) continue;
    if (liveHash !== targetHash || candidateHash !== previousHash) throw new Error("oid_pair_recovery_orientation_unknown");
    durable(file, { ...transaction, state: `pair_${domain}_restore_intent` });
    await exchange(candidate, live);
    fsyncDir(root);
    fsyncDir(path12.dirname(candidate));
    if (hashOidPairTree(live) !== previousHash) throw new Error("oid_pair_previous_restore_unverified");
  }
  await assertOidPairPreviousRuntime(root, transaction.pair.previous);
  const terminal = pairTerminalReceipt(root, transaction, file, "rolled_back");
  pairRecordTerminalEvent(root, terminal);
  injectFailure("pair_after_rollback_receipt");
  completeOidPairAdmission(root, handle);
}
function pairRecordTerminalEvent(root, transaction) {
  const file = path12.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${String(transaction.sequence).padStart(16, "0")}.json`);
  const state = pinnedJson(file, "pair_terminal_event").localUpdate;
  if (!transaction.pair.activationNotClaimed && state.activation?.transactionNonce !== transaction.transactionNonce || state.targetDigest !== transaction.pair.targetDigest) throw new Error("oid_pair_recovery_event_conflict");
  if (state.phase !== "activated") pairRecordEvent(root, state, { phase: transaction.state === "pair_rolled_back" ? "failed" : "awaiting_serving", receipt: transaction.pair.receipt });
}
async function recoverOidPairAdmissionIntent(root, observed, waitMs) {
  const paths = pairPaths(root), intent = observed.oidAdmissionIntent;
  if (!pairOwnerProvablyDead(intent.owner)) return { state: "MANUAL", recovered: false, reason: "oid_pair_owner_alive_or_unknown" };
  const locks = [];
  try {
    for (const file of [paths.admission, paths.activity, ...["nassaj-local-preview-build.lock", "nassaj-client-build.lock", "nassaj-preview-event-mutation.lock"].map((name) => path12.join(paths.gitRoot, name))]) locks.push(await pairLock(file, waitMs));
    let current = pairReadMaintenance(paths);
    if (pairCanonical(current.oidAdmissionIntent) !== pairCanonical(intent) || !pairOwnerProvablyDead(intent.owner)) throw new Error("oid_pair_admission_intent_changed");
    if (intent.schema !== "nassaj-oid-admission-intent/v1" || intent.transaction.state !== "pair_admission_intent" || intent.transaction.pair.databaseState !== "PRE_CANDIDATE" || !["OID_DRAINING", "OID_QUIESCENT"].includes(current.phase) && current.state !== "OPEN") throw new Error("oid_pair_admission_intent_invalid");
    if (current.state === "OPEN") current = pairWriteMaintenance(paths, current, {
      state: "DRAINING",
      gateClosed: true,
      phase: "OID_DRAINING",
      transactionId: intent.identity.transactionNonce,
      identity: { kind: "oid-pair", oid: intent.identity },
      owner: intent.owner,
      databaseState: "PRE_CANDIDATE"
    });
    const journalFile = path12.join(paths.gitRoot, intent.identity.journalBasename);
    let terminal = null;
    try {
      terminal = pinnedJson(journalFile, "pair_admission_terminal");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const deferred = terminal?.state === "restart_deferred_restored";
    if (deferred && (terminal.schema !== "nassaj-oid-control-transaction/v2" || terminal.pair?.databaseState !== "PRE_CANDIDATE" || terminal.oldStopIntentAt || terminal.oldStoppedAt || terminal.bootDirection || terminal.bootNonce || terminal.transactionNonce !== intent.transaction.transactionNonce || terminal.sequence !== intent.transaction.sequence || terminal.pair.targetDigest !== intent.transaction.pair.targetDigest || pairCanonical(terminal.fullUpdateWaiter) !== pairCanonical(intent.transaction.fullUpdateWaiter))) throw new Error("oid_pair_admission_effect_possible");
    if (terminal && (!deferred && terminal.state !== "pair_rolled_back" || terminal.pair.activationNotClaimed !== true || !deferred && !validateOidPairTerminal(root, terminal) || terminal.actionId !== intent.transaction.actionId || pairCanonical(terminal.pair.previous) !== pairCanonical(intent.transaction.pair.previous) || pairCanonical(terminal.pair.target) !== pairCanonical(intent.transaction.pair.target))) throw new Error("oid_pair_admission_effect_possible");
    if (intent.transaction.schema === "nassaj-oid-control-transaction/v2") {
      if (intent.transaction.oldStopIntentAt || intent.transaction.oldStoppedAt || intent.transaction.bootDirection) throw new Error("oid_triple_admission_effect_possible");
      pairVerifyLive(root, { targetClientBuildId: intent.transaction.pair.previous.clientBuildId, targetServerBuildId: intent.transaction.pair.previous.serverBuildId }, intent.transaction.pair.previous);
    }
    for (const domain of ["client", "server"]) {
      if (hashOidPairTree(path12.join(root, domain === "client" ? "dist" : "dist-server")) !== intent.transaction.pair.previous[`${domain}TreeSha256`] || hashOidPairTree(path12.join(root, ".nassaj-local-preview", `${domain}-candidates`, intent.transaction.pair.target[`${domain}BuildId`])) !== intent.transaction.pair.target[`${domain}TreeSha256`]) throw new Error("oid_pair_admission_layout_changed");
    }
    await assertOidPairPreviousRuntime(root, intent.transaction.pair.previous);
    if (deferred) {
      const grant = path12.join(paths.controlRoot, `oid-child-${terminal.transactionNonce}.json`);
      try {
        lstatSync2(grant);
        throw new Error("oid_pair_candidate_bootstrap_observed");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const eventFile2 = path12.join(paths.gitRoot, `nassaj-preview-oid-event-control-${String(terminal.sequence).padStart(16, "0")}.json`);
      const state2 = pinnedJson(eventFile2, "pair_deferred_event").localUpdate;
      if (state2.targetDigest !== terminal.pair.targetDigest || state2.activation) throw new Error("full_waiter_pre_effect_cas_conflict");
      releaseFullWaiterBeforeEffects(root, terminal, journalFile);
      pairRecordEvent(root, state2, { phase: "failed", consent: null });
      const { checksum: checksum2, sequence: sequence2, ...previous2 } = intent.previousMaintenance;
      pairWriteMaintenance(paths, current, { ...previous2, oidAdmissionIntent: null });
      return { state: "OPEN", recovered: true, reason: "oid_pair_admission_aborted_before_effects" };
    }
    const receipt = terminal || pairTerminalReceipt(root, intent.transaction, journalFile, "rolled_back");
    injectFailure("pair_after_admission_rollback_receipt");
    const eventFile = path12.join(paths.gitRoot, `nassaj-preview-oid-event-control-${String(receipt.sequence).padStart(16, "0")}.json`);
    const state = pinnedJson(eventFile, "pair_admission_event").localUpdate;
    if (state.targetDigest !== receipt.pair.targetDigest || state.activation && state.activation.transactionNonce !== receipt.transactionNonce) throw new Error("oid_pair_admission_event_changed");
    pairRecordEvent(root, state, { phase: "failed", receipt: receipt.pair.receipt });
    const { checksum, sequence, ...previous } = intent.previousMaintenance;
    pairWriteMaintenance(paths, current, { ...previous, oidAdmissionIntent: null });
    return { state: "OPEN", recovered: true, reason: "oid_pair_admission_aborted_before_effects" };
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}
async function recoverOidPairAdmission(root, { waitMs = 3e4 } = {}) {
  const paths = pairPaths(root), observed = pairReadMaintenance(paths);
  if (observed.oidAdmissionIntent && ["OPEN", "OID_DRAINING", "OID_QUIESCENT"].includes(observed.state === "OPEN" ? "OPEN" : observed.phase)) {
    const link = observed.oidAdmissionIntent.identity;
    if (!Number.isSafeInteger(link?.sequence) || link.sequence < 1 || !HEX643.test(link.transactionNonce || "") || link.journalBasename !== `nassaj-oid-control-transaction-${link.sequence}-${link.transactionNonce}.json`) throw new Error("oid_pair_admission_intent_invalid");
    const intentFile = path12.join(paths.gitRoot, link.journalBasename);
    let entry = null;
    try {
      entry = pinnedJson(intentFile, "pair_admission_counterpart");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!entry || entry.pair?.activationNotClaimed === true) return recoverOidPairAdmissionIntent(root, observed, waitMs);
  }
  if (observed.identity?.kind !== "oid-pair") return { state: observed.state, recovered: false };
  if (observed.state === "OPEN") {
    validateOidPairMaintenance(root, observed);
    return { state: "OPEN", recovered: false };
  }
  if (!pairOwnerProvablyDead(observed.owner)) return { state: "MANUAL", recovered: false, reason: "oid_pair_owner_alive_or_unknown" };
  const locks = [await pairLock(paths.admission, waitMs)];
  let current;
  try {
    locks.push(await pairLock(paths.activity, waitMs));
    current = pairReadMaintenance(paths);
    if (current.identity?.oid?.transactionNonce !== observed.identity.oid.transactionNonce || !pairOwnerProvablyDead(current.owner)) throw new Error("oid_pair_recovery_owner_changed");
    for (const name of ["nassaj-local-preview-build.lock", "nassaj-client-build.lock", "nassaj-preview-event-mutation.lock"]) locks.push(await pairLock(path12.join(paths.gitRoot, name), waitMs));
    let transaction;
    try {
      transaction = pairJournal(paths, current.identity.oid);
    } catch (error) {
      if (error.code === "ENOENT" && ["OID_DRAINING", "OID_QUIESCENT"].includes(current.phase)) return { state: "MANUAL", recovered: false, reason: "oid_pair_preparation_interrupted_without_counterpart" };
      throw error;
    }
    if (transaction.value.schema === "nassaj-oid-control-transaction/v2") return { state: "MANUAL", recovered: false, reason: "oid_triple_retained_executor_resume_required" };
    if (transaction.value.pair.databaseState === "UNKNOWN" && transaction.value.state !== "pair_served") return { state: "MANUAL", recovered: false, reason: "oid_pair_database_unknown" };
    let released = false;
    const handle = {
      paths,
      get journal() {
        return current;
      },
      transition(patch) {
        current = pairWriteMaintenance(paths, current, patch);
        return current;
      },
      release() {
        if (released) return;
        released = true;
        for (const lock of [...locks].reverse()) lock.release();
      }
    };
    if (transaction.value.state === "pair_served") {
      validateOidPairMaintenance(root, current);
      const receipt = transaction.value.pair.receipt;
      const child = pinnedJson(path12.join(paths.controlRoot, `oid-child-${current.transactionId}.json`), "pair_recovery_child");
      if (child.pid !== receipt.pid || child.startTime !== receipt.startTime || !pairOwnerAlive(child)) throw new Error("oid_pair_terminal_child_unverified");
      handle.transition({ owner: { ...current.owner, ...pairProcessIdentity() }, phase: "OID_RECOVERING" });
      pairRecordTerminalEvent(root, transaction.value);
      completeOidPairAdmission(root, handle);
    } else if (transaction.value.state === "pair_rolled_back") {
      validateOidPairMaintenance(root, current);
      await assertOidPairPreviousRuntime(root, transaction.value.pair.previous);
      handle.transition({ owner: { ...current.owner, ...pairProcessIdentity() }, phase: "OID_RECOVERING" });
      pairRecordTerminalEvent(root, transaction.value);
      completeOidPairAdmission(root, handle);
    } else {
      handle.transition({ owner: { ...current.owner, ...pairProcessIdentity() }, phase: "OID_RECOVERING" });
      await restoreOidPairBeforeCandidate(root, handle, transaction.value, transaction.file);
    }
    return { state: "OPEN", recovered: true };
  } finally {
    for (const lock of [...locks].reverse()) lock.release();
  }
}
function oidPairDependencyContract(packageText, lockText) {
  const manifest = JSON.parse(packageText), lock = JSON.parse(lockText);
  if (!manifest || Array.isArray(manifest) || !lock || Array.isArray(lock)) throw new Error("oid_pair_dependency_contract_invalid");
  delete manifest.version;
  delete lock.version;
  if (lock.packages?.[""]) delete lock.packages[""].version;
  return sha2(pairCanonical({ manifest, lock }));
}
function readOidPairServingReceipt(root, expected) {
  if (!Number.isSafeInteger(expected.sequence) || !HEX643.test(expected.transactionNonce || "") || !HEX643.test(expected.targetDigest || "")) throw new Error("oid_pair_serving_identity_invalid");
  const gitRoot = gitControlRoot(root);
  const transaction = pinnedJson(path12.join(gitRoot, `nassaj-oid-control-transaction-${expected.sequence}-${expected.transactionNonce}.json`), "pair_serving_journal");
  if (transaction.state !== "pair_served" || !validateOidPairTerminal(root, transaction)) throw new Error("oid_pair_serving_terminal_invalid");
  const receipt = pinnedJson(path12.join(gitRoot, `nassaj-oid-pair-serving-${expected.transactionNonce}.json`), "pair_serving_receipt");
  const terminal = transaction.pair.receipt;
  if (receipt.sequence !== expected.sequence || transaction.sequence !== receipt.sequence || receipt.targetDigest !== transaction.pair.targetDigest || receipt.transactionNonce !== expected.transactionNonce || receipt.targetDigest !== expected.targetDigest || receipt.actionId !== transaction.actionId || expected.actionId !== void 0 && receipt.actionId !== expected.actionId || expected.buildId !== void 0 && receipt.serverBuildId !== expected.buildId || receipt.clientBuildId !== terminal.clientBuildId || receipt.serverBuildId !== terminal.serverBuildId || receipt.pid !== terminal.pid || receipt.startTime !== terminal.startTime || receipt.outcome !== "served" || !Number.isSafeInteger(receipt.servedAt)) throw new Error("oid_pair_serving_receipt_invalid");
  if (transaction.schema === "nassaj-oid-control-transaction/v2" && (receipt.schema !== "nassaj-oid-triple-serving/v2" || receipt.nodeModulesTreeSha256 !== terminal.nodeModulesTreeSha256 || JSON.stringify(receipt.generationNames) !== JSON.stringify(UPDATE_GENERATION_NAMES))) throw new Error("oid_triple_serving_receipt_invalid");
  return receipt;
}
async function writeOidPairServingReceipt(root, outcome, healthProof) {
  const terminal = outcome.pair?.receipt;
  const triple = outcome.schema === "nassaj-oid-control-transaction/v2";
  if (triple && healthProof?.oidNodeModulesTreeSha256 !== terminal?.nodeModulesTreeSha256) throw new Error("oid_triple_serving_dependencies_invalid");
  if (outcome.state !== "pair_served" || !validateOidPairTerminal(root, outcome) || healthProof?.normalAdmissionReady !== true || healthProof.pid !== terminal.pid || healthProof.serverProcessStartTicks !== terminal.startTime || healthProof.serverTransactionNonce !== outcome.transactionNonce || healthProof.oidPairTransactionNonce !== outcome.transactionNonce || healthProof.oidPairTargetDigest !== outcome.pair.targetDigest || healthProof.serverLoadedBuildId !== terminal.serverBuildId || healthProof.clientBuildIdServed !== terminal.clientBuildId) throw new Error("oid_pair_serving_health_invalid");
  const receipt = {
    ...triple ? {
      schema: "nassaj-oid-triple-serving/v2",
      generationNames: UPDATE_GENERATION_NAMES,
      nodeModulesTreeSha256: terminal.nodeModulesTreeSha256
    } : {},
    outcome: "served",
    sequence: outcome.sequence,
    actionId: outcome.actionId,
    transactionNonce: outcome.transactionNonce,
    targetDigest: outcome.pair.targetDigest,
    clientBuildId: terminal.clientBuildId,
    serverBuildId: terminal.serverBuildId,
    pid: terminal.pid,
    startTime: terminal.startTime,
    servedAt: Date.now()
  };
  const file = path12.join(gitControlRoot(root), `nassaj-oid-pair-serving-${outcome.transactionNonce}.json`);
  try {
    durableCreate(file, receipt);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const verified = readOidPairServingReceipt(root, receipt);
  await reconcileOidPairServingReceipt(root, verified);
  return verified;
}
async function recordFullClientBaselineUnderEventLock(root, receipt) {
  const gitRoot = gitControlRoot(root);
  const outcome = pinnedJson(path12.join(gitRoot, `nassaj-oid-control-transaction-${receipt.sequence}-${receipt.transactionNonce}.json`), "full_baseline_transaction");
  const binding = recordFullClientPublicationBaseline(root, receipt, {
    afterWrite: (point) => injectFailure(`full_baseline_after_${point}`),
    rollbackDirectories: [path12.join(root, ".nassaj-local-preview/server-candidates", outcome.pair.target.serverBuildId)],
    verifyClosure: (directory) => {
      if (hashOidPairTree(directory) !== outcome.pair.target.clientTreeSha256) throw new Error("client_baseline_full_tree_mismatch");
    }
  });
  if (!binding) return;
  const serving = pinnedJson(path12.join(gitRoot, "nassaj-client-publication-serving-v1.json"), "full_baseline_serving");
  const lease = await pairLock(path12.join(gitRoot, "nassaj-local-preview-ledger.lock"));
  try {
    const file = path12.join(gitRoot, "nassaj-local-preview-ledger-v1.json");
    let ledger = { schemaVersion: 1, updatedAt: null };
    try {
      ledger = pinnedJson(file, "full_baseline_ledger");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (ledger.schemaVersion !== 1) throw new Error("full_baseline_ledger_invalid");
    if (ledger.clientPublicationServing?.receiptDigest === serving.receiptDigest) return;
    const next = advanceClientServingLineageRecord(ledger, { ...serving, expectedReceiptDigest: ledger.clientPublicationServing?.receiptDigest ?? null });
    durable(file, next);
    injectFailure("full_baseline_after_ledger");
  } finally {
    lease.release();
  }
}
async function reconcileOidPairServingReceipt(root, expected) {
  const receipt = readOidPairServingReceipt(root, expected);
  const gitRoot = gitControlRoot(root), lease = await pairLock(path12.join(gitRoot, "nassaj-preview-event-mutation.lock"));
  try {
    const file = path12.join(gitRoot, `nassaj-preview-oid-event-control-${String(receipt.sequence).padStart(16, "0")}.json`);
    const state = pinnedJson(file, "pair_serving_event").localUpdate;
    if (state.targetDigest !== receipt.targetDigest || state.activation?.transactionNonce !== receipt.transactionNonce || state.activation?.actionId !== receipt.actionId) throw new Error("oid_pair_serving_event_mismatch");
    await recordFullClientBaselineUnderEventLock(root, receipt);
    if (state.phase !== "activated") pairRecordEvent(root, state, { phase: "activated", receipt });
    return receipt;
  } finally {
    lease.release();
  }
}
async function recordOidPairApplicationServing(root, expected, healthProof) {
  if (!Number.isSafeInteger(expected.sequence) || !HEX643.test(expected.transactionNonce || "") || !HEX643.test(expected.targetDigest || "")) throw new Error("oid_pair_serving_identity_invalid");
  const outcome = pinnedJson(path12.join(gitControlRoot(root), `nassaj-oid-control-transaction-${expected.sequence}-${expected.transactionNonce}.json`), "pair_application_serving");
  if (outcome.pair?.targetDigest !== expected.targetDigest) throw new Error("oid_pair_serving_identity_invalid");
  return writeOidPairServingReceipt(root, outcome, healthProof);
}
if (process.argv[1] === "-") main().catch((error) => {
  process.stderr.write(`${error.message}
`);
  process.exitCode = 1;
});
export {
  applyBootstrapModeCAS,
  assertOidTripleEffectiveMode,
  assertOidTripleFailureBinding,
  assertOidTriplePm2Authority,
  assertOidTripleRuntime,
  beginOidPairAdmission,
  buildOidTripleStartEnvironment,
  captureOidPairSnapshot,
  captureOidTriplePm2Authority,
  captureOidTriplePreviousGeneration,
  captureOidTripleSupervisor,
  completeOidPairAdmission,
  createOidManualDisposition,
  createOidTripleSafeDiagnostic,
  dispositionArtifactHash,
  hashOidPairDependencyTree,
  hashOidPairTree,
  inspectBootstrapQualification,
  inspectConfirmedOidPair,
  inspectOidBootstrapAdmission,
  inspectOidPairAuthority,
  inspectOidPairRestart,
  inspectOidTripleGenerationPlan,
  oidPairDependencyContract,
  oidTripleCloneBudget,
  oidTripleDependencySlot,
  oidTripleSafeDiagnosticReason,
  persistOidTriplePm2Slot,
  prepareOidTripleClaimedDependencyExchange,
  prepareOidTripleDependencyExchange,
  prepareOidTriplePublicationSnapshot,
  probeOidRollbackClientHttp,
  readDispositionPacket,
  readOidPairServingReceipt,
  reconcileOidPairServingReceipt,
  recordOidPairApplicationServing,
  recordOidTripleOriginFailure,
  recordOidTripleSafeStartFailure,
  recoverOidPairAdmission,
  releaseFullWaiterBeforeEffects,
  restoreBootstrapModeCAS,
  runOidPairTransaction,
  runOidTripleNativeProbe,
  runOidTripleSafePhase,
  validateBootstrapModeProposal,
  validateOidManualDisposition,
  validateOidPairMaintenance,
  validateOidPairTerminal,
  validateOidTriplePm2AuthorityChain,
  validateOidTriplePm2Dump,
  validateOidTriplePm2Slot,
  writeOidPairServingReceipt
};
