"""
Telegram Bot — TData Cloner (batch mode).

Flow:
  1. /start → proxy
  2. Send 1..N zip files (each is one or many accounts)
  3. After 15s of no new uploads → auto-start cloning
  4. All accounts cloned in parallel (MAX_CONCURRENT)
  5. One result zip back, each tdata named by phone number
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
from aiogram.types import Message, Document, FSInputFile

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

MAX_CONCURRENT = 5          # parallel clone workers
COLLECT_TIMEOUT = 15        # seconds of silence before auto-start

# user_id -> asyncio.Task (the pending "start after timeout" task)
_pending_timers: dict[int, asyncio.Task] = {}

# user_id -> work_dir (cleaned up after done)
_work_dirs: dict[int, str] = {}


# ── FSM States ────────────────────────────────────────────────────────────

class CloneStates(StatesGroup):
    waiting_proxy  = State()
    collecting     = State()   # receiving zip files
    cloning        = State()   # processing, ignore new messages


# ── Handlers ──────────────────────────────────────────────────────────────

@dp.message(Command("start"))
async def cmd_start(message: Message, state: FSMContext):
    _cancel_timer(message.from_user.id)
    _cleanup_work(message.from_user.id)
    await state.clear()
    await message.answer(
        "👋 <b>TData Cloner Bot</b>\n\n"
        "📡 Отправь прокси <b>SOCKS5</b>:\n"
        "<code>ip:port</code>  или  <code>ip:port:user:pass</code>\n"
        "<code>socks5://user:pass@ip:port</code>\n\n"
        "⚠️ HTTP прокси не поддерживаются.\n"
        "Или <code>-</code> — без прокси.",
        parse_mode="HTML"
    )
    await state.set_state(CloneStates.waiting_proxy)


@dp.message(CloneStates.waiting_proxy)
async def got_proxy(message: Message, state: FSMContext):
    proxy_str = message.text.strip() if message.text else ""

    if proxy_str == "-":
        proxy_str = None
    else:
        try:
            proxy = parse_proxy(proxy_str)
        except Exception as e:
            await message.answer(f"❌ Не могу распарсить прокси: {e}\n\nПопробуй ещё раз.")
            return
        if proxy.proxy_type != __import__('socks').SOCKS5:
            await message.answer(
                "⚠️ Только SOCKS5. Или отправь <code>-</code> для работы без прокси.",
                parse_mode="HTML"
            )
            return

    # Init work dir
    work_dir = tempfile.mkdtemp(prefix="tdata_clone_")
    _work_dirs[message.from_user.id] = work_dir
    os.makedirs(os.path.join(work_dir, "zips"), exist_ok=True)

    await state.update_data(proxy_str=proxy_str, zip_count=0)
    label = "Без прокси" if not proxy_str else f"Прокси принят"
    await message.answer(
        f"✅ {label}.\n\n"
        "📦 Отправляй <b>.zip файлы</b> — по одному или сразу пачкой.\n"
        f"Через <b>{COLLECT_TIMEOUT}с</b> после последнего файла начнётся клонирование.\n"
        "Или нажми /go чтобы стартовать сразу.",
        parse_mode="HTML"
    )
    await state.set_state(CloneStates.collecting)


@dp.message(CloneStates.collecting, F.document)
async def got_zip(message: Message, state: FSMContext):
    doc: Document = message.document
    uid = message.from_user.id

    if not doc.file_name.lower().endswith(".zip"):
        await message.answer("⚠️ Нужен .zip файл, пропускаю.")
        return

    if uid not in _work_dirs:
        await message.answer("❌ Сессия устарела. /start")
        await state.clear()
        return

    work_dir = _work_dirs[uid]
    data = await state.get_data()
    n = data.get("zip_count", 0) + 1

    zip_path = os.path.join(work_dir, "zips", f"{n:03d}_{doc.file_name}")
    await bot.download(doc, destination=zip_path)
    await state.update_data(zip_count=n)

    await message.answer(
        f"📥 Получил файл {n}: <code>{doc.file_name}</code>\n"
        f"Отправь ещё или жди {COLLECT_TIMEOUT}с для старта. /go — стартовать сразу.",
        parse_mode="HTML"
    )

    # Reset/start inactivity timer
    _cancel_timer(uid)
    task = asyncio.create_task(_auto_start(uid, message, state))
    _pending_timers[uid] = task


@dp.message(CloneStates.collecting, Command("go"))
async def cmd_go(message: Message, state: FSMContext):
    _cancel_timer(message.from_user.id)
    await _start_cloning(message, state)


@dp.message(CloneStates.cloning)
async def busy(message: Message, state: FSMContext):
    await message.answer("⏳ Клонирование уже идёт, подожди...")


async def _auto_start(uid: int, message: Message, state: FSMContext):
    """Called COLLECT_TIMEOUT seconds after the last received zip."""
    await asyncio.sleep(COLLECT_TIMEOUT)
    current_state = await state.get_state()
    if current_state == CloneStates.collecting:
        await _start_cloning(message, state)


async def _start_cloning(message: Message, state: FSMContext):
    uid = message.from_user.id
    data = await state.get_data()
    n = data.get("zip_count", 0)

    if n == 0:
        await message.answer("❌ Не получил ни одного zip файла.")
        await state.clear()
        _cleanup_work(uid)
        return

    if uid not in _work_dirs:
        await message.answer("❌ Сессия устарела. /start")
        await state.clear()
        return

    await state.set_state(CloneStates.cloning)
    work_dir = _work_dirs[uid]
    proxy_str = data.get("proxy_str")
    proxy = parse_proxy(proxy_str) if proxy_str else None

    await message.answer(f"🚀 Старт! Обрабатываю {n} архив(ов)...")

    try:
        result_zip = await process_all(
            work_dir=work_dir,
            proxy=proxy,
            message=message,
        )
    except Exception as e:
        logger.exception("process_all error")
        await message.answer(f"❌ Критическая ошибка: {e}")
        _cleanup_work(uid)
        await state.clear()
        return

    if result_zip:
        await message.answer_document(
            FSInputFile(result_zip, filename="cloned_tdata.zip"),
            caption="✅ <b>Готово!</b> Все склонированные TData внутри.",
            parse_mode="HTML"
        )
    else:
        await message.answer("❌ Ни одна сессия не была успешно склонирована.")

    _cleanup_work(uid)
    await state.clear()


async def process_all(work_dir: str, proxy, message: Message) -> Optional[str]:
    """Extract all zips, find all tdata folders, clone all in parallel."""
    zips_dir = os.path.join(work_dir, "zips")
    extract_dir = os.path.join(work_dir, "extracted")
    output_dir = os.path.join(work_dir, "output")
    os.makedirs(extract_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)

    # Extract every uploaded zip
    for fname in sorted(os.listdir(zips_dir)):
        if not fname.lower().endswith(".zip"):
            continue
        zip_p = os.path.join(zips_dir, fname)
        out_d = os.path.join(extract_dir, fname[:-4])
        os.makedirs(out_d, exist_ok=True)
        try:
            with zipfile.ZipFile(zip_p, "r") as zf:
                zf.extractall(out_d)
        except zipfile.BadZipFile:
            await message.answer(f"⚠️ Пропускаю повреждённый архив: {fname}")

    # Expand any nested zips inside
    expand_nested_zips(extract_dir)

    # Find all tdata folders
    tdata_paths = find_all_tdata(extract_dir)
    if not tdata_paths:
        await message.answer("❌ Не нашёл ни одной папки tdata в архивах.")
        return None

    total = len(tdata_paths)
    await message.answer(
        f"🔍 Найдено аккаунтов: <b>{total}</b>\n"
        f"⚙️ Параллельно: до {MAX_CONCURRENT}",
        parse_mode="HTML"
    )

    semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    tasks = [
        clone_account(
            idx=i,
            total=total,
            tdata_path=tp,
            output_dir=output_dir,
            proxy=proxy,
            message=message,
            semaphore=semaphore,
        )
        for i, tp in enumerate(tdata_paths, 1)
    ]
    results = await asyncio.gather(*tasks)

    ok     = [(phone, path) for phone, path, err in results if path]
    errors = [(phone, err)  for phone, path, err in results if err]

    # Summary
    lines = [f"📊 Итог: {len(ok)}/{total} успешно"]
    if errors:
        lines.append("❌ Ошибки:")
        for phone, err in errors[:10]:
            lines.append(f"  • {phone}: {err}")
        if len(errors) > 10:
            lines.append(f"  ... и ещё {len(errors)-10}")
    await message.answer("\n".join(lines))

    if not ok:
        return None

    # Build result zip: each tdata in a folder named by phone
    result_zip = os.path.join(work_dir, "cloned_tdata.zip")
    with zipfile.ZipFile(result_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for phone, new_tdata in ok:
            for root, dirs, files in os.walk(new_tdata):
                for fname in files:
                    abs_p = os.path.join(root, fname)
                    # arc: phone/tdata/key_data  etc.
                    rel = os.path.relpath(abs_p, os.path.dirname(new_tdata))
                    zf.write(abs_p, f"{phone}/{rel}")

    return result_zip


async def clone_account(
    idx: int,
    total: int,
    tdata_path: str,
    output_dir: str,
    proxy,
    message: Message,
    semaphore: asyncio.Semaphore,
) -> tuple[str, Optional[str], Optional[str]]:
    """Clone one account. Returns (phone_label, new_tdata_path|None, error|None)."""
    label = f"acc{idx:02d}"
    prefix = f"[{idx}/{total}]" if total > 1 else ""

    async def on_progress(text: str):
        msg = f"{prefix} {text}".strip() if prefix else text
        try:
            await message.answer(msg)
        except Exception:
            pass

    async with semaphore:
        acc_out = os.path.join(output_dir, f"slot_{idx:03d}")
        os.makedirs(acc_out, exist_ok=True)

        cloner = TDataCloner(
            api_id=API_ID,
            api_hash=API_HASH,
            proxy=proxy,
            code_timeout=90,
            on_progress=on_progress,
        )

        try:
            phone, new_tdata = await cloner.clone(tdata_path, acc_out)
            return phone, new_tdata, None

        except ValueError as e:
            err = str(e)
            if "2FA" in err or "password" in err.lower():
                return label, None, "2FA (не поддерживается в батч-режиме)"
            return label, None, err
        except TimeoutError as e:
            return label, None, f"таймаут: {e}"
        except Exception as e:
            logger.exception(f"Clone error account {idx}")
            return label, None, str(e)


# ── Helpers ───────────────────────────────────────────────────────────────


def expand_nested_zips(base_dir: str):
    """Recursively extract .zip files found inside base_dir."""
    changed = True
    while changed:
        changed = False
        for root, dirs, files in os.walk(base_dir):
            dirs[:] = [d for d in dirs if not d.startswith("__") and not d.startswith(".")]
            for fname in files:
                if not fname.lower().endswith(".zip"):
                    continue
                zip_p = os.path.join(root, fname)
                out_d = os.path.join(root, fname[:-4])
                if os.path.exists(out_d):
                    continue
                try:
                    os.makedirs(out_d, exist_ok=True)
                    with zipfile.ZipFile(zip_p, "r") as zf:
                        zf.extractall(out_d)
                    logger.info(f"Expanded nested zip: {fname}")
                    changed = True
                except Exception as e:
                    logger.warning(f"Skip bad zip {fname}: {e}")


def find_all_tdata(base_dir: str) -> list[str]:
    """Find ALL tdata/ folders, skip macOS metadata."""
    result = []
    for root, dirs, files in os.walk(base_dir):
        dirs[:] = [d for d in dirs if not d.startswith("__") and not d.startswith(".")]
        to_remove = []
        for d in dirs:
            if d.lower() == "tdata":
                result.append(os.path.join(root, d))
                to_remove.append(d)
        for d in to_remove:
            dirs.remove(d)
    return result


def _cancel_timer(uid: int):
    task = _pending_timers.pop(uid, None)
    if task and not task.done():
        task.cancel()


def _cleanup_work(uid: int):
    wd = _work_dirs.pop(uid, None)
    if wd:
        shutil.rmtree(wd, ignore_errors=True)


@dp.message(Command("cancel"))
async def cmd_cancel(message: Message, state: FSMContext):
    uid = message.from_user.id
    _cancel_timer(uid)
    _cleanup_work(uid)
    await state.clear()
    await message.answer("❌ Отменено. /start — начать заново.")


# ── Run ───────────────────────────────────────────────────────────────────

async def main():
    import uvicorn
    from api import app as fastapi_app

    logger.info("Starting bot + HTTP API...")
    config = uvicorn.Config(fastapi_app, host="0.0.0.0", port=8080, log_level="info")
    server = uvicorn.Server(config)
    await asyncio.gather(dp.start_polling(bot), server.serve())


if __name__ == "__main__":
    asyncio.run(main())
