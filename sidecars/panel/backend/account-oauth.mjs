/** @fileoverview Google OAuth identity and quota queries for saved Antigravity credentials. */

import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsPromises, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix as posixPath, win32 as winPath } from 'node:path';
import { fetchGoogleAccount } from './account-http.mjs';
import { isWslEnvironment } from './account-keyring-store.mjs';
import { buildOfficialQuotaPools } from './quota-pools.mjs';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_USER_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const CLOUD_CODE_HOSTS = [
  'daily-cloudcode-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'daily-cloudcode-pa.sandbox.googleapis.com',
];
const OAUTH_CLIENT_ID_RE = /^\d+-[\w-]+\.apps\.googleusercontent\.com$/;
const OAUTH_CLIENT_SECRET_RE = /^GOCSPX-[\w-]+$/;
// One-way SHA-256 digest of the official Antigravity desktop OAuth client_id for synchronous allowlist checks
// without embedding plaintext OAuth credentials in source control.
const OFFICIAL_OAUTH_CLIENT_ID_HASHES = Object.freeze(
  new Set(['bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea'])
);
const ACCOUNT_USER_AGENT = `antigravity/hub/4.3.0 (os_type=${process.platform === 'win32' ? 'windows' : process.platform}; arch=${process.arch === 'x64' ? 'amd64' : process.arch})`;

const PE_ID_LEN_OP = Buffer.from([0x48, 0xc7, 0x40, 0x08]);
const PE_LEA_RIP_OP = Buffer.from([0x48, 0x8d, 0x0d]);
const PE_BETWEEN_OP = Buffer.from([0x48, 0x89, 0x08, 0x48, 0xc7, 0x40, 0x18]);

let nativeOAuthClientsPromise = null;
const discoveredAllowedClientIds = new Set();

