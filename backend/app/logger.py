"""
Structured logging so every FortyGuard interaction is traceable in dev.
Mirrors the REQ / RES / POLL / ERR tagging pattern that's already proven
useful when manually testing endpoints (see project test-harness logs).
"""
import json
import logging
import sys

from .config import settings


class TagFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        tag = getattr(record, "tag", record.levelname)
        base = f"[{tag}] {record.getMessage()}"
        payload = getattr(record, "payload", None)
        if payload is not None:
            try:
                base += "\n" + json.dumps(payload, indent=2, default=str)
            except (TypeError, ValueError):
                base += f"\n{payload!r}"
        return base


def _build_logger() -> logging.Logger:
    logger = logging.getLogger("thermora")
    logger.setLevel(settings.LOG_LEVEL)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(TagFormatter())
        logger.addHandler(handler)
    logger.propagate = False
    return logger


log = _build_logger()


def log_req(message: str, payload: dict | None = None) -> None:
    log.info(message, extra={"tag": "REQ", "payload": payload})


def log_res(message: str, payload: dict | None = None) -> None:
    log.info(message, extra={"tag": "RES", "payload": payload})


def log_poll(message: str, payload: dict | None = None) -> None:
    log.info(message, extra={"tag": "POLL", "payload": payload})


def log_err(message: str, payload: dict | None = None) -> None:
    log.error(message, extra={"tag": "ERR", "payload": payload})


def log_db(message: str, payload: dict | None = None) -> None:
    log.debug(message, extra={"tag": "DB", "payload": payload})
