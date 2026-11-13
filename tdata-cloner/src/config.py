"""
Configuration for TData Session Cloner
"""

# Telegram API credentials
# Get from https://my.telegram.org/apps
API_ID = 0        # <- вставь свой
API_HASH = ""     # <- вставь свой

# Telegram Desktop executable path (Windows)
TELEGRAM_EXE = r"C:\Users\User\AppData\Roaming\Telegram Desktop\Telegram.exe"

# Output directory for cloned TData
OUTPUT_DIR = "./output"

# Delay settings (seconds)
CODE_WAIT_TIMEOUT = 60   # Сколько ждём код
CODE_POLL_INTERVAL = 3   # Как часто проверяем
