"""
TData loading and exporting via opentele.
Converts TData <-> Telethon sessions.
"""

import os
import logging
from typing import Optional

from telethon import TelegramClient
from telethon.sessions import StringSession

logger = logging.getLogger(__name__)


async def tdata_to_client(
    tdata_path: str,
    api_id: int,
    api_hash: str,
    proxy=None,
    session_path: Optional[str] = None
) -> TelegramClient:
    """
    Load TData folder → Telethon TelegramClient (connected).

    :param tdata_path: Path to tdata folder
    :param api_id: Telegram API ID
    :param api_hash: Telegram API Hash
    :param proxy: Proxy tuple for Telethon or None
    :param session_path: Optional path to save .session file
    :return: Connected TelegramClient
    """
    try:
        from opentele.td import TDesktop
        from opentele.api import UseCurrentSession
    except ImportError:
        raise ImportError("opentele not installed: pip install opentele")

    logger.info(f"Loading TData from: {tdata_path}")

    tdesk = TDesktop(tdata_path)

    if not tdesk.isLoaded():
        raise ValueError(f"Failed to load TData from {tdata_path}")

    logger.info(f"TData loaded. Accounts: {tdesk.accountsCount}")

    session = StringSession() if not session_path else session_path

    client = await tdesk.ToTelethon(
        session=session,
        flag=UseCurrentSession,
        api_id=api_id,
        api_hash=api_hash,
    )

    if proxy:
        client._proxy = proxy

    await client.connect()

    if not await client.is_user_authorized():
        raise ValueError("Session is not authorized (maybe TData expired?)")

    me = await client.get_me()
    logger.info(f"Authorized as: {me.first_name} (+{me.phone})")

    return client


async def client_to_tdata(client: TelegramClient, output_path: str) -> str:
    """
    Export Telethon session → TData folder.

    :param client: Connected authorized TelegramClient
    :param output_path: Directory to save TData
    :return: Path to created TData
    """
    try:
        from opentele.td import TDesktop
        from opentele.api import CreateNewSession
    except ImportError:
        raise ImportError("opentele not installed: pip install opentele")

    os.makedirs(output_path, exist_ok=True)
    tdata_out = os.path.join(output_path, "tdata")

    logger.info(f"Exporting session to TData: {tdata_out}")

    tdesk = await TDesktop.FromTelethon(
        client,
        flag=CreateNewSession
    )
    tdesk.SaveTData(tdata_out)

    logger.info(f"TData saved: {tdata_out}")
    return tdata_out
