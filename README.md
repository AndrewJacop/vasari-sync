# vasari-sync (vsync)

A cross-platform CLI tool for syncing project files that should never touch
public/shared version control — `.env` files, internal docs, local secrets,
per-developer config — to a storage backend you already own (your own S3
bucket, SFTP server, private GitHub repo, etc).

> Status: early development. See `local-docs/PLAN.md` for the task breakdown.