function sha256Hex(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function parsePeSections(headerBuf) {
  if (!Buffer.isBuffer(headerBuf) || headerBuf.length < 64) return null;
  const pe = headerBuf.readUInt16LE(0) === 0x5a4d ? headerBuf.readUInt32LE(60) : 0;
  if (!pe || pe + 24 > headerBuf.length || headerBuf.readUInt32LE(pe) !== 0x4550) {
    return null;
  }
  const machine = headerBuf.readUInt16LE(pe + 4);
  if (machine !== 0x8664 && machine !== 0xaa64) return null;
  const count = headerBuf.readUInt16LE(pe + 6);
  const table = pe + 24 + headerBuf.readUInt16LE(pe + 20);
  if (table + count * 40 > headerBuf.length) return null;

  let text = null;
  let rodata = null;
  for (let i = 0; i < count; i += 1) {
    const offset = table + i * 40;
    const name = headerBuf.toString('ascii', offset, offset + 8).replace(/\0+$/, '');
    const section = {
      name,
      rva: headerBuf.readUInt32LE(offset + 12),
      size: headerBuf.readUInt32LE(offset + 16),
      start: headerBuf.readUInt32LE(offset + 20),
    };
    if (name === '.text') text = section;
    else if (name === '.rdata') rodata = section;
  }
  return rodata ? { machine, text, rodata } : null;
}

function readSafeUInt64LE(buf, offset) {
  if (offset + 8 > buf.length) return -1;
  const lo = buf.readUInt32LE(offset);
  const hi = buf.readUInt32LE(offset + 4);
  if (hi > 0x1fffff) return -1;
  return hi * 0x100000000 + lo;
}

function parseMachO64RodataRanges(headerBuf, sliceOffset = 0, totalSize = Infinity) {
  if (!Buffer.isBuffer(headerBuf) || headerBuf.length < 32) return null;
  if (headerBuf.readUInt32LE(0) !== 0xfeedfacf) return null;
  const ncmds = headerBuf.readUInt32LE(16);
  const sizeofcmds = headerBuf.readUInt32LE(20);
  if (ncmds <= 0 || ncmds > 256 || 32 + sizeofcmds > headerBuf.length) return null;

  const ranges = [];
  let pos = 32;
  const end = 32 + sizeofcmds;
  for (let i = 0; i < ncmds && pos + 8 <= end; i += 1) {
    const cmd = headerBuf.readUInt32LE(pos);
    const cmdsize = headerBuf.readUInt32LE(pos + 4);
    if (cmdsize < 8 || pos + cmdsize > end) break;
    // LC_SEGMENT_64 = 0x19
    if (cmd === 0x19 && cmdsize >= 72) {
      const nsects = headerBuf.readUInt32LE(pos + 64);
      let sectPos = pos + 72;
      for (let s = 0; s < nsects && sectPos + 80 <= pos + cmdsize; s += 1) {
        const sectName = headerBuf.toString('ascii', sectPos, sectPos + 16).replace(/\0+$/, '');
        if (sectName === '__rodata' || sectName === '__cstring' || sectName === '__const') {
          const size = readSafeUInt64LE(headerBuf, sectPos + 40);
          const relOffset = headerBuf.readUInt32LE(sectPos + 48);
          const absStart = sliceOffset + relOffset;
          if (size > 0 && absStart >= 0 && absStart + size <= totalSize) {
            ranges.push({ start: absStart, size, priority: sectName === '__rodata' ? 0 : 1 });
          }
        }
        sectPos += 80;
      }
    }
    pos += cmdsize;
  }
  ranges.sort((a, b) => a.priority - b.priority);
  return ranges.length > 0 ? ranges : null;
}

function isElf64LittleEndian(headerBuf) {
  return (
    Buffer.isBuffer(headerBuf) &&
    headerBuf.length >= 64 &&
    headerBuf[0] === 0x7f &&
    headerBuf[1] === 0x45 &&
    headerBuf[2] === 0x4c &&
    headerBuf[3] === 0x46 &&
    headerBuf[4] === 2 &&
    headerBuf[5] === 1
  );
}

function parseElf64HeaderMeta(headerBuf) {
  if (!isElf64LittleEndian(headerBuf)) {
    return null;
  }
  const shoff = readSafeUInt64LE(headerBuf, 40);
  const shentsize = headerBuf.readUInt16LE(58);
  const shnum = headerBuf.readUInt16LE(60);
  const shstrndx = headerBuf.readUInt16LE(62);
  if (shoff <= 0 || shentsize < 64 || shnum <= 0 || shnum > 512) return null;
  return { shoff, shentsize, shnum, shstrndx };
}

function extractElf64LoadRangesFromPhdrs(phTableBuf, phentsize, phnum, totalSize) {
  const roRanges = [];
  const allRanges = [];
  for (let i = 0; i < phnum; i += 1) {
    const base = i * phentsize;
    if (base + 56 > phTableBuf.length) break;
    const pType = phTableBuf.readUInt32LE(base);
    const pFlags = phTableBuf.readUInt32LE(base + 4);
    const pOffset = readSafeUInt64LE(phTableBuf, base + 8);
    const pFilesz = readSafeUInt64LE(phTableBuf, base + 32);
    if (pType !== 1 || pOffset < 0 || pFilesz <= 0 || pOffset + pFilesz > totalSize) continue;
    const range = { start: pOffset, size: pFilesz };
    allRanges.push(range);
    if ((pFlags & 2) === 0) {
      roRanges.push(range);
    }
  }
  return roRanges.length > 0 ? roRanges : allRanges;
}

function extractElf64RodataRangesFromTables(shTableBuf, shentsize, shnum, shstrBuf, totalSize) {
  const ranges = [];
  for (let i = 0; i < shnum; i += 1) {
    const base = i * shentsize;
    if (base + 64 > shTableBuf.length) break;
    const nameOff = shTableBuf.readUInt32LE(base);
    const shType = shTableBuf.readUInt32LE(base + 4);
    const shOffset = readSafeUInt64LE(shTableBuf, base + 24);
    const shSize = readSafeUInt64LE(shTableBuf, base + 32);
    if (shType !== 1 || shOffset <= 0 || shSize <= 0 || shOffset + shSize > totalSize) continue;
    let secName = '';
    if (shstrBuf && nameOff < shstrBuf.length) {
      const zeroIdx = shstrBuf.indexOf(0, nameOff);
      secName = shstrBuf.toString('ascii', nameOff, zeroIdx >= 0 ? zeroIdx : shstrBuf.length);
    }
    if (!shstrBuf || secName === '.rodata' || secName.startsWith('.rodata.')) {
      ranges.push({ start: shOffset, size: shSize });
    }
  }
  return ranges;
}

const PACKED_CLIENT_ID_RE = /(\d{6,30})(-[A-Za-z0-9_-]{8,80}\.apps\.googleusercontent\.com)/g;
const PACKED_CLIENT_SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{8,80}/g;
const GOOGLE_DESKTOP_SECRET_LEN = 35; // "GOCSPX-" (7) + 28 base64url chars

function refinePackedClientId(digits, suffix) {
  const full = `${digits}${suffix}`;
  if (OFFICIAL_OAUTH_CLIENT_ID_HASHES.has(sha256Hex(full))) {
    return { id: full, official: true };
  }
  // Go's string table packs literals without null terminators; if the preceding literal ended
  // with digits, check suffix slices against the official SHA-256 allowlist to recover exact bounds.
  for (let trim = 1; trim <= digits.length - 8; trim += 1) {
    const candidate = `${digits.slice(trim)}${suffix}`;
    if (OFFICIAL_OAUTH_CLIENT_ID_HASHES.has(sha256Hex(candidate))) {
      return { id: candidate, official: true };
    }
  }
  const boundedDigits = digits.length > 24 ? digits.slice(-24) : digits;
  const fallback = `${boundedDigits}${suffix}`;
  return OAUTH_CLIENT_ID_RE.test(fallback) ? { id: fallback, official: false } : null;
}

function collectOAuthTokensFromAsciiChunk(
  asciiText,
  baseOffset,
  idMap,
  secretList,
  { hasMoreChunks = false } = {}
) {
  PACKED_CLIENT_ID_RE.lastIndex = 0;
  let m;
  while ((m = PACKED_CLIENT_ID_RE.exec(asciiText)) !== null) {
    if (hasMoreChunks && m.index + m[0].length >= asciiText.length) {
      continue;
    }
    const refined = refinePackedClientId(m[1], m[2]);
    if (!refined) continue;
    const absPos = baseOffset + m.index + (m[0].length - refined.id.length);
    const prev = idMap.get(refined.id);
    if (!prev || (refined.official && !prev.official)) {
      idMap.set(refined.id, { id: refined.id, official: refined.official, pos: absPos });
    }
  }

  PACKED_CLIENT_SECRET_RE.lastIndex = 0;
  while ((m = PACKED_CLIENT_SECRET_RE.exec(asciiText)) !== null) {
    const raw = m[0];
    if (hasMoreChunks && m.index + raw.length >= asciiText.length) {
      continue;
    }
    const absPos = baseOffset + m.index;
    const afterIdx = m.index + raw.length;
    const nextCode = afterIdx < asciiText.length ? asciiText.charCodeAt(afterIdx) : 0;
    const hasCleanDelimiter =
      afterIdx >= asciiText.length ||
      !(
        (nextCode >= 48 && nextCode <= 57) ||
        (nextCode >= 65 && nextCode <= 90) ||
        (nextCode >= 97 && nextCode <= 122) ||
        nextCode === 45 ||
        nextCode === 95
      );
    // In packed Go `.rodata` without null terminators, a 35-byte `GOCSPX-...` secret may run
    // directly into the next string literal; slice the standard 35-byte desktop secret.
    if (raw.length > GOOGLE_DESKTOP_SECRET_LEN) {
      const stdSlice = raw.slice(0, GOOGLE_DESKTOP_SECRET_LEN);
      if (OAUTH_CLIENT_SECRET_RE.test(stdSlice)) {
        secretList.push({ secret: stdSlice, pos: absPos, exact: false });
      }
    } else if (OAUTH_CLIENT_SECRET_RE.test(raw)) {
      secretList.push({ secret: raw, pos: absPos, exact: hasCleanDelimiter });
    }
  }
}

function pairDiscoveredOAuthTokens(idMap, secretList) {
  if (idMap.size === 0 || secretList.length === 0) return [];
  const uniqueSecrets = new Map();
  for (const item of secretList) {
    const prev = uniqueSecrets.get(item.secret);
    if (!prev || (item.exact && !prev.exact)) {
      uniqueSecrets.set(item.secret, item);
    }
  }
  const secrets = [...uniqueSecrets.values()];
  const ids = [...idMap.values()].sort((a, b) => {
    if (a.official !== b.official) return a.official ? -1 : 1;
    return a.pos - b.pos;
  });

  const pairs = [];
  const seenPairs = new Set();
  for (const idEntry of ids) {
    const rankedSecrets = [...secrets].sort(
      (a, b) => Math.abs(a.pos - idEntry.pos) - Math.abs(b.pos - idEntry.pos)
    );
    for (const secEntry of rankedSecrets.slice(0, 4)) {
      const pairKey = `${idEntry.id}|${secEntry.secret}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      pairs.push({ id: idEntry.id, secret: secEntry.secret });
    }
  }
  return pairs;
}

// Go's x64 OAuth config initializer stores ClientID and ClientSecret as two consecutive pointer/length pairs.
function scanGoOAuthInitializerMatches(machineCode, textRva, rodata) {
  const matches = [];
  for (
    let i = machineCode.indexOf(PE_ID_LEN_OP);
    i >= 0 && i + 33 <= machineCode.length;
    i = machineCode.indexOf(PE_ID_LEN_OP, i + 1)
  ) {
    if (
      !machineCode.subarray(i + 8, i + 11).equals(PE_LEA_RIP_OP) ||
      !machineCode.subarray(i + 15, i + 22).equals(PE_BETWEEN_OP) ||
      !machineCode.subarray(i + 26, i + 29).equals(PE_LEA_RIP_OP)
    ) {
      continue;
    }
    const idLen = machineCode.readUInt32LE(i + 4);
    const secretLen = machineCode.readUInt32LE(i + 22);
    if (idLen <= 0 || idLen > 100 || secretLen <= 0 || secretLen > 100) continue;
    const idRva = textRva + (i + 11) + 4 + machineCode.readInt32LE(i + 11);
    const secretRva = textRva + (i + 29) + 4 + machineCode.readInt32LE(i + 29);
    const idOffset = idRva - rodata.rva;
    const secretOffset = secretRva - rodata.rva;
    if (
      idOffset < 0 ||
      idOffset + idLen > rodata.size ||
      secretOffset < 0 ||
      secretOffset + secretLen > rodata.size
    ) {
      continue;
    }
    matches.push({ idOffset, idLen, secretOffset, secretLen });
  }
  return matches;
}

function scanBufferRangesForOAuthClients(binary, ranges) {
  const idMap = new Map();
  const secretList = [];
  for (const r of ranges) {
    const end = Math.min(binary.length, r.start + r.size);
    if (r.start < 0 || end <= r.start) continue;
    const ascii = binary.toString('latin1', r.start, end);
    collectOAuthTokensFromAsciiChunk(ascii, r.start, idMap, secretList);
  }
  return pairDiscoveredOAuthTokens(idMap, secretList);
}

export function extractNativeOAuthClients(binary) {
  if (!Buffer.isBuffer(binary) || binary.length < 64) return [];

  // 1. Windows PE (x64 exact RIP-relative initializer match + ARM64/fallback .rdata scan)
  const peSections = parsePeSections(binary);
  if (peSections) {
    const { machine, text, rodata } = peSections;
    if (
      machine === 0x8664 &&
      text &&
      text.start + text.size <= binary.length &&
      rodata.start + rodata.size <= binary.length
    ) {
      const machineCode = binary.subarray(text.start, text.start + text.size);
      const clients = new Map();
      for (const m of scanGoOAuthInitializerMatches(machineCode, text.rva, rodata)) {
        const id = binary.toString(
          'ascii',
          rodata.start + m.idOffset,
          rodata.start + m.idOffset + m.idLen
        );
        const secret = binary.toString(
          'ascii',
          rodata.start + m.secretOffset,
          rodata.start + m.secretOffset + m.secretLen
        );
        if (OAUTH_CLIENT_ID_RE.test(id) && OAUTH_CLIENT_SECRET_RE.test(secret)) {
          clients.set(id, { id, secret });
        }
      }
      if (clients.size > 0) {
        return Array.from(clients.values()).reverse();
      }
    }
    if (rodata.start + rodata.size <= binary.length) {
      return scanBufferRangesForOAuthClients(binary, [{ start: rodata.start, size: rodata.size }]);
    }
    return [];
  }

  // 2. Linux ELF64 (x86_64 & aarch64)
  const elfMeta = parseElf64HeaderMeta(binary);
  if (elfMeta) {
    const tableEnd = elfMeta.shoff + elfMeta.shnum * elfMeta.shentsize;
    if (tableEnd <= binary.length) {
      const shTable = binary.subarray(elfMeta.shoff, tableEnd);
      let shstrBuf = null;
      if (elfMeta.shstrndx < elfMeta.shnum) {
        const strBase = elfMeta.shstrndx * elfMeta.shentsize;
        const strOff = readSafeUInt64LE(shTable, strBase + 24);
        const strSize = readSafeUInt64LE(shTable, strBase + 32);
        if (strOff > 0 && strSize > 0 && strOff + strSize <= binary.length) {
          shstrBuf = binary.subarray(strOff, strOff + strSize);
        }
      }
      const ranges = extractElf64RodataRangesFromTables(
        shTable,
        elfMeta.shentsize,
        elfMeta.shnum,
        shstrBuf,
        binary.length
      );
      if (ranges.length > 0) {
        return scanBufferRangesForOAuthClients(binary, ranges);
      }
    }
    return scanBufferRangesForOAuthClients(binary, [{ start: 0, size: binary.length }]);
  }

  // 3. macOS Mach-O 64 & Universal Fat Binary (Apple Silicon arm64 & Intel x86_64)
  let machSliceOffset = 0;
  let machSliceSize = binary.length;
  if (binary.readUInt32BE(0) === 0xcafebabe) {
    const nfat = binary.readUInt32BE(4);
    if (nfat > 0 && nfat <= 8 && 8 + nfat * 20 <= binary.length) {
      for (let i = 0; i < nfat; i += 1) {
        const off = binary.readUInt32BE(8 + i * 20 + 8);
        const sz = binary.readUInt32BE(8 + i * 20 + 12);
        if (off > 0 && off + 32 <= binary.length && binary.readUInt32LE(off) === 0xfeedfacf) {
          machSliceOffset = off;
          machSliceSize = Math.min(sz, binary.length - off);
          break;
        }
      }
    }
  }
  if (
    machSliceOffset + 32 <= binary.length &&
    binary.readUInt32LE(machSliceOffset) === 0xfeedfacf
  ) {
    const headerWindow = binary.subarray(
      machSliceOffset,
      Math.min(binary.length, machSliceOffset + 16384)
    );
    const ranges = parseMachO64RodataRanges(
      headerWindow,
      machSliceOffset,
      machSliceOffset + machSliceSize
    );
    if (ranges) {
      return scanBufferRangesForOAuthClients(binary, ranges);
    }
    return scanBufferRangesForOAuthClients(binary, [{ start: machSliceOffset, size: machSliceSize }]);
  }

  return [];
}

const STREAM_CHUNK_BYTES = 1024 * 1024;
const STREAM_OVERLAP_BYTES = 256;

async function streamHandleRangesForOAuthClients(handle, ranges) {
  const idMap = new Map();
  const secretList = [];
  const chunkBuf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES + STREAM_OVERLAP_BYTES);

  for (const r of ranges) {
    let cursor = r.start;
    const rangeEnd = r.start + r.size;
    let carryLen = 0;

    while (cursor < rangeEnd) {
      const toRead = Math.min(STREAM_CHUNK_BYTES, rangeEnd - cursor);
      const { bytesRead } = await handle.read(chunkBuf, carryLen, toRead, cursor);
      if (bytesRead <= 0) break;
      const windowLen = carryLen + bytesRead;
      const hasMoreChunks = cursor + bytesRead < rangeEnd;
      const ascii = chunkBuf.toString('latin1', 0, windowLen);
      collectOAuthTokensFromAsciiChunk(ascii, cursor - carryLen, idMap, secretList, {
        hasMoreChunks,
      });
      const nextCarry = Math.min(STREAM_OVERLAP_BYTES, windowLen);
      if (nextCarry > 0 && hasMoreChunks) {
        chunkBuf.copy(chunkBuf, 0, windowLen - nextCarry, windowLen);
      }
      carryLen = nextCarry;
      cursor += bytesRead;
    }
  }

  chunkBuf.fill(0);
  return pairDiscoveredOAuthTokens(idMap, secretList);
}

async function extractNativeOAuthClientsFromFile(filePath) {
  if (typeof fsPromises === 'undefined' || typeof fsPromises?.open !== 'function') {
    return [];
  }
  let handle = null;
  try {
    handle = await fsPromises.open(filePath, 'r');
    const st = await handle.stat();
    if (!st.isFile() || st.size < 64) return [];
    const headerLen = Math.min(16384, st.size);
    const headerBuf = Buffer.alloc(headerLen);
    await handle.read(headerBuf, 0, headerLen, 0);

    // 1. Windows PE
    const peSections = parsePeSections(headerBuf);
    if (peSections) {
      const { machine, text, rodata } = peSections;
      if (
        machine === 0x8664 &&
        text &&
        text.start + text.size <= st.size &&
        rodata.start + rodata.size <= st.size
      ) {
        const textBuf = Buffer.allocUnsafe(text.size);
        let offset = 0;
        while (offset < text.size) {
          const { bytesRead } = await handle.read(
            textBuf,
            offset,
            text.size - offset,
            text.start + offset
          );
          if (bytesRead <= 0) break;
          offset += bytesRead;
        }
        if (offset === text.size) {
          const matches = scanGoOAuthInitializerMatches(textBuf, text.rva, rodata);
          const clients = new Map();
          for (const m of matches) {
            const idBuf = Buffer.allocUnsafe(m.idLen);
            const secBuf = Buffer.allocUnsafe(m.secretLen);
            const [idRead, secRead] = await Promise.all([
              handle.read(idBuf, 0, m.idLen, rodata.start + m.idOffset),
              handle.read(secBuf, 0, m.secretLen, rodata.start + m.secretOffset),
            ]);
            if (idRead.bytesRead === m.idLen && secRead.bytesRead === m.secretLen) {
              const id = idBuf.toString('ascii');
              const secret = secBuf.toString('ascii');
              if (OAUTH_CLIENT_ID_RE.test(id) && OAUTH_CLIENT_SECRET_RE.test(secret)) {
                clients.set(id, { id, secret });
              }
            }
            secBuf.fill(0);
          }
          if (clients.size > 0) {
            return Array.from(clients.values()).reverse();
          }
        }
      }
      if (rodata.start + rodata.size <= st.size) {
        return await streamHandleRangesForOAuthClients(handle, [
          { start: rodata.start, size: rodata.size },
        ]);
      }
      return [];
    }

    // 2. Linux ELF64
    if (isElf64LittleEndian(headerBuf)) {
      const elfMeta = parseElf64HeaderMeta(headerBuf);
      if (elfMeta) {
        const shTableBytes = elfMeta.shnum * elfMeta.shentsize;
        if (elfMeta.shoff + shTableBytes <= st.size && shTableBytes <= 65536) {
          const shTableBuf = Buffer.allocUnsafe(shTableBytes);
          const { bytesRead } = await handle.read(shTableBuf, 0, shTableBytes, elfMeta.shoff);
          if (bytesRead === shTableBytes) {
            let shstrBuf = null;
            if (elfMeta.shstrndx < elfMeta.shnum) {
              const strBase = elfMeta.shstrndx * elfMeta.shentsize;
              const strOff = readSafeUInt64LE(shTableBuf, strBase + 24);
              const strSize = readSafeUInt64LE(shTableBuf, strBase + 32);
              if (strOff > 0 && strSize > 0 && strSize <= 262144 && strOff + strSize <= st.size) {
                shstrBuf = Buffer.allocUnsafe(strSize);
                await handle.read(shstrBuf, 0, strSize, strOff);
              }
            }
            const ranges = extractElf64RodataRangesFromTables(
              shTableBuf,
              elfMeta.shentsize,
              elfMeta.shnum,
              shstrBuf,
              st.size
            );
            if (ranges.length > 0) {
              return await streamHandleRangesForOAuthClients(handle, ranges);
            }
          }
        }
      }
      // Fallback for stripped ELF64 binaries without section headers (`sstrip` / `e_shnum === 0`)
      const phoff = readSafeUInt64LE(headerBuf, 32);
      const phentsize = headerBuf.readUInt16LE(54);
      const phnum = headerBuf.readUInt16LE(56);
      if (phoff > 0 && phentsize >= 56 && phnum > 0 && phnum <= 128) {
        const phBytes = phnum * phentsize;
        if (phoff + phBytes <= st.size && phBytes <= 16384) {
          const phBuf = Buffer.allocUnsafe(phBytes);
          const { bytesRead } = await handle.read(phBuf, 0, phBytes, phoff);
          if (bytesRead === phBytes) {
            const loadRanges = extractElf64LoadRangesFromPhdrs(phBuf, phentsize, phnum, st.size);
            if (loadRanges.length > 0) {
              return await streamHandleRangesForOAuthClients(handle, loadRanges);
            }
          }
        }
      }
      if (st.size <= 256 * 1024 * 1024) {
        return await streamHandleRangesForOAuthClients(handle, [{ start: 0, size: st.size }]);
      }
      return [];
    }

    // 3. macOS Mach-O 64 & Universal Fat Binary
    let machSliceOffset = 0;
    let machSliceSize = st.size;
    let sliceHeader = headerBuf;
    if (headerBuf.readUInt32BE(0) === 0xcafebabe) {
      const nfat = headerBuf.readUInt32BE(4);
      if (nfat > 0 && nfat <= 8 && 8 + nfat * 20 <= headerBuf.length) {
        for (let i = 0; i < nfat; i += 1) {
          const off = headerBuf.readUInt32BE(8 + i * 20 + 8);
          const sz = headerBuf.readUInt32BE(8 + i * 20 + 12);
          if (off > 0 && off + 64 <= st.size) {
            const probeHdr = Buffer.alloc(Math.min(16384, st.size - off));
            const { bytesRead } = await handle.read(probeHdr, 0, probeHdr.length, off);
            if (bytesRead >= 32 && probeHdr.readUInt32LE(0) === 0xfeedfacf) {
              machSliceOffset = off;
              machSliceSize = Math.min(sz, st.size - off);
              sliceHeader = probeHdr.subarray(0, bytesRead);
              break;
            }
          }
        }
      }
    }
    if (sliceHeader.length >= 32 && sliceHeader.readUInt32LE(0) === 0xfeedfacf) {
      const ranges = parseMachO64RodataRanges(
        sliceHeader,
        machSliceOffset,
        machSliceOffset + machSliceSize
      );
      if (ranges && ranges.length > 0) {
        return await streamHandleRangesForOAuthClients(handle, ranges);
      }
      if (machSliceSize > 0 && machSliceSize <= 256 * 1024 * 1024) {
        return await streamHandleRangesForOAuthClients(handle, [
          { start: machSliceOffset, size: machSliceSize },
        ]);
      }
    }

    return [];
  } catch {
    return [];
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

export function collectNativeOAuthBinaryCandidates({
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
  existsFn = existsSync,
} = {}) {
  const pathMod = platform === 'win32' ? winPath : posixPath;
  const seen = new Set();
  const candidates = [];
  const add = (filePath) => {
    const clean = String(filePath || '').trim();
    if (!clean) return;
    const key = platform === 'win32' ? clean.toLowerCase() : clean;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(clean);
  };

  const addFromInstallRoot = (installRoot) => {
    if (!installRoot) return;
    if (platform === 'win32') {
      add(pathMod.join(installRoot, 'resources', 'bin', 'language_server.exe'));
      add(
        pathMod.join(
          installRoot,
          'resources',
          'app',
          'extensions',
          'antigravity',
          'bin',
          'language_server_windows_x64.exe'
        )
      );
      add(
        pathMod.join(
          installRoot,
          'resources',
          'app',
          'extensions',
          'antigravity',
          'bin',
          'language_server_windows_arm64.exe'
        )
      );
      return;
    }
    if (platform === 'darwin') {
      const resRoot = installRoot.endsWith('.app')
        ? pathMod.join(installRoot, 'Contents', 'Resources')
        : installRoot.endsWith('/Contents')
          ? pathMod.join(installRoot, 'Resources')
          : pathMod.join(installRoot, 'resources');
      add(pathMod.join(resRoot, 'bin', 'language_server'));
      for (const binName of [
        'language_server_macos_arm',
        'language_server_macos_arm64',
        'language_server_macos_x64',
        'language_server_darwin_arm64',
        'language_server_darwin_x64',
      ]) {
        add(pathMod.join(resRoot, 'app', 'extensions', 'antigravity', 'bin', binName));
      }
      return;
    }
    add(pathMod.join(installRoot, 'resources', 'bin', 'language_server'));
    for (const binName of [
      'language_server_linux_x64',
      'language_server_linux_arm',
      'language_server_linux_arm64',
    ]) {
      add(pathMod.join(installRoot, 'resources', 'app', 'extensions', 'antigravity', 'bin', binName));
    }
  };

  add(env?.ANTIGRAVITY_LS_BIN);
  const hints = [
    env?.USAGE_MONITOR_HOST_EXE,
    env?.ANTIGRAVITY_AGENTAPI_EXE,
    env?.CHROME_DEVTOOLS_MCP_JS,
    env?.APPIMAGE,
  ];
  for (const rawHint of hints) {
    const hint = String(rawHint || '').trim();
    if (!hint) continue;
    const leaf = pathMod.basename(hint).toLowerCase();
    if (/^(?:language_server.*|agy)(?:\.exe)?$/i.test(leaf)) {
      add(hint);
      continue;
    }
    if (platform === 'win32' && /\.exe$/i.test(leaf)) {
      addFromInstallRoot(pathMod.dirname(hint));
    }
    if (platform === 'darwin') {
      const appIdx = hint.toLowerCase().indexOf('.app/');
      if (appIdx > 0) {
        addFromInstallRoot(hint.slice(0, appIdx + 4));
      } else if (hint.toLowerCase().endsWith('.app')) {
        addFromInstallRoot(hint);
      }
    }
    let cur = hint;
    for (let depth = 0; depth < 8 && cur && pathMod.dirname(cur) !== cur; depth += 1) {
      if (pathMod.basename(cur).toLowerCase() === 'resources') {
        addFromInstallRoot(pathMod.dirname(cur));
        break;
      }
      cur = pathMod.dirname(cur);
    }
  }

  const geminiBase =
    String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || pathMod.join(homeDir, '.gemini');

  if (platform === 'win32') {
    const localAppData =
      String(env?.LOCALAPPDATA || '').trim() || pathMod.join(homeDir, 'AppData', 'Local');
    const programFiles = String(env?.ProgramFiles || '').trim() || 'C:\\Program Files';
    addFromInstallRoot(pathMod.join(localAppData, 'Programs', 'Antigravity'));
    addFromInstallRoot(pathMod.join(localAppData, 'Programs', 'Antigravity IDE'));
    addFromInstallRoot(pathMod.join(programFiles, 'Antigravity'));
    addFromInstallRoot(pathMod.join(programFiles, 'Antigravity IDE'));
    add(pathMod.join(geminiBase, 'bin', 'agy.exe'));
  } else if (platform === 'darwin') {
    for (const bundle of [
      '/Applications/Antigravity.app',
      pathMod.join(homeDir, 'Applications', 'Antigravity.app'),
      '/Applications/Antigravity IDE.app',
      pathMod.join(homeDir, 'Applications', 'Antigravity IDE.app'),
    ]) {
      addFromInstallRoot(bundle);
    }
    add(pathMod.join(geminiBase, 'bin', 'agy'));
    add('/opt/homebrew/bin/agy');
    add('/usr/local/bin/agy');
  } else {
    for (const root of [
      '/opt/Antigravity',
      '/opt/antigravity',
      '/usr/share/antigravity',
      '/opt/Antigravity IDE',
      '/opt/antigravity-ide',
      '/usr/share/antigravity-ide',
    ]) {
      addFromInstallRoot(root);
    }
    add(pathMod.join(geminiBase, 'bin', 'agy'));
    add(pathMod.join(homeDir, '.local', 'bin', 'agy'));
    add('/usr/local/bin/agy');
    add('/usr/bin/agy');

    // WSL2: also inspect host Windows Antigravity installation if mounted under /mnt/*
    if (isWslEnvironment({ platform, env }) && typeof spawnSync === 'function' && env === process.env) {
      try {
        const cmdRes = spawnSync('cmd.exe', ['/d', '/c', 'echo %LOCALAPPDATA%'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 3000,
        });
        const winLocal = String(cmdRes?.stdout || '').trim().split(/\r?\n/)[0]?.trim() || '';
        const m = winLocal.match(/^([A-Za-z]):[\\/](.*)$/);
        if (m) {
          const wslLocal = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
          for (const dirName of ['Antigravity', 'antigravity', 'Antigravity IDE']) {
            add(`${wslLocal}/Programs/${dirName}/resources/bin/language_server.exe`);
            add(
              `${wslLocal}/Programs/${dirName}/resources/app/extensions/antigravity/bin/language_server_windows_x64.exe`
            );
          }
        }
      } catch {
        // Ignore WSL interop probe failure
      }
    }
  }

  if (typeof existsFn !== 'function') return candidates;
  return candidates.filter((p) => {
    try {
      return Boolean(existsFn(p));
    } catch {
      return false;
    }
  });
}

function discoverRunningOAuthBinaryPaths(platform = process.platform) {
  if (platform === 'linux' && existsSync('/proc')) {
    const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
    const found = new Set();
    try {
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const procDir = `/proc/${name}`;
        try {
          if (myUid !== null && statSync(procDir).uid !== myUid) continue;
          const exe = readlinkSync(`${procDir}/exe`).replace(/ \(deleted\)$/, '');
          if (/^(?:language_server.*|agy)$/i.test(posixPath.basename(exe))) {
            found.add(exe);
          }
        } catch {
          // Process exited or unreadable
        }
      }
    } catch {
      // Ignore /proc scan error
    }
    return Promise.resolve([...found]);
  }

  if (typeof execFile !== 'function') {
    return Promise.resolve([]);
  }

  if (platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('/bin/ps', ['-axo', 'comm='], { timeout: 3000, encoding: 'utf8' }, (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        const paths = [
          ...new Set(
            String(stdout)
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((p) => p.startsWith('/') && /^(?:language_server.*|agy)$/i.test(posixPath.basename(p)))
          ),
        ];
        resolve(paths);
      });
    });
  }

  if (platform !== 'win32') {
    return Promise.resolve([]);
  }

  const shell = join(
    process.env.SystemRoot || 'C:/Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const cmd =
    "Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%' OR Name LIKE 'agy%'\" | Select-Object -ExpandProperty ExecutablePath -Unique";
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 3000, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        const paths = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((p) => /^(?:language_server.*|agy)\.exe$/i.test(winPath.basename(p)));
        resolve(paths);
      }
    );
  });
}

function rememberDiscoveredClients(clients) {
  for (const client of clients) {
    if (client?.id) discoveredAllowedClientIds.add(client.id);
  }
  return Object.freeze(clients.map((c) => Object.freeze({ id: c.id, secret: c.secret })));
}

export async function loadNativeOAuthClients(options = undefined) {
  const customRun = Boolean(options && Object.keys(options).length > 0);
  const env = options?.env ?? process.env;
  const overrideId = String(env?.USAGE_MONITOR_OAUTH_CLIENT_ID || '').trim();
  const overrideSecret = String(env?.USAGE_MONITOR_OAUTH_CLIENT_SECRET || '').trim();
  if (OAUTH_CLIENT_ID_RE.test(overrideId) && OAUTH_CLIENT_SECRET_RE.test(overrideSecret)) {
    return rememberDiscoveredClients([{ id: overrideId, secret: overrideSecret }]);
  }

  const runLoad = async () => {
    const platform = options?.platform ?? process.platform;
    const normKey = (p) => (platform === 'win32' ? String(p).toLowerCase() : String(p));
    const extractFromFileFn = options?.extractFromFileFn || extractNativeOAuthClientsFromFile;
    const discoverRunningFn =
      options?.discoverRunningFn || (() => discoverRunningOAuthBinaryPaths(platform));
    const candidates = collectNativeOAuthBinaryCandidates({
      platform,
      env,
      homeDir: options?.homeDir ?? homedir(),
      existsFn: options?.existsFn ?? existsSync,
    });
    const tried = new Set();
    for (const filePath of candidates) {
      tried.add(normKey(filePath));
      const clients = await extractFromFileFn(filePath);
      if (Array.isArray(clients) && clients.length > 0) {
        return rememberDiscoveredClients(clients);
      }
    }
    const runningPaths = await discoverRunningFn().catch(() => []);
    for (const filePath of runningPaths) {
      const clean = String(filePath || '').trim();
      const key = normKey(clean);
      if (!key || tried.has(key)) continue;
      tried.add(key);
      const clients = await extractFromFileFn(clean);
      if (Array.isArray(clients) && clients.length > 0) {
        return rememberDiscoveredClients(clients);
      }
    }
    return Object.freeze([]);
  };

  if (customRun) {
    return runLoad();
  }
  if (!nativeOAuthClientsPromise) {
    nativeOAuthClientsPromise = runLoad();
  }
  const clients = await nativeOAuthClientsPromise;
  if (!clients.length) {
    nativeOAuthClientsPromise = null;
  }
  return clients;
}

export function isAllowedOAuthClientId(clientId, allowedIds = null) {
  if (typeof clientId !== 'string') return false;
  const clean = clientId.trim();
  if (!clean) return false;
  if (allowedIds) {
    if (allowedIds instanceof Set && allowedIds.has(clean)) return true;
    if (Array.isArray(allowedIds) && allowedIds.includes(clean)) return true;
  }
  if (discoveredAllowedClientIds.has(clean)) return true;
  return OFFICIAL_OAUTH_CLIENT_ID_HASHES.has(sha256Hex(clean));
}

export async function buildGoogleAccountLoginUrl(
  redirectUri,
  state,
  codeChallenge,
  { getClients = loadNativeOAuthClients } = {}
) {
  const clients = await getClients();
  if (!Array.isArray(clients) || !clients.length || !clients[0]?.id) {
    throw new Error('oauthClientUnavailable');
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clients[0].id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: [
      'openid',
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/aicode',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ].join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export async function exchangeGoogleAccountCode(
  code,
  redirectUri,
  codeVerifier,
  { fetchFn = fetchGoogleAccount, getClients = loadNativeOAuthClients } = {}
) {
  const clients = await getClients();
  if (!Array.isArray(clients) || !clients.length || !clients[0]?.id || !clients[0]?.secret) {
    throw new Error('oauthClientUnavailable');
  }
  const primaryId = clients[0].id;
  const matchingClients = clients.filter((c) => c?.id === primaryId && c?.secret);
  let exchanged = null;
  for (const client of matchingClients) {
    const response = await fetchFn(OAUTH_TOKEN_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': ACCOUNT_USER_AGENT },
      body: new URLSearchParams({
        client_id: client.id,
        client_secret: client.secret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    const result = await response.json();
    if (
      response.ok &&
      result.access_token &&
      result.refresh_token &&
      Number.isFinite(result.expires_in) &&
      result.expires_in > 0
    ) {
      exchanged = result;
      break;
    }
    if (!['invalid_client', 'unauthorized_client'].includes(result?.error)) {
      break;
    }
  }
  if (!exchanged) throw new Error('loginExchangeFailed');
  return resolveGoogleCredential({
    token: { ...exchanged, expiry: new Date(Date.now() + exchanged.expires_in * 1000).toISOString() },
    ...(exchanged.id_token ? { id_token: exchanged.id_token } : {}),
  }, { fetchFn, getClients: async () => clients });
}

export async function resolveGoogleCredential(
  credential,
  { refresh = false, fetchFn = fetchGoogleAccount, getClients = loadNativeOAuthClients } = {}
) {
  let { access_token: accessToken, refresh_token: refreshToken, expiry } = credential.token;
  let idToken = credential.id_token;
  if (refresh || !accessToken || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now() + 60_000) {
    const clients = await getClients();
    if (!clients.length) throw new Error('oauthClientUnavailable');
    let refreshed = false;
    for (const { id, secret } of clients) {
      const response = await fetchFn(OAUTH_TOKEN_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
        body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'refresh_token', refresh_token: refreshToken }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(result?.error)) continue;
        throw new Error('oauthUnavailable');
      }
      if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('oauthUnavailable');
      accessToken = result.access_token;
      refreshToken = result.refresh_token || refreshToken;
      idToken = result.id_token;
      expiry = new Date(Date.now() + result.expires_in * 1000).toISOString();
      refreshed = true;
      break;
    }
    if (!refreshed) throw new Error('credentialRejected');
  }
  const userResponse = await fetchFn(OAUTH_USER_URL, {
    redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userResponse.ok) throw new Error(userResponse.status === 401 ? 'credentialRejected' : 'oauthUnavailable');
  const user = await userResponse.json();
  if (!user.email || user.verified_email === false) throw new Error('credentialRejected');
  return {
    email: user.email,
    credential: {
      token: { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expiry },
      auth_method: 'consumer',
      id_token_email: user.email,
      ...(idToken ? { id_token: idToken } : {}),
      ...(Number.isSafeInteger(credential.aicode_scope_sign_out_attempted_at) &&
      credential.aicode_scope_sign_out_attempted_at > 0
        ? { aicode_scope_sign_out_attempted_at: credential.aicode_scope_sign_out_attempted_at }
        : {}),
    },
  };
}

export function resolveSetupTierInfo(setup) {
  const tierObj = setup?.paidTier || setup?.currentTier || setup?.userTier || null;
  if (!tierObj) return null;
  const tierId = String(tierObj?.id || '').trim();
  const rawName = String(tierObj?.name || '').trim();
  const rawDesc = String(tierObj?.description || '').trim();
  const tierIdLower = tierId.toLowerCase();
  const tierText = `${tierId} ${rawName} ${rawDesc}`;
  const tierMultiplier = /(?:^|[-_\s])5x(?:$|[-_\s])|ultra[-_]?lite/i.test(tierText)
    ? '5x'
    : /(?:^|[-_\s])20x(?:$|[-_\s])/i.test(tierText) ||
        tierIdLower === 'g1-ultra-tier' ||
        (/^g1-ultra(?:-[a-z0-9]+)?-tier$/i.test(tierIdLower) && !/lite|5x/i.test(tierIdLower))
      ? '20x'
      : '';
  const tierName =
    rawName ||
    (/ultra/i.test(tierIdLower)
      ? 'Google AI Ultra'
      : /pro/i.test(tierIdLower)
        ? 'Google AI Pro'
        : /free|standard/i.test(tierIdLower)
          ? 'Google AI Free'
          : '');
  if (!tierName && !tierId) return null;
  return { tierId, tierName: tierName || 'Google AI', tierMultiplier };
}

export async function retrieveCredentialQuota(accessToken, fetchFn = fetchGoogleAccount) {
  let preferredHost = '';
  async function post(method, data, retryWithoutProject = true) {
    const hosts = preferredHost
      ? [preferredHost, ...CLOUD_CODE_HOSTS.filter((h) => h !== preferredHost)]
      : CLOUD_CODE_HOSTS;
    for (const host of hosts) {
      const response = await fetchFn(`https://${host}/v1internal:${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4500),
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': ACCOUNT_USER_AGENT },
        body: JSON.stringify(data),
      }).catch(() => null);
      if (response?.ok) {
        const payload = await response.json().catch(() => null);
        const result = payload?.response ?? payload;
        const valid = method === 'loadCodeAssist' ? result && typeof result === 'object' :
          method === 'fetchAvailableModels' ? result?.models && typeof result.models === 'object' :
            Array.isArray(result?.groups) || Array.isArray(result?.quotaSummary?.groups) || Array.isArray(result?.buckets);
        if (valid) {
          preferredHost = host;
          return result;
        }
      }
      if (response?.status === 401) throw new Error('credentialRejected');
      if (response?.status === 403 && data.project && retryWithoutProject) return post(method, {}, false);
    }
    return null;
  }

  const setup = await post('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } });
  const project = setup?.cloudaicompanionProject?.id || setup?.cloudaicompanionProject;
  if (!setup) throw new Error('quotaUnavailable');
  const tierInfo = resolveSetupTierInfo(setup);
  const request = typeof project === 'string' && project ? { project } : {};
  const clientConfigs = setup.cascadeModelConfigData?.clientModelConfigs;
  const [summary, available] = await Promise.all([
    post('retrieveUserQuotaSummary', request),
    Array.isArray(clientConfigs) && clientConfigs.length ? null : post('fetchAvailableModels', request),
  ]);
  const configs = Array.isArray(clientConfigs) && clientConfigs.length ? clientConfigs :
    Object.entries(available?.models || {}).filter(([, model]) => model?.quotaInfo && !model.disabled)
      .map(([modelId, model]) => ({ modelId, modelOrAlias: { model: modelId }, label: model.displayName, quotaInfo: model.quotaInfo }));
  const raw = summary?.quotaSummary ?? summary;
  if (!Array.isArray(raw?.groups) && !Array.isArray(raw?.buckets) && !configs.length) throw new Error('quotaUnavailable');
  const adaptBuckets = (buckets) => (Array.isArray(buckets) ? buckets : []).map((bucket) => ({
    ...bucket,
    bucketId: bucket?.bucketId ?? bucket?.bucket_id,
    remainingFraction: bucket?.remainingFraction ?? bucket?.remaining_fraction,
    resetTime: bucket?.resetTime ?? bucket?.reset_time,
  }));
  const quota = {
    groups: (Array.isArray(raw?.groups) ? raw.groups : []).map((group) => ({
      ...group, displayName: group?.displayName || group?.name, buckets: adaptBuckets(group?.buckets),
    })),
    buckets: adaptBuckets(raw?.buckets),
  };
  const { quotaPoolsMap } = buildOfficialQuotaPools(quota, configs);
  const pools = Array.from(quotaPoolsMap.values()).filter(({ isAvailable }) => isAvailable).map((pool) => ({
    poolKey: pool.poolKey,
    poolLabel: pool.poolLabel,
    remainingPct: pool.remainingPct,
    weeklyRemainingPct: pool.weeklyRemainingPct,
    resetTime: pool.resetTime,
    weeklyResetTime: pool.weeklyResetTime,
  }));
  if (tierInfo) {
    Object.defineProperty(pools, 'tierInfo', { value: tierInfo, enumerable: false });
    Object.defineProperty(pools, 'tierName', { value: tierInfo.tierName, enumerable: false });
  }
  return pools;
}
