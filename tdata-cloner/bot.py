"""
Telegram Bot interface for TData Cloner.

Usage flow:
  1. /start → bot asks for proxy
  2. User sends proxy string (ip:port:user:pass)
  3. Bot asks for TData archive (.zip)
  4. User sends .zip with tdata folder
  5. Bot clones the session
  6. Bot sends back new TData as .zip
  7. If 2FA needed → bot asks for password mid-flow
"""

import asyncio
import logging
import os
import shutil
import tempfile
import zipfile
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import (
    Message,
    Document,
    FSInputFile,
)

from src import TDataCloner, parse_proxy
from src.config import API_ID, API_HASH, OUTPUT_DIR

# ── Setup ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
if not BOT_TOKEN:
    raise ValueError("Set BOT_TOKEN environment variable")

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher(storage=MemoryStorage())

os.makedirs(OUTPUT_DIR, exist_ok=True)


# ── FSM States ────────────────────────────────────────────────────────────

class CloneStates(StatesGroup):
    waiting_proxy = State()
    waiting_tdata = State()
    waiting_2fa = State()
    cloning = State()


# ── State storage for per-user data ──────────────────────────────────────

user_data: dict = {}  # user_id -> {proxy, tdata_path, work_dir, cloner}


# ── Handlers ──────────────────────────────────────────────────────────────

@dp.message(Command("start"))
async def cmd_start(message: Message, state: FSMContext):
    await state.clear()
    await message.answer(
        "👋 <b>TData Cloner Bot</b>\n\n"
        "Клонирует Telegram-сессию из TData в новую авторизацию.\n\n"
        "📡 Отправь прокси в формате:\n"
        "<code>ip:port</code>\n"
        "<code>ip:port:user:pass</code>\n"
        "<code>socks5://user:pass@ip:port</code>",
        parse_mode="HTML"
    )
    await state.set_state(CloneStates.waiting_proxy)


@dp.message(CloneStates.waiting_proxy)
async def got_proxy(message: Message, state: FSMContext):
    proxy_str = message.text.strip()
    try:
        proxy = parse_proxy(proxy_str)
    except Exception as e:
        await message.answer(f"❌ Не могу распарсить прокси: {e}\n\nПопробуй ещё раз.")
        return

    await state.update_data(proxy_str=proxy_str)
    await message.answer(
        f"✅ Прокси принят: <code>{proxy}</code>\n\n"
        "📦 Теперь отправь TData как <b>.zip архив</b>\n"
        "(архив должен содержать папку <code>tdata/</code> внутри)",
        parse_mode="HTML"
    )
    await state.set_state(CloneStates.waiting_tdata)


@dp.message(CloneStates.waiting_tdata, F.document)
async def got_tdata(message: Message, state: FSMContext):
    doc: Document = message.document

    if not doc.file_name.endswith(".zip"):
        await message.answer("❌ Нужен .zip файл с папкой tdata внутри.")
        return

    await message.answer("⏳ Загружаю архив...")

    # Create temp work dir
    work_dir = tempfile.mkdtemp(prefix="tdata_clone_")
    zip_path = os.path.join(work_dir, "tdata.zip")

    # Download
    await bot.download(doc, destination=zip_path)

    # Extract
    extract_dir = os.path.join(work_dir, "extracted")
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_dir)
    except zipfile.BadZipFile:
        await message.answer("❌ Файл повреждён или не является zip архивом.")
        shutil.rmtree(work_dir, ignore_errors=True)
        return

    # Find tdata folder
    tdata_path = find_tdata(extract_dir)
    if not tdata_path:
        await message.answer(
            "❌ Не нашёл папку <code>tdata</code> в архиве.\n"
            "Убедись что архив содержит папку tdata/ внутри.",
            parse_mode="HTML"
        )
        shutil.rmtree(work_dir, ignore_errors=True)
        return

    data = await state.get_data()
    proxy = parse_proxy(data["proxy_str"])

    await state.update_data(work_dir=work_dir, tdata_path=tdata_path)
    await state.set_state(CloneStates.cloning)

    output_dir = os.path.join(work_dir, "output")

    async def on_progress(text: str):
        await message.answer(text)

    cloner = TDataCloner(
        api_id=API_ID,
        api_hash=API_HASH,
        proxy=proxy,
        code_timeout=90,
        on_progress=on_progress,
    )

    try:
        new_tdata_path = await cloner.clone(tdata_path, output_dir)
    except ValueError as e:
        err = str(e)
        if "2FA" in err or "password" in err.lower():
            # Store cloner state, ask for password
            await state.update_data(pending_2fa=True)
            await message.answer(
                "🔐 Аккаунт защищён двухфакторной аутентификацией.\n"
                "Введи пароль от 2FA:",
                parse_mode="HTML"
            )
            await state.set_state(CloneStates.waiting_2fa)
            # Store for re-use
            user_data[message.from_user.id] = {
                "work_dir": work_dir,
                "tdata_path": tdata_path,
                "proxy": proxy,
                "output_dir": output_dir,
            }
            return
        else:
            await message.answer(f"❌ Ошибка: {e}")
            shutil.rmtree(work_dir, ignore_errors=True)
            await state.clear()
            return
    except TimeoutError as e:
        await message.answer(f"⏱ Таймаут: {e}")
        shutil.rmtree(work_dir, ignore_errors=True)
        await state.clear()
        return
    except Exception as e:
        logger.exception("Clone error")
        await message.answer(f"❌ Неожиданная ошибка: {e}")
        shutil.rmtree(work_dir, ignore_errors=True)
        await state.clear()
        return

    await send_result(message, new_tdata_path, work_dir, state)


