"""
Configuration for TData Session Cloner
Values are read from environment variables (set in Railway dashboard).
"""
import os

# Telegram API credentials — get from https://my.telegram.org/apps
API_ID = int(os.environ.get("API_ID", "0"))
API_HASH = os.environ.get("API_HASH", "")

# Output directory for cloned TData
OUTPUT_DIR = "./output"

# Delay settings (seconds)
CODE_WAIT_TIMEOUT = 60
CODE_POLL_INTERVAL = 3
