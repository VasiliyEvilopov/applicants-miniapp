"""
Proxy parsing and validation utilities
Supports formats:
  ip:port
  ip:port:user:pass
  socks5://user:pass@ip:port
  http://user:pass@ip:port
"""

import re
from dataclasses import dataclass
from typing import Optional
import socks


@dataclass
class Proxy:
    host: str
    port: int
    username: Optional[str] = None
    password: Optional[str] = None
    proxy_type: int = socks.SOCKS5  # socks.SOCKS5 | socks.HTTP

    def to_telethon(self) -> tuple:
        """Format for Telethon proxy param"""
        return (self.proxy_type, self.host, self.port,
                True, self.username, self.password)

    def to_requests(self) -> dict:
        """Format for requests library"""
        scheme = "socks5" if self.proxy_type == socks.SOCKS5 else "http"
        if self.username:
            url = f"{scheme}://{self.username}:{self.password}@{self.host}:{self.port}"
        else:
            url = f"{scheme}://{self.host}:{self.port}"
        return {"http": url, "https": url}

    def __str__(self):
        if self.username:
            return f"{self.host}:{self.port} (auth: {self.username})"
        return f"{self.host}:{self.port}"


def parse_proxy(proxy_str: str) -> Proxy:
    """
    Parse proxy string in any common format.

    Examples:
        "1.2.3.4:1080"
        "1.2.3.4:1080:user:pass"
        "socks5://user:pass@1.2.3.4:1080"
        "http://1.2.3.4:3128"
    """
    proxy_str = proxy_str.strip()

    # URL format
    url_match = re.match(
        r'^(socks5|socks4|http)://(?:([^:@]+):([^@]*)@)?([^:]+):(\d+)$',
        proxy_str, re.IGNORECASE
    )
    if url_match:
        scheme, user, password, host, port = url_match.groups()
        ptype = socks.HTTP if scheme.lower() == "http" else socks.SOCKS5
        return Proxy(
            host=host,
            port=int(port),
            username=user or None,
            password=password or None,
            proxy_type=ptype
        )

    # ip:port:user:pass format
    parts = proxy_str.split(":")
    if len(parts) == 4:
        return Proxy(
            host=parts[0],
            port=int(parts[1]),
            username=parts[2],
            password=parts[3]
        )
    elif len(parts) == 2:
        return Proxy(host=parts[0], port=int(parts[1]))

    raise ValueError(f"Cannot parse proxy: {proxy_str}")