@dp.message(CloneStates.waiting_2fa)
async def got_2fa(message: Message, state: FSMContext):
    password = message.text.strip()
    uid = message.from_user.id

    if uid not in user_data:
        await message.answer("❌ Сессия устарела. Начни заново: /start")
        await state.clear()
        return

    ud = user_data[uid]

    async def on_progress_2fa(text: str):
        await message.answer(text)

    cloner = TDataCloner(
        api_id=API_ID,
        api_hash=API_HASH,
        proxy=ud["proxy"],
        code_timeout=90,
        two_fa_password=password,
        on_progress=on_progress_2fa,
    )

    try:
        new_tdata_path = await cloner.clone(ud["tdata_path"], ud["output_dir"])
    except Exception as e:
        logger.exception("Clone error (2FA)")
        await message.answer(f"❌ Ошибка: {e}")
        shutil.rmtree(ud["work_dir"], ignore_errors=True)
        del user_data[uid]
        await state.clear()
        return

    work_dir = ud["work_dir"]
    del user_data[uid]
    await send_result(message, new_tdata_path, work_dir, state)


async def send_result(
    message: Message,
    tdata_path: str,
    work_dir: str,
    state: FSMContext
):
    """Zip new TData and send to user."""
    zip_out = os.path.join(work_dir, "new_tdata.zip")

    with zipfile.ZipFile(zip_out, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(tdata_path):
            for file in files:
                abs_path = os.path.join(root, file)
                arc_name = os.path.relpath(abs_path, os.path.dirname(tdata_path))
                zf.write(abs_path, arc_name)

    await message.answer_document(
        FSInputFile(zip_out, filename="new_tdata.zip"),
        caption="✅ <b>Готово!</b> Новая TData внутри архива.",
        parse_mode="HTML"
    )

    shutil.rmtree(work_dir, ignore_errors=True)
    await state.clear()


# ── Helpers ───────────────────────────────────────────────────────────────

def find_tdata(base_dir: str) -> str | None:
    """Recursively find 'tdata' folder in extracted archive."""
    for root, dirs, files in os.walk(base_dir):
        for d in dirs:
            if d.lower() == "tdata":
                return os.path.join(root, d)
    return None


@dp.message(Command("cancel"))
async def cmd_cancel(message: Message, state: FSMContext):
    uid = message.from_user.id
    if uid in user_data:
        shutil.rmtree(user_data[uid].get("work_dir", ""), ignore_errors=True)
        del user_data[uid]
    await state.clear()
    await message.answer("❌ Отменено. /start — начать заново.")


# ── Run ───────────────────────────────────────────────────────────────────

async def main():
    import uvicorn
    from api import app as fastapi_app

    logger.info("Starting bot + HTTP API...")

    # Run FastAPI on port 8080 alongside the bot
    config = uvicorn.Config(fastapi_app, host="0.0.0.0", port=8080, log_level="info")
    server = uvicorn.Server(config)

    await asyncio.gather(
        dp.start_polling(bot),
        server.serve(),
    )


if __name__ == "__main__":
    asyncio.run(main())
