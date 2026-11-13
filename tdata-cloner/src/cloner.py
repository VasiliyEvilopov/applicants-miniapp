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
# 200+ real Android device models grouped by brand
_DEVICE_MODELS = [
    # Samsung Galaxy S-series
    "Samsung Galaxy S24 Ultra", "Samsung Galaxy S24+", "Samsung Galaxy S24",
    "Samsung Galaxy S23 Ultra", "Samsung Galaxy S23+", "Samsung Galaxy S23",
    "Samsung Galaxy S22 Ultra", "Samsung Galaxy S22+", "Samsung Galaxy S22",
    "Samsung Galaxy S21 Ultra", "Samsung Galaxy S21+", "Samsung Galaxy S21",
    "Samsung Galaxy S21 FE", "Samsung Galaxy S20 Ultra", "Samsung Galaxy S20+",
    # Samsung Galaxy A-series
    "Samsung Galaxy A55", "Samsung Galaxy A54", "Samsung Galaxy A53",
    "Samsung Galaxy A52s", "Samsung Galaxy A52", "Samsung Galaxy A35",
    "Samsung Galaxy A34", "Samsung Galaxy A33", "Samsung Galaxy A25",
    "Samsung Galaxy A24", "Samsung Galaxy A15", "Samsung Galaxy A14",
    "Samsung Galaxy A73", "Samsung Galaxy A72", "Samsung Galaxy A71",
    # Samsung Galaxy M/F-series
    "Samsung Galaxy M54", "Samsung Galaxy M53", "Samsung Galaxy M34",
    "Samsung Galaxy M33", "Samsung Galaxy F54", "Samsung Galaxy F34",
    # Xiaomi
    "Xiaomi 14 Ultra", "Xiaomi 14 Pro", "Xiaomi 14",
    "Xiaomi 13 Ultra", "Xiaomi 13 Pro", "Xiaomi 13",
    "Xiaomi 12 Pro", "Xiaomi 12", "Xiaomi 12 Lite",
    "Xiaomi 11T Pro", "Xiaomi 11T", "Xiaomi 11 Lite NE",
    # Xiaomi Redmi
    "Xiaomi Redmi Note 13 Pro+", "Xiaomi Redmi Note 13 Pro",
    "Xiaomi Redmi Note 13", "Xiaomi Redmi Note 12 Pro+",
    "Xiaomi Redmi Note 12 Pro", "Xiaomi Redmi Note 12",
    "Xiaomi Redmi Note 11 Pro", "Xiaomi Redmi Note 11",
    "Xiaomi Redmi 13C", "Xiaomi Redmi 12", "Xiaomi Redmi 12C",
    "Xiaomi Redmi A2+", "Xiaomi Redmi A2",
    # POCO
    "POCO X6 Pro", "POCO X6", "POCO X5 Pro", "POCO X5",
    "POCO F5 Pro", "POCO F5", "POCO F4 GT", "POCO F4",
    "POCO M6 Pro", "POCO M5s", "POCO M5", "POCO C65",
    # OnePlus
    "OnePlus 12", "OnePlus 12R", "OnePlus 11", "OnePlus 11R",
    "OnePlus 10 Pro", "OnePlus 10T", "OnePlus 9 Pro", "OnePlus 9",
    "OnePlus Nord 3", "OnePlus Nord CE 3 Lite", "OnePlus Nord CE 3",
    "OnePlus Nord 2T", "OnePlus Nord CE 2 Lite",
    # Google Pixel
    "Google Pixel 8 Pro", "Google Pixel 8", "Google Pixel 8a",
    "Google Pixel 7 Pro", "Google Pixel 7", "Google Pixel 7a",
    "Google Pixel 6 Pro", "Google Pixel 6", "Google Pixel 6a",
    "Google Pixel 5", "Google Pixel 4a",
    # OPPO
    "OPPO Find X7 Ultra", "OPPO Find X7 Pro", "OPPO Find X7",
    "OPPO Find X6 Pro", "OPPO Find X6", "OPPO Reno 11 Pro",
    "OPPO Reno 11", "OPPO Reno 10 Pro+", "OPPO Reno 10 Pro",
    "OPPO Reno 10", "OPPO A98", "OPPO A78", "OPPO A58",
    # Realme
    "Realme GT 5 Pro", "Realme GT 5", "Realme GT Neo 5",
    "Realme GT 3", "Realme 11 Pro+", "Realme 11 Pro",
    "Realme 11", "Realme 10 Pro+", "Realme 10 Pro",
    "Realme C55", "Realme C53", "Realme Narzo 60 Pro",
    # Vivo
    "vivo X100 Pro", "vivo X100", "vivo X90 Pro+",
    "vivo X90 Pro", "vivo X90", "vivo V29 Pro",
    "vivo V29", "vivo V27 Pro", "vivo Y100",
    # Motorola
    "Motorola Edge 50 Pro", "Motorola Edge 50 Ultra", "Motorola Edge 50",
    "Motorola Edge 40 Pro", "Motorola Edge 40 Neo", "Motorola Edge 40",
    "Motorola Edge 30 Ultra", "Motorola Edge 30 Pro",
    "Motorola Moto G84", "Motorola Moto G73", "Motorola Moto G54",
    "Motorola Moto G53", "Motorola Moto G34",
    # Sony Xperia
    "Sony Xperia 1 VI", "Sony Xperia 1 V", "Sony Xperia 1 IV",
    "Sony Xperia 5 V", "Sony Xperia 5 IV", "Sony Xperia 10 VI",
    "Sony Xperia 10 V", "Sony Xperia 10 IV",
    # Nokia
    "Nokia G42", "Nokia G22", "Nokia XR21",
    "Nokia C32", "Nokia C22", "Nokia C12",
    # Huawei (without GMS — still common)
    "Huawei P60 Pro", "Huawei P60", "Huawei Mate 60 Pro",
    "Huawei Nova 11 Pro", "Huawei Nova 11", "Huawei Nova 10 Pro",
    # ZTE / nubia
    "nubia Z50 Ultra", "nubia Z50S Pro", "ZTE Blade V50 Design",
    # Asus
    "ASUS ROG Phone 8 Pro", "ASUS ROG Phone 7 Ultimate",
    "ASUS ZenFone 10", "ASUS ZenFone 9",
    # Infinix / Tecno
    "Infinix Note 30 Pro", "Infinix Hot 40 Pro", "Infinix Smart 8",
    "Tecno Camon 20 Pro", "Tecno Spark 20 Pro",
]

