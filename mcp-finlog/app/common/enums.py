from __future__ import annotations

from enum import Enum
from typing import Optional


class ChatType(str, Enum):
    """Telegram chat types."""

    PRIVATE = "private"
    GROUP = "group"
    SUPERGROUP = "supergroup"
    CHANNEL = "channel"

    @classmethod
    def from_string(cls, chat_type: Optional[str]) -> "ChatType":
        """Convert string to ChatType enum, default to PRIVATE if not found."""
        if not chat_type:
            return cls.PRIVATE
        normalized = chat_type.lower()
        for member in cls:
            if member.value == normalized:
                return member
        return cls.PRIVATE

    def is_group_chat(self) -> bool:
        """Check if this is a group or supergroup chat."""
        return self in (ChatType.GROUP, ChatType.SUPERGROUP)


class ParseMode(str, Enum):
    """Telegram message parse modes."""

    HTML = "HTML"
    MARKDOWN = "Markdown"
    MARKDOWN_V2 = "MarkdownV2"


class CommandGroup(str, Enum):
    """Command groups based on structure and behavior."""

    TRANSACTION = "transaction"  # Format: /[command] [-id=id_value] [value] [description] [-time=time_value]
    LIST = "list"  # Format: /list [time] [user] [-type=type1,type2] [-page=page_num]
    DELETE = "delete"  # Format: /delete [id]
    SHOW = "show"  # Format: /show [id]
    IMPORT = "import"  # Format: /import YYYY/MM
    INFO = "info"  # Format: informational commands (e.g., /commands)
    # Add more groups as needed


class TelegramCommand(str, Enum):
    """Supported Telegram commands."""

    ADD_INCOME = "income"
    ADD_EXPENSE = "expense"
    ADD_LOAN = "loan"
    LIST = "list"
    REPORT = "report"
    SHOW = "show"
    DELETE = "delete"
    PAY = "pay"
    IMPORT = "import"
    COMMANDS = "commands"

    _INCOME_ALIASES = {"income", "thu", "thu_nhap", "add_income"}
    _EXPENSE_ALIASES = {"expense", "chi", "chi_phi", "spend", "add_expense"}
    _LOAN_ALIASES = {"loan", "vay", "no", "debt", "borrow", "lend", "add_loan"}
    _LIST_ALIASES = {"list", "danh_sach", "ls"}
    _REPORT_ALIASES = {"report", "bao_cao", "summary", "stats"}
    _SHOW_ALIASES = {"show", "xem", "view", "detail"}
    _DELETE_ALIASES = {"delete", "xoa", "del", "remove"}
    _PAY_ALIASES = {"pay", "tra", "thanh_toan", "repay"}
    _IMPORT_ALIASES = {"import"}
    _COMMANDS_ALIASES = {"commands", "help", "start", "info"}

    @classmethod
    def get_group(cls, command: "TelegramCommand") -> CommandGroup:
        """Get the command group for a given command."""
        transaction_commands = {cls.ADD_INCOME, cls.ADD_EXPENSE, cls.ADD_LOAN}
        if command in transaction_commands:
            return CommandGroup.TRANSACTION
        list_commands = {cls.LIST, cls.REPORT}
        if command in list_commands:
            return CommandGroup.LIST
        if command == cls.SHOW:
            return CommandGroup.SHOW
        if command == cls.DELETE:
            return CommandGroup.DELETE
        if command == cls.PAY:
            return CommandGroup.DELETE  # Same structure as delete
        if command == cls.IMPORT:
            return CommandGroup.IMPORT
        if command == cls.COMMANDS:
            return CommandGroup.INFO
        raise ValueError(f"Unknown command group for: {command}")

    @classmethod
    def from_text(cls, text: Optional[str]) -> Optional["TelegramCommand"]:
        """Normalize and match incoming command names."""
        if not text:
            return None

        normalized = cls._normalize(text)
        if not normalized:
            return None

        if normalized in cls._INCOME_ALIASES:
            return cls.ADD_INCOME
        if normalized in cls._EXPENSE_ALIASES:
            return cls.ADD_EXPENSE
        if normalized in cls._LOAN_ALIASES:
            return cls.ADD_LOAN
        if normalized in cls._LIST_ALIASES:
            return cls.LIST
        if normalized in cls._REPORT_ALIASES:
            return cls.REPORT
        if normalized in cls._SHOW_ALIASES:
            return cls.SHOW
        if normalized in cls._DELETE_ALIASES:
            return cls.DELETE
        if normalized in cls._PAY_ALIASES:
            return cls.PAY
        if normalized in cls._IMPORT_ALIASES:
            return cls.IMPORT
        if normalized in cls._COMMANDS_ALIASES:
            return cls.COMMANDS
        return None

    @staticmethod
    def _normalize(text: str) -> str:
        """Strip slashes and whitespace to extract command token."""
        cleaned = text.strip().lower()
        if cleaned.startswith("/"):
            cleaned = cleaned[1:]
        cleaned = cleaned.replace("\\", "").strip()
        if not cleaned:
            return ""
        token = cleaned.split()[0]
        return token.strip(" /:\\")


class LanguageLocale(str, Enum):
    """Supported language codes with default timezone mappings."""

    VI = "vi"
    EN = "en"
    JA = "ja"

    @classmethod
    def from_code(cls, code: Optional[str]) -> "LanguageLocale":
        if not code:
            return cls.VI
        normalized = code.lower()
        for member in cls:
            if member.value == normalized:
                return member
        return cls.VI

    @property
    def default_timezone(self) -> str:
        """Return default timezone for this language."""
        timezone_map = {
            LanguageLocale.VI: "Asia/Ho_Chi_Minh",
            LanguageLocale.JA: "Asia/Tokyo",
            LanguageLocale.EN: "UTC",
        }
        return timezone_map.get(self, "UTC")

    @property
    def babel_locale_identifier(self) -> str:
        """Return Babel locale identifier for this language."""
        locale_map = {
            LanguageLocale.VI: "vi_VN",
            LanguageLocale.JA: "ja_JP",
            LanguageLocale.EN: "en_US",
        }
        return locale_map.get(self, "en_US")

    @property
    def currency_code(self) -> str:
        """Return currency code for this language."""
        currency_map = {
            LanguageLocale.VI: "VND",
            LanguageLocale.JA: "JPY",
            LanguageLocale.EN: "USD",
        }
        return currency_map.get(self, "USD")

    @property
    def currency_symbol(self) -> str:
        """Return currency symbol for this language."""
        currency_symbols = {
            LanguageLocale.VI: "₫",
            LanguageLocale.JA: "￥",
            LanguageLocale.EN: "$",
        }
        return currency_symbols.get(self, "$")


