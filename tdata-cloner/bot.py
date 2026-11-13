"""
Telegram Bot interface for TData Cloner.

Usage flow:
  1. /start → bot asks for proxy
  2. User sends proxy string or "-" for no proxy
  3. Bot asks for TData archive (.zip)
     — zip can contain ONE or MANY accounts:
       * multiple tdata/ folders at different paths
       * multiple inner .zip files each with a tdata/
  4. Bot clones all accounts in parallel (up to MAX_CONCURRENT)
  5. Bot sends back a single .zip with all new TData folders
"""

import asyncio
import logging
import os
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Optional

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

MAX_CONCURRENT = 5   # max simultaneous clone operations


# ── FSM States ────────────────────────────────────────────────────────────

class CloneStates(StatesGroup):
    waiting_proxy = State()
    waiting_tdata = State()


# ── Handlers ──────────────────────────────────────────────────────────────

@dp.message(Command("start"))
async def cmd_start(message: Message, state: FSMContext):
    await state.clear()
    await message.answer(
        "👋 <b>TData Cloner Bot</b>\n\n"
        "Клонирует одну или несколько Telegram-сессий из TData.\n\n"
        "📡 Отправь прокси в формате <b>SOCKS5</b>:\n"
        "<code>ip:port</code>\n"
        "<code>ip:port:user:pass</code>\n"
        "<code>socks5://user:pass@ip:port</code>\n\n"
        "⚠️ HTTP прокси не работают с Telegram — только SOCKS5.\n"
        "Или отправь <code>-</code> чтобы работать без прокси.",
        parse_mode="HTML"
    )
    await state.set_state(CloneStates.waiting_proxy)


@dp.message(CloneStates.waiting_proxy)
async def got_proxy(message: Message, state: FSMContext):
    proxy_str = message.text.strip()

    if proxy_str == "-":
        await state.update_data(proxy_str=None)
        await message.answer(
            "✅ Без прокси.\n\n"
            "📦 Отправь <b>.zip архив</b> с TData.\n"
            "Можно один аккаунт или несколько — зип может содержать:\n"
            "• папки вида <code>номер/tdata/</code>\n"
            "• вложенные <code>.zip</code> файлы с tdata внутри",
            parse_mode="HTML"
        )
        await state.set_state(CloneStates.waiting_tdata)
        return

    try:
        proxy = parse_proxy(proxy_str)
    except Exception as e:
        await message.answer(f"❌ Не могу распарсить прокси: {e}\n\nПопробуй ещё раз.")
        return

    if proxy.proxy_type != __import__('socks').SOCKS5:
        await message.answer(
            "⚠️ HTTP прокси не работают с Telegram.\n"
            "Используй SOCKS5 или отправь <code>-</code> для работы без прокси.",
            parse_mode="HTML"
        )
        return

    await state.update_data(proxy_str=proxy_str)
    await message.answer(
        f"✅ Прокси принят.\n\n"
        "📦 Отправь <b>.zip архив</b> с TData.\n"
        "Можно один аккаунт или несколько — зип может содержать:\n"
        "• папки вида <code>номер/tdata/</code>\n"
        "• вложенные <code>.zip</code> файлы с tdata внутри",
        parse_mode="HTML"
    )
    await state.set_state(CloneStates.waiting_tdata)


@dp.message(CloneStates.waiting_tdata, F.document)
async def got_tdata(message: Message, state: FSMContext):
    doc: Document = message.document

    if not doc.file_name.lower().endswith(".zip"):
        await message.answer("❌ Нужен .zip файл.")
        return

    data = await state.get_data()
    proxy_str = data.get("proxy_str")
    proxy = parse_proxy(proxy_str) if proxy_str else None

    await message.answer("⏳ Загружаю и распаковываю архив...")

    work_dir = tempfile.mkdtemp(prefix="tdata_clone_")
    zip_path = os.path.join(work_dir, "upload.zip")

    try:
        await bot.download(doc, destination=zip_path)

        extract_dir = os.path.join(work_dir, "extracted")
        os.makedirs(extract_dir, exist_ok=True)

        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_dir)

        # Find all accounts (expand nested zips first)
        expand_nested_zips(extract_dir)
        tdata_paths = find_all_tdata(extract_dir)

        if not tdata_paths:
            await message.answer(
                "❌ Не нашёл ни одной папки <code>tdata</code> в архиве.\n"
                "Убедись что архив содержит tdata/ внутри.",
                parse_mode="HTML"
            )
            return

        count = len(tdata_paths)
        await message.answer(
            f"🔍 Найдено аккаунтов: <b>{count}</b>\n"
            f"🚀 Начинаю клонирование{' (до ' + str(MAX_CONCURRENT) + ' параллельно)' if count > 1 else ''}...",
            parse_mode="HTML"
        )

        output_dir = os.path.join(work_dir, "output")
        os.makedirs(output_dir, exist_ok=True)

        semaphore = asyncio.Semaphore(MAX_CONCURRENT)
        tasks = [
            clone_account(
                idx=i,
                total=count,
                tdata_path=tdata_path,
                output_dir=output_dir,
                proxy=proxy,
                message=message,
                semaphore=semaphore,
            )
            for i, tdata_path in enumerate(tdata_paths, 1)
        ]

        results = await asyncio.gather(*tasks, return_exceptions=False)

        # Build result zip
        ok = [(label, path) for label, path, err in results if path]
        errors = [(label, err) for label, path, err in results if err]

        if not ok:
            lines = "\n".join(f"• {label}: {err}" for label, err in errors)
            await message.answer(f"❌ Все аккаунты завершились с ошибкой:\n{lines}")
            return

        result_zip = os.path.join(work_dir, "cloned_tdata.zip")
        with zipfile.ZipFile(result_zip, "w", zipfile.ZIP_DEFLATED) as zf:
            for label, new_tdata in ok:
                for root, dirs, files in os.walk(new_tdata):
                    for file in files:
                        abs_p = os.path.join(root, file)
                        arc = label + "/" + os.path.relpath(abs_p, os.path.dirname(new_tdata))
                        zf.write(abs_p, arc)

        caption_lines = [f"✅ <b>Готово!</b> Склонировано: {len(ok)}/{count}"]
        if errors:
            caption_lines.append("\n⚠️ Ошибки:")
            for label, err in errors:
                caption_lines.append(f"• {label}: {err}")

        await message.answer_document(
            FSInputFile(result_zip, filename="cloned_tdata.zip"),
            caption="\n".join(caption_lines),
            parse_mode="HTML"
        )

    except zipfile.BadZipFile:
        await message.answer("❌ Файл повреждён или не является zip архивом.")
    except Exception as e:
        logger.exception("Unexpected error in got_tdata")
        await message.answer(f"❌ Неожиданная ошибка: {e}")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
        await state.clear()


