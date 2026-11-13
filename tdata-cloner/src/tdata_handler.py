"""
Pure-Python TData reader/writer.
No opentele, no PyQt5. Uses only: tgcrypto, hashlib, struct, os.

TData file format:
  TDF$(4) + version(4-LE) + body(N) + MD5(16)
  MD5 input = body + len(body)(4-LE) + version(4-LE) + TDF$

QDataStream (BigEndian):
  QByteArray: 4-byte BE uint32 size (0xFFFFFFFF = null) + data
  int32:      4-byte BE signed
  uint32:     4-byte BE unsigned
  uint64:     8-byte BE unsigned
  int64:      8-byte BE signed
  rawData(n): n bytes verbatim

Encryption (AES-256-IGE, old-MTP style):
  prepareAES_oldmtp(auth_key, msg_key, decrypt):
    x = 8 if decrypt else 0
    sha1_a = SHA1(msg_key[:16] + auth_key[x:x+32])
    sha1_b = SHA1(auth_key[x+32:x+48] + msg_key[:16] + auth_key[x+48:x+64])
    sha1_c = SHA1(auth_key[x+64:x+96] + msg_key[:16])
    sha1_d = SHA1(msg_key[:16] + auth_key[x+96:x+128])
    aes_key = sha1_a[:8] + sha1_b[8:20] + sha1_c[4:16]
    aes_iv  = sha1_a[8:20] + sha1_b[:8] + sha1_c[16:20] + sha1_d[:8]

LocalKey derivation (empty passcode):
  hash_key = SHA512(salt + b'' + salt)
  local_key = PBKDF2-SHA512(hash_key, salt, iterations=1, dklen=256)
"""

import asyncio
import hashlib
import logging
import os
import struct
from typing import Optional, Tuple

import tgcrypto
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.crypto import AuthKey as TelethonAuthKey

logger = logging.getLogger(__name__)

TDF_MAGIC = b"TDF$"
APP_VERSION = 4000000  # arbitrary; Telegram Desktop 4.x


# ──────────────────────────────────────────────────────────────────────────────
# Low-level binary helpers
# ──────────────────────────────────────────────────────────────────────────────

def _r_uint32(data: bytes, off: int) -> Tuple[int, int]:
    return struct.unpack_from(">I", data, off)[0], off + 4


def _r_int32(data: bytes, off: int) -> Tuple[int, int]:
    return struct.unpack_from(">i", data, off)[0], off + 4


def _r_uint64(data: bytes, off: int) -> Tuple[int, int]:
    return struct.unpack_from(">Q", data, off)[0], off + 8


def _r_int64(data: bytes, off: int) -> Tuple[int, int]:
    return struct.unpack_from(">q", data, off)[0], off + 8


def _r_qba(data: bytes, off: int) -> Tuple[Optional[bytes], int]:
    """Read QByteArray: 4-byte BE size + data (0xFFFFFFFF = null)."""
    size = struct.unpack_from(">I", data, off)[0]
    off += 4
    if size == 0xFFFFFFFF:
        return None, off
    return data[off : off + size], off + size


def _w_uint32(v: int) -> bytes:
    return struct.pack(">I", v)


def _w_int32(v: int) -> bytes:
    return struct.pack(">i", v)


def _w_uint64(v: int) -> bytes:
    return struct.pack(">Q", v)


def _w_int64(v: int) -> bytes:
    return struct.pack(">q", v)


def _w_qba(data: Optional[bytes]) -> bytes:
    if data is None:
        return struct.pack(">I", 0xFFFFFFFF)
    return struct.pack(">I", len(data)) + data


# ──────────────────────────────────────────────────────────────────────────────
# TDF file I/O
# ──────────────────────────────────────────────────────────────────────────────

def _tdf_read(base_path: str) -> Tuple[int, bytes]:
    """
    Try suffixes 's', '1', '0'.  Return (version, body_bytes) for first valid file.
    """
    for suffix in ("s", "1", "0"):
        path = base_path + suffix
        if not os.path.isfile(path):
            continue
        with open(path, "rb") as fh:
            raw = fh.read()
        if len(raw) < 24:
            continue
        magic = raw[:4]
        if magic != TDF_MAGIC:
            continue
        version = struct.unpack_from("<I", raw, 4)[0]
        body_and_md5 = raw[8:]
        body = body_and_md5[:-16]
        md5_stored = body_and_md5[-16:]
        md5_input = (
            body
            + struct.pack("<I", len(body))
            + struct.pack("<I", version)
            + TDF_MAGIC
        )
        if hashlib.md5(md5_input).digest() != md5_stored:
            logger.warning("MD5 mismatch in %s, trying next", path)
            continue
        logger.debug("Read TDF file %s (version %d, body %d bytes)", path, version, len(body))
        return version, body
    raise FileNotFoundError(f"No valid TDF file found at base path: {base_path}")


