from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
    )

    ASSEMBLYAI_API_KEY: str
    CARTESIA_API_KEY: str
    GEMINI_API_KEY: str
    GEMINI_DEFAULT_MODEL: str = "gemini-flash-latest"
    GEMINI_BASE_URL: str = "https://generativelanguage.googleapis.com/v1beta/openai/"

settings = Settings()