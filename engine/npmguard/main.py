import uvicorn

from .config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "npmguard.api:app",
        host=settings.api_host,
        port=settings.api_port,
        log_level=settings.log_level,
    )


if __name__ == "__main__":
    main()