def _tdf_write(base_path: str, version: int, body: bytes) -> None:
    """Write a TDF file (always writes the 's' variant)."""
    md5_input = (
        body
        + struct.pack("<I", len(body))
        + struct.pack("<I", version)
        + TDF_MAGIC
    )
    md5 = hashlib.md5(md5_input).digest()
    raw = TDF_MAGIC + struct.pack("<I", version) + body + md5
    path = base_path + "s"
    dir_ = os.path.dirname(path)
    if dir_:
        os.makedirs(dir_, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(raw)
    logger.debug("Wrote TDF file %s (%d bytes)", path, len(raw))


# ──────────────────────────────────────────────────────────────────────────────
# AES-256-IGE local encryption
# ──────────────────────────────────────────────────────────────────────────────

def _prepare_aes(auth_key: bytes, msg_key: bytes) -> Tuple[bytes, bytes]:
    # opentele always calls prepareAES_oldmtp(key128, send=False) → x=8
    # for BOTH encrypt and decrypt of local data
    x = 8
    sha1_a = hashlib.sha1(msg_key[:16] + auth_key[x : x + 32]).digest()
    sha1_b = hashlib.sha1(
        auth_key[x + 32 : x + 48] + msg_key[:16] + auth_key[x + 48 : x + 64]
    ).digest()
    sha1_c = hashlib.sha1(auth_key[x + 64 : x + 96] + msg_key[:16]).digest()
    sha1_d = hashlib.sha1(msg_key[:16] + auth_key[x + 96 : x + 128]).digest()
    aes_key = sha1_a[:8] + sha1_b[8:20] + sha1_c[4:16]
    aes_iv = sha1_a[8:20] + sha1_b[:8] + sha1_c[16:20] + sha1_d[:8]
    return aes_key, aes_iv


def _decrypt_local(encrypted: bytes, auth_key: bytes) -> bytes:
    """
    Decrypt locally-encrypted data.
    Returns the payload bytes (without the 4-byte length prefix).
    """
    if len(encrypted) <= 16 or (len(encrypted) & 0x0F):
        raise ValueError(f"Bad encrypted size: {len(encrypted)}")
    encrypted_key = encrypted[:16]  # SHA1 checksum used as AES msg_key
    encrypted_data = encrypted[16:]
    aes_key, aes_iv = _prepare_aes(auth_key, encrypted_key)
    decrypted = tgcrypto.ige256_decrypt(encrypted_data, aes_key, aes_iv)
    check = hashlib.sha1(decrypted).digest()[:16]
    if check != encrypted_key:
        raise ValueError("AES decrypt checksum mismatch – wrong key?")
    data_len = struct.unpack_from("<I", decrypted, 0)[0]
    if data_len < 4 or data_len > len(decrypted):
        raise ValueError(f"Bad decrypted data_len: {data_len}")
    return decrypted[4:data_len]


def _encrypt_local(payload: bytes, auth_key: bytes) -> bytes:
    """
    Encrypt payload for local storage.
    Returns sha1_prefix(16) + AES-IGE-encrypted block.
    """
    # Build: 4-byte-LE size placeholder + payload
    inner = b"\x00\x00\x00\x00" + payload
    size = len(inner)  # 4 + len(payload); this is what gets stored
    # Pad to multiple of 16
    pad = (16 - (size % 16)) % 16
    inner_padded = inner + os.urandom(pad)
    # Store ORIGINAL (pre-pad) size in first 4 bytes, NOT the padded size
    inner_padded = struct.pack("<I", size) + inner_padded[4:]
    sha1_prefix = hashlib.sha1(inner_padded).digest()[:16]
    aes_key, aes_iv = _prepare_aes(auth_key, sha1_prefix)
    encrypted = tgcrypto.ige256_encrypt(inner_padded, aes_key, aes_iv)
    return sha1_prefix + encrypted


# ──────────────────────────────────────────────────────────────────────────────
# LocalKey derivation
# ──────────────────────────────────────────────────────────────────────────────

def _create_local_key(salt: bytes, passcode: bytes = b"") -> bytes:
    """
    Derive a 256-byte LocalKey from salt + passcode (empty = no passcode).
    Matches Storage::CreateLocalKey in opentele/tdesktop.
    """
    h = hashlib.sha512(salt + passcode + salt).digest()
    iterations = 1 if not passcode else 100_000
    return hashlib.pbkdf2_hmac("sha512", h, salt, iterations, 256)


# ──────────────────────────────────────────────────────────────────────────────
# File naming helpers
# ──────────────────────────────────────────────────────────────────────────────

def _compose_data_string(data_name: str, index: int) -> str:
    result = data_name.replace("#", "")
    if index > 0:
        result += f"#{index + 1}"
    return result


def _compute_data_name_key(data_name: str) -> int:
    md5 = hashlib.md5(data_name.encode("utf-8")).digest()
    return struct.unpack_from("<Q", md5, 0)[0]  # little-endian uint64


def _to_file_part(val: int) -> str:
    result = ""
    for _ in range(16):
        v = val & 0xF
        result += chr(ord("0") + v) if v < 10 else chr(ord("A") + v - 10)
        val >>= 4
    return result


# ──────────────────────────────────────────────────────────────────────────────
# ReadEncryptedFile / WriteEncryptedFile wrappers
# ──────────────────────────────────────────────────────────────────────────────

def _read_encrypted_file(base_path: str, local_key: bytes) -> bytes:
    """Read a TDF file, extract its single QByteArray, decrypt it, return payload."""
    _version, body = _tdf_read(base_path)
    encrypted, _ = _r_qba(body, 0)
    if encrypted is None:
        raise ValueError("Null QByteArray in encrypted file")
    return _decrypt_local(encrypted, local_key)


def _write_encrypted_file(base_path: str, payload: bytes, local_key: bytes) -> None:
    """Encrypt payload, wrap in QByteArray, write as TDF file."""
    encrypted = _encrypt_local(payload, local_key)
    body = _w_qba(encrypted)
    _tdf_write(base_path, APP_VERSION, body)


# ──────────────────────────────────────────────────────────────────────────────
# TData → Telethon client
# ──────────────────────────────────────────────────────────────────────────────

def _load_tdata(tdata_path: str) -> Tuple[int, bytes]:
    """
    Parse a TData folder and return (dc_id, auth_key_bytes).
    """
    base_path = os.path.abspath(tdata_path)

    # ── 1. Read key_datas ────────────────────────────────────────────────────
    key_file_path = os.path.join(base_path, "key_data")
    _version, key_body = _tdf_read(key_file_path)

    off = 0
    salt, off = _r_qba(key_body, off)
    key_encrypted, off = _r_qba(key_body, off)
    info_encrypted, off = _r_qba(key_body, off)

    if salt is None or key_encrypted is None or info_encrypted is None:
        raise ValueError("Null field in key_data")
    logger.debug("salt=%d bytes, key_enc=%d bytes, info_enc=%d bytes",
                 len(salt), len(key_encrypted), len(info_encrypted))

    # ── 2. Derive passcode key (no passcode) and decrypt local key ───────────
    passcode_key = _create_local_key(salt, b"")
    local_key_raw = _decrypt_local(key_encrypted, passcode_key)
    if len(local_key_raw) < 256:
        raise ValueError(f"LocalKey too short: {len(local_key_raw)}")
    local_key = local_key_raw[:256]
    logger.debug("LocalKey derived (%d bytes)", len(local_key))

    # ── 3. Decrypt info → account indices ────────────────────────────────────
    info_payload = _decrypt_local(info_encrypted, local_key)
    off = 0
    count, off = _r_int32(info_payload, off)
    logger.debug("Account count: %d", count)
    if count <= 0:
        raise ValueError(f"No accounts in TData (count={count})")

    indices = []
    for _ in range(count):
        idx, off = _r_int32(info_payload, off)
        indices.append(idx)

    # active_index follows (may be absent in older files)
    active_index = indices[0]
    if off + 4 <= len(info_payload):
        active_index, _ = _r_int32(info_payload, off)

    logger.debug("Account indices: %s, active: %d", indices, active_index)

    # ── 4. Load each account, prefer active ──────────────────────────────────
    accounts = {}
    for idx in indices:
        try:
            dc_id, auth_key = _load_account(base_path, local_key, idx)
            accounts[idx] = (dc_id, auth_key)
            logger.debug("Loaded account index=%d dc_id=%d", idx, dc_id)
        except Exception as exc:
            logger.warning("Could not load account index=%d: %s", idx, exc)

    if not accounts:
        raise RuntimeError("No accounts could be loaded from TData")

    # Return active account; fall back to first loaded
    if active_index in accounts:
        return accounts[active_index]
    return next(iter(accounts.values()))


def _load_account(base_path: str, local_key: bytes, index: int) -> Tuple[int, bytes]:
    """
    Load a single account's MTP authorization data.
    Returns (dc_id, auth_key_bytes).
    """
    data_name = _compose_data_string("data", index)
    data_name_key = _compute_data_name_key(data_name)
    file_part = _to_file_part(data_name_key)
    mtp_file = os.path.join(base_path, file_part)
    logger.debug("Loading account index=%d data_name=%r file_part=%s", index, data_name, file_part)

    payload = _read_encrypted_file(mtp_file, local_key)

    # payload = int32(blockId=75) + QByteArray(serialized_mtp_auth)
    off = 0
    block_id, off = _r_int32(payload, off)
    if block_id != 75:
        raise ValueError(f"Unexpected blockId {block_id} (expected 75=dbi.MtpAuthorization)")

    serialized, off = _r_qba(payload, off)
    if serialized is None:
        raise ValueError("Null serialized MTP authorization")

    return _parse_mtp_authorization(serialized)


_WIDE_IDS_TAG = (~0) & 0xFFFFFFFFFFFFFFFF  # int(~0) = -1 as signed, but as uint64 it's all Fs


def _parse_mtp_authorization(serialized: bytes) -> Tuple[int, bytes]:
    """
    Parse serialized MTP authorization blob.
    Returns (main_dc_id, auth_key_bytes).
    """
    off = 0
    # Check for wide IDs tag (kWideIdsTag = -1 as int64)
    first_i64, _ = _r_int64(serialized, 0)
    if first_i64 == -1:
        # Wide IDs format: int64(-1) + uint64(userId) + int32(mainDcId)
        off += 8  # skip kWideIdsTag
        _user_id, off = _r_uint64(serialized, off)
        main_dc_id, off = _r_int32(serialized, off)
    else:
        # Legacy format: int32(userId) + int32(mainDcId)
        _user_id, off = _r_int32(serialized, 0)
        off = 4
        main_dc_id, off = _r_int32(serialized, off)
        # check if legacy kWideIdsTag
        # Actually kWideIdsTag check is on (userId<<32)|mainDcId as uint64
        combined = ((_user_id & 0xFFFFFFFF) << 32) | (main_dc_id & 0xFFFFFFFF)
        if combined == _WIDE_IDS_TAG:
            _user_id, off = _r_uint64(serialized, off)
            main_dc_id, off = _r_int32(serialized, off)

    logger.debug("MTP auth: main_dc_id=%d", main_dc_id)

    # Read keys
    key_count, off = _r_int32(serialized, off)
    logger.debug("Key count: %d", key_count)

    auth_key = None
    for _ in range(key_count):
        dc_id, off = _r_int32(serialized, off)
        key_bytes = serialized[off : off + 256]
        off += 256
        logger.debug("  key dc_id=%d", dc_id)
        if dc_id == main_dc_id:
            auth_key = key_bytes

    if auth_key is None:
        raise ValueError(f"No auth key found for main_dc_id={main_dc_id}")

    return main_dc_id, auth_key


async def tdata_to_client(
    tdata_path: str,
    api_id: int,
    api_hash: str,
    proxy=None,
) -> TelegramClient:
    """
    Load TData, extract session, return a connected TelegramClient.
    """
    logger.info("Loading TData from %s", tdata_path)
    dc_id, auth_key_bytes = _load_tdata(tdata_path)
    logger.info("Extracted session: dc_id=%d auth_key=%s…", dc_id, auth_key_bytes[:4].hex())

    # Build Telethon StringSession from raw dc_id + auth_key
    session = StringSession()
    session.set_dc(dc_id, _dc_ip(dc_id), 443)
    # Inject the raw auth key
    session.auth_key = TelethonAuthKey(auth_key_bytes)

    client = TelegramClient(
        session=session,
        api_id=api_id,
        api_hash=api_hash,
        proxy=proxy,
    )
    await client.connect()
    if not await client.is_user_authorized():
        raise RuntimeError("Session from TData is not authorized (expired/revoked?)")
    return client


def _dc_ip(dc_id: int) -> str:
    """Return production DC IP for dc_id."""
    return {
        1: "149.154.175.53",
        2: "149.154.167.51",
        3: "149.154.175.100",
        4: "149.154.167.91",
        5: "91.108.56.130",
    }.get(dc_id, "149.154.167.51")


# ──────────────────────────────────────────────────────────────────────────────
# Telethon client → TData
# ──────────────────────────────────────────────────────────────────────────────

def _serialize_mtp_authorization(dc_id: int, user_id: int, auth_key: bytes) -> bytes:
    """
    Serialize MTP authorization in wide-IDs format.
    Returns bytes suitable for writing as QByteArray in the mtp data file.
    """
    result = b""
    result += _w_int64(-1)             # kWideIdsTag
    result += _w_uint64(user_id)       # userId (wide)
    result += _w_int32(dc_id)          # mainDcId

    # mtpKeys: 1 key
    result += _w_int32(1)
    result += _w_int32(dc_id)
    result += auth_key                 # 256 bytes

    # mtpKeysToDestroy: 0 keys
    result += _w_int32(0)

    return result


def _build_mtp_payload(dc_id: int, user_id: int, auth_key: bytes) -> bytes:
    """
    Build the decrypted payload for the mtp data file:
    int32(75=dbi.MtpAuthorization) + QByteArray(serialized)
    """
    serialized = _serialize_mtp_authorization(dc_id, user_id, auth_key)
    return _w_int32(75) + _w_qba(serialized)


def _build_map_payload() -> bytes:
    """
    Build a minimal decrypted map payload (empty map data).
    Just the settings key = 0 (no entries).
    """
    # An empty map has no entries; Telegram Desktop can still load it.
    return b""


def _write_tdata(
    base_path: str,
    dc_id: int,
    user_id: int,
    auth_key: bytes,
    index: int = 0,
) -> None:
    """
    Write a minimal but valid TData folder structure.
    """
    os.makedirs(base_path, exist_ok=True)

    # ── Generate keys ─────────────────────────────────────────────────────────
    _pass = os.urandom(256)      # random 256-byte secret
    _salt_lk = os.urandom(32)    # salt for local key derivation
    local_key = _create_local_key(_salt_lk, _pass)

    passcode_salt = os.urandom(32)
    passcode_key = _create_local_key(passcode_salt, b"")  # empty passcode

    # Encrypt local_key with passcode_key
    key_encrypted = _encrypt_local(local_key, passcode_key)

    # ── Encrypt info (account count + indices + active_index) ─────────────────
    info_payload = _w_int32(1) + _w_int32(index) + _w_int32(index)
    info_encrypted = _encrypt_local(info_payload, local_key)

    # ── Write key_datas ───────────────────────────────────────────────────────
    key_body = _w_qba(passcode_salt) + _w_qba(key_encrypted) + _w_qba(info_encrypted)
    key_file = os.path.join(base_path, "key_data")
    _tdf_write(key_file, APP_VERSION, key_body)
    logger.debug("Wrote key_datas")

    # ── Compute paths for account data ────────────────────────────────────────
    data_name = _compose_data_string("data", index)
    data_name_key = _compute_data_name_key(data_name)
    file_part = _to_file_part(data_name_key)

    # Account data lives directly in base_path (not in a subfolder)
    # (StorageAccount uses the base_path directly for the mtp file)
    mtp_base = os.path.join(base_path, file_part)

    # ── Write mtp data file ───────────────────────────────────────────────────
    mtp_payload = _build_mtp_payload(dc_id, user_id, auth_key)
    _write_encrypted_file(mtp_base, mtp_payload, local_key)
    logger.debug("Wrote mtp data file: %s", file_part)

    # ── Write map file (minimal – empty map data) ─────────────────────────────
    # map file resides in the account subdirectory: base_path/<file_part>/map
    account_dir = os.path.join(base_path, file_part[:-0] if False else file_part)
    # Actually: map is at basePath = PathJoin(baseGlobalPath, ToFilePart(dataNameKey))
    account_basepath = os.path.join(base_path, file_part)
    os.makedirs(account_basepath, exist_ok=True)

    # map file = account_basepath/map (TDF, with two empty QByteArrays + encrypted mapData)
    map_encrypted = _encrypt_local(b"", local_key)  # empty map
    map_body = _w_qba(b"") + _w_qba(b"") + _w_qba(map_encrypted)
    map_file = os.path.join(account_basepath, "map")
    _tdf_write(map_file, APP_VERSION, map_body)
    logger.debug("Wrote map file")

    logger.info("TData written to %s (dc_id=%d)", base_path, dc_id)


async def client_to_tdata(
    client: TelegramClient,
    output_dir: str,
) -> str:
    """
    Export a connected TelegramClient session to a TData folder.
    Returns the path to the written TData folder.
    """
    # Extract session info from client
    me = await client.get_me()
    user_id = me.id
    session = client.session

    dc_id = session.dc_id
    auth_key_bytes = session.auth_key.key  # raw 256 bytes

    logger.info("Exporting session: user_id=%d dc_id=%d", user_id, dc_id)

    tdata_folder = os.path.join(output_dir, "tdata")
    _write_tdata(tdata_folder, dc_id, user_id, auth_key_bytes)
    return tdata_folder
