"""
Read Telegram auth code from service messages (sender: 777000).
Used to intercept the login code sent to the first session.
"""

import asyncio
import logging
import re
from typing import Optional

from telethon import TelegramClient, events
from telethon.tl.types import User

logger = logging.getLogger(__name__)

TELEGRAM_SERVICE_ID = 777000  # Official Telegram service account


async def wait_for_code(
    client: TelegramClient,
    timeout: int = 60,
    poll_interval: int = 3
) -> Optional[str]:
    """
    Wait for auth code message from Telegram (777000).

    Strategy 1: event handler (new message)
    Strategy 2: polling last messages (fallback)

    :param client: Connected authorized Telethon client (session 1)
    :param timeout: Max seconds to wait
    :param poll_interval: Polling interval in seconds
    :return: 5-digit auth code string or None
    """
    code_future: asyncio.Future = asyncio.get_event_loop().create_future()

    @client.on(events.NewMessage(from_users=TELEGRAM_SERVICE_ID))
    async def handler(event):
        code = extract_code(event.message.text)
        if code and not code_future.done():
            logger.info(f"Code received via event: {code}")
            code_future.set_result(code)

    client.add_event_handler(handler)

    try:
        # Wait for event-based code
        code = await asyncio.wait_for(code_future, timeout=timeout)
        return code
    except asyncio.TimeoutError:
        logger.warning("Event timeout, falling back to polling...")
    finally:
        client.remove_event_handler(handler)

    # Fallback: poll last messages from 777000
    return await poll_for_code(client, timeout=timeout, interval=poll_interval)


async def poll_for_code(
    client: TelegramClient,
    timeout: int = 60,
    interval: int = 3
) -> Optional[str]:
    """
    Poll messages from 777000 looking for a fresh auth code.
    """
    import time
    start = time.time()
    seen_codes = set()

    while time.time() - start < timeout:
        try:
            messages = await client.get_messages(TELEGRAM_SERVICE_ID, limit=3)
            for msg in messages:
                if not msg or not msg.text:
                    continue
                code = extract_code(msg.text)
                if code and code not in seen_codes:
                    seen_codes.add(code)
                    logger.info(f"Code found via polling: {code}")
                    return code
        except Exception as e:
            logger.warning(f"Polling error: {e}")

        await asyncio.sleep(interval)

    logger.error(f"Code not received within {timeout}s")
    return None


def extract_code(text: str) -> Optional[str]:
    """
    Extract 5-digit auth code from Telegram service message.

    Patterns:
      "Your login code: 12345"
      "Login code: 12345. Do not give..."
      "12345 is your Telegram code"
    """
    if not text:
        return None

    patterns = [
        r'(?:code|код)[:\s]+(\d{5})',
        r'(\d{5})\s+is your',
        r'\b(\d{5})\b',
    ]

    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1)

    return None