async def clone_account(
    idx: int,
    total: int,
    tdata_path: str,
    output_dir: str,
    proxy,
    message: Message,
    semaphore: asyncio.Semaphore,
) -> tuple[str, Optional[str], Optional[str]]:
    """
    Clone one account. Returns (label, new_tdata_path_or_None, error_or_None).
    """
    label = f"acc{idx:02d}"  # will be overwritten with phone after connect

    prefix = f"[{idx}/{total}]" if total > 1 else ""

    async def on_progress(text: str):
        msg = f"{prefix} {text}".strip() if prefix else text
        try:
            await message.answer(msg)
        except Exception:
            pass

    async with semaphore:
        acc_output = os.path.join(output_dir, f"account_{idx:02d}")
        os.makedirs(acc_output, exist_ok=True)

        cloner = TDataCloner(
            api_id=API_ID,
            api_hash=API_HASH,
            proxy=proxy,
            code_timeout=90,
            on_progress=on_progress,
        )

        try:
            new_tdata = await cloner.clone(tdata_path, acc_output)
            # Try to get phone from path name hint (parent dir of tdata)
            phone_hint = Path(tdata_path).parent.name
            if phone_hint and phone_hint[0] in "0123456789+":
                label = phone_hint
            return label, new_tdata, None

        except ValueError as e:
            err = str(e)
            if "2FA" in err or "password" in err.lower():
                return label, None, "2FA (введи пароль вручную — пока не поддерживается в батч-режиме)"
            return label, None, err
        except TimeoutError as e:
            return label, None, f"таймаут: {e}"
        except Exception as e:
            logger.exception(f"Clone error for account {idx}")
            return label, None, str(e)


# ── Helpers ───────────────────────────────────────────────────────────────

def expand_nested_zips(base_dir: str):
    """Extract any .zip files found inside base_dir (one level of nesting)."""
    for root, dirs, files in os.walk(base_dir):
        dirs[:] = [d for d in dirs if not d.startswith("__") and not d.startswith(".")]
        for fname in files:
            if fname.lower().endswith(".zip") and not fname.startswith("__"):
                zip_p = os.path.join(root, fname)
                out_d = os.path.join(root, fname[:-4])  # strip .zip
                if os.path.exists(out_d):
                    continue
                try:
                    os.makedirs(out_d, exist_ok=True)
                    with zipfile.ZipFile(zip_p, "r") as zf:
                        zf.extractall(out_d)
                    logger.info(f"Extracted nested zip: {fname}")
                except Exception as e:
                    logger.warning(f"Failed to extract nested zip {fname}: {e}")


def find_all_tdata(base_dir: str) -> list[str]:
    """
    Find ALL tdata folders in base_dir, skipping macOS metadata dirs.
    Returns list of absolute paths to each tdata/ folder found.
    """
    result = []
    for root, dirs, files in os.walk(base_dir):
        dirs[:] = [d for d in dirs if not d.startswith("__") and not d.startswith(".")]
        for d in dirs:
            if d.lower() == "tdata":
                result.append(os.path.join(root, d))
                dirs.remove(d)  # don't recurse into tdata itself
                break
    return result


@dp.message(Command("cancel"))
async def cmd_cancel(message: Message, state: FSMContext):
    await state.clear()
    await message.answer("❌ Отменено. /start — начать заново.")


# ── Run ───────────────────────────────────────────────────────────────────

async def main():
    import uvicorn
    from api import app as fastapi_app

    logger.info("Starting bot + HTTP API...")

    config = uvicorn.Config(fastapi_app, host="0.0.0.0", port=8080, log_level="info")
    server = uvicorn.Server(config)

    await asyncio.gather(
        dp.start_polling(bot),
        server.serve(),
    )


if __name__ == "__main__":
    asyncio.run(main())
