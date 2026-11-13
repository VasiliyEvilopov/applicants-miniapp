"""
Read Telegram auth code from service messages (sender: 777000).
Used to intercept the login code sent to the first session.
"""

import asyncio
import logging
import re
import time
from typing import Optional, Callable, Coroutine

from telethon import TelegramClient, events

logger = logging.getLogger(__name__)

TELEGRAM_SERVICE_ID = 777000  # Official Telegram service account


def extract_code(text: str) -> Optional[str]:
    """
    Extract 5-6 digit auth code from Telegram service message.

    Handles:
      "Login code: 12345"
      "Ваш код входа: 12345"
      "Код: 12345. Никому не давай."
      "12345 is your Telegram code"
      "12345 — ваш код Telegram"
    """
    if not text:
        return None

    patterns = [
        # Russian/English: "код: XXXXX" or "code: XXXXX" (with optional words between)
        r'(?:code|код)[^0-9]{0,20}(\d{5,6})',
        # "XXXXX is your"
        r'(\d{5,6})\s+(?:is your|—\s*ваш|это ваш)',
        # Any standalone 5-6 digit number (last resort)
        r'\b(\d{5,6})\b',
    ]

    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1)

    return None


async def wait_for_code(
    client: TelegramClient,
    timeout: int = 90,
    poll_interval: int = 3,
    on_progress: Optional[Callable[[str], Coroutine]] = None,
) -> Optional[str]:
    """
    Wait for auth code message from Telegram (777000).

    Strategy 0: check existing recent messages immediately (code may arrive fast)
    Strategy 1: event handler (new message)
    Strategy 2: polling last messages (fallback)

    Total timeout = timeout seconds.
    """
    # Strategy 0: check if code already arrived (fast code delivery)
    try:
        msgs = await client.get_messages(TELEGRAM_SERVICE_ID, limit=3)
        for msg in msgs:
            if msg and msg.text:
                code = extract_code(msg.text)
                if code:
                    logger.info(f"Code found in existing messages: {code}")
                    return code
    except Exception as e:
        logger.warning(f"Pre-check messages error: {e}")

    # Strategy 1: event handler
    loop = asyncio.get_running_loop()
    code_future: asyncio.Future = loop.create_future()

    @client.on(events.NewMessage(from_users=TELEGRAM_SERVICE_ID))
    async def handler(event):
        code = extract_code(event.message.text)
        if code and not code_future.done():
            logger.info(f"Code received via event: {code} | raw: {event.message.text!r}")
            code_future.set_result(code)

    client.add_event_handler(handler)
    deadline = time.monotonic() + timeout

    try:
        remaining = deadline - time.monotonic()
        code = await asyncio.wait_for(code_future, timeout=max(remaining, 1))
        return code
    except asyncio.TimeoutError:
        logger.warning("Event timeout, falling back to polling...")
    finally:
        client.remove_event_handler(handler)

    # Strategy 2: poll
    seen_codes: set = set()
    while time.monotonic() < deadline:
        try:
            msgs = await client.get_messages(TELEGRAM_SERVICE_ID, limit=5)
            for msg in msgs:
                if not msg or not msg.text:
                    continue
                code = extract_code(msg.text)
                if code and code not in seen_codes:
                    seen_codes.add(code)
                    logger.info(f"Code found via polling: {code} | raw: {msg.text!r}")
                    return code
        except Exception as e:
            logger.warning(f"Polling error: {e}")

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break

        wait = min(poll_interval, remaining)
        # Send a progress ping every ~30s
        elapsed = timeout - remaining
        if on_progress and int(elapsed) % 30 < poll_interval:
            try:
                await on_progress(f"⏳ Всё ещё жду код... ({int(remaining)}с осталось)")
            except Exception:
                pass

        await asyncio.sleep(wait)

    logger.error(f"Code not received within {timeout}s")
    return None
