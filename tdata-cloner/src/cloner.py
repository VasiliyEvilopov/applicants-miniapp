"""
Core cloning logic:
  1. Load TData → Session 1 (read-only, reads auth code)
  2. Create Session 2 on same account via fresh auth
  3. Export Session 2 → new TData
"""

import asyncio
import logging
import os
import random
from typing import Callable, Coroutine, Optional

from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.errors import (
    SessionPasswordNeededError,
    PhoneCodeInvalidError,
    PhoneCodeExpiredError,
    FloodWaitError,
)

from .tdata_handler import tdata_to_client, client_to_tdata
from .code_reader import wait_for_code
from .proxy_utils import Proxy

logger = logging.getLogger(__name__)

# Type alias for optional async progress callback
ProgressCallback = Optional[Callable[[str], Coroutine]]

# ── Random device fingerprint pools ───────────────────────────────────────────
_DEVICE_MODELS = [
    "Samsung Galaxy S23 Ultra", "Samsung Galaxy S22", "Samsung Galaxy A54",
    "Xiaomi 13 Pro", "Xiaomi Redmi Note 12", "POCO X5 Pro",
    "OnePlus 11", "OnePlus Nord 3", "Google Pixel 7 Pro",
    "Huawei P60 Pro", "OPPO Find X6", "Realme GT 5",
    "Motorola Edge 40", "Nokia G60", "Sony Xperia 1 V",
]

_SYSTEM_VERSIONS = [
    "Android 13", "Android 12", "Android 12L",
    "Android 13; SDK 33", "Android 12; SDK 32",
    "14", "13", "12",
]

_APP_VERSIONS = [
    "10.3.2", "10.2.9", "10.1.5", "10.0.1",
    "9.6.7", "9.5.3", "9.4.1",
    "10.3.0", "10.2.5",
]

_LANG_CODES = ["en", "ru", "en-US", "en-GB"]


def _random_fingerprint() -> dict:
    """Generate a random Telegram client device fingerprint."""
    return {
        "device_model": random.choice(_DEVICE_MODELS),
        "system_version": random.choice(_SYSTEM_VERSIONS),
        "app_version": random.choice(_APP_VERSIONS),
        "lang_code": random.choice(_LANG_CODES),
        "system_lang_code": random.choice(_LANG_CODES),
    }


class TDataCloner:
    def __init__(
        self,
        api_id: int,
        api_hash: str,
        proxy: Optional[Proxy] = None,
        code_timeout: int = 60,
        two_fa_password: Optional[str] = None,
        on_progress: ProgressCallback = None,
    ):
        self.api_id = api_id
        self.api_hash = api_hash
        self.proxy = proxy
        self.code_timeout = code_timeout
        self.two_fa_password = two_fa_password
        self.on_progress = on_progress

        self._phone: str = "unknown"
        self._client1: Optional[TelegramClient] = None
        self._client2: Optional[TelegramClient] = None

    async def _progress(self, text: str):
        if self.on_progress:
            try:
                await self.on_progress(text)
            except Exception:
                pass

    async def clone(self, tdata_path: str, output_dir: str) -> tuple[str, str]:
        """Returns (phone, new_tdata_path)."""
        try:
            return await self._do_clone(tdata_path, output_dir)
        finally:
            await self._cleanup()

    async def _do_clone(self, tdata_path: str, output_dir: str) -> str:
        proxy_tuple = self.proxy.to_telethon() if self.proxy else None

        # ── Step 1: Load source TData ──────────────────────────────────────
        await self._progress("🔑 Читаю TData и подключаюсь к Telegram...")
        logger.info("Step 1: Loading source TData...")
        self._client1 = await tdata_to_client(
            tdata_path=tdata_path,
            api_id=self.api_id,
            api_hash=self.api_hash,
            proxy=proxy_tuple,
        )
        me = await self._client1.get_me()
        phone = me.phone  # digits only, no "+"
        logger.info(f"Account: {me.first_name} (+{phone})")
        await self._progress(f"✅ Аккаунт: {me.first_name} (+{phone})")
        self._phone = phone

        # ── Step 2: Create second client for fresh auth ───────────────────
        await self._progress("📡 Запрашиваю код авторизации...")
        logger.info("Step 2: Starting fresh authorization...")
        fp = _random_fingerprint()
        logger.info(f"Device fingerprint: {fp['device_model']} / {fp['system_version']} / TG {fp['app_version']}")
        self._client2 = TelegramClient(
            session=StringSession(),
            api_id=self.api_id,
            api_hash=self.api_hash,
            proxy=proxy_tuple,
            connection_retries=1,
            timeout=20,
            device_model=fp["device_model"],
            system_version=fp["system_version"],
            app_version=fp["app_version"],
            lang_code=fp["lang_code"],
            system_lang_code=fp["system_lang_code"],
        )
        try:
            await asyncio.wait_for(self._client2.connect(), timeout=30)
        except asyncio.TimeoutError:
            raise RuntimeError("Не удалось подключить второй клиент (таймаут 30с). Проверь прокси.")

        # Request auth code
        sent = await self._client2.send_code_request(phone)
        logger.info(f"Code sent to {phone} (phone_code_hash: {sent.phone_code_hash[:8]}...)")

        # ── Step 3: Wait for code in Session 1 ───────────────────────────
        await self._progress(
            f"📱 Код отправлен на {phone}\n"
            f"⏳ Жду когда он придёт в исходный аккаунт (до {self.code_timeout}с)..."
        )
        logger.info(f"Step 3: Waiting for auth code (timeout: {self.code_timeout}s)...")
        code = await wait_for_code(
            self._client1,
            timeout=self.code_timeout,
            on_progress=self.on_progress,
        )

        if not code:
            raise TimeoutError(f"Код не пришёл за {self.code_timeout} секунд")

        logger.info(f"Got auth code: {code}")
        await self._progress(f"🔢 Получил код: {code}")

        # ── Step 4: Sign in with code ─────────────────────────────────────
        await self._progress("🔄 Выполняю авторизацию...")
        logger.info("Step 4: Signing in...")
        try:
            await self._client2.sign_in(
                phone=phone,
                code=code,
                phone_code_hash=sent.phone_code_hash,
            )
        except SessionPasswordNeededError:
            if not self.two_fa_password:
                raise ValueError(
                    "Account has 2FA enabled but no password provided. "
                    "Pass --password flag."
                )
            logger.info("2FA required, entering password...")
            await self._client2.sign_in(password=self.two_fa_password)
        except PhoneCodeInvalidError:
            raise ValueError(f"Auth code {code} is invalid")
        except PhoneCodeExpiredError:
            raise ValueError(f"Auth code {code} has expired")
        except FloodWaitError as e:
            raise RuntimeError(f"FloodWait: retry after {e.seconds}s")

        me2 = await self._client2.get_me()
        logger.info(f"Authorized successfully: {me2.first_name}")

        # ── Step 5: Export to TData ───────────────────────────────────────
        await self._progress("💾 Создаю новую TData...")
        logger.info("Step 5: Exporting new session to TData...")
        tdata_out = await client_to_tdata(self._client2, output_dir)

        return self._phone, tdata_out

    async def _cleanup(self):
        for client in (self._client1, self._client2):
            if client and client.is_connected():
                try:
                    await client.disconnect()
                except Exception:
                    pass