# Android version strings with build numbers (the way real devices report them)
_SYSTEM_VERSIONS = [
    # Android 14
    "14", "Android 14",
    "14; Build/UQ1A.240205.004", "14; Build/AP1A.240405.002",
    "14; Build/AP2A.240805.005",
    # Android 13
    "13", "Android 13",
    "13; Build/TQ2A.230505.002", "13; Build/TQ3A.230901.001",
    "13; Build/TP1A.220624.014",
    # Android 12
    "12", "Android 12",
    "12; Build/SK3A.220210.001", "12; Build/SP1A.210812.016",
    "12L", "12.1",
    # Android 11
    "11", "Android 11",
    "11; Build/RQ3A.211001.001", "11; Build/RP1A.201005.001",
    # Android 10 (older but still used)
    "10", "Android 10",
    "10; Build/QP1A.191005.007",
]

# Telegram Android app versions (real release history)
_APP_VERSIONS = [
    "10.14.5", "10.14.4", "10.14.2", "10.14.1",
    "10.13.3", "10.13.2", "10.13.1", "10.13.0",
    "10.12.5", "10.12.4", "10.12.3", "10.12.2", "10.12.1",
    "10.11.3", "10.11.2", "10.11.1", "10.11.0",
    "10.10.3", "10.10.2", "10.10.1",
    "10.9.5", "10.9.4", "10.9.3", "10.9.2", "10.9.1",
    "10.8.3", "10.8.2", "10.8.1",
    "10.7.5", "10.7.4", "10.7.3", "10.7.2",
    "10.6.4", "10.6.3", "10.6.2", "10.6.1",
    "10.5.4", "10.5.3", "10.5.2", "10.5.1",
    "10.4.5", "10.4.4", "10.4.3", "10.4.2", "10.4.1",
    "10.3.2", "10.3.1", "10.3.0",
    "10.2.9", "10.2.8", "10.2.7",
    "10.1.5", "10.1.4", "10.1.3",
    "10.0.3", "10.0.2", "10.0.1",
    "9.6.7", "9.6.6", "9.6.5",
    "9.5.3", "9.5.2", "9.5.1",
    "9.4.5", "9.4.4", "9.4.3",
]

# Language codes — weighted toward common regions
_LANG_CODES = [
    # High frequency
    "ru", "ru", "ru",           # Russia (most likely user base)
    "en", "en",                 # English
    "uk",                       # Ukrainian
    "kk",                       # Kazakh
    "uz",                       # Uzbek
    # Medium frequency
    "de", "fr", "es", "it", "pt",
    "tr", "pl", "ro", "nl", "sv",
    # Less common but realistic
    "ar", "fa", "hi", "id", "vi",
    "zh-CN", "zh-TW", "ja", "ko",
    "en-US", "en-GB", "pt-BR",
]

# Timezone offsets as strings (for extra variation — not a Telethon param
# but useful if you later pass it via other means)
_TIMEZONES = [
    "UTC+3", "UTC+5", "UTC+6", "UTC+7",   # Russia/CIS
    "UTC+0", "UTC+1", "UTC+2",             # Europe
    "UTC+4", "UTC+8",                      # UAE, China
    "UTC-5", "UTC-8",                      # Americas
]


def _random_fingerprint() -> dict:
    """Generate a fully randomized Telegram client device fingerprint.

    Each clone gets a unique combination of device model, Android build,
    Telegram app version and locale — no two sessions look like the same device.
    """
    lang = random.choice(_LANG_CODES)
    # system_lang_code may differ slightly from app lang_code (realistic)
    sys_lang = random.choice(_LANG_CODES) if random.random() > 0.6 else lang
    return {
        "device_model": random.choice(_DEVICE_MODELS),
        "system_version": random.choice(_SYSTEM_VERSIONS),
        "app_version": random.choice(_APP_VERSIONS),
        "lang_code": lang,
        "system_lang_code": sys_lang,
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
