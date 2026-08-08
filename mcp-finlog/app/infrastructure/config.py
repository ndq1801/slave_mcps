from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Optional here so that `import`-ing the package never fails; the MCP server
    # validates DATABASE_URL at startup (see index.py).
    database_url: str | None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=False,  # DATABASE_URL will map to database_url automatically
        env_file_encoding="utf-8",
        extra="ignore",  # Ignore extra environment variables (like PORT from Railway)
    )


settings = Settings()
